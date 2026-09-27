import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../config.js";
import { spawnHidden } from "../utils/child-process.js";
import type { RlmListSubagentsResult } from "./rlm-runtime.js";

/**
 * bb mirror threads for RLM subagents (PRIME-11/PRIME-24).
 *
 * A depth-0 session inside bb (BB_THREAD_ID/BB_PROJECT_ID set) mirrors every
 * plain `rlm.spawn` by default: the child is admitted with a deferred turn, and
 * this module writes the single-use claim file and spawns the mirror bb thread
 * whose first prompt rebinds onto the child. Explicit `bb_mirror=True` keeps
 * the PRIME-11 semantics (the caller brings its own thread); `bb_mirror=False`
 * forces a plain, invisible child. Everything degrades locally: when the bb
 * CLI is missing or the thread spawn fails, the child falls back to a plain
 * headless admission turn.
 */

export const RLM_MIRROR_TASK_FRAME = "[task from parent]";
export const RLM_MIRROR_ROSTER_TIMEOUT_MS = 20_000;
const RLM_MIRROR_SPAWN_TIMEOUT_MS = 30_000;
const RLM_MIRROR_ROSTER_POLL_MS = 300;
const BB_THREAD_ID_PATTERN = /^thr_[A-Za-z0-9]+$/u;
/** Consumer format owned here; acp-mode.ts matches mirror prompts against it. */
export const RLM_MIRROR_MARKER_PATTERN = /^\[rlm-mirror:([a-f0-9]{32})\][ \t]*$/u;
/** A stale claim must not rebind; the parent re-spawns instead. */
export const RLM_MIRROR_CLAIM_TTL_MS = 10 * 60_000;
const RLM_MIRROR_CLAIMS_DIR = "acp-mirror-claims";

export interface BbMirrorEnv {
	threadId: string;
	projectId: string;
	environmentId?: string;
	/** bb binary override; falls back to "bb" on PATH inside spawnBbMirrorThread. */
	bbCli?: string;
}

export type BbSpawnFailureKind = "spawn-error" | "nonzero-exit" | "timeout";

export class BbSpawnFailed extends Error {
	/** "spawn-error" proves no thread exists; the other kinds leave existence unknown. */
	readonly kind: BbSpawnFailureKind;

	constructor(kind: BbSpawnFailureKind, message: string) {
		super(message);
		this.name = "BbSpawnFailed";
		this.kind = kind;
	}

	/** True only when bb definitely created no thread, so the caller may fall back. */
	get definitive(): boolean {
		return this.kind === "spawn-error";
	}
}

/** True when this session runs inside a bb thread (the ACP plugin injects both ids). */
export function isInsideBbThreadSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.BB_THREAD_ID && env.BB_PROJECT_ID);
}

/**
 * Auto-mirror default: plain `rlm.spawn` in a depth-0 bb session mirrors the
 * child into the thread list. `PRIME_AGENT_AUTO_MIRROR=0|false|off` disables it.
 */
export function shouldAutoMirrorRlmChild(depth: number, env: NodeJS.ProcessEnv = process.env): boolean {
	if (depth !== 0) return false;
	if (!isInsideBbThreadSession(env)) return false;
	const override = env.PRIME_AGENT_AUTO_MIRROR?.trim().toLowerCase();
	return override !== "0" && override !== "false" && override !== "off";
}

export function bbMirrorEnvFromProcess(env: NodeJS.ProcessEnv = process.env): BbMirrorEnv | undefined {
	const threadId = env.BB_THREAD_ID;
	const projectId = env.BB_PROJECT_ID;
	if (!threadId || !projectId) return undefined;
	const environmentId = env.BB_ENVIRONMENT_ID;
	const bbCli = env.BB_CLI;
	return {
		threadId,
		projectId,
		...(environmentId ? { environmentId } : {}),
		...(bbCli ? { bbCli } : {}),
	};
}

export function newMirrorClaimNonce(): string {
	return randomBytes(16).toString("hex");
}

function mirrorClaimsDir(agentDir: string): string {
	return join(agentDir, RLM_MIRROR_CLAIMS_DIR);
}

/** Build the mirror prompt: leading claim-nonce marker line, then the task body. */
export function buildRlmMirrorPrompt(nonce: string, prompt: string): string {
	return `[rlm-mirror:${nonce}]\n${RLM_MIRROR_TASK_FRAME}\n\n${prompt}`;
}

export interface RlmMirrorClaim {
	target: string;
	createdAtMs: number;
}

/** Write the single-use claim the mirror thread's ACP frontend consumes on boot. */
export function writeRlmMirrorClaimFile(nonce: string, target: string, agentDir: string = getAgentDir()): void {
	const claimsDir = mirrorClaimsDir(agentDir);
	mkdirSync(claimsDir, { recursive: true });
	writeFileSync(join(claimsDir, `${nonce}.json`), JSON.stringify({ target, createdAtMs: Date.now() }));
}

/** A failed spawn leaves no thread that could ever consume the claim. */
export function removeRlmMirrorClaimFile(nonce: string, agentDir: string = getAgentDir()): void {
	try {
		rmSync(join(mirrorClaimsDir(agentDir), `${nonce}.json`));
	} catch {
		// A leftover claim only stays valid until the reader's TTL expires.
	}
}

/**
 * Resolve the claim a mirror marker points at. Claims live in the agent dir:
 * only a claim written by the spawning parent on this machine can name a rebind
 * target, so a leaked marker cannot rebind onto an arbitrary session by name.
 * Stale claims return undefined and are consumed by the caller on use.
 */
export function readRlmMirrorClaim(nonce: string, agentDir: string = getAgentDir()): RlmMirrorClaim | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(join(mirrorClaimsDir(agentDir), `${nonce}.json`), "utf8"),
		) as Partial<RlmMirrorClaim>;
		if (typeof parsed.target !== "string" || parsed.target.length === 0) return undefined;
		const createdAtMs = typeof parsed.createdAtMs === "number" ? parsed.createdAtMs : 0;
		if (Date.now() - createdAtMs > RLM_MIRROR_CLAIM_TTL_MS) return undefined;
		return { target: parsed.target, createdAtMs };
	} catch {
		return undefined;
	}
}

/** Consume a claim after a successful rebind so its nonce cannot be replayed. */
export function consumeRlmMirrorClaim(nonce: string, agentDir: string = getAgentDir()): void {
	try {
		rmSync(join(mirrorClaimsDir(agentDir), `${nonce}.json`));
	} catch {
		// A leftover claim only stays valid until its TTL expires.
	}
}

/** Mirror thread titles read `<name> · <task summary>` (60-char summary). */
export function mirrorThreadTitle(name: string, task: string): string {
	const summary = task.split(/\s+/u).filter(Boolean).join(" ").slice(0, 60);
	return summary ? `${name} · ${summary}` : name;
}

/**
 * Poll the parent-scoped roster until the admitted child has a live daemon
 * session. The exact child id wins over a same-named passive row.
 */
export async function resolveChildActiveSessionId(
	list: () => Promise<RlmListSubagentsResult>,
	childId: string,
	sessionName: string,
	timeoutMs: number,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "roster never listed the child";
	while (Date.now() < deadline) {
		try {
			const subagents = (await list()).subagents;
			const byId = subagents.find((agent) => agent.active_session_id && agent.rlm_child_id === childId);
			const byName = subagents.find((agent) => agent.active_session_id && agent.session_name === sessionName);
			const match = byId ?? byName;
			if (match?.active_session_id) return match.active_session_id;
			lastError = `child ${sessionName} (${childId}) has no active session yet`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, RLM_MIRROR_ROSTER_POLL_MS);
			timer.unref?.();
		});
	}
	throw new Error(`bb mirror spawn failed: ${lastError} after ${Math.round(timeoutMs / 1000)}s`);
}

export interface BbMirrorSpawnOutcome {
	/** Thread id when bb reported it; a created-but-unreported thread stays undefined. */
	threadId?: string;
	threadCreated: boolean;
}

export interface BbMirrorSpawnOptions {
	projectId: string;
	environmentId?: string;
	title: string;
	/** Full mirror prompt: `[rlm-mirror:<nonce>]` marker line plus the task body. */
	prompt: string;
	/** bb binary override; defaults to `process.env.BB_CLI` or "bb". */
	bbCommand?: string;
	timeoutMs?: number;
}

/**
 * Spawn the mirror bb thread via the bb CLI and parse the thread id. A zero
 * exit with unparsable output still created a thread, so it is reported as
 * created without an id and the caller must not retry blindly. A timeout or a
 * late nonzero exit leaves thread existence unknown (`kind !== "spawn-error"`),
 * so the caller keeps the claim and parks instead of falling back.
 */
export async function spawnBbMirrorThread(options: BbMirrorSpawnOptions): Promise<BbMirrorSpawnOutcome> {
	const args = [
		"thread",
		"spawn",
		"--json",
		"--project",
		options.projectId,
		...(options.environmentId ? ["--environment", options.environmentId] : []),
		"--parent-self",
		"--provider",
		"acp-prime-agent",
		"--title",
		options.title,
		"--prompt-file",
		"-",
	];
	const bbCommand = options.bbCommand?.trim() || process.env.BB_CLI?.trim() || "bb";
	const child = spawnHidden(bbCommand, args, { stdio: ["pipe", "pipe", "pipe"] });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let settled = false;
	return await new Promise<BbMirrorSpawnOutcome>((resolve, reject) => {
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(
				new BbSpawnFailed(
					"timeout",
					`bb ${args.slice(0, 2).join(" ")} timed out after ${options.timeoutMs ?? RLM_MIRROR_SPAWN_TIMEOUT_MS}ms`,
				),
			);
		}, options.timeoutMs ?? RLM_MIRROR_SPAWN_TIMEOUT_MS);
		timeout.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new BbSpawnFailed("spawn-error", `bb ${args.slice(0, 2).join(" ")} failed: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			const stdoutText = Buffer.concat(stdout).toString("utf8");
			const stderrText = Buffer.concat(stderr).toString("utf8");
			if (code !== 0) {
				reject(
					new BbSpawnFailed(
						"nonzero-exit",
						`bb ${args.slice(0, 2).join(" ")} failed with exit code ${code}: ${stderrText.trim() || stdoutText.trim()}`,
					),
				);
				return;
			}
			resolve(parseBbSpawnOutcome(stdoutText));
		});
		child.stdin?.end(options.prompt, "utf8", () => {
			// EPIPE here means bb closed stdin early; the close/error handlers own the outcome.
		});
		// A stdin write failure must not surface as an unhandled error event.
		child.stdin?.on("error", () => undefined);
	});
}

function parseBbSpawnOutcome(stdoutText: string): BbMirrorSpawnOutcome {
	try {
		const parsed: unknown = JSON.parse(stdoutText);
		if (parsed && typeof parsed === "object") {
			const id = (parsed as { id?: unknown }).id;
			if (typeof id === "string" && BB_THREAD_ID_PATTERN.test(id)) {
				return { threadId: id, threadCreated: true };
			}
		}
	} catch {
		// Fall through: the thread exists but bb printed nothing parsable.
	}
	return { threadCreated: true };
}

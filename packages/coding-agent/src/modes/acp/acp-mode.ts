import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { VERSION } from "../../config.js";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.js";
import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import { takeOverStdout, writeRawStdout } from "../../core/output-guard.js";
import { SessionManager } from "../../core/session-manager.js";
import { parseSlashCommand } from "../../core/slash-commands.js";
import { InProcessAgentConnection } from "../agent-connection/in-process-agent-connection.js";
import type {
	AgentConnection,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionEvent,
	AgentConnectionSessionInputPause,
	AgentConnectionState,
} from "../agent-connection/types.js";
import { latestAutonomousGateAttempt } from "../headless-completion.js";
import { type AcpEventMappingState, acpUpdatesForSessionEvent } from "./acp-events.js";
import { resolveAcpMcpServers } from "./acp-mcp.js";
import { PRIME_AGENT_META_NAMESPACE, type PrimeAgentAutonomousMeta, primeAgentMeta } from "./acp-meta.js";
import { type AcpStopReason, acpStopReason } from "./acp-stop-reason.js";

/**
 * ACP frames must reach real stdout.
 *
 * Startup calls `takeOverStdout()` for every non-interactive mode, which
 * redirects `process.stdout.write` to stderr so stray logging cannot corrupt a
 * machine-readable stream. Handing `process.stdout` to the SDK would therefore
 * publish the whole protocol on stderr; write through the raw escape hatch the
 * guard exposes, exactly as RPC mode does.
 */
function rawStdoutSink(): WritableStream<Uint8Array> {
	const decoder = new TextDecoder();
	return new WritableStream<Uint8Array>({
		write(chunk) {
			writeRawStdout(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
		},
	});
}

function normalizeWindowsDriveLetter(path: string): string {
	if (process.platform !== "win32" || !/^[A-Z]:/i.test(path)) return path;
	return path.slice(0, 1).toLowerCase() + path.slice(1);
}

function canonicalCwd(path: string): string {
	const resolved = resolve(path);
	let canonical: string;
	try {
		canonical = realpathSync(resolved);
	} catch {
		// Preserve the previous lexical comparison when a path is missing or inaccessible.
		canonical = resolved;
	}
	return normalizeWindowsDriveLetter(canonical);
}

/**
 * Cross-process ACP session registry.
 *
 * bb forks an ACP provider by spawning a fresh agent process and sending it
 * `session/fork` with the *source* session's id, so the forked process must be
 * able to map that id back to a session file on disk. ACP session ids are
 * per-process random UUIDs, so `session/new` publishes
 * `{ACP sessionId -> runtime session id + session file}` into a small JSON
 * registry inside the session directory; `session/fork` and `session/load`
 * read it back. The source and fork processes share the session directory
 * because bb reuses the source thread's environment for the fork.
 */
const ACP_SESSION_REGISTRY_FILENAME = "acp-session-registry.json";
const ACP_SESSION_REGISTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface AcpSessionRegistryEntry {
	/** Protocol-level ACP session id (registry map key is the same value). */
	runtimeSessionId: string | null;
	/** Session file at registration time; may be null before the first persist. */
	sessionFile: string | null;
	cwd: string;
	createdAt: number;
}

type AcpSessionRegistry = Record<string, AcpSessionRegistryEntry>;

function acpSessionRegistryPath(sessionDir: string): string {
	return join(sessionDir, ACP_SESSION_REGISTRY_FILENAME);
}

function readAcpSessionRegistry(sessionDir: string): AcpSessionRegistry {
	try {
		const parsed = JSON.parse(readFileSync(acpSessionRegistryPath(sessionDir), "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		return parsed as AcpSessionRegistry;
	} catch {
		return {};
	}
}

function writeAcpSessionRegistry(sessionDir: string, registry: AcpSessionRegistry): void {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(acpSessionRegistryPath(sessionDir), `${JSON.stringify(registry, null, "\t")}\n`, "utf8");
}

function pruneAcpSessionRegistry(registry: AcpSessionRegistry, now = Date.now()): AcpSessionRegistry {
	const pruned: AcpSessionRegistry = {};
	for (const [sessionId, entry] of Object.entries(registry)) {
		if (now - entry.createdAt <= ACP_SESSION_REGISTRY_MAX_AGE_MS) pruned[sessionId] = entry;
	}
	return pruned;
}

function registerAcpSession(
	sessionDir: string,
	sessionId: string,
	entry: { runtimeSessionId: string | null; sessionFile: string | null; cwd: string },
): void {
	const registry = pruneAcpSessionRegistry(readAcpSessionRegistry(sessionDir));
	registry[sessionId] = { ...entry, createdAt: Date.now() };
	try {
		writeAcpSessionRegistry(sessionDir, registry);
	} catch {
		// A failed registry write only degrades fork support for this session;
		// session/new must not fail because of it.
	}
}

/**
 * Resolve a registered ACP session id to its session file.
 *
 * Prefers the file recorded at registration time; falls back to scanning the
 * session directory for the runtime session id, which covers sessions whose
 * file only appeared after the first persist.
 */
async function resolveAcpSessionFile(
	sessionDir: string,
	sessionId: string,
): Promise<{ entry: AcpSessionRegistryEntry; sessionFile: string | undefined } | undefined> {
	const entry = readAcpSessionRegistry(sessionDir)[sessionId];
	if (!entry) return undefined;
	if (entry.sessionFile && existsSync(entry.sessionFile)) return { entry, sessionFile: entry.sessionFile };
	if (entry.runtimeSessionId) {
		try {
			const sessions = await SessionManager.list(entry.cwd, sessionDir);
			const match = sessions.find((session) => session.id === entry.runtimeSessionId);
			if (match) return { entry, sessionFile: match.path };
		} catch {
			// Fall through to the undefined return below.
		}
	}
	return { entry, sessionFile: undefined };
}

function isJsonRpcResponse(message: unknown, requestId: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	const record = message as Record<string, unknown>;
	return (
		record.jsonrpc === "2.0" &&
		record.id === requestId &&
		!Object.hasOwn(record, "method") &&
		Object.hasOwn(record, "result") !== Object.hasOwn(record, "error")
	);
}

function sameCwd(left: string, right: string): boolean {
	const canonicalLeft = canonicalCwd(left);
	const canonicalRight = canonicalCwd(right);
	if (canonicalLeft === canonicalRight) return true;

	try {
		const leftStat = statSync(canonicalLeft, { bigint: true });
		const rightStat = statSync(canonicalRight, { bigint: true });
		// Either half being zero makes the pair untrustworthy: Windows path-based
		// stat can report dev 0 with a real ino, and comparing ino alone would match
		// distinct directories on different volumes, since file IDs are volume-local.
		const leftIdentityMissing = leftStat.dev === 0n || leftStat.ino === 0n;
		const rightIdentityMissing = rightStat.dev === 0n || rightStat.ino === 0n;
		if (leftIdentityMissing || rightIdentityMissing) return false;
		return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
	} catch {
		return false;
	}
}

export interface AcpModeOptions {
	/** Bind headless extensions once the connection is live (in-process mode). */
	bindHeadlessExtensions?: () => Promise<void>;
	/**
	 * Transport override. Defaults to NDJSON over stdio; tests supply an
	 * in-memory stream pair so the protocol runs without a subprocess.
	 */
	stream?: ReturnType<typeof acp.ndJsonStream>;
	/** Skip claiming stdout when the caller supplies its own transport. */
	ownStdout?: boolean;
}

interface AcpPendingTerminal {
	promptTurnId: number;
	boundary: TurnBoundary;
	outcome: "result" | "error";
	abort: AbortController;
	status?: AgentAutonomousStatus;
	turnFailure?: string;
	failure?: string;
	task?: Promise<void>;
}

interface AcpInputPauseRelease {
	promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
}

interface AcpSessionEntry {
	id: string;
	mappingState: AcpEventMappingState;
	abort: AbortController | undefined;
	cancelling: boolean;
	cancelTask: Promise<void> | undefined;
	stopFailure: string | undefined;
	inputPause: AgentConnectionSessionInputPause | undefined;
	inputPauseKey: string | undefined;
	inputPauseRelease: AcpInputPauseRelease | undefined;
	pendingTerminal: AcpPendingTerminal | undefined;
	promptTask: Promise<void> | undefined;
	resolvePromptTask: (() => void) | undefined;
	unsubscribe: (() => void) | undefined;
	producer: AcpUpdateProducer;
}

/**
 * The sole producer of ACP session updates for one ACP session.
 *
 * ACP notifications are asynchronous, so assigning an id at each call site is
 * insufficient: detached calls can be observed out of order. This producer
 * serializes publication and stamps the *delivered* order. Its phase/outcome
 * fields are application metadata, deliberately independent of ACP stop
 * reasons such as `end_turn`.
 */
class AcpUpdateProducer {
	private eventSequence = 0;
	private nextPromptTurnId = 0;
	private activePromptTurnId = 0;
	private tail: Promise<void> = Promise.resolve();
	private readonly childOriginTurnIds = new Map<string, number>();
	private readonly terminalChildOriginTurns = new Set<number>();
	private readonly responseCommittedTurns = new Set<number>();
	private readonly terminalLifecycleTurns = new Set<number>();
	private readonly finishedPromptTurns = new Set<number>();
	private readonly admissionReady: Promise<void>;
	private releaseAdmission!: () => void;
	private admissionOpen = false;
	private admissionClosed = false;

	constructor(
		private readonly sessionId: string,
		private readonly client: { notify(method: unknown, params: unknown): Promise<unknown> },
	) {
		// Subscribe before the initial snapshot, but do not let that subscription
		// publish a session-bound update before session/new has replied.
		this.admissionReady = new Promise<void>((resolve) => {
			this.releaseAdmission = resolve;
		});
	}

	commitSessionNewResponse(): void {
		if (this.admissionClosed) return;
		this.admissionOpen = true;
		this.releaseAdmission();
	}

	failSessionNewAdmission(): void {
		if (this.admissionOpen || this.admissionClosed) return;
		this.admissionClosed = true;
		this.releaseAdmission();
	}

	beginPrompt(): number {
		this.activePromptTurnId = ++this.nextPromptTurnId;
		return this.activePromptTurnId;
	}

	private cleanupTurn(turnId: number): void {
		this.responseCommittedTurns.delete(turnId);
		if (![...this.childOriginTurnIds.values()].some((originTurnId) => originTurnId === turnId)) {
			this.terminalChildOriginTurns.delete(turnId);
		}
	}

	beginTerminalLifecycle(turnId: number): void {
		this.terminalLifecycleTurns.add(turnId);
	}

	finishPrompt(turnId: number): void {
		if (this.activePromptTurnId === turnId) this.activePromptTurnId = 0;
		if (this.terminalLifecycleTurns.has(turnId)) {
			this.finishedPromptTurns.add(turnId);
			return;
		}
		this.cleanupTurn(turnId);
	}

	finishTerminalLifecycle(turnId: number): void {
		this.terminalLifecycleTurns.delete(turnId);
		if (this.finishedPromptTurns.delete(turnId)) this.cleanupTurn(turnId);
	}

	/**
	 * Cut a scoreable terminal boundary before it is queued. A subscription
	 * callback after this point is connection-scoped, never appended to a turn
	 * that an evaluator may treat as terminal.
	 */
	commitResponse(turnId: number): void {
		this.responseCommittedTurns.add(turnId);
	}

	isResponseCommitted(turnId: number): boolean {
		return this.responseCommittedTurns.has(turnId);
	}

	sealTerminal(turnId: number): void {
		this.commitResponse(turnId);
		if ([...this.childOriginTurnIds.values()].some((originTurnId) => originTurnId === turnId)) {
			this.terminalChildOriginTurns.add(turnId);
		}
		if (this.activePromptTurnId === turnId) this.activePromptTurnId = 0;
	}

	turnForEvent(event: AgentConnectionSessionEvent): number {
		if (event.type === "rlm_child_update") {
			const known = this.childOriginTurnIds.get(event.child.id);
			const originTurnId = known ?? this.activePromptTurnId;
			const turnId = this.terminalChildOriginTurns.has(originTurnId) ? 0 : originTurnId;
			const childFinished = ["done", "error", "cancelled"].includes(event.child.status);
			if (childFinished) {
				this.childOriginTurnIds.delete(event.child.id);
				if (![...this.childOriginTurnIds.values()].some((origin) => origin === originTurnId)) {
					this.terminalChildOriginTurns.delete(originTurnId);
				}
			} else if (known === undefined) {
				// Remember its initial origin, including connection scope, so a later
				// child update cannot be relabelled by a subsequent prompt.
				this.childOriginTurnIds.set(event.child.id, originTurnId);
			}
			return turnId;
		}
		return this.activePromptTurnId;
	}

	async publish(
		update: Record<string, unknown>,
		turnId: number,
		phase: "event" | "responseBoundary" | "terminalQuiescence",
		outcome?: "result" | "error",
	): Promise<boolean> {
		// Admission is synchronous through the tail assignment below: close either
		// rejects this call here or drains the update after it joins the queue.
		if (this.admissionClosed) return false;
		const eventSequence = ++this.eventSequence;
		const priorMeta = (update._meta && typeof update._meta === "object" ? update._meta : {}) as Record<
			string,
			unknown
		>;
		const priorPrimeMeta =
			priorMeta[PRIME_AGENT_META_NAMESPACE] && typeof priorMeta[PRIME_AGENT_META_NAMESPACE] === "object"
				? (priorMeta[PRIME_AGENT_META_NAMESPACE] as Record<string, unknown>)
				: {};
		const correlatedUpdate = {
			...update,
			_meta: {
				...priorMeta,
				[PRIME_AGENT_META_NAMESPACE]: {
					...priorPrimeMeta,
					promptTurnId: turnId,
					eventSequence,
					phase,
					...(outcome ? { outcome } : {}),
				},
			},
		};
		// Keep the chain alive after a failed notification, while preserving
		// the order of every later notification and allowing callers to await its drain.
		let published = false;
		this.tail = this.tail.then(async () => {
			try {
				await this.admissionReady;
				if (!this.admissionOpen) return;
				await this.client.notify(acp.methods.client.session.update, {
					sessionId: this.sessionId,
					update: correlatedUpdate,
				});
				published = true;
			} catch {
				// Drop only this update; a rejected queue tail would strand later updates.
			}
		});
		await this.tail;
		return published;
	}

	drain(): Promise<void> {
		return this.tail;
	}

	async close(): Promise<void> {
		this.admissionClosed = true;
		this.releaseAdmission();
		await this.tail;
		this.admissionOpen = false;
	}
}

/**
 * Split ACP prompt blocks into the text and images prime-agent accepts.
 *
 * Image and embedded-resource blocks are advertised in `initialize`, so they must
 * actually reach the model: dropping them silently would let a client believe a
 * pasted screenshot was accepted.
 */
function promptContent(blocks: readonly unknown[]): { text: string; images: ImageContent[] } {
	const texts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const typed = block as {
			type?: string;
			text?: string;
			data?: string;
			mimeType?: string;
			uri?: string;
			resource?: { text?: string; uri?: string };
		};
		if (typed.type === "text" && typeof typed.text === "string") {
			texts.push(typed.text);
		} else if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
			images.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
		} else if (typed.type === "resource" && typeof typed.resource?.text === "string") {
			// Embedded text resources become context the model can read.
			const uri = typed.resource.uri ? `${typed.resource.uri}\n` : "";
			texts.push(`${uri}${typed.resource.text}`);
		} else if (typed.type === "resource_link" && typeof typed.uri === "string") {
			texts.push(typed.uri);
		}
	}
	return { text: texts.join("\n"), images };
}

/**
 * A leading `<system_instructions>` wrapper block (the bridge attaches it to a
 * spawned thread's first prompt) must not merge into the user's prompt text:
 * slash-command execution only fires when the prompt text starts with "/". This
 * separates the leading wrapper from the rest so a leading slash command still
 * routes to the session's command handling.
 */
const ACP_INSTRUCTIONS_PATTERN = /^<system_instructions>[\s\S]*<\/system_instructions>$/;

interface AcpPromptSplit {
	/** Leading instruction-wrapper texts, joined. Empty when absent. */
	instructionsText: string;
	/** Text blocks after the instruction wrapper, in order. */
	restTexts: string[];
	images: ImageContent[];
}

function splitAcpPromptBlocks(blocks: readonly unknown[]): AcpPromptSplit {
	const instructionTexts: string[] = [];
	const restTexts: string[] = [];
	const images: ImageContent[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const typed = block as {
			type?: string;
			text?: string;
			data?: string;
			mimeType?: string;
		};
		if (typed.type === "image" && typeof typed.data === "string" && typeof typed.mimeType === "string") {
			images.push({ type: "image", data: typed.data, mimeType: typed.mimeType });
			continue;
		}
		if (typed.type !== "text" || typeof typed.text !== "string") continue;
		if (restTexts.length === 0 && ACP_INSTRUCTIONS_PATTERN.test(typed.text.trim())) {
			instructionTexts.push(typed.text);
		} else {
			restTexts.push(typed.text);
		}
	}
	return { instructionsText: instructionTexts.join("\n"), restTexts, images };
}

/**
 * Detect a prompt that begins with a registered extension command. The command
 * itself should execute as a command; everything after it — arguments, then the
 * instruction wrapper — becomes the model's turn content. Returns undefined
 * when the prompt does not start with a registered command.
 */
/**
 * Cross-thread tells ("[bb message from thread:X]" attribution line) prefix the
 * sender attribution before the message text, so a steer like "/exit" from
 * another thread reaches the agent with the attribution glued to the command.
 * Strip that leading attribution line so the command detection below still
 * sees the slash command.
 */
const ACP_TELL_ATTRIBUTION_PATTERN = /^\[bb message from thread:[^\]]*\]\s*$/u;

export function headWithoutTellAttribution(head: string): string {
	const lines = head.split("\n");
	while (lines.length > 1 && ACP_TELL_ATTRIBUTION_PATTERN.test(lines[0].trim())) {
		lines.shift();
	}
	return lines.join("\n").trim();
}

async function acpLeadingCommandTurn(
	connection: AgentConnection,
	split: AcpPromptSplit,
): Promise<{ commandInvocation: string; turnText: string; images?: ImageContent[] } | undefined> {
	if (split.restTexts.length === 0) return undefined;
	const head = headWithoutTellAttribution(split.restTexts[0].trim());
	const command = parseSlashCommand(head);
	if (!command) return undefined;
	const registered = await connection
		.getCommands()
		.then((commands) =>
			commands.some(
				(candidate) =>
					candidate.source === "extension" &&
					(candidate.name === command.name || candidate.registeredName === command.name),
			),
		)
		.catch(() => false);
	if (!registered) return undefined;
	const turnParts = [
		...(command.args ? [command.args] : []),
		...split.restTexts.slice(1),
		...(split.instructionsText ? [split.instructionsText] : []),
	];
	const turnText = turnParts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
	return {
		commandInvocation: `/${command.name}`,
		turnText,
		...(turnText.length > 0 && split.images.length > 0 ? { images: split.images } : {}),
	};
}

function autonomousMeta(status: AgentAutonomousStatus | undefined): PrimeAgentAutonomousMeta | undefined {
	if (!status?.enabled) return undefined;
	return {
		enabled: status.enabled,
		continuationsUsed: status.continuationsUsed,
		turnsUsed: status.turnsUsed,
		tokensUsed: status.tokensUsed,
		gateAttempt: latestAutonomousGateAttempt(status) || undefined,
		gateFailure: status.lastGateFailure?.exitText,
	};
}

function outstandingSubagentCount(children: readonly AgentConnectionRlmChildAgentSnapshot[] | undefined): number {
	return (children ?? []).filter((child) => child.status === "queued" || child.status === "running").length;
}

function quiescenceMeta(
	status: AgentAutonomousStatus,
	children: readonly AgentConnectionRlmChildAgentSnapshot[] | undefined,
): { outstandingSubagents: number; remainingAutonomousContinuations: number } {
	return {
		outstandingSubagents: outstandingSubagentCount(children),
		remainingAutonomousContinuations: status.enabled
			? Math.max(0, status.limits.maxContinuations - status.continuationsUsed)
			: 0,
	};
}

/**
 * The transcript as it stood before a turn started, recorded so the turn's own
 * messages can be told apart from everything older.
 *
 * A pre-turn message *count* cannot do that job: auto-compaction can fire during
 * a turn and rebuild `state.messages` (it filters, slices, and re-materializes
 * persisted entries), so this turn's failure can end up at a lower index than
 * the count taken before prompting. Membership is tracked by things a rebuild
 * preserves instead — the message objects themselves, plus a content key for
 * transports that hand back fresh copies (daemon RPC re-parses JSON, so identity
 * does not survive it) and for compaction paths that re-materialize a kept
 * message from its persisted entry with its original timestamp.
 */
interface TurnBoundary {
	identities: WeakSet<object>;
	keys: Set<string>;
}

/** Key for a kept message: compaction drops messages, it does not rewrite them. */
function messageKey(message: unknown): string | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as { role?: unknown; timestamp?: unknown; stopReason?: unknown; errorMessage?: unknown };
	if (typeof record.timestamp !== "number") return undefined;
	return JSON.stringify([
		record.role ?? null,
		record.timestamp,
		record.stopReason ?? null,
		record.errorMessage ?? null,
	]);
}

function turnBoundary(messages: readonly AgentMessage[]): TurnBoundary {
	const identities = new WeakSet<object>();
	const keys = new Set<string>();
	for (const message of messages) {
		if (typeof message !== "object" || message === null) continue;
		identities.add(message);
		const key = messageKey(message);
		if (key) keys.add(key);
	}
	return { identities, keys };
}

function isPreTurn(message: unknown, boundary: TurnBoundary): boolean {
	if (typeof message !== "object" || message === null) return false;
	if (boundary.identities.has(message)) return true;
	const key = messageKey(message);
	return key !== undefined && boundary.keys.has(key);
}

/**
 * Error text from an assistant message this turn produced, when it failed.
 *
 * `promptAndWait` resolves for a failed turn just as it does for a successful
 * one, so the outcome has to be read off the transcript. Only messages that were
 * not in the transcript before the turn are considered: scanning the whole
 * transcript would let an earlier failed turn reject a later turn that never
 * called the model (a handled slash command, say), reporting a stale error.
 *
 * A transcript read that fails is not treated as success — that would restore
 * the silent-success behavior this exists to prevent.
 */
async function turnFailure(connection: AgentConnection, boundary: TurnBoundary): Promise<string | undefined> {
	const messages = await connection.getMessages();
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		// The newest assistant message predates the turn, so the turn appended none.
		if (isPreTurn(message, boundary)) return undefined;
		const assistant = message as { stopReason?: string; errorMessage?: string };
		if (assistant.stopReason !== "error") return undefined;
		return assistant.errorMessage || "the model request failed";
	}
	return undefined;
}

export async function runAcpMode(runtimeHost: AgentSessionRuntime): Promise<never> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runAcpModeWithConnection(connection, {
		bindHeadlessExtensions: () => connection.bindHeadlessExtensions({}),
	});
}

export async function runAcpModeWithConnection(
	connection: AgentConnection,
	options: AcpModeOptions = {},
): Promise<never> {
	// ACP owns stdout: any stray write corrupts the JSON-RPC stream.
	if (options.ownStdout !== false && !options.stream) {
		takeOverStdout();
	}
	const supportsMcpServers =
		connection.supportsAcpMcpServers?.() === true &&
		connection.replaceAcpMcpServers !== undefined &&
		connection.releaseAcpMcpServers !== undefined;
	const acpMcpOwnerId = randomUUID();
	let acpMcpServerNames: string[] = [];
	const clearAcpMcpServers = async (serverNames = acpMcpServerNames): Promise<void> => {
		if (!supportsMcpServers || !connection.releaseAcpMcpServers) return;
		await connection.releaseAcpMcpServers(acpMcpOwnerId, serverNames);
		acpMcpServerNames = [];
	};
	const replaceAcpMcpServers = async (servers: readonly acp.McpServer[], cwd: string): Promise<void> => {
		if (acpMcpServerNames.length > 0) {
			// Retry a prior best-effort close before admitting another session,
			// including one that does not declare replacement MCP servers.
			await clearAcpMcpServers();
		}
		if (servers.length === 0 && acpMcpServerNames.length === 0) return;
		if (!supportsMcpServers || !connection.replaceAcpMcpServers) {
			throw acp.RequestError.invalidParams({ reason: "MCP servers are unavailable in this ACP host" });
		}
		const resolved = resolveAcpMcpServers(servers, cwd);
		const serverNames = resolved.map((server) => server.name);
		try {
			await connection.replaceAcpMcpServers(resolved, acpMcpOwnerId);
		} catch (error) {
			// The daemon may have applied the configuration before its acknowledgement
			// was lost. Always attempt owner-scoped cleanup before rejecting admission.
			await clearAcpMcpServers(serverNames).catch(() => undefined);
			throw error;
		}
		acpMcpServerNames = serverNames;
	};

	// One ACP connection drives one AgentConnection, whose newSession() replaces
	// the live session rather than creating a parallel one. Tracking a single
	// session keeps every event unambiguously attributable; a second session/new
	// is refused rather than silently sharing conversation state, cwd, and queues.
	let session: AcpSessionEntry | undefined;
	let closedInputPause: AgentConnectionSessionInputPause | undefined;
	let closedInputPauseKey: string | undefined;
	let sessionNewInFlight = false;
	let sessionCloseInFlight = false;
	let sessionCloseTask: Promise<void> | undefined;
	let bound = false;

	const baseStream =
		options.stream ?? acp.ndJsonStream(rawStdoutSink(), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
	// ACP's public request handler only returns a response; it has no response
	// commit callback. Observe the outgoing response at the supplied stream
	// boundary instead. The SDK serializes every write, so opening the producer
	// after this write resolves puts buffered notifications strictly behind it.
	let pendingSessionNewResponse:
		| {
				requestId: unknown;
				producer: AcpUpdateProducer;
				entry: AcpSessionEntry;
				inputPause: AgentConnectionSessionInputPause | undefined;
		  }
		| undefined;
	const failPendingSessionNewResponse = (): void => {
		const admission = pendingSessionNewResponse;
		pendingSessionNewResponse = undefined;
		admission?.producer.failSessionNewAdmission();
		admission?.entry.inputPauseRelease?.reject(new Error("ACP session/new response was not delivered"));
	};
	type AcpStreamMessage = typeof baseStream.writable extends WritableStream<infer TMessage> ? TMessage : never;
	const stream: typeof baseStream = {
		readable: baseStream.readable,
		writable: new WritableStream<AcpStreamMessage>({
			async write(message) {
				let writer: WritableStreamDefaultWriter<AcpStreamMessage> | undefined;
				try {
					writer = baseStream.writable.getWriter();
					await writer.write(message);
				} catch (error) {
					failPendingSessionNewResponse();
					throw error;
				} finally {
					writer?.releaseLock();
				}
				if (pendingSessionNewResponse && isJsonRpcResponse(message, pendingSessionNewResponse.requestId)) {
					const admission = pendingSessionNewResponse;
					pendingSessionNewResponse = undefined;
					if (admission.inputPause) {
						try {
							await admission.inputPause.release();
							if (admission.entry.inputPause === admission.inputPause) {
								admission.entry.inputPause = undefined;
								admission.entry.inputPauseKey = undefined;
							}
							if (closedInputPause === admission.inputPause) {
								closedInputPause = undefined;
								closedInputPauseKey = undefined;
							}
							admission.entry.inputPauseRelease?.resolve();
							admission.entry.inputPauseRelease = undefined;
						} catch (error) {
							admission.entry.stopFailure = error instanceof Error ? error.message : String(error);
							admission.entry.inputPauseRelease?.reject(error);
						}
					}
					admission.producer.commitSessionNewResponse();
				}
			},
			async close() {
				let writer: WritableStreamDefaultWriter<AcpStreamMessage> | undefined;
				try {
					writer = baseStream.writable.getWriter();
					await writer.close();
				} catch (error) {
					failPendingSessionNewResponse();
					throw error;
				} finally {
					writer?.releaseLock();
				}
				failPendingSessionNewResponse();
			},
			async abort(reason) {
				let writer: WritableStreamDefaultWriter<AcpStreamMessage> | undefined;
				try {
					writer = baseStream.writable.getWriter();
					await writer.abort(reason);
				} catch (error) {
					failPendingSessionNewResponse();
					throw error;
				} finally {
					writer?.releaseLock();
				}
				failPendingSessionNewResponse();
			},
		}),
	};

	const cancelOutstandingRlmChildren = async (): Promise<void> => {
		const children = await connection.getRlmChildSnapshots();
		const cancellations = await Promise.allSettled(children.map((child) => connection.cancelRlmChild(child.id)));
		const failed = cancellations.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	};
	const abortConnectionWork = async (): Promise<void> => {
		await connection.abortAndClearQueue();
	};
	const acquireStopInputPause = async (entry: AcpSessionEntry): Promise<AgentConnectionSessionInputPause> => {
		if (entry.inputPauseRelease) {
			await entry.inputPauseRelease.promise.catch(() => undefined);
			entry.inputPauseRelease = undefined;
		}
		const leaseKey = entry.inputPauseKey ?? randomUUID();
		entry.inputPauseKey = leaseKey;
		const pause = await connection.acquireSessionInputPause(leaseKey);
		entry.inputPause = pause;
		return pause;
	};

	const stopSessionWork = async (pending?: AcpPendingTerminal, promptTask?: Promise<void>): Promise<void> => {
		await abortConnectionWork();
		await connection.waitForIdle();
		await cancelOutstandingRlmChildren();
		await pending?.task;
		await promptTask;
	};

	const finalizePendingTerminal = (entry: AcpSessionEntry, pending: AcpPendingTerminal): void => {
		pending.task = (async () => {
			while (true) {
				const status = await connection.waitForHeadlessCompletion({ waitForRlmQuiescence: true });
				if (pending.abort.signal.aborted || session !== entry || entry.pendingTerminal !== pending) return;
				const finalFailure = await turnFailure(connection, pending.boundary);
				if (pending.abort.signal.aborted || session !== entry || entry.pendingTerminal !== pending) return;
				const liveChildren = await connection.getRlmChildSnapshots();
				if (pending.abort.signal.aborted || session !== entry || entry.pendingTerminal !== pending) return;
				const terminalQuiescence = quiescenceMeta(status, liveChildren);
				if (terminalQuiescence.outstandingSubagents !== 0) continue;
				pending.status = status;
				pending.turnFailure = finalFailure;

				entry.producer.sealTerminal(pending.promptTurnId);
				const autonomous = autonomousMeta(status);
				const publication = entry.producer.publish(
					{
						sessionUpdate: "session_info_update",
						_meta: primeAgentMeta({ ...(autonomous ? { autonomous } : {}), quiescence: terminalQuiescence }),
					},
					pending.promptTurnId,
					"terminalQuiescence",
					finalFailure ? "error" : pending.outcome,
				);
				// Keep terminal ownership until this settlement task has fully drained.
				// A follow-up prompt awaits that task; clearing ownership at publication
				// admission would let it overlap the first prompt handler.
				if (!(await publication)) return;
				await entry.producer.drain();
				return;
			}
		})()
			.catch((error: unknown) => {
				if (pending.abort.signal.aborted || entry.pendingTerminal !== pending) return;
				pending.failure = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				entry.producer.finishTerminalLifecycle(pending.promptTurnId);
				if (entry.pendingTerminal === pending) entry.pendingTerminal = undefined;
				if (entry.abort === pending.abort) entry.abort = undefined;
			});
	};

	/**
	 * Admit one ACP session: build the entry, subscribe for its lifetime,
	 * reconcile the initial child snapshot, and claim the single-session slot.
	 * Shared by `session/new`, `session/load`, and `session/fork`; the caller
	 * owns the response commit gate (`pendingSessionNewResponse`).
	 */
	const admitAcpSession = async (
		sessionId: string,
		client: { notify(method: unknown, params: unknown): Promise<unknown> },
	): Promise<AcpSessionEntry> => {
		// Install the listener before fetching the snapshot. Child updates can arrive
		// while the snapshot request is in flight; the connection remains the
		// authoritative source used when quiescence is emitted below.
		const producer = new AcpUpdateProducer(sessionId, client);
		let inputPauseRelease: AcpInputPauseRelease | undefined;
		if (closedInputPause) {
			let resolve!: () => void;
			let reject!: (error: unknown) => void;
			const promise = new Promise<void>((resolvePromise, rejectPromise) => {
				resolve = resolvePromise;
				reject = rejectPromise;
			});
			void promise.catch(() => undefined);
			inputPauseRelease = { promise, resolve, reject };
		}
		const mappingState: AcpEventMappingState = {};
		// Seed the context window before the first turn: a completed assistant
		// response cannot be reported as an ACP `usage_update` without it.
		try {
			const initialState = await connection.getState();
			mappingState.contextWindow = initialState.model?.contextWindow;
		} catch {
			// A failed state read only defers usage reporting to the next turn.
		}
		const observedChildren = new Map<string, unknown>();
		const entry: AcpSessionEntry = {
			id: sessionId,
			mappingState,
			abort: undefined,
			cancelling: false,
			cancelTask: undefined,
			stopFailure: undefined,
			inputPause: closedInputPause,
			inputPauseKey: closedInputPauseKey,
			inputPauseRelease,
			pendingTerminal: undefined,
			promptTask: undefined,
			resolvePromptTask: undefined,
			unsubscribe: undefined,
			producer,
		};
		// Subscribe for the session lifetime, not per prompt turn: prime-agent
		// subagents are fire-and-forget and keep reporting after the spawning turn
		// ends, so a turn-scoped subscription would drop their updates. One
		// mapping state per session keeps streaming bash output correlated with
		// the run that produced it.
		const unsubscribe = connection.subscribe((event) => {
			// Heartbeats are connection-scoped, including if one races a prompt.
			// They therefore intentionally use origin turn 0.
			if (event.type === "heartbeats_changed") {
				void producer.publish(
					{ sessionUpdate: "session_info_update", _meta: primeAgentMeta({ heartbeatsChanged: true }) },
					0,
					"event",
				);
				return;
			}
			if (event.type !== "session_event") return;
			if (event.event.type === "rlm_child_update") {
				observedChildren.set(event.event.child.id, event.event.child);
			}
			const turnId = producer.turnForEvent(event.event);
			for (const update of acpUpdatesForSessionEvent(event.event, mappingState)) {
				void producer.publish(update, turnId, "event");
			}
		});
		try {
			// Reconcile after subscribing so updates cannot be lost while the snapshot
			// request is in flight. Do not turn a failed read into an empty roster.
			const initialSnapshot = await connection.getInitialSnapshot();
			for (const child of initialSnapshot.children ?? []) {
				if (observedChildren.has(child.id)) continue;
				observedChildren.set(child.id, child);
				const event = { type: "rlm_child_update", child } as const;
				const turnId = producer.turnForEvent(event);
				for (const update of acpUpdatesForSessionEvent(event, mappingState)) {
					void producer.publish(update, turnId, "event");
				}
			}
		} catch (error) {
			producer.failSessionNewAdmission();
			unsubscribe();
			await clearAcpMcpServers().catch(() => undefined);
			throw error;
		}
		// Claim the single-session slot only once the subscription and snapshot are
		// ready, so a failed setup cannot leave it occupied and unusable.
		entry.unsubscribe = unsubscribe;
		session = entry;
		return entry;
	};

	/**
	 * Publish an ACP session to the cross-process registry so a later
	 * `session/fork` (in the process bb spawns for the forked thread) can resolve
	 * it back to a session file. Best-effort: a failed write only disables
	 * forking from this session.
	 */
	const registerAdmittedAcpSession = async (sessionId: string): Promise<void> => {
		const state = await connection.getState().catch(() => undefined);
		if (!state?.sessionDir) return;
		registerAcpSession(state.sessionDir, sessionId, {
			runtimeSessionId: state.sessionId ?? null,
			sessionFile: state.sessionFile ?? null,
			cwd: state.cwd,
		});
	};

	const handle = acp
		.agent({ name: "prime-agent" })
		.onRequest("initialize", async () => ({
			protocolVersion: acp.PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true },
				...(supportsMcpServers ? { mcpCapabilities: { http: true } } : {}),
				// Advertise close so a client knows it can release the session (and
				// the single-session slot) instead of dropping the connection.
				// Advertise fork so ACP clients (bb side chat, thread forks) can clone
				// an existing session into a new one via session/fork.
				sessionCapabilities: { close: {}, fork: {} },
			},
			agentInfo: { name: "prime-agent", title: "Prime Agent", version: VERSION },
			// Advertise prime-agent extras under a namespaced key: ACP reserves
			// every object root for future protocol fields.
			_meta: primeAgentMeta({}),
		}))
		.onRequest("session/new", async (ctx: any) => {
			// Reserve the single-session slot before the first await. Otherwise two
			// concurrent requests can both pass the empty-slot check while cwd or
			// snapshot reads are in flight, then overwrite each other's session.
			if (session || sessionNewInFlight || sessionCloseInFlight) {
				throw new Error(
					"prime-agent ACP mode hosts one session per connection; " +
						"start another prime-agent process for a second session",
				);
			}
			sessionNewInFlight = true;
			try {
				const params = ctx.params as acp.NewSessionRequest;
				const mcpServers = params.mcpServers ?? [];
				if (mcpServers.length > 0 && !supportsMcpServers) {
					throw acp.RequestError.invalidParams({ reason: "MCP servers are unavailable in this ACP host" });
				}
				if (!bound) {
					// Only latch after a successful bind: a rejected bind must not leave
					// extensions permanently unavailable for the rest of the process.
					await options.bindHeadlessExtensions?.();
					bound = true;
				}
				// prime-agent's cwd is fixed at startup by the session it was launched
				// with, so a client-supplied cwd cannot be adopted after the fact.
				// Report the real cwd back in `_meta` rather than failing the request or
				// letting the client assume a directory the agent is not using.
				const requestedCwd = params.cwd;
				const actualCwd = await connection
					.getState()
					.then((state) => state.cwd)
					.catch(() => undefined);
				if (!actualCwd && mcpServers.some((server) => "command" in server)) {
					throw acp.RequestError.invalidParams({ reason: "Could not resolve the ACP session cwd for stdio MCP" });
				}
				await replaceAcpMcpServers(mcpServers, actualCwd ?? "");
				let cwdMismatch: { requested: string; actual: string } | undefined;
				if (
					typeof requestedCwd === "string" &&
					requestedCwd.length > 0 &&
					actualCwd &&
					!sameCwd(requestedCwd, actualCwd)
				) {
					cwdMismatch = { requested: requestedCwd, actual: actualCwd };
				}
				const sessionId = randomUUID();
				const entry = await admitAcpSession(sessionId, ctx.client);
				await registerAdmittedAcpSession(sessionId);
				const response = {
					sessionId,
					...(cwdMismatch ? { _meta: primeAgentMeta({ cwd: cwdMismatch }) } : {}),
				};
				// The stream wrapper commits this gate after this exact response has
				// written. Buffered subscription updates retain producer order.
				pendingSessionNewResponse = {
					requestId: ctx.requestId,
					producer: entry.producer,
					entry,
					inputPause: closedInputPause,
				};
				return response;
			} finally {
				sessionNewInFlight = false;
			}
		})
		.onRequest("session/load", async (ctx: any) => {
			// Same single-slot reservation as session/new: the loaded session
			// replaces whatever this process booted with.
			if (session || sessionNewInFlight || sessionCloseInFlight) {
				throw new Error(
					"prime-agent ACP mode hosts one session per connection; " +
						"start another prime-agent process for a second session",
				);
			}
			sessionNewInFlight = true;
			try {
				const params = ctx.params as acp.LoadSessionRequest;
				const mcpServers = params.mcpServers ?? [];
				if (mcpServers.length > 0 && !supportsMcpServers) {
					throw acp.RequestError.invalidParams({ reason: "MCP servers are unavailable in this ACP host" });
				}
				if (!bound) {
					// Only latch after a successful bind: a rejected bind must not leave
					// extensions permanently unavailable for the rest of the process.
					await options.bindHeadlessExtensions?.();
					bound = true;
				}
				const processState = await connection.getState();
				if (!processState.sessionDir) {
					throw acp.RequestError.invalidParams({ reason: "Could not resolve the ACP session directory for load" });
				}
				await replaceAcpMcpServers(mcpServers, processState.cwd);
				// Resolve the requested session id through the cross-process registry
				// (the same map `session/fork` reads back).
				const source = await resolveAcpSessionFile(processState.sessionDir, params.sessionId);
				if (!source) throw new Error(`Unknown ACP session: ${params.sessionId}`);
				// The ACP spec pairs the session id with the request cwd. A stored
				// session from another workspace must not be restored into this one;
				// fail so the client falls back to a fresh session.
				if (typeof params.cwd === "string" && params.cwd.length > 0 && !sameCwd(source.entry.cwd, params.cwd)) {
					throw acp.RequestError.invalidParams({
						reason: `ACP session ${params.sessionId} belongs to another working directory`,
					});
				}
				if (source.sessionFile) {
					// Resume keeps the requested ACP session id, so admit the session
					// under it after the runtime has switched onto the file.
					const switched = await connection.switchSession(source.sessionFile);
					if (switched.cancelled) {
						throw new Error("ACP load was cancelled by a session hook");
					}
				}
				// No persisted file means the source session never wrote history
				// (no messages yet): loading it is a no-op on the fresh boot session.
				const entry = await admitAcpSession(params.sessionId, ctx.client);
				await registerAdmittedAcpSession(params.sessionId);
				// The stream wrapper commits this gate after this exact response has
				// written. Buffered subscription updates retain producer order.
				pendingSessionNewResponse = {
					requestId: ctx.requestId,
					producer: entry.producer,
					entry,
					inputPause: closedInputPause,
				};
				return {};
			} finally {
				sessionNewInFlight = false;
			}
		})
		.onRequest("session/fork", async (ctx: any) => {
			// Same single-slot reservation as session/new: the forked session replaces
			// whatever this process booted with, and a concurrent admission must not
			// race the replacement.
			if (session || sessionNewInFlight || sessionCloseInFlight) {
				throw new Error(
					"prime-agent ACP mode hosts one session per connection; " +
						"start another prime-agent process for a second session",
				);
			}
			sessionNewInFlight = true;
			try {
				const params = ctx.params as acp.ForkSessionRequest;
				const mcpServers = params.mcpServers ?? [];
				if (mcpServers.length > 0 && !supportsMcpServers) {
					throw acp.RequestError.invalidParams({ reason: "MCP servers are unavailable in this ACP host" });
				}
				if (!bound) {
					// Only latch after a successful bind: a rejected bind must not leave
					// extensions permanently unavailable for the rest of the process.
					await options.bindHeadlessExtensions?.();
					bound = true;
				}
				const processState = await connection.getState();
				if (!processState.sessionDir) {
					throw acp.RequestError.invalidParams({ reason: "Could not resolve the ACP session directory for fork" });
				}
				await replaceAcpMcpServers(mcpServers, processState.cwd);
				// bb forks by spawning a fresh process and passing the source session's
				// id; resolve it to a session file through the cross-process registry.
				const source = await resolveAcpSessionFile(processState.sessionDir, params.sessionId);
				if (!source) throw new Error(`Unknown ACP session: ${params.sessionId}`);
				let branchedManager: SessionManager;
				if (source.sessionFile) {
					const sourceManager = SessionManager.open(source.sessionFile);
					const leafId = sourceManager.getLeafId();
					if (leafId) {
						// Tip fork: copy the source history path into a new session file.
						sourceManager.createBranchedSession(leafId);
						branchedManager = sourceManager;
					} else {
						// Empty source session: inherit the parent link without history.
						branchedManager = SessionManager.create(sourceManager.getCwd(), sourceManager.getSessionDir());
						branchedManager.newSession({ parentSession: source.sessionFile });
					}
				} else {
					// The source session never persisted (no messages yet): fork is a
					// fresh session in the same directory.
					branchedManager = SessionManager.create(processState.cwd, processState.sessionDir);
					branchedManager.newSession({ parentSession: source.entry.sessionFile ?? undefined });
				}
				// createBranchedSession defers writing when the copy has no assistant
				// message; switchSession needs the file on disk, so flush it now.
				branchedManager.flushNow();
				const branchedSessionFile = branchedManager.getSessionFile();
				if (!branchedSessionFile) {
					throw new Error("Failed to create forked session file");
				}
				// Replace this process's boot session with the branched copy. The source
				// file itself is never reopened, so the original session stays intact.
				const switched = await connection.switchSession(branchedSessionFile);
				if (switched.cancelled) {
					throw new Error("ACP fork was cancelled by a session hook");
				}
				const sessionId = randomUUID();
				const entry = await admitAcpSession(sessionId, ctx.client);
				// Point the registry at the branched copy so forking the fork works.
				const forkedState = await connection.getState().catch(() => undefined);
				if (forkedState?.sessionDir) {
					registerAcpSession(forkedState.sessionDir, sessionId, {
						runtimeSessionId: branchedManager.getSessionId(),
						sessionFile: branchedSessionFile,
						cwd: branchedManager.getCwd(),
					});
				}
				const response = { sessionId };
				// The stream wrapper commits this gate after this exact response has
				// written. Buffered subscription updates retain producer order.
				pendingSessionNewResponse = {
					requestId: ctx.requestId,
					producer: entry.producer,
					entry,
					inputPause: closedInputPause,
				};
				return response;
			} finally {
				sessionNewInFlight = false;
			}
		})
		.onRequest("session/prompt", async (ctx: any) => {
			const params = ctx.params as { sessionId: string; prompt: readonly unknown[] };
			const entry = session?.id === params.sessionId ? session : undefined;
			if (!entry) throw new Error(`Unknown ACP session: ${params.sessionId}`);
			if (sessionCloseInFlight) throw new Error(`ACP session is closing: ${params.sessionId}`);
			if (entry.cancelling) throw new Error(`ACP session is cancelling: ${params.sessionId}`);
			await entry.inputPauseRelease?.promise;
			// A prompt response precedes its correlated terminal update. Serialize the
			// next turn behind that lifecycle so it cannot overwrite terminal ownership.
			await entry.pendingTerminal?.task;
			if (session !== entry) throw new Error(`Unknown ACP session: ${params.sessionId}`);
			if (sessionCloseInFlight) throw new Error(`ACP session is closing: ${params.sessionId}`);
			// This prompt was admitted before the cancellation started; it is dropped
			// by the cancel rather than malformed, so report the protocol stop reason
			// instead of a request error.
			if (entry.cancelling) return { stopReason: "cancelled" satisfies AcpStopReason };
			if (entry.stopFailure) throw new Error(`ACP session stop failed: ${entry.stopFailure}`);
			if (entry.pendingTerminal?.failure) {
				throw new Error(`ACP lifecycle reconciliation failed: ${entry.pendingTerminal.failure}`);
			}
			if (entry.abort) throw new Error("A prompt turn is already running for this ACP session");

			const abort = new AbortController();
			entry.abort = abort;
			let resolvePromptTask!: () => void;
			const promptTask = new Promise<void>((resolve) => {
				resolvePromptTask = resolve;
			});
			entry.promptTask = promptTask;
			entry.resolvePromptTask = resolvePromptTask;
			// Allocate the causal turn before the first await, not when an update is
			// delivered. This prevents late producer events becoming the next turn.
			const promptTurnId = entry.producer.beginPrompt();
			// Refresh per turn: the model (and therefore the context window) can
			// change between turns, and completed responses report usage against it.
			try {
				const turnState = await connection.getState();
				const turnContextWindow = turnState.model?.contextWindow;
				if (turnContextWindow) entry.mappingState.contextWindow = turnContextWindow;
			} catch {
				// Keep the previously seeded window when a state read fails.
			}
			let responseBoundaryEmitted = false;
			let terminalSettlementCancelled = false;
			try {
				const { text, images } = promptContent(params.prompt);
				const priorMessages = turnBoundary(await connection.getMessages());
				if (abort.signal.aborted) {
					await entry.producer.drain();
					return { stopReason: "cancelled" satisfies AcpStopReason };
				}
				// A follow-up prompt can arrive while injected work (subagent replies,
				// heartbeats) keeps the resident session busy. ACP has no native queue
				// field, so queue the host turn behind that work with follow-up
				// semantics instead of rejecting it as "Agent is already processing".
				const promptOptions = {
					...(images.length > 0 ? { images } : {}),
					streamingBehavior: "followUp" as const,
					queueIfBusy: true,
					signal: abort.signal,
				};
				// A prompt that begins with a registered extension command (with
				// optional arguments) executes as a command first, then the remaining
				// text — arguments and the instruction wrapper — reaches the model as
				// the turn content. Without the split, the wrapper prefix stops
				// parseSlashCommand from ever seeing the command.
				const leadingCommand = await acpLeadingCommandTurn(connection, splitAcpPromptBlocks(params.prompt));
				if (leadingCommand) {
					await connection.promptAndWait(leadingCommand.commandInvocation, {
						streamingBehavior: "followUp",
						queueIfBusy: true,
						signal: abort.signal,
					});
					if (abort.signal.aborted) {
						await entry.producer.drain();
						return { stopReason: "cancelled" satisfies AcpStopReason };
					}
					if (leadingCommand.turnText.length > 0) {
						await connection.promptAndWait(leadingCommand.turnText, {
							...(leadingCommand.images ? { images: leadingCommand.images } : {}),
							streamingBehavior: "followUp" as const,
							queueIfBusy: true,
							signal: abort.signal,
						});
						if (abort.signal.aborted) {
							await entry.producer.drain();
							return { stopReason: "cancelled" satisfies AcpStopReason };
						}
					}
				} else {
					await connection.promptAndWait(text, promptOptions);
				}
				if (abort.signal.aborted) {
					await entry.producer.drain();
					return { stopReason: "cancelled" satisfies AcpStopReason };
				}
				const status = await connection.waitForHeadlessCompletion();
				if (abort.signal.aborted) {
					await entry.producer.drain();
					return { stopReason: "cancelled" satisfies AcpStopReason };
				}
				const failure = await turnFailure(connection, priorMessages);
				if (abort.signal.aborted) {
					await entry.producer.drain();
					return { stopReason: "cancelled" satisfies AcpStopReason };
				}
				const autonomous = autonomousMeta(status);
				const liveChildren = await connection.getRlmChildSnapshots();
				if (abort.signal.aborted) {
					await entry.producer.drain();
					return { stopReason: "cancelled" satisfies AcpStopReason };
				}
				const outcome = failure ? "error" : "result";
				let terminalStatus = status;
				const observedQuiescence = quiescenceMeta(status, liveChildren);
				// The roster is telemetry at the response cut, not proof of terminality:
				// a child can publish a terminal status before its result reaches the parent.
				// Every turn therefore finalizes through the strong settlement barrier.
				entry.producer.commitResponse(promptTurnId);
				responseBoundaryEmitted = await entry.producer.publish(
					{
						sessionUpdate: "session_info_update",
						_meta: primeAgentMeta({ terminalQuiescenceExpected: true }),
					},
					promptTurnId,
					"responseBoundary",
					outcome,
				);
				if (!responseBoundaryEmitted) throw new Error("Failed to publish ACP response boundary");
				// Fold the current plan-code mode into the completion update so a
				// fresh or resumed session reports the active mode without waiting
				// for the next mode change. Read fresh: the mode may have changed
				// during the turn (extension appends mid-turn).
				let planCodeState: AgentConnectionState["planCode"];
				try {
					planCodeState = (await connection.getState()).planCode;
				} catch {
					// Mode display is best-effort; a failed state read just skips it.
				}
				const completionUpdateEmitted = await entry.producer.publish(
					{
						sessionUpdate: "session_info_update",
						_meta: primeAgentMeta({
							...(autonomous ? { autonomous } : {}),
							quiescence: observedQuiescence,
							...(planCodeState ? { planCode: planCodeState } : {}),
						}),
					},
					promptTurnId,
					"event",
				);
				if (!completionUpdateEmitted) throw new Error("Failed to publish ACP completion update");
				await entry.producer.drain();
				if (!abort.signal.aborted) {
					entry.producer.beginTerminalLifecycle(promptTurnId);
					const pending: AcpPendingTerminal = { promptTurnId, boundary: priorMessages, outcome, abort };
					entry.pendingTerminal = pending;
					finalizePendingTerminal(entry, pending);
					await pending.task;
					terminalSettlementCancelled = abort.signal.aborted;
					if (pending.failure) {
						throw new Error(`ACP lifecycle reconciliation failed: ${pending.failure}`);
					}
					if (pending.turnFailure) {
						throw new Error(`prime-agent turn failed: ${pending.turnFailure}`);
					}
					terminalStatus = pending.status ?? status;
				}
				if (failure) throw new Error(`prime-agent turn failed: ${failure}`);
				return {
					stopReason: acpStopReason({
						cancelled: terminalSettlementCancelled,
						autonomous: terminalStatus,
					}),
				};
			} catch (error) {
				if (abort.signal.aborted && !entry.producer.isResponseCommitted(promptTurnId)) {
					await entry.producer.drain();
					return { stopReason: "cancelled" satisfies AcpStopReason };
				}
				// Failed prompt/snapshot admission gets one correlated error boundary;
				// it never gets an invented terminal-quiescence update.
				if (!responseBoundaryEmitted) {
					await entry.producer.publish(
						{
							sessionUpdate: "session_info_update",
							_meta: primeAgentMeta({ terminalQuiescenceExpected: false }),
						},
						promptTurnId,
						"responseBoundary",
						"error",
					);
				}
				await entry.producer.drain();
				throw error;
			} finally {
				entry.producer.finishPrompt(promptTurnId);
				if (entry.promptTask === promptTask) {
					entry.promptTask = undefined;
					entry.resolvePromptTask = undefined;
					resolvePromptTask();
				}
				if (entry.abort === abort && entry.pendingTerminal?.abort !== abort) entry.abort = undefined;
			}
		})
		.onRequest("session/close", async (ctx: any) => {
			const params = ctx.params as { sessionId: string };
			if (session?.id !== params.sessionId) {
				throw new Error(`Unknown ACP session: ${params.sessionId}`);
			}
			// Stop real work, not just local bookkeeping: aborting only the local
			// controller leaves the agent running with nobody listening, so closing
			// must abort the connection the same way session/cancel does.
			if (sessionCloseInFlight) throw new Error(`ACP session is already closing: ${params.sessionId}`);
			sessionCloseInFlight = true;
			let finishClose!: () => void;
			sessionCloseTask = new Promise<void>((resolve) => {
				finishClose = resolve;
			});
			const closing = session;
			try {
				await closing.cancelTask?.catch(() => undefined);
				closing.cancelling = true;
				closing.abort?.abort();
				const pending = closing.pendingTerminal;
				const promptTask = closing.promptTask;
				try {
					const inputPause = await acquireStopInputPause(closing);
					const inputPauseKey = closing.inputPauseKey;
					if (!inputPauseKey) throw new Error("Missing ACP close input-pause key");
					await stopSessionWork(pending, promptTask);
					closing.unsubscribe?.();
					// Keep the backing session fenced until a replacement ACP session is admitted.
					await closing.producer.close();
					// Host credentials are already gone before kernel release runs. Do not
					// retain the ACP session slot if best-effort transport reaping fails.
					await clearAcpMcpServers().catch(() => undefined);
					closedInputPause = inputPause;
					closedInputPauseKey = inputPauseKey;
					if (closing.inputPause === inputPause) {
						closing.inputPause = undefined;
						closing.inputPauseKey = undefined;
					}
					closing.stopFailure = undefined;
				} catch (error) {
					closing.stopFailure = error instanceof Error ? error.message : String(error);
					throw error;
				}
				if (session === closing) session = undefined;
				return {};
			} finally {
				if (session === closing) closing.cancelling = false;
				finishClose();
				sessionCloseTask = undefined;
				sessionCloseInFlight = false;
			}
		})
		.onNotification("session/cancel", async (ctx: any) => {
			const params = ctx.params as { sessionId: string };
			while (sessionCloseInFlight) await sessionCloseTask;
			// Only cancel the addressed session: aborting unconditionally would kill
			// whichever turn happens to be running, and leave the real turn's
			// AbortController unmarked so it reports a wrong stop reason.
			if (session?.id !== params.sessionId) return;
			const cancelling = session;
			if (cancelling.cancelling) {
				await cancelling.cancelTask;
				return;
			}
			const abort = cancelling.abort;
			if (!abort && !cancelling.stopFailure && !cancelling.inputPauseRelease) return;
			const pending = abort && cancelling.pendingTerminal?.abort === abort ? cancelling.pendingTerminal : undefined;
			const promptTask = cancelling.promptTask;
			cancelling.cancelling = true;
			const cancelTask = (async () => {
				abort?.abort();
				try {
					const inputPause = await acquireStopInputPause(cancelling);
					await stopSessionWork(pending, promptTask);
					await inputPause.release();
					if (cancelling.inputPause === inputPause) {
						cancelling.inputPause = undefined;
						cancelling.inputPauseKey = undefined;
					}
					if (closedInputPause === inputPause) {
						closedInputPause = undefined;
						closedInputPauseKey = undefined;
					}
					cancelling.inputPauseRelease = undefined;
					cancelling.stopFailure = undefined;
					if (pending && cancelling.pendingTerminal === pending) cancelling.pendingTerminal = undefined;
					if (abort && cancelling.abort === abort) cancelling.abort = undefined;
				} catch (error) {
					cancelling.stopFailure = error instanceof Error ? error.message : String(error);
					throw error;
				}
			})();
			cancelling.cancelTask = cancelTask;
			try {
				await cancelTask;
			} finally {
				if (cancelling.cancelTask === cancelTask) cancelling.cancelTask = undefined;
				cancelling.cancelling = false;
			}
		})
		.connect(stream);

	// Exit when the client disconnects (stdin EOF or a closed transport). Blocking
	// forever would leave an orphaned agent per run, which matters most for a
	// harness that spawns many short-lived sessions.
	await handle.closed.catch(() => undefined);
	session?.abort?.abort();
	session?.unsubscribe?.();
	await session?.inputPause?.release().catch(() => undefined);
	session = undefined;
	await closedInputPause?.release().catch(() => undefined);
	closedInputPause = undefined;
	closedInputPauseKey = undefined;
	await clearAcpMcpServers().catch(() => undefined);
	await connection.dispose().catch(() => undefined);
	// Only the real stdio entrypoint owns the process; a caller-supplied transport
	// (tests, embedding) must never have its host exited from under it.
	if (options.stream) return undefined as never;
	return process.exit(0) as never;
}

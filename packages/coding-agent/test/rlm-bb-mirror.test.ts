import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BbSpawnFailed,
	bbMirrorEnvFromProcess,
	buildRlmMirrorPrompt,
	consumeRlmMirrorClaim,
	isInsideBbThreadSession,
	mirrorThreadTitle,
	newMirrorClaimNonce,
	readRlmMirrorClaim,
	removeRlmMirrorClaimFile,
	resolveChildActiveSessionId,
	shouldAutoMirrorRlmChild,
	spawnBbMirrorThread,
	writeRlmMirrorClaimFile,
} from "../src/core/rlm-bb-mirror.js";
import type { RlmListSubagentsResult } from "../src/core/rlm-runtime.js";

let directory: string | undefined;
let recordDir: string | undefined;

const FAKE_BB = `#!/bin/sh
printf '%s\\n' "$@" > "$BB_RECORD_DIR/args"
cat > "$BB_RECORD_DIR/stdin"
printf '%s' "$BB_FAKE_OUTPUT"
exit "\${BB_FAKE_EXIT:-0}"
`;

function rosterEntry(
	overrides: { rlm_child_id?: string; active_session_id?: string | null } = {},
): RlmListSubagentsResult {
	return {
		subagents: [
			{
				rlm_child_id: "sub-1",
				active_session_id: null,
				session_id: "session-1",
				session_name: "worker",
				session_dir: "/tmp/worker",
				status: "running",
				...overrides,
			},
		],
	};
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "prime-bb-mirror-test-"));
	recordDir = join(directory, "record");
	mkdirSync(recordDir, { recursive: true });
	vi.stubEnv("PRIME_AGENT_CODING_AGENT_DIR", directory);
});

afterEach(() => {
	vi.unstubAllEnvs();
	if (directory) rmSync(directory, { recursive: true, force: true });
	directory = undefined;
	recordDir = undefined;
});

describe("bb mirror auto-spawn decision", () => {
	it("mirrors only depth-0 sessions inside bb", () => {
		expect(shouldAutoMirrorRlmChild(0, { BB_THREAD_ID: "thr_1", BB_PROJECT_ID: "proj_1" })).toBe(true);
		expect(shouldAutoMirrorRlmChild(1, { BB_THREAD_ID: "thr_1", BB_PROJECT_ID: "proj_1" })).toBe(false);
		expect(shouldAutoMirrorRlmChild(0, {})).toBe(false);
		expect(shouldAutoMirrorRlmChild(0, { BB_THREAD_ID: "thr_1" })).toBe(false);
	});

	it("honors the PRIME_AGENT_AUTO_MIRROR kill switch", () => {
		const env = { BB_THREAD_ID: "thr_1", BB_PROJECT_ID: "proj_1" };
		for (const value of ["0", "false", "off"]) {
			expect(shouldAutoMirrorRlmChild(0, { ...env, PRIME_AGENT_AUTO_MIRROR: value })).toBe(false);
		}
		expect(shouldAutoMirrorRlmChild(0, { ...env, PRIME_AGENT_AUTO_MIRROR: "1" })).toBe(true);
	});

	it("detects bb thread sessions and extracts the mirror env", () => {
		expect(isInsideBbThreadSession({ BB_THREAD_ID: "thr_1", BB_PROJECT_ID: "proj_1" })).toBe(true);
		expect(isInsideBbThreadSession({ BB_THREAD_ID: "thr_1" })).toBe(false);
		expect(
			bbMirrorEnvFromProcess({
				BB_THREAD_ID: "thr_1",
				BB_PROJECT_ID: "proj_1",
				BB_ENVIRONMENT_ID: "env_1",
				BB_CLI: "/opt/bb",
			}),
		).toEqual({
			threadId: "thr_1",
			projectId: "proj_1",
			environmentId: "env_1",
			bbCli: "/opt/bb",
		});
		expect(bbMirrorEnvFromProcess({ BB_THREAD_ID: "thr_1", BB_PROJECT_ID: "proj_1" })).toEqual({
			threadId: "thr_1",
			projectId: "proj_1",
		});
	});
});

describe("mirror claim files", () => {
	it("writes, reads, consumes, and expires single-use claims under the agent dir", () => {
		const nonce = newMirrorClaimNonce();
		expect(nonce).toMatch(/^[a-f0-9]{32}$/);
		writeRlmMirrorClaimFile(nonce, "child-active-1");
		const path = join(directory!, "acp-mirror-claims", `${nonce}.json`);
		expect(readRlmMirrorClaim(nonce)).toEqual({ target: "child-active-1", createdAtMs: expect.any(Number) });
		expect(readRlmMirrorClaim("b".repeat(32))).toBeUndefined();
		// Stale claims do not rebind; the parent re-spawns instead.
		writeFileSync(path, JSON.stringify({ target: "child-active-1", createdAtMs: Date.now() - 11 * 60_000 }));
		expect(readRlmMirrorClaim(nonce)).toBeUndefined();
		writeRlmMirrorClaimFile(nonce, "child-active-1");
		consumeRlmMirrorClaim(nonce);
		expect(existsSync(path)).toBe(false);
		// Consuming/removing an absent claim stays silent.
		expect(() => consumeRlmMirrorClaim(nonce)).not.toThrow();
		expect(() => removeRlmMirrorClaimFile(nonce)).not.toThrow();
	});
});

describe("mirror prompt builder", () => {
	it("produces the consumer-matched marker line plus the task body", () => {
		const nonce = newMirrorClaimNonce();
		const prompt = buildRlmMirrorPrompt(nonce, "do it");
		expect(prompt).toBe(`[rlm-mirror:${nonce}]\n[task from parent]\n\ndo it`);
	});
});

describe("mirror thread titles", () => {
	it("summarizes the task onto one line", () => {
		expect(mirrorThreadTitle("worker", "line one\nline  two")).toBe("worker · line one line two");
		const long = "x".repeat(80);
		const title = mirrorThreadTitle("worker", long);
		expect(title.startsWith("worker · ")).toBe(true);
		expect(title.length).toBe("worker · ".length + 60);
	});
});

describe("resolveChildActiveSessionId", () => {
	it("waits for the roster to list the child's active session", async () => {
		const list = vi
			.fn()
			.mockRejectedValueOnce(new Error("roster unavailable"))
			.mockResolvedValue(rosterEntry({ active_session_id: "active-1" }));
		await expect(resolveChildActiveSessionId(() => list(), "sub-1", "worker", 5_000)).resolves.toBe("active-1");
	});

	it("prefers the exact child id over a same-named passive row", async () => {
		const result: RlmListSubagentsResult = {
			subagents: [
				{
					rlm_child_id: "sub-other",
					active_session_id: "active-shadow",
					session_id: "session-shadow",
					session_name: "worker",
					session_dir: "/tmp/other",
					status: "completed",
				},
				{
					rlm_child_id: "sub-1",
					active_session_id: "active-1",
					session_id: "session-1",
					session_name: "worker",
					session_dir: "/tmp/worker",
					status: "running",
				},
			],
		};
		await expect(resolveChildActiveSessionId(() => Promise.resolve(result), "sub-1", "worker", 5_000)).resolves.toBe(
			"active-1",
		);
	});

	it("does not bind by name to a stale completed same-named row (PRIME-26 review)", async () => {
		// A same-named respawn is legal while the old child's delete-unwind row
		// still lists a live-looking active_session_id; the claim must keep
		// polling for the new child instead of binding to the dying session.
		const result: RlmListSubagentsResult = {
			subagents: [
				{
					rlm_child_id: "sub-old",
					active_session_id: "active-stale",
					session_id: "session-stale",
					session_name: "worker",
					session_dir: "/tmp/stale",
					status: "completed",
				},
			],
		};
		await expect(
			resolveChildActiveSessionId(() => Promise.resolve(result), "sub-new", "worker", 250),
		).rejects.toThrow(/no active session yet/);
	});
});

describe("spawnBbMirrorThread", () => {
	function installFakeBb(output: string, exit = 0): string {
		const script = join(recordDir!, "fake-bb.sh");
		writeFileSync(script, FAKE_BB);
		chmodSync(script, 0o755);
		vi.stubEnv("BB_FAKE_OUTPUT", output);
		vi.stubEnv("BB_FAKE_EXIT", String(exit));
		vi.stubEnv("BB_RECORD_DIR", recordDir!);
		return script;
	}

	it("spawns the mirror thread through the bb CLI and returns the thread id", async () => {
		const bbScript = installFakeBb('{"id":"thr_abc123"}');
		const outcome = await spawnBbMirrorThread({
			projectId: "proj_1",
			environmentId: "env_1",
			title: "worker · task",
			prompt: "[rlm-mirror:abcd]\n[task from parent]\n\ndo it",
			bbCommand: bbScript,
			timeoutMs: 5_000,
		});
		expect(outcome).toEqual({ threadId: "thr_abc123", threadCreated: true });
		const args = readFileSync(join(recordDir!, "args"), "utf8").split("\n");
		expect(args).toContain("--parent-self");
		expect(args).toContain("--provider");
		expect(args[args.indexOf("--provider") + 1]).toBe("acp-prime-agent");
		expect(args).toContain("--project");
		expect(args[args.indexOf("--project") + 1]).toBe("proj_1");
		expect(args).toContain("--environment");
		expect(args[args.indexOf("--environment") + 1]).toBe("env_1");
		const stdin = readFileSync(join(recordDir!, "stdin"), "utf8");
		expect(stdin).toBe("[rlm-mirror:abcd]\n[task from parent]\n\ndo it");
	});

	it("reports a created thread without an id when bb prints nothing parsable", async () => {
		const bbScript = installFakeBb("not json");
		const outcome = await spawnBbMirrorThread({
			projectId: "proj_1",
			title: "worker · task",
			prompt: "prompt",
			bbCommand: bbScript,
			timeoutMs: 5_000,
		});
		expect(outcome).toEqual({ threadCreated: true });
	});

	it("throws BbSpawnFailed when the bb CLI fails without creating a thread", async () => {
		installFakeBb("boom", 3);
		await expect(
			spawnBbMirrorThread({
				projectId: "proj_1",
				title: "worker · task",
				prompt: "prompt",
				bbCommand: installFakeBb("boom", 3),
				timeoutMs: 5_000,
			}),
		).rejects.toBeInstanceOf(BbSpawnFailed);
	});
});

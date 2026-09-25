import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as armNoopExpiryTimer } from "node:timers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { success } from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor, prewarmPoolKey } from "../src/modes/daemon/daemon-supervisor.js";

/**
 * Prewarm-pool fixtures carry the entry's expiry handle; production arms a real
 * TTL timer, but these tests never hold a pooled worker that long. A no-op
 * armed timer satisfies the entry type without scheduling anything.
 */
function makeExpiryTimer(): ReturnType<typeof setTimeout> {
	return armNoopExpiryTimer(() => {}, 60_000).unref();
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

interface PoolInternals {
	// deno-lint-ignore no-explicit-any
	prewarmPool: Map<string, any>;
	handleCommand(client: object, command: object): Promise<unknown>;
	tryConsumePrewarmPool(command: object): Promise<{ worker: unknown; summary: SessionSummary } | undefined>;
	handlePrewarmCommand(command: object): void;
	removePrewarmPoolEntry(key: string): void;
	launchWorker: ReturnType<typeof vi.fn>;
	forwardToWorker: ReturnType<typeof vi.fn>;
	stopWorker: ReturnType<typeof vi.fn>;
	writeRosterEntry: ReturnType<typeof vi.fn>;
	refreshWorkerSummaries: ReturnType<typeof vi.fn>;
	createOrReuseWorker: ReturnType<typeof vi.fn>;
	publicSummary(worker: object, summary: SessionSummary): SessionSummary;
	log: ReturnType<typeof vi.fn>;
	defaultSessionConfig: { agentDir?: string; cwd?: string };
	descriptorDir: string;
}

function makeSupervisor(): PoolInternals {
	const directory = mkdtempSync(join(tmpdir(), "prime-prewarm-pool-"));
	tempDirs.push(directory);
	mkdirSync(join(directory, "workers"), { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify({}));
	const supervisor = new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as PoolInternals;
	supervisor.log = vi.fn();
	return supervisor;
}

function makeWorkerFixture(id: string, sessionFile: string) {
	return {
		descriptor: {
			workerId: id,
			lifecycle: "ready" as const,
			rootActiveSessionId: `${id}-root`,
			sessionFile,
			pid: 1,
			createCommand: { type: "create" as const },
		},
		summaries: new Map(),
		intentionalStop: false,
	};
}

function makeSummary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `${id}-session`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		lastActivityAt: new Date().toISOString(),
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

describe("worker prewarm pool", () => {
	it("keys pool entries by cwd and the full launch env minus per-pane shell noise", () => {
		const base = { cwd: "/tmp/project", launchEnv: { PATH: "/usr/bin", PRIME_API_KEY: "k1" } };
		expect(prewarmPoolKey(base)).toBe(prewarmPoolKey({ ...base }));
		expect(prewarmPoolKey(base)).not.toBe(prewarmPoolKey({ ...base, cwd: "/other" }));
		expect(prewarmPoolKey(base)).not.toBe(
			prewarmPoolKey({ ...base, launchEnv: { PATH: "/usr/bin", PRIME_API_KEY: "k2" } }),
		);
		// Shell/tmux per-pane noise must not fragment the pool.
		const noisyA = {
			...base,
			launchEnv: { ...base.launchEnv, TMUX: "/tmp/tmux-1/default,1,0", SHLVL: "2", ITERM_SESSION_ID: "w0t0p0:a" },
		};
		const noisyB = {
			...base,
			launchEnv: {
				...base.launchEnv,
				TMUX: "/tmp/tmux-1/default,1,95",
				SHLVL: "3",
				ITERM_SESSION_ID: "w0t1p7:b",
				COLORFGBG: "0;15",
			},
		};
		expect(prewarmPoolKey(noisyA)).toBe(prewarmPoolKey(noisyB));
		// Key digest is stable across insertion order of the same env.
		const reordered = { cwd: base.cwd, launchEnv: { PRIME_API_KEY: "k1", PATH: "/usr/bin" } };
		expect(prewarmPoolKey(base)).toBe(prewarmPoolKey(reordered));
		// Non-noise env differences fork the key: worker process.env comes from
		// the pooled spawn env and is never rebound at consume, so any var the
		// worker reads must participate in the key (e.g. provider routing).
		expect(prewarmPoolKey(base)).not.toBe(
			prewarmPoolKey({ ...base, launchEnv: { PATH: "/different", PRIME_API_KEY: "k1" } }),
		);
		expect(prewarmPoolKey(base)).not.toBe(
			prewarmPoolKey({ ...base, launchEnv: { PATH: "/usr/bin", PRIME_API_KEY: "k1", CLOUDFLARE_ACCOUNT_ID: "42" } }),
		);
	});

	it("does not consume pooled workers for non-fresh creates", async () => {
		const supervisor = makeSupervisor();
		const entry = {
			key: prewarmPoolKey({ cwd: "/tmp/project" }),
			ready: Promise.resolve(makeWorkerFixture("w1", "/tmp/sessions/s1.jsonl")),
			expiryTimer: makeExpiryTimer(),
		};
		supervisor.prewarmPool.set(entry.key, {
			...entry,
			createCommand: { type: "create", config: { cwd: "/tmp/project" } },
		});
		for (const command of [
			{ type: "create", sessionPath: "/tmp/sessions/s1.jsonl" },
			{ type: "create", continueRecent: true },
			{ type: "create", noSession: true },
			{ type: "create", name: "named" },
			{ type: "create", lifecycle: "client_owned" },
		]) {
			expect(
				await supervisor.tryConsumePrewarmPool({
					...command,
					config: { cwd: "/tmp/project" },
				}),
			).toBeUndefined();
		}
		expect(supervisor.prewarmPool.size).toBe(1);
		clearTimeout(entry.expiryTimer);
	});

	it("consumes a pooled worker for a fresh create and forwards to the draft root", async () => {
		const supervisor = makeSupervisor();
		const summary = makeSummary("s1");
		const worker = makeWorkerFixture("w1", "/tmp/sessions/s1.jsonl");
		const key = prewarmPoolKey({ cwd: "/tmp/project" });
		supervisor.prewarmPool.set(key, {
			key,
			ready: Promise.resolve(worker),
			expiryTimer: makeExpiryTimer(),
			createCommand: { type: "create", config: { cwd: "/tmp/project" } },
		});
		supervisor.forwardToWorker = vi.fn(async () => success(undefined, "create", summary));
		supervisor.writeRosterEntry = vi.fn();
		supervisor.refreshWorkerSummaries = vi.fn(async () => undefined);

		const consumed = await supervisor.tryConsumePrewarmPool({
			type: "create",
			config: { cwd: "/tmp/project" },
		});
		expect(consumed?.summary).toBe(summary);
		expect(consumed?.worker).toBe(worker);
		expect(supervisor.forwardToWorker).toHaveBeenCalledWith(worker, {
			type: "create",
			config: { cwd: "/tmp/project" },
			sessionPath: "/tmp/sessions/s1.jsonl",
		});
		expect(supervisor.prewarmPool.size).toBe(0);
	});

	it("stops the pooled worker and drops the entry when the draft has no session file", async () => {
		const supervisor = makeSupervisor();
		const key = prewarmPoolKey({ cwd: "/tmp/project" });
		const brokenWorker = makeWorkerFixture("w1", "");
		supervisor.prewarmPool.set(key, {
			key,
			ready: Promise.resolve(brokenWorker),
			expiryTimer: makeExpiryTimer(),
			createCommand: { type: "create", config: { cwd: "/tmp/project" } },
		});
		supervisor.stopWorker = vi.fn(async () => undefined);
		const consumed = await supervisor.tryConsumePrewarmPool({
			type: "create",
			config: { cwd: "/tmp/project" },
		});
		expect(consumed).toBeUndefined();
		expect(supervisor.prewarmPool.size).toBe(0);
		expect(supervisor.stopWorker).toHaveBeenCalledWith(brokenWorker, true);
	});

	it("refuses a config-mismatched create but keeps the entry for a later matching create", async () => {
		const supervisor = makeSupervisor();
		const worker = makeWorkerFixture("w1", "/tmp/sessions/s1.jsonl");
		const key = prewarmPoolKey({ cwd: "/tmp/project" });
		supervisor.prewarmPool.set(key, {
			key,
			ready: Promise.resolve(worker),
			expiryTimer: makeExpiryTimer(),
			createCommand: { type: "create", config: { cwd: "/tmp/project" } },
		});
		supervisor.forwardToWorker = vi.fn();
		supervisor.stopWorker = vi.fn(async () => undefined);

		const consumed = await supervisor.tryConsumePrewarmPool({
			type: "create",
			config: { cwd: "/tmp/project", provider: "custom-provider" },
		});
		expect(consumed).toBeUndefined();
		expect(supervisor.forwardToWorker).not.toHaveBeenCalled();
		expect(supervisor.stopWorker).not.toHaveBeenCalled();
		// The pooled worker is not orphaned: the entry stays (TTL still applies).
		expect(supervisor.prewarmPool.size).toBe(1);
	});
	it("adopts a pooled worker in the create command path", async () => {
		const supervisor = makeSupervisor();
		const summary = makeSummary("s1");
		const worker = makeWorkerFixture("w1", "/tmp/sessions/s1.jsonl");
		const key = prewarmPoolKey({ cwd: "/tmp/project" });
		const expiryTimer = makeExpiryTimer();
		supervisor.prewarmPool.set(key, {
			key,
			ready: Promise.resolve(worker),
			expiryTimer,
			createCommand: { type: "create", config: { cwd: "/tmp/project" } },
		});
		supervisor.forwardToWorker = vi.fn(async () => success(undefined, "create", summary));
		supervisor.writeRosterEntry = vi.fn();
		supervisor.refreshWorkerSummaries = vi.fn(async () => undefined);
		supervisor.publicSummary = vi.fn((_worker: object, passed: SessionSummary) => passed);
		supervisor.createOrReuseWorker = vi.fn(async () => {
			throw new Error("cold create path must not run when a pooled worker is adopted");
		});

		const client = { id: "client-1" };
		const response = (await supervisor.handleCommand(client, {
			id: "cmd-1",
			type: "create",
			config: { cwd: "/tmp/project" },
			env: undefined,
			launchEnv: {},
		})) as { success: boolean; data: SessionSummary };
		expect(response.success).toBe(true);
		expect(response.data.activeSessionId).toBe("s1");
		expect(supervisor.createOrReuseWorker).not.toHaveBeenCalled();
		expect(supervisor.prewarmPool.size).toBe(0);
	});
});

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransformStream } from "node:stream/web";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRlmAttachMarker, runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import type { AgentConnection, AgentConnectionEventListener } from "../src/modes/agent-connection/types.js";

const CLAIM_NONCE = "a".repeat(32);

function usagelessAutonomousStatus() {
	return {
		enabled: false,
		continuationsUsed: 0,
		turnsUsed: 0,
		tokensUsed: 0,
		limits: {
			maxContinuations: 0,
			maxTurns: 0,
			maxTokens: 0,
			subagentKeepAliveMs: 0,
			maxTokensPerContinuation: 0,
		},
		gates: { requirePlanApproval: false, requireCleanWorktree: false, requireNoRunningSubagents: false },
		gateAttempts: {},
	};
}

interface FakeSessionRecord {
	state: {
		activeSessionId: string;
		sessionId: string;
		cwd: string;
	};
	messages: AgentMessage[];
}

class FakeMirrorConnection {
	activeSessionId: string;
	readonly sessions = new Map<string, FakeSessionRecord>();
	readonly attachCalls: string[] = [];
	readonly killCalls: string[] = [];
	readonly prompts: string[];
	readonly cancelCalls: string[] = [];
	rlmChildren: { id: string; waitingMirrorAdmission?: boolean }[] = [];
	readonly withAttach: boolean;
	failInitialSnapshotFor?: string;
	claimSummaries = new Map<string, { cwd?: string; rlmDepth?: number }>();
	private readonly listeners = new Set<AgentConnectionEventListener>();

	constructor(withAttach = true) {
		this.withAttach = withAttach;
		if (!withAttach) {
			// Mirror the in-process adapter shape: no rebind support at all.
			const partial = this as Partial<Pick<FakeMirrorConnection, "attachActiveSession" | "killSession">>;
			partial.attachActiveSession = undefined;
			partial.killSession = undefined;
		}
		this.activeSessionId = "draft-1";
		this.sessions.set("draft-1", {
			state: { activeSessionId: "draft-1", sessionId: "draft-session", cwd: "/tmp/mirror" },
			messages: [],
		});
		this.sessions.set("child-1", {
			state: { activeSessionId: "child-1", sessionId: "child-session", cwd: "/tmp/mirror" },
			messages: [],
		});
		this.claimSummaries.set("child-1", { cwd: "/tmp/mirror", rlmDepth: 1 });
		this.prompts = [];
	}

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onBeforeSessionInvalidate(): () => void {
		return () => {};
	}

	async getState() {
		const record = this.sessions.get(this.activeSessionId);
		if (!record) throw new Error(`no fake session ${this.activeSessionId}`);
		return record.state;
	}

	async getInitialSnapshot() {
		if (this.failInitialSnapshotFor === this.activeSessionId) {
			throw new Error(`simulated re-admission failure for ${this.activeSessionId}`);
		}
		const record = this.sessions.get(this.activeSessionId);
		if (!record) throw new Error(`no fake session ${this.activeSessionId}`);
		return { state: record.state, messages: record.messages, children: [] };
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.sessions.get(this.activeSessionId)!.messages;
	}

	async promptAndWait(text: string) {
		this.prompts.push(text);
	}

	async waitForHeadlessCompletion() {
		return usagelessAutonomousStatus();
	}

	async getRlmChildSnapshots() {
		return this.rlmChildren as never;
	}

	async abortAndClearQueue() {
		return { steering: [], followUp: [] };
	}

	async waitForIdle() {}

	async cancelRlmChild(childId: string) {
		this.cancelCalls.push(childId);
		return true;
	}

	async acquireSessionInputPause(_leaseKey: string) {
		return { release: async () => {} };
	}

	async getActiveSessionState(activeSessionId: string) {
		const summary = this.claimSummaries.get(activeSessionId);
		if (!summary) throw new Error(`Unknown active session: ${activeSessionId}`);
		return summary;
	}

	async attachActiveSession(target: string) {
		if (!this.withAttach) throw new Error("attachActiveSession should not be called");
		this.attachCalls.push(target);
		this.activeSessionId = target;
	}

	async killSession(id: string) {
		this.killCalls.push(id);
	}

	async dispose() {}
}

function textPrompt(text: string) {
	return [{ type: "text" as const, text }];
}

describe("ACP mirror rebind (PRIME-11)", () => {
	let toAgent: TransformStream<Uint8Array, Uint8Array>;
	let toClient: TransformStream<Uint8Array, Uint8Array>;
	let agentDir: string;

	beforeEach(() => {
		toAgent = new TransformStream<Uint8Array, Uint8Array>();
		toClient = new TransformStream<Uint8Array, Uint8Array>();
		agentDir = mkdtempSync(join(tmpdir(), "mirror-claims-"));
		process.env.PRIME_AGENT_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		void toAgent.writable.abort().catch(() => undefined);
		void toClient.writable.abort().catch(() => undefined);
		delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
		rmSync(agentDir, { recursive: true, force: true });
	});

	function writeClaim(nonce: string, target: string, createdAtMs = Date.now()): void {
		const claimsDir = join(agentDir, "acp-mirror-claims");
		mkdirSync(claimsDir, { recursive: true });
		writeFileSync(join(claimsDir, `${nonce}.json`), JSON.stringify({ target, createdAtMs }));
	}

	it("parses the rlm-mirror marker and strips tell attribution", () => {
		expect(parseRlmAttachMarker(`[rlm-mirror:${CLAIM_NONCE}]\nDo the thing`)).toEqual({
			claimNonce: CLAIM_NONCE,
			remaining: "Do the thing",
		});
		expect(parseRlmAttachMarker(`[bb message from thread:thr_x]\n[rlm-mirror:${CLAIM_NONCE}]\nDo the thing`)).toEqual(
			{
				claimNonce: CLAIM_NONCE,
				remaining: "Do the thing",
			},
		);
		expect(parseRlmAttachMarker("plain task")).toBeUndefined();
		expect(parseRlmAttachMarker("[rlm-mirror:not-a-nonce] rest")).toBeUndefined();
		expect(parseRlmAttachMarker(`[rlm-mirror:${CLAIM_NONCE}] trailing text`)).toBeUndefined();
	});

	it("rebinds a virgin frontend onto the claimed RLM session and forwards the marker-stripped task", async () => {
		const connection = new FakeMirrorConnection();
		writeClaim(CLAIM_NONCE, "child-1");
		const updates: unknown[] = [];
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", (ctx: any) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};

		const first = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt(`[rlm-mirror:${CLAIM_NONCE}]\nDo the thing`),
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual(["child-1"]);
		expect(connection.killCalls).toEqual(["draft-1"]);
		expect(connection.prompts).toEqual(["Do the thing"]);
		// The claim is consumed (single use).
		expect(existsSync(join(agentDir, "acp-mirror-claims", `${CLAIM_NONCE}.json`))).toBe(false);

		// A later prompt on the mirror thread steers the same session verbatim.
		const second = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt("status update"),
		})) as { stopReason?: string };
		expect(second.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual(["child-1"]);
		expect(connection.prompts).toEqual(["Do the thing", "status update"]);
		void updates;
	});

	it("does not rebind on a marker-only prompt and keeps it as the turn content", async () => {
		const connection = new FakeMirrorConnection();
		writeClaim(CLAIM_NONCE, "child-1");
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", () => {})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};

		const only = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt(`[rlm-mirror:${CLAIM_NONCE}]`),
		})) as { stopReason?: string };
		expect(only.stopReason).toBe("end_turn");
		// No rebind: no attach, no kill, and the claim file is untouched.
		expect(connection.attachCalls).toEqual([]);
		expect(connection.killCalls).toEqual([]);
		expect(existsSync(join(agentDir, "acp-mirror-claims", `${CLAIM_NONCE}.json`))).toBe(true);
		// The bare marker still runs as a normal turn on the draft.
		expect(connection.prompts).toEqual([`[rlm-mirror:${CLAIM_NONCE}]`]);
	});

	it("keeps deferred mirror children parked across a stop/close cycle", async () => {
		const connection = new FakeMirrorConnection();
		connection.rlmChildren = [{ id: "parked-child", waitingMirrorAdmission: true }, { id: "running-child" }];
		writeClaim(CLAIM_NONCE, "child-1");
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", () => {})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};
		await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt(`[rlm-mirror:${CLAIM_NONCE}]
Do the thing`),
		});

		// Closing the mirror thread stops outstanding turns but must not kill a
		// child parked on its deferred admission turn; a normal child still goes.
		await handle.agent.request("session/close", { sessionId: session.sessionId });
		expect(connection.cancelCalls).toEqual(["running-child"]);
	});

	it("degrades to a normal turn when the adapter cannot rebind", async () => {
		const connection = new FakeMirrorConnection(false);
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", () => {})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};
		const first = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt(`[rlm-mirror:${CLAIM_NONCE}]\nDo the thing`),
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.prompts).toEqual(["Do the thing"]);
	});

	it("degrades to a normal turn on a stale claim and leaves the draft alive", async () => {
		const connection = new FakeMirrorConnection();
		writeClaim(CLAIM_NONCE, "child-1", Date.now() - 11 * 60_000);
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", () => {})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};
		const first = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt(`[rlm-mirror:${CLAIM_NONCE}]\nDo the thing`),
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual([]);
		expect(connection.killCalls).toEqual([]);
		expect(connection.prompts).toEqual(["Do the thing"]);
	});

	it("degrades without touching anything when the claim names a non-subagent session", async () => {
		const connection = new FakeMirrorConnection();
		writeClaim(CLAIM_NONCE, "not-a-session");
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", () => {})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};
		const first = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt(`[rlm-mirror:${CLAIM_NONCE}]\nDo the thing`),
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual([]);
		expect(connection.prompts).toEqual(["Do the thing"]);
	});

	it("rebinds through a leading system_instructions wrapper block", async () => {
		const connection = new FakeMirrorConnection();
		writeClaim(CLAIM_NONCE, "child-1");
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as any,
		);
		const handle = acp
			.client({ name: "mirror-client" })
			.onNotification("session/update", () => {})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const session = (await handle.agent.request("session/new", { cwd: "/tmp/mirror", mcpServers: [] })) as {
			sessionId: string;
		};
		const first = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [
				{ type: "text", text: "<system_instructions>You are viewing bb remotely.</system_instructions>" },
				{ type: "text", text: `[rlm-mirror:${CLAIM_NONCE}]\nDo the thing` },
			],
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual(["child-1"]);
		expect(connection.prompts[0]).toContain("<system_instructions>");
		expect(connection.prompts[0]).toContain("Do the thing");
		expect(connection.prompts[0]).not.toContain("[rlm-mirror:");
	});
});

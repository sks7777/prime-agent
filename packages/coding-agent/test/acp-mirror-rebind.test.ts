import { TransformStream } from "node:stream/web";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRlmAttachMarker, runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import type {
	AgentConnection,
	AgentConnectionEventListener,
	AgentConnectionState,
} from "../src/modes/agent-connection/types.js";

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
	state: Partial<AgentConnectionState>;
	messages: AgentMessage[];
}

class FakeMirrorConnection {
	activeSessionId: string;
	readonly sessions = new Map<string, FakeSessionRecord>();
	readonly attachCalls: string[] = [];
	readonly killCalls: string[] = [];
	readonly prompts: string[];
	readonly withAttach: boolean;
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
		return [];
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

	beforeEach(() => {
		toAgent = new TransformStream<Uint8Array, Uint8Array>();
		toClient = new TransformStream<Uint8Array, Uint8Array>();
	});

	afterEach(() => {
		void toAgent.writable.abort().catch(() => undefined);
		void toClient.writable.abort().catch(() => undefined);
	});

	it("parses the rlm-attach marker and strips tell attribution", () => {
		expect(parseRlmAttachMarker("[rlm-attach:child-1]\nDo the thing")).toEqual({
			target: "child-1",
			remaining: "Do the thing",
		});
		expect(parseRlmAttachMarker("[bb message from thread:thr_x]\n[rlm-attach:child-1]\nDo the thing")).toEqual({
			target: "child-1",
			remaining: "Do the thing",
		});
		expect(parseRlmAttachMarker("plain task")).toBeUndefined();
		expect(parseRlmAttachMarker("[rlm-attach:not a session] rest")).toBeUndefined();
		expect(parseRlmAttachMarker("[rlm-attach:child-1] trailing text")).toBeUndefined();
	});

	it("rebinds a virgin frontend onto the named RLM session and forwards the stripped task", async () => {
		const connection = new FakeMirrorConnection();
		const updates: any[] = [];
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
			prompt: textPrompt("[rlm-attach:child-1]\nDo the thing"),
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual(["child-1"]);
		expect(connection.killCalls).toEqual(["draft-1"]);
		expect(connection.prompts).toEqual(["Do the thing"]);

		// A later prompt on the mirror thread steers the same session verbatim.
		const second = (await handle.agent.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: textPrompt("status update"),
		})) as { stopReason?: string };
		expect(second.stopReason).toBe("end_turn");
		expect(connection.attachCalls).toEqual(["child-1"]);
		expect(connection.prompts).toEqual(["Do the thing", "status update"]);
		void handle;
		void updates;
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
			prompt: textPrompt("[rlm-attach:child-1]\nDo the thing"),
		})) as { stopReason?: string };
		expect(first.stopReason).toBe("end_turn");
		expect(connection.prompts).toEqual(["Do the thing"]);
	});
});

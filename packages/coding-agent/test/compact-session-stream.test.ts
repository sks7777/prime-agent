import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CompactAssistantStreamReconstructor,
	createCompactAssistantDelta,
} from "../src/modes/daemon/compact-session-stream.js";
import { DAEMON_PROTOCOL_INFO, type DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("compact daemon assistant streaming", () => {
	it("reconstructs the legacy full message_update from start and delta frames", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "message_start", message: assistant([]) },
		});

		const started = assistant([{ type: "text", text: "" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		expect(startFrame).toBeDefined();
		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { type: "message_update", message: { content: [{ type: "text", text: "" }] } },
		});

		const updated = assistant([{ type: "text", text: "hello" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: updated },
			},
			meta: {
				id: "active-1:2",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 2,
				cursor: { generation: "generation-1", sequence: 2 },
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		if (!deltaFrame) {
			throw new Error("Expected a compact delta frame");
		}
		const reconstructed = reconstructor.reconstruct(deltaFrame);
		expect(reconstructed).toMatchObject({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: { content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
			},
			meta: { cursor: { generation: "generation-1", sequence: 2 } },
		});
		expect((reconstructed as Extract<DaemonOutbound, { type: "session_event" }>).event).not.toHaveProperty(
			"assistantMessageEvent.partial",
		);
	});

	it("keeps delta payload size independent of the growing assistant message", () => {
		const text = "x".repeat(1024 * 1024);
		const partial = assistant([{ type: "text", text }]);
		const full: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-large",
			event: {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
			},
		};
		const compact = createCompactAssistantDelta(full);
		expect(compact).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(1024);
		expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(2 * 1024 * 1024);
	});

	it("does not duplicate text already present on a provider start event", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: { type: "message_start", message: assistant([]) },
		});
		const started = assistant([{ type: "text", text: "Hello" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: started },
			},
		});

		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "" }] } },
		});
		expect(reconstructor.reconstruct(deltaFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "Hello" }] } },
		});
	});

	it("does not overwrite a partial that observe(message_start) already set up", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		// observe(message_start) seeds an empty partial
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-seed",
			event: { type: "message_start", message: assistant([]) },
		});
		// Simulate a roster-sync seed with a stale completed message
		reconstructor.seed(
			"active-seed",
			assistant([
				{ type: "thinking", thinking: "old" },
				{ type: "toolCall", id: "tc-1", name: "search", arguments: {} },
			]),
		);
		// The seed should NOT have overwritten the empty partial from message_start.
		// A text_start at contentIndex 0 should work (not be blocked by stale thinking block).
		const started = assistant([{ type: "text", text: "" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-seed",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "" }] } },
		});
	});

	it("seed does not overwrite a partial even from attachClient fallback", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-attach",
			event: { type: "message_start", message: assistant([]) },
		});
		// Simulate attachClient fallback: seed with last completed assistant message
		reconstructor.seed(
			"active-attach",
			assistant([
				{ type: "thinking", thinking: "completed" },
				{ type: "toolCall", id: "old", name: "done", arguments: {} },
			]),
		);
		// text_delta should still work because seed didn't overwrite the empty partial
		const updated = assistant([{ type: "text", text: "hello" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-attach",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: updated },
			},
		});
		expect(reconstructor.reconstruct(deltaFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "hello" }] } },
		});
	});

	it("auto-heals text_delta when content block has wrong type (stale seed)", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		// Seed with a stale message that has toolCall at contentIndex 2
		reconstructor.seed(
			"active-heal",
			assistant([
				{ type: "thinking", thinking: "old" },
				{ type: "thinking", thinking: "old2" },
				{ type: "toolCall", id: "old-tc", name: "old", arguments: {} },
			]),
		);
		// text_delta at ci=2 should auto-heal instead of failing
		const updated = assistant([
			{ type: "thinking", thinking: "" },
			{ type: "thinking", thinking: "" },
			{ type: "text", text: "the quick brown fox" },
		]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-heal",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 2,
					delta: "the quick brown fox",
					partial: updated,
				},
			},
		});
		const result = reconstructor.reconstruct(deltaFrame!);
		expect(result).toBeDefined();
		expect(result).toMatchObject({
			event: { message: { content: [{}, {}, { type: "text", text: "the quick brown fox" }] } },
		});
	});

	it("text_end corrects auto-healed text with full final content", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.seed("active-end", assistant([{ type: "toolCall", id: "old", name: "old", arguments: {} }]));
		// text_delta auto-heals with partial text
		const deltaMsg = assistant([{ type: "text", text: "partial" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-end",
			event: {
				type: "message_update",
				message: deltaMsg,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial", partial: deltaMsg },
			},
		});
		expect(reconstructor.reconstruct(deltaFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "partial" }] } },
		});
		// text_end sets the full correct text
		const endMsg = assistant([{ type: "text", text: "the full correct text" }]);
		const endFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-end",
			event: {
				type: "message_update",
				message: endMsg,
				assistantMessageEvent: {
					type: "text_end",
					contentIndex: 0,
					content: "the full correct text",
					partial: endMsg,
				},
			},
		});
		expect(reconstructor.reconstruct(endFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "the full correct text" }] } },
		});
	});

	it("auto-heals thinking_delta when content block has wrong type", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.seed("active-thinking", assistant([{ type: "text", text: "wrong" }]));
		const updated = assistant([{ type: "thinking", thinking: "step by step" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-thinking",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "step by step", partial: updated },
			},
		});
		const result = reconstructor.reconstruct(deltaFrame!);
		expect(result).toBeDefined();
		expect(result).toMatchObject({
			event: { message: { content: [{ type: "thinking", thinking: "step by step" }] } },
		});
	});

	it("seed is used when no partial exists (initial attach)", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		// No observe(message_start) — seed should set the partial
		reconstructor.seed("active-initial", assistant([{ type: "text", text: "seeded" }]));
		const updated = assistant([{ type: "text", text: "seeded hello" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-initial",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " hello", partial: updated },
			},
		});
		expect(reconstructor.reconstruct(deltaFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "seeded hello" }] } },
		});
	});

	it("continues tool arguments after reconstructing from a snapshot", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.seed(
			"active-tool",
			assistant([{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hel" } }]),
		);
		const updated = assistant([{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hello" } }]);
		const delta = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-tool",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: {
					type: "toolcall_delta",
					contentIndex: 0,
					delta: 'lo"}',
					partial: updated,
				},
			},
		});

		expect(reconstructor.reconstruct(delta!)).toMatchObject({
			event: {
				message: {
					content: [{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hello" } }],
				},
			},
		});
	});
});

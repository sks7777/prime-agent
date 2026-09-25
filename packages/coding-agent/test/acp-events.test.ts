import { describe, expect, it } from "vitest";
import { type AcpEventMappingState, acpUpdatesForSessionEvent } from "../src/modes/acp/acp-events.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/types.js";

/** Real streaming shape: the discriminator is on the event, delta is a string. */
function assistantDelta(
	type: "text_delta" | "thinking_delta",
	delta: string,
	contentIndex = 0,
): AgentConnectionSessionEvent {
	return {
		type: "message_update",
		message: { role: "assistant", content: [], usage: {} } as never,
		assistantMessageEvent: { type, contentIndex, delta, partial: {} } as never,
	} as AgentConnectionSessionEvent;
}

describe("ACP session event mapping", () => {
	it("maps thinking deltas to agent_thought_chunk, not visible text", () => {
		const updates = acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "reasoning"));
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_thought_chunk",
				messageId: "prime-agent-assistant-1",
				content: { type: "text", text: "reasoning" },
			},
		]);
	});

	it("assigns one message id per assistant message", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		const start = { type: "message_start", message } as AgentConnectionSessionEvent;
		const end = { type: "message_end", message } as AgentConnectionSessionEvent;

		expect(acpUpdatesForSessionEvent(start, state)).toEqual([]);
		expect(acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "think"), state)[0]).toMatchObject({
			messageId: "prime-agent-assistant-1",
		});
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "answer"), state)[0]).toMatchObject({
			messageId: "prime-agent-assistant-1",
		});
		expect(acpUpdatesForSessionEvent(end, state)).toEqual([]);
		expect(state.activeAssistantMessageId).toBeUndefined();

		expect(acpUpdatesForSessionEvent(start, state)).toEqual([]);
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", "next"), state)[0]).toMatchObject({
			messageId: "prime-agent-assistant-2",
		});
	});

	it("ignores empty deltas and non-assistant messages", () => {
		expect(acpUpdatesForSessionEvent(assistantDelta("text_delta", ""))).toEqual([]);
		expect(
			acpUpdatesForSessionEvent({
				type: "message_update",
				message: { role: "user", content: "hi" } as never,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: {} } as never,
			} as AgentConnectionSessionEvent),
		).toEqual([]);
	});

	it("surfaces provider auto-retry wait state as namespaced metadata", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 3,
			delayMs: 8000,
			errorMessage: "503 Service temporarily unavailable",
			reason: "unavailable",
		} as AgentConnectionSessionEvent);
		expect(updates[0]?.sessionUpdate).toBe("session_info_update");
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				autoRetry: {
					phase: "waiting",
					attempt: 2,
					maxAttempts: 3,
					delayMs: 8000,
					reason: "unavailable",
					errorMessage: "503 Service temporarily unavailable",
				},
			},
		});
	});

	it("surfaces provider auto-retry recovery as namespaced metadata", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "auto_retry_end",
			success: true,
			attempt: 2,
		} as AgentConnectionSessionEvent);
		expect(updates[0]?.sessionUpdate).toBe("session_info_update");
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				autoRetry: { phase: "recovered", attempt: 2 },
			},
		});
		const failed = acpUpdatesForSessionEvent({
			type: "auto_retry_end",
			success: false,
			attempt: 3,
			finalError: "retry exhausted",
		} as AgentConnectionSessionEvent);
		expect(failed[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				autoRetry: { phase: "exhausted", attempt: 3, errorMessage: "retry exhausted" },
			},
		});
	});

	it("surfaces plan-code mode state as namespaced metadata", () => {
		const updates = acpUpdatesForSessionEvent({
			type: "plan_code_mode",
			planCode: {
				mode: "plan",
				executing: true,
				todos: [
					{ step: 1, text: "Read the plan", completed: true },
					{ step: 2, text: "Ship it", completed: false },
				],
			},
		} as AgentConnectionSessionEvent);
		expect(updates[0]?.sessionUpdate).toBe("session_info_update");
		expect(updates[0]?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				planCode: {
					mode: "plan",
					executing: true,
					todos: [
						{ step: 1, text: "Read the plan", completed: true },
						{ step: 2, text: "Ship it", completed: false },
					],
				},
			},
		});

		// Exit (no mode) publishes an empty planCode payload the dialect can use
		// to clear the mode state.
		const cleared = acpUpdatesForSessionEvent({
			type: "plan_code_mode",
			planCode: {},
		} as AgentConnectionSessionEvent);
		expect(cleared[0]?._meta).toMatchObject({ [PRIME_AGENT_META_NAMESPACE]: { planCode: {} } });
	});

	it("emits nothing for events ACP has no place for", () => {
		expect(acpUpdatesForSessionEvent({ type: "agent_start" } as AgentConnectionSessionEvent)).toEqual([]);
		expect(acpUpdatesForSessionEvent({ type: "recap_update", recap: "x" } as AgentConnectionSessionEvent)).toEqual(
			[],
		);
	});

	it("reports completed assistant responses as usage updates against the seeded context window", () => {
		const state: AcpEventMappingState = { contextWindow: 200_000 };
		const message = {
			role: "assistant",
			content: [],
			usage: { input: 1000, output: 50, cacheRead: 250, cacheWrite: 0, totalTokens: 1300 },
			stopReason: "stop",
		} as never;
		const end = { type: "message_end", message } as AgentConnectionSessionEvent;

		expect(acpUpdatesForSessionEvent(end, state)).toEqual([
			{ sessionUpdate: "usage_update", used: 1300, size: 200_000 },
		]);
		// The streaming message id still resets on end.
		expect(state.activeAssistantMessageId).toBeUndefined();
	});

	it("omits usage updates without a known context window or usable usage", () => {
		const message = {
			role: "assistant",
			content: [],
			usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10 },
			stopReason: "stop",
		} as never;
		const end = { type: "message_end", message } as AgentConnectionSessionEvent;

		// No seeded context window yet.
		expect(acpUpdatesForSessionEvent(end, {})).toEqual([]);
		// Zero usage carries no trustworthy context size.
		const emptyUsage = {
			role: "assistant",
			content: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
		} as never;
		expect(
			acpUpdatesForSessionEvent({ type: "message_end", message: emptyUsage } as AgentConnectionSessionEvent, {
				contextWindow: 200_000,
			}),
		).toEqual([]);
	});

	it("skips usage updates for error and aborted responses", () => {
		const state: AcpEventMappingState = { contextWindow: 200_000 };
		for (const stopReason of ["error", "aborted"]) {
			const message = {
				role: "assistant",
				content: [],
				usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 },
				stopReason,
			} as never;
			const end = { type: "message_end", message } as AgentConnectionSessionEvent;
			expect(acpUpdatesForSessionEvent(end, state)).toEqual([]);
		}
	});

	it("re-sends only the unforwarded suffix on a stream resync", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		const start = { type: "message_start", message } as AgentConnectionSessionEvent;
		acpUpdatesForSessionEvent(start, state);
		// Client already received the first 6 chars of text (block 1) and 4 chars of thinking (block 0).
		acpUpdatesForSessionEvent(assistantDelta("thinking_delta", "thnk", 0), state);
		acpUpdatesForSessionEvent(assistantDelta("text_delta", "short ", 1), state);

		const streamed = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "thnk deeper" },
				{ type: "text", text: "short answer body" },
			],
		} as never;
		const updates = acpUpdatesForSessionEvent(
			{ type: "stream_resynced", message: streamed } as AgentConnectionSessionEvent,
			state,
		);
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_thought_chunk",
				messageId: "prime-agent-assistant-1",
				content: { type: "text", text: " deeper" },
			},
			{
				sessionUpdate: "agent_message_chunk",
				messageId: "prime-agent-assistant-1",
				content: { type: "text", text: "answer body" },
			},
		]);
	});

	it("forwards every live delta in full and concatenates them per block", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		acpUpdatesForSessionEvent({ type: "message_start", message } as AgentConnectionSessionEvent, state);
		const chunks = [
			acpUpdatesForSessionEvent(assistantDelta("text_delta", "Hello ", 0), state),
			acpUpdatesForSessionEvent(assistantDelta("text_delta", "from ", 0), state),
			acpUpdatesForSessionEvent(assistantDelta("text_delta", "prime-agent", 0), state),
		];
		expect(
			chunks
				.flat()
				.map((update) => (update.content as { text: string }).text)
				.join(""),
		).toBe("Hello from prime-agent");
	});

	it("sends only the incremental suffix when deltas resume after a resync", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		acpUpdatesForSessionEvent({ type: "message_start", message } as AgentConnectionSessionEvent, state);
		acpUpdatesForSessionEvent(assistantDelta("text_delta", "head, ", 0), state);

		const streamed = { role: "assistant", content: [{ type: "text", text: "head, tail" }] } as never;
		const resync = acpUpdatesForSessionEvent(
			{ type: "stream_resynced", message: streamed } as AgentConnectionSessionEvent,
			state,
		);
		expect((resync[0]?.content as { text: string }).text).toBe("tail");

		const resumed = acpUpdatesForSessionEvent(assistantDelta("text_delta", " and more", 0), state);
		expect((resumed[0]?.content as { text: string }).text).toBe(" and more");
	});

	it("sends only the incremental suffix on a repeated resync", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		acpUpdatesForSessionEvent({ type: "message_start", message } as AgentConnectionSessionEvent, state);
		acpUpdatesForSessionEvent(assistantDelta("text_delta", "ab", 0), state);

		const first = acpUpdatesForSessionEvent(
			{
				type: "stream_resynced",
				message: { role: "assistant", content: [{ type: "text", text: "abcd" }] },
			} as AgentConnectionSessionEvent,
			state,
		);
		expect((first[0]?.content as { text: string }).text).toBe("cd");

		const second = acpUpdatesForSessionEvent(
			{
				type: "stream_resynced",
				message: { role: "assistant", content: [{ type: "text", text: "abcdef" }] },
			} as AgentConnectionSessionEvent,
			state,
		);
		expect((second[0]?.content as { text: string }).text).toBe("ef");
	});

	it("re-syncs the tracked length when a resynced block is shorter than forwarded", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		acpUpdatesForSessionEvent({ type: "message_start", message } as AgentConnectionSessionEvent, state);
		acpUpdatesForSessionEvent(assistantDelta("text_delta", "longer prefix", 0), state);

		// A truncated replay resets the forwarded length; later deltas flow again.
		const shrunk = acpUpdatesForSessionEvent(
			{
				type: "stream_resynced",
				message: { role: "assistant", content: [{ type: "text", text: "tiny" }] },
			} as AgentConnectionSessionEvent,
			state,
		);
		expect(shrunk).toEqual([]);

		const resumed = acpUpdatesForSessionEvent(assistantDelta("text_delta", "X", 0), state);
		expect(resumed).toEqual([
			{
				sessionUpdate: "agent_message_chunk",
				messageId: "prime-agent-assistant-1",
				content: { type: "text", text: "X" },
			},
		]);
	});

	it("emits nothing on resync when everything was already forwarded", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		acpUpdatesForSessionEvent({ type: "message_start", message } as AgentConnectionSessionEvent, state);
		acpUpdatesForSessionEvent(assistantDelta("text_delta", "complete"), state);

		const streamed = { role: "assistant", content: [{ type: "text", text: "complete" }] } as never;
		expect(
			acpUpdatesForSessionEvent(
				{ type: "stream_resynced", message: streamed } as AgentConnectionSessionEvent,
				state,
			),
		).toEqual([]);
	});

	it("starts a fresh forwarded-prefix map per assistant message", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		const start = { type: "message_start", message } as AgentConnectionSessionEvent;
		acpUpdatesForSessionEvent(start, state);
		acpUpdatesForSessionEvent(assistantDelta("text_delta", "first message"), state);
		acpUpdatesForSessionEvent({ type: "message_end", message } as AgentConnectionSessionEvent, state);

		acpUpdatesForSessionEvent(start, state);
		const streamed = { role: "assistant", content: [{ type: "text", text: "second" }] } as never;
		const updates = acpUpdatesForSessionEvent(
			{ type: "stream_resynced", message: streamed } as AgentConnectionSessionEvent,
			state,
		);
		expect(updates).toEqual([
			{
				sessionUpdate: "agent_message_chunk",
				messageId: "prime-agent-assistant-2",
				content: { type: "text", text: "second" },
			},
		]);
	});
});

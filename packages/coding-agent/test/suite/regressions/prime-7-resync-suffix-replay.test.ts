import { describe, expect, it } from "vitest";
import { type AcpEventMappingState, acpUpdatesForSessionEvent } from "../../../src/modes/acp/acp-events.js";
import type { AgentConnectionSessionEvent } from "../../../src/modes/agent-connection/types.js";

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

/**
 * PRIME-7: daemon resyncs replay the authoritative streaming message after
 * dropped transport frames. The client keeps what it already rendered, so the
 * mapping must live-forward whole increments and replay only the unforwarded
 * suffix on a resync — never slicing live deltas against the cumulative
 * forwarded length (that dropped every delta after the first).
 */
describe("PRIME-7 resync suffix replay", () => {
	it("live deltas concatenate to the full text, resync sends only the missing tail", () => {
		const state: AcpEventMappingState = {};
		const message = { role: "assistant", content: [], usage: {} } as never;
		acpUpdatesForSessionEvent({ type: "message_start", message } as AgentConnectionSessionEvent, state);

		const sent = ["The ", "quick ", "brown "].map((delta) => {
			const update = acpUpdatesForSessionEvent(assistantDelta("text_delta", delta, 0), state)[0] as {
				content?: { text: string };
			};
			return update.content?.text ?? "";
		});
		expect(sent).toEqual(["The ", "quick ", "brown "]);

		const resync = acpUpdatesForSessionEvent(
			{
				type: "stream_resynced",
				message: { role: "assistant", content: [{ type: "text", text: "The quick brown fox" }] },
			} as AgentConnectionSessionEvent,
			state,
		);
		expect(resync).toEqual([
			{
				sessionUpdate: "agent_message_chunk",
				messageId: "prime-agent-assistant-1",
				content: { type: "text", text: "fox" },
			},
		]);
	});
});

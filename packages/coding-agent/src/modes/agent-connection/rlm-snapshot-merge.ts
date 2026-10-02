import type { AgentConnectionRlmChildAgentSnapshot } from "./types.js";

/**
 * Merge an incoming RLM child snapshot onto a previous one.
 *
 * Active updates may omit fields the previous snapshot already carried (a
 * daemon session id, an activity projection), while a terminal update without
 * them means the child is no longer resident. The merge rules keep the
 * previous value for active children and prefer the incoming value for
 * terminal ones, exactly as the interactive mode's original implementation.
 */
export function mergeSubagentSnapshot(
	previous: AgentConnectionRlmChildAgentSnapshot,
	incoming: AgentConnectionRlmChildAgentSnapshot,
): AgentConnectionRlmChildAgentSnapshot {
	const active = incoming.status === "running" || incoming.status === "queued";
	return {
		...previous,
		...incoming,
		parentId: incoming.parentId ?? previous.parentId,
		activeSessionId: active ? (incoming.activeSessionId ?? previous.activeSessionId) : incoming.activeSessionId,
		activity: active ? (incoming.activity ?? previous.activity) : incoming.activity,
	};
}

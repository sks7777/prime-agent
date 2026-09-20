import type { AssistantMessage, AssistantMessageEvent, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens } from "../../core/compaction/index.js";
import type { AgentConnectionSessionEvent } from "../agent-connection/types.js";
import type { PrimeAgentIpythonMeta, PrimeAgentSessionMeta } from "./acp-meta.js";
import { primeAgentMeta } from "./acp-meta.js";

/**
 * Translate prime-agent session events into ACP `session/update` payloads.
 *
 * Kept as a pure function so the mapping is testable without a live ACP client
 * or a running agent. Returning an array lets one prime-agent event fan out to
 * several ACP updates (or none, for events ACP has no place for).
 */

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpSessionUpdate {
	sessionUpdate: string;
	[key: string]: unknown;
}

/** prime-agent's model-facing tool is the Python REPL; bash is the secondary escape hatch. */
export const IPYTHON_TOOL_NAME = "ipython";

export function acpToolKind(toolName: string): AcpToolKind {
	switch (toolName) {
		case IPYTHON_TOOL_NAME:
		case "bash":
			return "execute";
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		default:
			return "other";
	}
}

/** Decoded byte length of a base64 payload, without materializing it. */
function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Map one streaming assistant event to an ACP chunk.
 *
 * The delta discriminator lives on the event itself (`text_delta` /
 * `thinking_delta`) and carries a plain string, so reasoning and visible answer
 * text are distinct ACP update kinds a client can render or hide separately.
 */
function forwardedLength(forwarded: Map<number, number> | undefined, contentIndex: number): number {
	return forwarded?.get(contentIndex) ?? 0;
}

function trackForwarded(
	state: AcpEventMappingState,
	kind: "thinking" | "text",
	contentIndex: number,
	length: number,
): void {
	if (kind === "thinking") {
		state.forwardedThinkingLengths ??= new Map();
		state.forwardedThinkingLengths.set(contentIndex, length);
		return;
	}
	state.forwardedTextLengths ??= new Map();
	state.forwardedTextLengths.set(contentIndex, length);
}

function resetForwardedLengths(state: AcpEventMappingState): void {
	state.forwardedThinkingLengths?.clear();
	state.forwardedTextLengths?.clear();
}

/**
 * Catch-up chunks for a resynced streaming message.
 *
 * A daemon resync replays the consistent streaming message after dropped
 * transport frames; the client has already rendered the forwarded prefix, so
 * only the suffix per content block is re-sent. Tool-call arguments have no
 * ACP chunk form and close via tool_call updates, so they are skipped.
 */
function resyncDeltaUpdates(
	message: AssistantMessage,
	messageId: string,
	state: AcpEventMappingState,
): AcpSessionUpdate[] {
	const updates: AcpSessionUpdate[] = [];
	message.content.forEach((block, contentIndex) => {
		if (block.type === "thinking") {
			const sent = forwardedLength(state.forwardedThinkingLengths, contentIndex);
			if (block.thinking.length > sent) {
				trackForwarded(state, "thinking", contentIndex, block.thinking.length);
				updates.push({
					sessionUpdate: "agent_thought_chunk",
					messageId,
					content: textContent(block.thinking.slice(sent)),
				});
			}
			return;
		}
		if (block.type === "text") {
			const sent = forwardedLength(state.forwardedTextLengths, contentIndex);
			if (block.text.length > sent) {
				trackForwarded(state, "text", contentIndex, block.text.length);
				updates.push({
					sessionUpdate: "agent_message_chunk",
					messageId,
					content: textContent(block.text.slice(sent)),
				});
			}
		}
	});
	return updates;
}

function assistantDeltaUpdates(
	event: AssistantMessageEvent,
	messageId: string,
	state: AcpEventMappingState,
): AcpSessionUpdate[] {
	if (event.type === "thinking_delta" && event.delta.length > 0) {
		const sent = forwardedLength(state.forwardedThinkingLengths, event.contentIndex);
		trackForwarded(state, "thinking", event.contentIndex, sent + event.delta.length);
		if (event.delta.length > sent) {
			return [{ sessionUpdate: "agent_thought_chunk", messageId, content: textContent(event.delta.slice(sent)) }];
		}
		return [];
	}
	if (event.type === "text_delta" && event.delta.length > 0) {
		const sent = forwardedLength(state.forwardedTextLengths, event.contentIndex);
		trackForwarded(state, "text", event.contentIndex, sent + event.delta.length);
		if (event.delta.length > sent) {
			return [{ sessionUpdate: "agent_message_chunk", messageId, content: textContent(event.delta.slice(sent)) }];
		}
		return [];
	}
	return [];
}

/** Extract the Python cell source so a client can show what is executing. */
function ipythonCellSource(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function toolResultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return undefined;
	const output = (result as { output?: unknown }).output;
	if (typeof output === "string") return output;
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const parts = content
			.map((block) =>
				block && typeof block === "object" && (block as { type?: string }).type === "text"
					? ((block as { text?: string }).text ?? "")
					: "",
			)
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

/**
 * Rich kernel output that ACP has no content type for.
 *
 * The ipython tool reports media and diffs under `details` (images additionally
 * ride along as ACP image content blocks); mirror those exact fields rather than
 * inventing a MIME bundle the tool never produces.
 */
function ipythonRichOutput(result: unknown): PrimeAgentIpythonMeta | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const { attachments, diffs } = details as { attachments?: unknown; diffs?: unknown };
	const meta: PrimeAgentIpythonMeta = {};
	if (Array.isArray(attachments) && attachments.length > 0) {
		meta.attachments = attachments.map((attachment) => {
			// KernelAttachment exposes mimeType, base64 `data`, and an optional path.
			// Report the decoded size rather than a `bytes` field the kernel never
			// sends, and never inline the payload: ACP already carries images as
			// content blocks, so duplicating them here would bloat every update.
			const typed = (attachment ?? {}) as { mimeType?: unknown; path?: unknown; data?: unknown };
			return {
				...(typeof typed.mimeType === "string" ? { mimeType: typed.mimeType } : {}),
				...(typeof typed.path === "string" ? { path: typed.path } : {}),
				...(typeof typed.data === "string" ? { bytes: base64ByteLength(typed.data) } : {}),
			};
		});
	}
	if (Array.isArray(diffs) && diffs.length > 0) meta.diffCount = diffs.length;
	return meta.attachments || meta.diffCount !== undefined ? meta : undefined;
}

/** Correlates streamed bash output and assistant chunks with their owning run or message. */
export interface AcpEventMappingState {
	activeBashRunId?: string;
	activeAssistantMessageId?: string;
	nextAssistantMessageSequence?: number;
	/**
	 * Context window of the session's current model, refreshed by the ACP mode
	 * from connection state. Without it a completed assistant message cannot be
	 * reported as an ACP `usage_update`, because the event carries no model info.
	 */
	contextWindow?: number;
	/**
	 * Characters already forwarded to the client for the current assistant
	 * message's content blocks, keyed by content index. A daemon resync replays
	 * the full streaming message, so the suffix beyond these lengths is re-sent
	 * as catch-up chunks instead of being lost to dropped transport frames.
	 */
	forwardedThinkingLengths?: Map<number, number>;
	forwardedTextLengths?: Map<number, number>;
}

/**
 * ACP `usage_update` for one completed assistant response.
 *
 * `used` is the request's context size (`usage.totalTokens`, falling back to the
 * explicit field sum, exactly like the session's own context estimate), and
 * `size` is the model's context window. Error/aborted responses carry no
 * trustworthy usage, and without a known context window there is nothing to
 * report against, so both cases emit nothing.
 *
 * After a compaction the context size is unknown until the next model response
 * (`AgentSession.getContextUsage()` returns `tokens: null` for the same reason),
 * and ACP `usage_update.used` has no nullable form, so `compaction_end` emits
 * nothing: bb keeps the last reported size until the next response corrects it.
 */
function usageUpdate(
	event: Extract<AgentConnectionSessionEvent, { type: "message_end" }>,
	state: AcpEventMappingState,
): AcpSessionUpdate[] {
	if (event.message.role !== "assistant") return [];
	const assistant = event.message as { stopReason?: unknown; usage?: unknown };
	if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return [];
	const usage = assistant.usage as
		| { totalTokens?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown }
		| undefined;
	if (!usage || typeof usage !== "object") return [];
	const used = calculateContextTokens(usage as Usage);
	if (!Number.isFinite(used) || used <= 0) return [];
	if (typeof state.contextWindow !== "number" || !Number.isFinite(state.contextWindow) || state.contextWindow <= 0) {
		return [];
	}
	return [{ sessionUpdate: "usage_update", used, size: state.contextWindow }];
}

function startAssistantMessage(state: AcpEventMappingState): string {
	const sequence = (state.nextAssistantMessageSequence ?? 0) + 1;
	state.nextAssistantMessageSequence = sequence;
	state.activeAssistantMessageId = `prime-agent-assistant-${sequence}`;
	return state.activeAssistantMessageId;
}

export function acpUpdatesForSessionEvent(
	event: AgentConnectionSessionEvent,
	state: AcpEventMappingState = {},
): AcpSessionUpdate[] {
	switch (event.type) {
		case "message_start":
			if (event.message.role === "assistant") {
				startAssistantMessage(state);
				resetForwardedLengths(state);
			}
			return [];

		case "message_update":
			if (event.message.role !== "assistant") return [];
			return assistantDeltaUpdates(
				event.assistantMessageEvent,
				state.activeAssistantMessageId ?? startAssistantMessage(state),
				state,
			);

		case "message_end":
			if (event.message.role === "assistant") {
				state.activeAssistantMessageId = undefined;
				resetForwardedLengths(state);
			}
			return usageUpdate(event, state);

		case "stream_resynced": {
			if (event.message.role !== "assistant") return [];
			const messageId = state.activeAssistantMessageId ?? startAssistantMessage(state);
			state.activeAssistantMessageId = messageId;
			return resyncDeltaUpdates(event.message as AssistantMessage, messageId, state);
		}

		case "tool_execution_start": {
			const cell = event.toolName === IPYTHON_TOOL_NAME ? ipythonCellSource(event.args) : undefined;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: event.toolName === IPYTHON_TOOL_NAME ? "Python cell" : event.toolName,
					kind: acpToolKind(event.toolName),
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: cell !== undefined ? { code: cell } : event.args,
				},
			];
		}

		case "tool_execution_end": {
			const text = toolResultText(event.result);
			const rich = event.toolName === IPYTHON_TOOL_NAME ? ipythonRichOutput(event.result) : undefined;
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: (event.isError ? "failed" : "completed") satisfies AcpToolStatus,
					...(text ? { content: [{ type: "content", content: textContent(text) }] } : {}),
					...(rich ? { _meta: primeAgentMeta({ ipython: rich }) } : {}),
				},
			];
		}

		// Bash runs outside the tool-call lifecycle, so it gets a synthetic tool
		// call keyed by run id to keep incremental output addressable.
		case "bash_start":
			state.activeBashRunId = event.runId;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: bashToolCallId(event.runId),
					title: event.command,
					kind: "execute" satisfies AcpToolKind,
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: { command: event.command },
				},
			];

		case "bash_output":
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(state.activeBashRunId),
					status: "in_progress" satisfies AcpToolStatus,
					content: [{ type: "content", content: textContent(event.chunk) }],
				},
			];

		case "bash_end":
			if (state.activeBashRunId === event.runId) state.activeBashRunId = undefined;
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(event.runId),
					status: (event.exitCode === 0 && !event.cancelled ? "completed" : "failed") satisfies AcpToolStatus,
				},
			];

		// Compaction, subagents, goals and recaps have no ACP equivalent: surface
		// them as namespaced metadata rather than distorting a standard update.
		// No corrective usage_update here: post-compaction context size is unknown
		// until the next model response (see usageUpdate doc above).
		case "compaction_end":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						compaction: {
							tokensBefore: event.result?.tokensBefore,
							summary: event.result?.summary,
						},
					}),
				},
			];

		case "rlm_child_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						subagents: [
							{
								id: event.child.id,
								sessionName: event.child.sessionName,
								status: event.child.status,
								model: event.child.model,
								tokenCount: event.child.tokenCount,
								error: event.child.error,
							},
						],
					}),
				},
			];

		// Goals, continual-harness refinement, and agent-to-agent messaging are
		// prime-agent concepts with no ACP counterpart. They are still part of a
		// turn's observable behavior, so they surface as namespaced metadata
		// instead of being dropped.
		case "goal_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						goal: {
							status: event.goal.status,
							objective: event.goal.objective,
							tokenBudget: event.goal.tokenBudget,
							tokensUsed: event.goal.tokensUsed,
						},
					}),
				},
			];

		case "refine_complete":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						refinement: {
							status: "complete",
							summary: event.result.summary,
							changes: event.result.appliedEdits
								?.filter((edit) => edit.applied)
								.map((edit) => `${edit.action} ${edit.kind}:${edit.id}`),
						},
					}),
				},
			];

		case "refine_failed":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({ refinement: { status: "failed", error: event.error } }),
				},
			];

		case "ipython_sent_agent_message":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						agentMessage: {
							toolCallId: event.toolCallId,
							target: event.message.target.sessionName ?? event.message.target.sessionId,
							deliveryStatus: event.message.deliveryStatus,
						},
					}),
				},
			];

		default:
			return [];
	}
}

const BASH_TOOL_CALL_PREFIX = "prime-agent-bash";

export function bashToolCallId(runId: string | undefined): string {
	return runId ? `${BASH_TOOL_CALL_PREFIX}-${runId}` : BASH_TOOL_CALL_PREFIX;
}

export type { PrimeAgentSessionMeta };

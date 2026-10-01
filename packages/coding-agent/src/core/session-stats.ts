import type { ContextUsage } from "./extensions/index.js";

export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	/** Assistant messages that contained at least one tool call — the number of LLM tool rounds. */
	toolRounds: number;
	/** Tool-call count distribution per assistant response: {max, avg}. 1 = every round had one call. */
	toolCallsPerRound: { max: number; avg: number };
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

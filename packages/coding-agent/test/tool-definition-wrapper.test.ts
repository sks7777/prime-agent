import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

describe("tool-definition-wrapper parallelSafe propagation", () => {
	it("wraps a ToolDefinition preserving parallelSafe and executionMode", () => {
		const definition = {
			name: "kernel",
			label: "Kernel",
			description: "Kernel tool",
			parameters: {},
			executionMode: "sequential",
			parallelSafe: true,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		} as unknown as ToolDefinition;

		const tool = wrapToolDefinition(definition);
		expect(tool.parallelSafe).toBe(true);
		expect(tool.executionMode).toBe("sequential");
	});

	it("synthesizes a ToolDefinition from an AgentTool preserving parallelSafe", () => {
		const synthetic = createToolDefinitionFromAgentTool({
			name: "k",
			label: "K",
			description: "d",
			parameters: {},
			parallelSafe: true,
			execute: async () => ({ content: [], details: {} }),
		} as never);
		expect(synthetic.parallelSafe).toBe(true);
	});
});

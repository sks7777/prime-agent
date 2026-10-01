import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

describe("tool-definition-wrapper parallelSafe propagation (PRIME-39)", () => {
	it("preserves parallelSafe in both wrapper directions", () => {
		const definition = {
			name: "kernel",
			label: "Kernel",
			description: "Kernel tool",
			parameters: {},
			executionMode: "sequential",
			parallelSafe: true,
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		} as unknown as ToolDefinition;
		expect(wrapToolDefinition(definition).parallelSafe).toBe(true);
		expect(createToolDefinitionFromAgentTool(wrapToolDefinition(definition) as never).parallelSafe).toBe(true);
	});
});

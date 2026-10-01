import { describe, expect, it } from "vitest";
import type { PromptTemplate } from "../src/core/prompt-templates.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import type { BuildSystemPromptOptions } from "../src/core/system-prompt.js";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

const template: PromptTemplate = {
	name: "session-prune",
	description: "Prune old sessions",
	argumentHint: "[keep <n>]",
	content: "unused here",
	filePath: "/virtual/session-prune.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/session-prune.md", {
		source: "local",
		scope: "user",
		origin: "top-level",
	}),
};

describe("buildSystemPrompt", () => {
	it("lists user-defined prompt templates so the model knows the commands", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "Base prompt.",
			cwd: "/tmp",
			promptTemplates: [template],
		});

		expect(prompt).toContain("<available_prompt_templates>");
		expect(prompt).toContain("/session-prune [keep <n>] — Prune old sessions");
	});

	it("omits the prompt-template section when no templates are loaded", () => {
		const prompt = buildSystemPrompt({ customPrompt: "Base prompt.", cwd: "/tmp" });

		expect(prompt).not.toContain("<available_prompt_templates>");
	});
});

describe("buildSystemPrompt batching guidance (PRIME-39)", () => {
	it("appends tool promptGuidelines in both prompt paths and omits the section when unset", () => {
		const guideline = "Batch independent operations: compound cells.";
		const paths: Array<[string, BuildSystemPromptOptions]> = [
			["default", { cwd: "/tmp", selectedTools: ["ipython"], promptGuidelines: [guideline] }],
			[
				"custom",
				{ customPrompt: "Base prompt.", cwd: "/tmp", selectedTools: ["ipython"], promptGuidelines: [guideline] },
			],
		];
		for (const [name, options] of paths) {
			expect(buildSystemPrompt(options), `${name} path`).toContain(`# Additional Guidance\n\n- ${guideline}`);
		}
		expect(
			buildSystemPrompt({ customPrompt: "Base prompt.", cwd: "/tmp", selectedTools: ["ipython"] }),
		).not.toContain("# Additional Guidance");
	});
});

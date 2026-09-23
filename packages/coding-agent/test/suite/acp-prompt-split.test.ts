import { describe, expect, it } from "vitest";
import { splitAcpPromptBlocks } from "../../src/modes/acp/acp-mode.js";

const WRAPPER = "<system_instructions>\nYou are viewing bb remotely.\n</system_instructions>";

function textBlocks(...texts: string[]) {
	return texts.map((text) => ({ type: "text", text }));
}

describe("splitAcpPromptBlocks", () => {
	it("keeps the wrapper and the command in separate rest blocks (regression)", () => {
		const split = splitAcpPromptBlocks(textBlocks(WRAPPER, "/plan", "/exit"));
		expect(split.instructionsText).toBe(WRAPPER);
		expect(split.restTexts).toEqual(["/plan", "/exit"]);
	});

	it("splits a merged wrapper+command block so the command is the head", () => {
		const split = splitAcpPromptBlocks(textBlocks(`${WRAPPER}\n/plan`));
		expect(split.instructionsText).toBe(WRAPPER);
		expect(split.restTexts).toEqual(["/plan"]);
	});

	it("splits a merged wrapper+command+args block and keeps the args", () => {
		const split = splitAcpPromptBlocks(textBlocks(`${WRAPPER}\n/plan make it quick`));
		expect(split.instructionsText).toBe(WRAPPER);
		expect(split.restTexts).toEqual(["/plan make it quick"]);
	});

	it("splits a merged wrapper+prose block without turning prose into a command", () => {
		const split = splitAcpPromptBlocks(textBlocks(`${WRAPPER}\nhello there`));
		expect(split.instructionsText).toBe(WRAPPER);
		expect(split.restTexts).toEqual(["hello there"]);
	});

	it("leaves a wrapper-only block as instructions (no empty rest block)", () => {
		const split = splitAcpPromptBlocks(textBlocks(WRAPPER));
		expect(split.instructionsText).toBe(WRAPPER);
		expect(split.restTexts).toEqual([]);
	});

	it("keeps later blocks after a merged first block", () => {
		const split = splitAcpPromptBlocks(textBlocks(`${WRAPPER}\n/plan`, "extra context"));
		expect(split.instructionsText).toBe(WRAPPER);
		expect(split.restTexts).toEqual(["/plan", "extra context"]);
	});

	it("does not treat a non-leading wrapper as instructions", () => {
		const split = splitAcpPromptBlocks(textBlocks("first user block", `${WRAPPER}\n/plan`));
		expect(split.instructionsText).toBe("");
		expect(split.restTexts).toEqual(["first user block", `${WRAPPER}\n/plan`]);
	});
});

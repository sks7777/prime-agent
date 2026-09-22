import { describe, expect, it } from "vitest";
import { headWithoutTellAttribution } from "../../src/modes/acp/acp-mode.js";

describe("headWithoutTellAttribution", () => {
	it("strips a leading bb tell attribution line", () => {
		expect(headWithoutTellAttribution("[bb message from thread:thr_x]\n\n/exit")).toBe("/exit");
	});

	it("strips the attribution and keeps the rest of the message", () => {
		expect(headWithoutTellAttribution("[bb message from thread:thr_x]\n\n/plan make it quick")).toBe(
			"/plan make it quick",
		);
	});

	it("strips the attribution but keeps non-command content", () => {
		expect(headWithoutTellAttribution("/exit")).toBe("/exit");
		// The attribution line is stripped for command detection; the tell body
		// remains (parseSlashCommand then rejects it and the text passes through).
		expect(headWithoutTellAttribution("[bb message from thread:thr_x]\nhello there")).toBe("hello there");
	});

	it("keeps a bare attribution line untouched (nothing left to dispatch)", () => {
		expect(headWithoutTellAttribution("[bb message from thread:thr_x]")).toBe("[bb message from thread:thr_x]");
	});
});

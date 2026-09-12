import assert from "node:assert";
import { describe, it } from "node:test";
import { stripTerminalSequences } from "../src/utils.js";

describe("stripTerminalSequences", () => {
	it("returns strings without escape sequences unchanged", () => {
		assert.strictEqual(stripTerminalSequences("plain text"), "plain text");
	});

	it("strips CSI color sequences", () => {
		assert.strictEqual(stripTerminalSequences("\x1b[31mred\x1b[0m"), "red");
	});

	it("strips OSC hyperlink sequences", () => {
		const line = "see \x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\ here";
		assert.strictEqual(stripTerminalSequences(line), "see docs here");
	});

	it("strips APC and DCS sequences", () => {
		assert.strictEqual(stripTerminalSequences("\x1b_gapc\x1b\\text"), "text");
	});

	it("preserves visible text between sequences", () => {
		assert.strictEqual(stripTerminalSequences("a\x1b[1mb\x1b[22mc"), "abc");
	});
});

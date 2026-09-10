import { describe, expect, it } from "vitest";
import { normalizeLayoutInput } from "../src/core/layout-normalize.js";

describe("normalizeLayoutInput", () => {
	it("passes plain text through unchanged", () => {
		expect(normalizeLayoutInput("hello")).toBe("hello");
		expect(normalizeLayoutInput("")).toBe("");
	});

	it("passes unmodified CSI-u sequences without a modifier through", () => {
		// щ without any modifier: codepoint 1097, modifier 1 (none) — plain text input.
		expect(normalizeLayoutInput("\x1b[1097u")).toBe("\x1b[1097u");
	});

	it("maps Cyrillic codepoints to Latin physical keys in CSI-u sequences with modifiers", () => {
		// ctrl+щ (1097) should match ctrl+o (111).
		expect(normalizeLayoutInput("\x1b[1097;5u")).toBe("\x1b[111;5u");
		// shift+й (1056 uppercase? no: 1049=Й) — uppercase Й with shift.
		expect(normalizeLayoutInput("\x1b[1049;2u")).toBe("\x1b[81;2u");
		// alt+ф (1092) should match alt+a (97).
		expect(normalizeLayoutInput("\x1b[1092;3u")).toBe("\x1b[97;3u");
	});

	it("keeps the shifted key and event type when remapping", () => {
		// [<cp>[:shifted[:base]][;mod[:event]]u
		expect(normalizeLayoutInput("\x1b[1097:79;5:1u")).toBe("\x1b[111:79;5:1u");
	});

	it("skips remapping when the terminal already reports the base layout key", () => {
		// Third field is baseLayoutKey (111 = o): terminal already says the physical key.
		expect(normalizeLayoutInput("\x1b[1097::111;5u")).toBe("\x1b[1097::111;5u");
	});

	it("leaves Latin codepoints untouched", () => {
		expect(normalizeLayoutInput("\x1b[111;5u")).toBe("\x1b[111;5u");
	});

	it("maps Cyrillic codepoints in xterm modifyOtherKeys sequences", () => {
		// ctrl+щ: [27;5;1097~
		expect(normalizeLayoutInput("\x1b[27;5;1097~")).toBe("\x1b[27;5;111~");
		// Without a modifier, the sequence is plain text input.
		expect(normalizeLayoutInput("\x1b[27;1;1097~")).toBe("\x1b[27;1;1097~");
	});

	it("passes unrelated escape sequences through", () => {
		expect(normalizeLayoutInput("\x1b[A")).toBe("\x1b[A");
		expect(normalizeLayoutInput("\r")).toBe("\r");
		expect(normalizeLayoutInput("\x03")).toBe("\x03");
	});
});

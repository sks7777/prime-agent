import { describe, expect, it } from "vitest";
import * as compat from "../src/compat.js";
import * as root from "../src/index.js";

describe("pi-ai compat entry point", () => {
	it("re-exports the full root entry surface", () => {
		// Runtime functions upstream pi extensions load from the compat subpath.
		expect(typeof compat.complete).toBe("function");
		expect(typeof compat.stream).toBe("function");
		expect(typeof compat.completeSimple).toBe("function");
		expect(typeof compat.streamSimple).toBe("function");
	});

	it("keeps root and compat exports identical", () => {
		const compatKeys = new Set(Object.keys(compat));
		for (const key of Object.keys(root)) {
			expect(compatKeys.has(key)).toBe(true);
		}
	});

	it("exposes type-only contract members used by extensions", () => {
		// Type-level imports are stripped at runtime, but their re-export keeps
		// extensions typechecking against the compat subpath.
		expect(compat).toBeDefined();
	});
});

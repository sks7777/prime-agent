import { describe, expect, it } from "vitest";
import { createCodingTools, createReadOnlyTools } from "../src/index.js";

describe("tool factory compat functions", () => {
	it("createCodingTools returns the fork's coding tool set with names", () => {
		const tools = createCodingTools(process.cwd());
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(typeof tool.name).toBe("string");
			expect(tool.name.length).toBeGreaterThan(0);
		}
		expect(tools.map((t) => t.name)).toContain("ipython");
	});

	it("createReadOnlyTools returns a subset of coding tools with names", () => {
		const readOnly = createReadOnlyTools(process.cwd());
		const coding = createCodingTools(process.cwd());
		const readOnlyNames = new Set(readOnly.map((t) => t.name));
		for (const name of coding.map((t) => t.name)) {
			if (name === "edit") expect(readOnlyNames.has(name)).toBe(false);
		}
		expect(readOnly.map((t) => t.name)).toContain("ipython");
	});
});

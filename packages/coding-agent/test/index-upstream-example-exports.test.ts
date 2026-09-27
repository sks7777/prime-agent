import { describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME, createBashTool, getAgentDir } from "../src/index.js";

// Upstream pi example extensions (e.g. examples/extensions/sandbox) import
// these names from "@earendil-works/pi-coding-agent". The fork's package
// entry must keep exporting them or such extensions break at load time.
describe("coding-agent entry exports required by upstream example extensions", () => {
	it("exports CONFIG_DIR_NAME as a non-empty string", () => {
		expect(typeof CONFIG_DIR_NAME).toBe("string");
		expect(CONFIG_DIR_NAME.length).toBeGreaterThan(0);
	});

	it("exports getAgentDir returning an absolute path", () => {
		expect(getAgentDir().length).toBeGreaterThan(0);
		expect(getAgentDir()).toMatch(/^\//);
	});

	it("exports createBashTool returning a bash tool", () => {
		const tool = createBashTool(process.cwd());
		expect(tool.name).toBe("bash");
		expect(typeof tool.execute).toBe("function");
	});
});

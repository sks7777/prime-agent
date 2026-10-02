import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.js";

describe("bash tool nonzero exit semantics", () => {
	it("resolves with output and the status line when a command exits nonzero", async () => {
		const bash = createBashTool(process.cwd());
		const result = await bash.execute("nonzero-exit-with-output", {
			command: `sh -c 'echo "probe-out"; exit 3'`,
		});
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toContain("probe-out");
		expect(text).toContain("Command exited with code 3");
	});

	it("resolves with the status line when a failing command produces no output", async () => {
		const bash = createBashTool(process.cwd());
		const result = await bash.execute("nonzero-exit-silent", { command: "false" });
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toContain("Command exited with code 1");
	});

	it("still rejects on timeout (execution failure, not an exit code)", async () => {
		const bash = createBashTool(process.cwd());
		await expect(bash.execute("timeout-still-error", { command: "sleep 5", timeout: 1 })).rejects.toThrow(
			/Command timed out after 1 seconds/,
		);
	});
});

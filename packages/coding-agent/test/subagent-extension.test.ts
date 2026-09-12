import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getPiInvocation } from "../examples/extensions/subagent/index.js";

describe("subagent extension getPiInvocation", () => {
	const originalArgv1 = process.argv[1];
	const originalExecArgv = [...process.execArgv];
	let tempDir: string;
	let tsEntry: string;

	const setup = () => {
		tempDir = mkdtempSync("subagent-extension-test-");
		tsEntry = join(tempDir, "cli.ts");
		writeFileSync(tsEntry, "// entrypoint");
		return tsEntry;
	};

	afterEach(() => {
		process.argv[1] = originalArgv1;
		process.execArgv.length = 0;
		process.execArgv.push(...originalExecArgv);
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("forwards execArgv for a TypeScript entrypoint so tsx can run it", () => {
		process.argv[1] = setup();
		process.execArgv.length = 0;
		process.execArgv.push("--import", "file:///repo/node_modules/tsx/dist/loader.mjs");

		const { command, args } = getPiInvocation(["--mode", "json", "-p", "--no-session"]);

		expect(command).toBe(process.execPath);
		expect(args.slice(0, 2)).toEqual(["--import", "file:///repo/node_modules/tsx/dist/loader.mjs"]);
		expect(args).toContain(tsEntry);
	});

	test("does not forward execArgv for a JavaScript entrypoint", () => {
		tempDir = mkdtempSync("subagent-extension-test-");
		const jsEntry = join(tempDir, "cli.js");
		writeFileSync(jsEntry, "// bundled entry\n");
		process.argv[1] = jsEntry;
		process.execArgv.length = 0;
		process.execArgv.push("--import", "file:///repo/node_modules/tsx/dist/loader.mjs");

		const { command, args } = getPiInvocation(["--mode", "json"]);

		expect(command).toBe(process.execPath);
		expect(args[0]).toBe(jsEntry);
	});
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";

describe("extension entry renderers", () => {
	let tempDir: string;
	let extensionsDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-entry-renderer-test-"));
		extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads an extension that registers an entry renderer", async () => {
		const extCode = `
			export default function(pi) {
				pi.registerEntryRenderer("workflow-entry", (entry, options, theme) => undefined);
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "entry-renderer.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toHaveLength(0);
		const ext = result.extensions.find((e) => e.path.includes("entry-renderer"));
		expect(ext).toBeDefined();
		expect(ext?.entryRenderers?.has("workflow-entry")).toBe(true);
	});
});

/**
 * Tests for ctx.isProjectTrusted() upstream-compatibility member.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("ExtensionContext.isProjectTrusted", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-is-project-trusted-"));
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("is exposed on ctx and command ctx and returns true", async () => {
		const extensionsDir = path.join(tempDir, "extensions");
		fs.mkdirSync(extensionsDir);
		const extCode = `
			export default function(pi) {
				pi.registerCommand("report-trust", {
					description: "Report trust",
					handler: async (_args, ctx) => {
						(globalThis as any).__trustResult = ctx.isProjectTrusted();
					},
				});
			}
		`;
		fs.writeFileSync(path.join(extensionsDir, "trust.ts"), extCode);

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);
		expect(result.errors).toHaveLength(0);
		const runner = new ExtensionRunner(result.extensions, result.runtime, tempDir, sessionManager, modelRegistry);

		const ctx = runner.createContext();
		expect(typeof ctx.isProjectTrusted).toBe("function");
		expect(ctx.isProjectTrusted()).toBe(true);

		const commandCtx = runner.createCommandContext();
		expect(commandCtx.isProjectTrusted()).toBe(true);

		// A command handler exercising the member must not throw.
		const command = runner.getCommand("report-trust");
		expect(command).toBeDefined();
		await command!.handler("", commandCtx);
		expect((globalThis as any).__trustResult).toBe(true);
	});
});

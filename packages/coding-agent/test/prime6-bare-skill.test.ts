import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getCodingAgentFixtureModel("anthropic", "claude-sonnet-4-5");

function lastUserText(context: any): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i]!;
		if (message.role === "user") {
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter((b: any) => b.type === "text")
						.map((b: any) => b.text)
						.join(" ");
		}
	}
	return "";
}

let tempDir: string;
let lastContext: any;

beforeEach(() => {
	tempDir = join(tmpdir(), `slash-bare-${Date.now()}-${Math.random()}`);
	mkdirSync(tempDir, { recursive: true });
	lastContext = undefined;
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function makeSkill(name: string) {
	const dir = join(tempDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, `---\nname: ${name}\ndescription: Test ${name}\n---\n\nBODY_${name.toUpperCase()}\n`);
	return { name, description: `Test ${name}`, filePath, baseDir: dir, disableModelInvocation: false };
}

function makeSession(skillNames: string[]) {
	const streamFn = ((_model: any, context: any) => {
		lastContext = context;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
		});
		return stream;
	}) as any;
	const agent = new Agent({
		convertToLlm,
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
		streamFn,
	});
	const resourceLoader = createTestResourceLoader();
	const skills = skillNames.map(makeSkill);
	(resourceLoader as any).getSkills = () => ({ skills, diagnostics: [] });
	return { agent, resourceLoader };
}

async function run(skillNames: string[], input: string) {
	const { agent, resourceLoader } = makeSession(skillNames);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const { SessionManager } = await import("../src/core/session-manager.js");
	const { SettingsManager } = await import("../src/core/settings-manager.js");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
		resourceLoader,
	});
	try {
		await session.prompt(input);
		return { ok: true as const };
	} catch (e) {
		return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
	} finally {
		session.dispose();
	}
}

const NAMES = [
	"agentsmd-generator",
	"golang-continuous-integration",
	"architect",
	"docx",
	"context7",
	"temporal-developer",
	"ozon-orders",
];

describe("bare skill-name invocation", () => {
	it("expands /<skill> into the skill block", async () => {
		for (const name of NAMES) {
			const r = await run(NAMES, `/${name}`);
			expect(r.ok, `${name}: ${(r as any).message ?? ""}`).toBe(true);
			expect(lastUserText(lastContext)).toContain(`BODY_${name.toUpperCase()}`);
		}
	});

	it("still expands /skill:<name>", async () => {
		const r = await run(NAMES, `/skill:agentsmd-generator`);
		expect(r.ok).toBe(true);
		expect(lastUserText(lastContext)).toContain("BODY_AGENTSMD-GENERATOR");
	});

	it("passes through an unknown slash token instead of throwing", async () => {
		const r = await run(NAMES, `/definitely-not-a-command-xyz`);
		expect(r.ok).toBe(true);
		expect(lastUserText(lastContext)).toContain("/definitely-not-a-command-xyz");
	});

	it("keeps builtin slash commands working", async () => {
		const r = await run(NAMES, `/help`);
		expect(r.ok).toBe(true);
	});
});

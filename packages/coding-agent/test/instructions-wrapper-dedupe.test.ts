import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { type Context, createAssistantMessageEventStream, type Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	convertToLlm,
	historyContainsInstructionsWrapper,
	stripRepeatedInstructionsWrapper,
} from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { createTestResourceLoader } from "./utilities.js";

const WRAPPER = "<system_instructions>\nbb bridge instructions\n</system_instructions>";

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 0 };
}

function assistant(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

// PRIME-40: bb attaches the <system_instructions> wrapper to the first prompt
// of every new connection (reconnect). Only the first copy may persist.
describe("historyContainsInstructionsWrapper", () => {
	it("detects a wrapper in a user message", () => {
		const history = [user(`${WRAPPER}\nНачало работы`), assistant("ok")];
		expect(historyContainsInstructionsWrapper(history)).toBe(true);
	});

	it("returns false without a wrapper or on empty history", () => {
		expect(historyContainsInstructionsWrapper([])).toBe(false);
		expect(historyContainsInstructionsWrapper([user("plain prompt"), assistant("ok")])).toBe(false);
	});
});

describe("stripRepeatedInstructionsWrapper", () => {
	it("keeps the wrapper when history has none (first turn of a session)", () => {
		const text = `${WRAPPER}\nплан согласован, начинай работу`;
		expect(stripRepeatedInstructionsWrapper(text, false)).toBe(text);
	});

	it("strips the repeated wrapper on reconnect and keeps the user text", () => {
		const text = `${WRAPPER}\nплан согласован, начинай работу`;
		expect(stripRepeatedInstructionsWrapper(text, true)).toBe("план согласован, начинай работу");
	});

	it("keeps text without a wrapper even when history has one", () => {
		const text = "обычный промпт";
		expect(stripRepeatedInstructionsWrapper(text, true)).toBe(text);
	});
});

// Integration: the strip must fire on the second (reconnect) submission and
// not on the first, through the real AgentSession prompt path.
describe("agent-session reconnect wrapper dedupe (PRIME-40)", () => {
	const model = getCodingAgentFixtureModel("anthropic", "claude-sonnet-4-5");
	let tempDir = "";

	function usage(): Usage {
		return {
			input: 7,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
		};
	}

	function lastUserText(context: Context): string {
		for (let i = context.messages.length - 1; i >= 0; i--) {
			const message = context.messages[i]!;
			if (message.role === "user") {
				return typeof message.content === "string"
					? message.content
					: message.content
							.filter((block): block is { type: "text"; text: string } => block.type === "text")
							.map((block) => block.text)
							.join(" ");
			}
		}
		return "";
	}

	it("persists the first wrapper and drops the repeated reconnect wrapper", async () => {
		tempDir = join(tmpdir(), `prime-wrapper-dedupe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const promptCalls: string[] = [];
		const streamFn: StreamFn = (_model, context) => {
			promptCalls.push(lastUserText(context));
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
						usage: usage(),
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await session.prompt(`${WRAPPER}\nпервый промпт`);
			await session.prompt(`${WRAPPER}\nповтор после реконнекта`);

			expect(promptCalls).toHaveLength(2);
			expect(promptCalls[0]).toContain(WRAPPER);
			expect(promptCalls[1]).not.toContain("<system_instructions>");
			expect(promptCalls[1]).toContain("повтор после реконнекта");
		} finally {
			session.dispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

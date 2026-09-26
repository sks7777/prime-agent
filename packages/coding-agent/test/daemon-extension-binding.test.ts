import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";

import { SessionManager } from "../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.js";

import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { bindActiveSessionState } from "../src/modes/daemon/daemon-extension-binding.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

describe("daemon extension binding", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-daemon-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-daemon", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((registeredModel) => ({
									id: registeredModel.id,
									name: registeredModel.name,
									api: registeredModel.api,
									reasoning: registeredModel.reasoning,
									input: registeredModel.input,
									cost: registeredModel.cost,
									contextWindow: registeredModel.contextWindow,
									maxTokens: registeredModel.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return runtime;
	}

	it("strips the duplicated partial message from broadcast message_update events", async () => {
		const runtime = await createRuntimeForTest(() => {}, ["streamed reply"]);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-slim",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-slim",
			lastEventSequence: 0,
		};
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("hello");

		const updates = outbound.filter(
			(message): message is Extract<DaemonOutbound, { type: "session_event" }> =>
				message.type === "session_event" && message.event.type === "message_update",
		);
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.event).toHaveProperty("message");
			expect(update.event).toHaveProperty("assistantMessageEvent");
			expect((update.event as { assistantMessageEvent: object }).assistantMessageEvent).not.toHaveProperty(
				"partial",
			);
		}
	});
	it("keeps a custom() request alive across multiple forwarded key events", async () => {
		const keys: string[] = [];
		let resolveCustom!: (value: string | undefined) => void;
		const customDone = new Promise<string | undefined>((resolve) => {
			resolveCustom = resolve;
		});

		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("daemon-custom", {
					description: "daemon custom",
					handler: async (_args, ctx) => {
						const result = await ctx.ui.custom<string>((tui, _theme, _keybindings, done) => {
							void tui;
							const component: Component & { handleInput?(data: string): void } = {
								render: (width: number) => [`custom widget width=${width}`],
								invalidate: () => {},
								handleInput: (data: string) => {
									keys.push(data);
									if (keys.length >= 3) done("done-after-3-keys");
								},
							};
							return component;
						});
						resolveCustom(result);
					},
				});
			},
			["custom reply"],
		);

		const outbound: DaemonOutbound[] = [];
		const state: ActiveSessionState = {
			activeSessionId: "active-custom",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-custom",
			lastEventSequence: 0,
		};
		// A client with extension UI support must be attached for custom() to proceed.
		// Production wiring: the base client set stays at the connection defaults
		// and the attach path writes negotiated capabilities per session.
		state.clients.add({
			id: "client-custom",
			socket: null as unknown as import("node:net").Socket,
			attachedActiveSessionIds: new Set(["active-custom"]),
			detachInput: () => {},
			supportsExtensionUi: true,
			capabilities: new Set(["attach_snapshot", "event_sequence"]),
			capabilitiesByActiveSessionId: new Map([["active-custom", new Set(["custom_widgets"])]]),
		});
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		// The command handler awaits custom(), which resolves only after done()
		// fires on the third forwarded key — so the prompt must not be awaited.
		const promptDone = runtime.session.prompt("/daemon-custom");
		let customRequestId: string | undefined;
		for (let i = 0; i < 100 && !customRequestId; i++) {
			await new Promise((resolve) => setImmediate(resolve));
			customRequestId = state.extensionUiRequests.keys().next().value;
		}
		expect(customRequestId).toBeDefined();
		const requestId = customRequestId!;

		const setWidgetMessages = () =>
			outbound.filter(
				(message): message is Extract<DaemonOutbound, { type: "extension_ui_request" }> =>
					message.type === "extension_ui_request" && message.method === "setWidget",
			);

		// The client forwards three key events with a reported width; the third
		// makes the component call done(), which resolves custom().
		for (const key of ["\x1b[A", "\x1b[B", "\r"]) {
			const pending = state.extensionUiRequests.get(requestId);
			expect(pending).toBeDefined();
			pending!.resolve({ key, width: 90 });
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(keys).toEqual(["\x1b[A", "\x1b[B", "\r"]);

		// The widget re-rendered at the client-reported width, not the fallback 120.
		const rendered = setWidgetMessages().flatMap((message) => message.payload.widgetLines);
		expect(rendered).toContain("custom widget width=90");

		// The request stays registered until the component calls done().
		expect(state.extensionUiRequests.has(requestId)).toBe(false);
		const finished = await customDone;
		expect(finished).toBe("done-after-3-keys");
		await promptDone;
		// Closing clears the widget.
		expect(setWidgetMessages().some((message) => message.payload.widgetLines === undefined)).toBe(true);
	});

	it("resolves custom() as undefined for a client without the custom_widgets capability", async () => {
		const outbound: DaemonOutbound[] = [];
		// An extension_ui-only client cannot answer a custom widget; custom() must
		// resolve undefined for it instead of pending forever.
		let customOutcome: "pending" | "undefined" = "pending";
		const runtime = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("daemon-custom-unanswered", {
					description: "daemon custom unanswered",
					handler: async (_args, ctx) => {
						const result = await ctx.ui.custom<string>(() => ({
							render: () => ["never rendered"],
							invalidate: () => {},
						}));
						customOutcome = result === undefined ? "undefined" : "pending";
					},
				});
			},
			["custom undefined reply"],
		);
		const state: ActiveSessionState = {
			activeSessionId: "active-unanswered",
			runtime,
			clients: new Set(),
			pendingAttaches: 0,
			extensionUiRequests: new Map(),
			eventGeneration: "generation-unanswered",
			lastEventSequence: 0,
		};
		state.clients.add({
			id: "client-dialogs-only",
			socket: null as unknown as import("node:net").Socket,
			attachedActiveSessionIds: new Set(["active-unanswered"]),
			detachInput: () => {},
			supportsExtensionUi: true,
			capabilities: new Set(["attach_snapshot", "event_sequence"]),
			capabilitiesByActiveSessionId: new Map(),
		});
		await bindActiveSessionState(state, {
			broadcast: (_state, message) => {
				outbound.push(message);
			},
			shutdown: () => {},
		});

		await runtime.session.prompt("/daemon-custom-unanswered");

		// No custom widget request was broadcast, and custom() resolved undefined
		// (the prompt turn completing proves it did not pend).
		expect(outbound.some((message) => message.type === "extension_ui_request")).toBe(false);
		expect(customOutcome).toBe("undefined");
	});
});

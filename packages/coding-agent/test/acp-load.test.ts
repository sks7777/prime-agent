import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

/**
 * A real AgentSessionRuntime over the faux provider: session replacement
 * (switchSession) must actually work, because ACP load switches this process's
 * runtime onto the registered session file.
 */
async function createRuntimeHost(options?: { persistSession?: boolean }) {
	const tempDir = join(tmpdir(), `pi-acp-load-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionsDir = join(tempDir, "sessions");

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("load-source-reply")]);

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			agentDir: tempDir,
			authStorage,
			cwd,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
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
	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager: options?.persistSession
			? SessionManager.create(tempDir, sessionsDir)
			: SessionManager.inMemory(tempDir, sessionsDir),
	});
	await runtimeHost.session.bindExtensions({});

	cleanups.push(async () => {
		await runtimeHost.dispose();
		faux.unregister();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
		}
	});

	return { runtimeHost, faux, tempDir, sessionsDir };
}

interface StartedMode {
	client: acp.ClientConnection;
	done: Promise<never>;
	toAgent: TransformStream<Uint8Array, Uint8Array>;
}

async function startMode(
	runtimeHost: Awaited<ReturnType<typeof createRuntimeHost>>["runtimeHost"],
): Promise<StartedMode> {
	const connection = new InProcessAgentConnection(runtimeHost);
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const done = runAcpModeWithConnection(connection, {
		stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
	});
	const client = acp
		.client({ name: "acp-load-test-client" })
		.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
	await client.agent.request("initialize", {
		protocolVersion: acp.PROTOCOL_VERSION,
		clientCapabilities: {},
	});
	return { client, done, toAgent };
}

async function stopMode(mode: StartedMode): Promise<void> {
	mode.client.close();
	await mode.toAgent.writable.close().catch(() => undefined);
	await mode.done.catch(() => undefined);
}

describe("ACP session/load", () => {
	it("advertises the loadSession capability in initialize", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const mode = await startMode(runtimeHost);
		try {
			const initialized = await mode.client.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			expect(initialized.agentCapabilities?.loadSession).toBe(true);
		} finally {
			await stopMode(mode);
		}
	});

	it("switches the runtime onto the registered source session file and keeps the id", async () => {
		const { runtimeHost, faux, tempDir, sessionsDir } = await createRuntimeHost({ persistSession: true });
		// Source process: admit an ACP session (registry write) and produce a
		// persisted user+assistant exchange so the load has history to restore.
		const sourceMode = await startMode(runtimeHost);
		const sourceSession = await sourceMode.client.agent.request("session/new", {
			cwd: tempDir,
			mcpServers: [],
		});
		expect(sourceSession.sessionId).toEqual(expect.any(String));

		faux.setResponses([fauxAssistantMessage("load-source-reply")]);
		await runtimeHost.session.prompt("hello for the load test");
		const preLoadConnection = new InProcessAgentConnection(runtimeHost);
		const preLoadState = await preLoadConnection.getState();
		const sourceFile = preLoadState.sessionFile;
		expect(sourceFile).toBeTruthy();
		const sourceEntries = readFileSync(sourceFile!, "utf8").split("\n").filter(Boolean).length;

		// Resume process: bb spawns a fresh process; simulate it with a second
		// mode over the same runtime (same registry directory).
		const resumeMode = await startMode(runtimeHost);
		try {
			// The load response is intentionally empty: the bridge keeps the
			// requested session id, and models/configOptions are optional.
			await resumeMode.client.agent.request("session/load", {
				sessionId: sourceSession.sessionId,
				cwd: tempDir,
				mcpServers: [],
			});

			// The runtime now sits on the source file with its history.
			const loadedConnection = new InProcessAgentConnection(runtimeHost);
			const loadedState = await loadedConnection.getState();
			expect(loadedState.sessionFile).toBe(sourceFile);
			expect(loadedState.sessionDir).toBe(sessionsDir);
			const loadedManager = SessionManager.open(loadedState.sessionFile!);
			const texts = loadedManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) =>
					typeof (entry as { message: { content: unknown } }).message.content === "string"
						? ((entry as { message: { content: string } }).message.content as string)
						: JSON.stringify((entry as { message: { content: unknown } }).message.content),
				);
			expect(texts.join("\n")).toContain("hello for the load test");

			// A prompt on the loaded session id reaches the agent and appends history.
			faux.setResponses([fauxAssistantMessage("post-load-reply")]);
			const result = await resumeMode.client.agent.request("session/prompt", {
				sessionId: sourceSession.sessionId,
				prompt: [{ type: "text", text: "after resume" }],
			});
			expect(result.stopReason).toBe("end_turn");
			const afterEntries = readFileSync(loadedState.sessionFile!, "utf8").split("\n").filter(Boolean);
			expect(afterEntries.length).toBeGreaterThan(sourceEntries);
			const afterManager = SessionManager.open(loadedState.sessionFile!);
			const afterTexts = afterManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) =>
					typeof (entry as { message: { content: unknown } }).message.content === "string"
						? ((entry as { message: { content: string } }).message.content as string)
						: JSON.stringify((entry as { message: { content: unknown } }).message.content),
				);
			expect(afterTexts.join("\n")).toContain("after resume");

			// The registry entry now points the resumed id at the live file so a
			// later fork or load in another process keeps resolving.
			const registry = JSON.parse(
				readFileSync(join(loadedState.sessionDir!, "acp-session-registry.json"), "utf8"),
			) as Record<string, { sessionFile: string | null }>;
			expect(registry[sourceSession.sessionId]?.sessionFile).toBe(sourceFile);
		} finally {
			await stopMode(resumeMode);
			await stopMode(sourceMode);
		}
	});

	it("rejects load requests whose cwd differs from the registered session's cwd", async () => {
		const { runtimeHost, tempDir } = await createRuntimeHost({ persistSession: true });
		const sourceMode = await startMode(runtimeHost);
		try {
			const sourceSession = await sourceMode.client.agent.request("session/new", {
				cwd: tempDir,
				mcpServers: [],
			});

			// A second mode (fresh process simulation) loading with a different cwd
			// must be rejected so the client falls back to a fresh session.
			const resumeMode = await startMode(runtimeHost);
			try {
				const otherDir = join(tempDir, "other-workspace");
				mkdirSync(otherDir, { recursive: true });
				await expect(
					resumeMode.client.agent.request("session/load", {
						sessionId: sourceSession.sessionId,
						cwd: otherDir,
						mcpServers: [],
					}),
				).rejects.toThrow();

				// The slot stays free after the rejected load.
				const created = await resumeMode.client.agent.request("session/new", {
					cwd: tempDir,
					mcpServers: [],
				});
				expect(created.sessionId).toEqual(expect.any(String));
			} finally {
				await stopMode(resumeMode);
			}
		} finally {
			await stopMode(sourceMode);
		}
	});

	it("rejects load requests for unknown session ids and frees the slot", async () => {
		const { runtimeHost, tempDir } = await createRuntimeHost({ persistSession: true });
		const mode = await startMode(runtimeHost);
		try {
			await expect(
				mode.client.agent.request("session/load", {
					sessionId: "00000000-0000-0000-0000-000000000000",
					cwd: tempDir,
					mcpServers: [],
				}),
			).rejects.toThrow();
			// A failed load must leave the single-session slot free.
			const created = await mode.client.agent.request("session/new", {
				cwd: tempDir,
				mcpServers: [],
			});
			expect(created.sessionId).toEqual(expect.any(String));
		} finally {
			await stopMode(mode);
		}
	});
});

import { existsSync, readFileSync, rmSync } from "node:fs";
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
 * (switchSession) must actually work, because ACP fork switches this process's
 * runtime onto the branched session file.
 */
async function createRuntimeHost(options?: { persistSession?: boolean }) {
	const tempDir = join(tmpdir(), `pi-acp-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const sessionsDir = join(tempDir, "sessions");

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("fork-source-reply")]);

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
		.client({ name: "acp-fork-test-client" })
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

describe("ACP session/fork", () => {
	it("advertises the fork capability in initialize", async () => {
		const { runtimeHost } = await createRuntimeHost();
		const mode = await startMode(runtimeHost);
		try {
			const initialized = await mode.client.agent.request("initialize", {
				protocolVersion: acp.PROTOCOL_VERSION,
				clientCapabilities: {},
			});
			expect(initialized.agentCapabilities?.sessionCapabilities?.fork).not.toBeNull();
			expect(initialized.agentCapabilities?.sessionCapabilities?.close).not.toBeNull();
		} finally {
			await stopMode(mode);
		}
	});

	it("clones the registered source session into a new branched session file", async () => {
		const { runtimeHost, faux, tempDir, sessionsDir } = await createRuntimeHost({ persistSession: true });
		// Source process: admit an ACP session (registry write) and produce a
		// persisted user+assistant exchange so the tip fork has history to copy.
		const sourceMode = await startMode(runtimeHost);
		const sourceSession = await sourceMode.client.agent.request("session/new", {
			cwd: tempDir,
			mcpServers: [],
		});
		expect(sourceSession.sessionId).toEqual(expect.any(String));

		const sourceConnection = new InProcessAgentConnection(runtimeHost);
		faux.setResponses([fauxAssistantMessage("fork-source-reply")]);
		await runtimeHost.session.prompt("hello from the source session");
		const preForkState = await sourceConnection.getState();
		const sourceFile = preForkState.sessionFile;
		expect(sourceFile).toBeTruthy();
		const sourceEntriesBefore = readFileSync(sourceFile!, "utf8").split("\n").filter(Boolean).length;

		// Fork process: bb spawns a fresh process for the forked thread; simulate
		// it with a second mode over the same runtime (same registry directory).
		const forkMode = await startMode(runtimeHost);
		try {
			const forked = await forkMode.client.agent.request("session/fork", {
				sessionId: sourceSession.sessionId,
				cwd: tempDir,
			});
			expect(forked.sessionId).toEqual(expect.any(String));
			expect(forked.sessionId).not.toBe(sourceSession.sessionId);

			// The branched copy exists on disk, points at the source as parent, and
			// carries the source history.
			const forkConnection = new InProcessAgentConnection(runtimeHost);
			const forkedState = await forkConnection.getState();
			expect(forkedState.sessionFile).toBeTruthy();
			expect(forkedState.sessionFile).not.toBe(sourceFile);
			expect(forkedState.sessionDir).toBe(sessionsDir);
			const branchedEntries = readFileSync(forkedState.sessionFile!, "utf8").split("\n").filter(Boolean);
			expect(branchedEntries.length).toBeGreaterThanOrEqual(sourceEntriesBefore);
			const branchedHeader = JSON.parse(branchedEntries[0]!) as { parentSession?: string; id?: string };
			expect(branchedHeader.parentSession).toBe(sourceFile);
			expect(branchedHeader.id).toBe(forkedState.sessionId);
			const branchedManager = SessionManager.open(forkedState.sessionFile!);
			const texts = branchedManager
				.getEntries()
				.filter((entry) => entry.type === "message")
				.map((entry) =>
					typeof (entry as { message: { content: unknown } }).message.content === "string"
						? ((entry as { message: { content: string } }).message.content as string)
						: JSON.stringify((entry as { message: { content: unknown } }).message.content),
				);
			expect(texts.join("\n")).toContain("hello from the source session");

			// The source file gained nothing from the fork.
			const sourceEntriesAfter = readFileSync(sourceFile!, "utf8").split("\n").filter(Boolean).length;
			expect(sourceEntriesAfter).toBe(sourceEntriesBefore);
		} finally {
			await stopMode(forkMode);
			await stopMode(sourceMode);
		}
	});

	it("rejects fork requests for unknown session ids and frees the slot", async () => {
		const { runtimeHost, tempDir } = await createRuntimeHost({ persistSession: true });
		const mode = await startMode(runtimeHost);
		try {
			await expect(
				mode.client.agent.request("session/fork", {
					sessionId: "00000000-0000-0000-0000-000000000000",
					cwd: tempDir,
				}),
			).rejects.toThrow();
			// A failed fork must leave the single-session slot free.
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

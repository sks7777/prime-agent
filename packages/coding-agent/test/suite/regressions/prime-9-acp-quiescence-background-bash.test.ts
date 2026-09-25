import { resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { type HostRequestHandlers, ReplKernelManager } from "../../../src/core/kernel/index.js";
import { ASYNC_BASH_COMPLETION_CUSTOM_TYPE } from "../../../src/core/messages.js";
import { canPassivateSession } from "../../../src/core/session-action-store.js";
import { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import { createHarness, type Harness } from "../harness.js";

const runtimeDir = resolve(__dirname, "../../../../../prime-agent-runtime");
const python = resolve(runtimeDir, ".venv/bin/python");

interface KernelSession {
	_ipythonKernelProvisioner?: IpythonKernelProvisioner;
	_createKernelHostHandlers(): HostRequestHandlers;
}

function passivationAllowed(session: AgentSession): boolean {
	return canPassivateSession(
		{
			isSessionActive: session.isSessionActive,
			attachedClients: 0,
			hasRegisteredCronJob: false,
			lastActivityAt: 0,
			hasParent: true,
			hasNonPassiveDescendants: false,
			isHydrating: false,
		},
		1,
		120_000,
	);
}

// Boots a real Python kernel: runs in the dedicated kernel-heavy lane, not the default shard.
describe("#PRIME-9 ACP quiescence ignores left-running background bash", () => {
	let harness: Harness | undefined;
	let manager: ReplKernelManager | undefined;

	afterEach(async () => {
		await manager?.shutdown();
		harness?.cleanup();
		vi.restoreAllMocks();
	});

	async function start(): Promise<{ session: AgentSession; kernel: ReplKernelManager; deliveryStates: boolean[] }> {
		harness = await createHarness({ tools: [], rlmDepth: 1, withConfiguredAuth: true });
		const session = harness.session;
		const internals = session as unknown as KernelSession;
		const hostHandlers = internals._createKernelHostHandlers();
		const completed = hostHandlers["bash.completed"]!;
		// Sample the unsettled-completion window inside the delivery path itself.
		const deliveryStates: boolean[] = [];
		hostHandlers["bash.completed"] = async (payload) => {
			deliveryStates.push(manager?.hasUnsettledBashCompletions ?? false);
			return completed(payload);
		};
		manager = new ReplKernelManager({
			python,
			cwd: harness.tempDir,
			env: { PYTHONPATH: resolve(runtimeDir, "src") },
			hostHandlers,
		});
		const provisioner = new IpythonKernelProvisioner(harness.tempDir);
		vi.spyOn(provisioner, "manager", "get").mockReturnValue(manager);
		internals._ipythonKernelProvisioner = provisioner;
		return { session, kernel: manager, deliveryStates };
	}

	it("lets strong quiescence settle while a left-running background process stays alive", {
		tags: ["kernel-heavy"],
	}, async () => {
		const { session, kernel, deliveryStates } = await start();
		const started = await kernel.execute("from rlm import bash\nhandle = bash('sleep 600')\nhandle.pid");
		expect(started.status).toBe("ok");
		expect(Number(started.result)).toBeGreaterThan(0);

		// The running handle keeps the worker resident (passivation hold is unchanged).
		expect(session.isSessionActive).toBe(true);
		expect(passivationAllowed(session)).toBe(false);
		expect(manager!.hasUnsettledBashCompletions).toBe(false);

		// But its liveness is environment state: the terminal barrier must settle.
		await expect(session.waitForRlmQuiescence()).resolves.toBeUndefined();
		expect(passivationAllowed(session)).toBe(false);

		harness!.setResponses([fauxAssistantMessage("Inspected the completed command.")]);
		await kernel.execute("handle.kill()");
		// The completed handle's notice queues the follow-up turn; idle implies it ran.
		await session.waitForIdle();
		expect(session.getLastAssistantText()).toBe("Inspected the completed command.");

		// The completion notice was delivered through a tracked unsettled window.
		expect(deliveryStates).toEqual([true]);
		await expect(session.waitForRlmQuiescence()).resolves.toBeUndefined();
		expect(manager!.hasUnsettledBashCompletions).toBe(false);
		expect(passivationAllowed(session)).toBe(true);
		expect(
			session.messages.filter(
				(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
			),
		).toHaveLength(1);
	});
});

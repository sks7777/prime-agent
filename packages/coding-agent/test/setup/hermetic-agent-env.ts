/**
 * Isolate test runs from the host agent runtime environment.
 *
 * Vitest runs are frequently launched from inside an agent session, which
 * exports the RLM runtime environment (`RLM_DEPTH`, `RLM_MAX_DEPTH`,
 * `RLM_SESSION_DIR`, `RLM_HARNESS_STATE_DIR`), the daemon-worker internals
 * (`PRIME_AGENT_INTERNAL_*`), and points the agent config dir at the
 * developer's real `~/.prime/agent`. Tests must exercise their own fixtures:
 * RLM max-depth fallbacks would report `source: "env"`, and the harness
 * digest would read the developer's real global harness memories instead of
 * the test fixture.
 *
 * Sandbox the agent config dir and drop the ambient RLM and daemon-worker
 * variables before any test file runs. Tests that need specific values set
 * them via `vi.stubEnv` (or their own fixtures), which overrides this setup.
 *
 * The env names come from a leaf module on purpose: importing src/config.js
 * here would load its whole module graph (including utils/child-process.ts)
 * into the module cache before per-test vi.mock("node:child_process")
 * registration, defeating those mocks for every test file.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_AGENT_DIR, ENV_LEGACY_SESSION_DIR, ENV_SESSION_DIR } from "../../src/core/env-names.js";

const sandboxAgentDir = mkdtempSync(join(tmpdir(), "prime-agent-vitest-agent-dir-"));
process.env[ENV_AGENT_DIR] = sandboxAgentDir;
// Third-party pi extensions read the pi-prefixed alias; point it at the
// sandbox too so the alias cannot disagree with the agent dir under test.
process.env.PI_CODING_AGENT_DIR = sandboxAgentDir;

for (const key of [
	ENV_SESSION_DIR,
	ENV_LEGACY_SESSION_DIR,
	"RLM_DEPTH",
	"RLM_MAX_DEPTH",
	"RLM_SESSION_DIR",
	"RLM_HARNESS_STATE_DIR",
	"RLM_GLOBAL_HARNESS_STATE_DIR",
] as const) {
	delete process.env[key];
}

for (const key of Object.keys(process.env)) {
	if (key.startsWith("PRIME_AGENT_INTERNAL_")) {
		delete process.env[key];
	}
}

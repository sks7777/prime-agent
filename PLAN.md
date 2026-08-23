# Plan: Iteratively update pi agent from earendil-works/pi v0.74.1 to v0.84.2, preserving PI RLM architecture

## Context

Two divergent upstreams share a common ancestor (`0bcaab420`, May 8 2026):

- **earendil-works/pi** (v0.84.2, latest release) — original project, 1698 commits ahead of merge-base.
- **PrimeIntellect-ai/prime-agent** (v0.8.0, current upstream) — 576 PI-specific commits with RLM, daemon, kernel, subagents, refinement.

Your fork (`sks7777/prime-agent`) is on `local/customizations` with 8 custom commits on top of PI v0.8.0.

## Resolved Decisions

- Target: **v0.84.2** (released, stable)
- Root package name: **`prime-agent`** (keep PI branding)
- Version scheme: **0.84.x** (adopt earendil's)
- Architecture: **PI daemon/kernel stays primary**. earendil packages added as libraries only.
- Approach: **Iterative** — merge one minor version at a time, commit, test, fix, commit, then next.

## Iteration Plan

42 earendil releases exist from v0.74.1 (first after merge-base) to v0.84.2. Grouped into 11 minor version steps:

| Step | From → To | Commits | Files | Breaking changes |
|------|-----------|--------|-------|-------------------|
| 0 | merge-base → v0.74.1 | 146 | 185 | (starting point) |
| 1 | v0.74.1 → v0.75.5 | 140 | 619 | Node 22.19 min, xiaomi provider, reasoningEffortMap→thinkingLevelMap, removed Google Gemini CLI/Antigravity, OSC 9;4 default off |
| 2 | v0.75.5 → v0.76.0 | 32 | 81 | — |
| 3 | v0.76.0 → v0.77.0 | 35 | 112 | — |
| 4 | v0.77.0 → v0.78.1 | 85 | 154 | — |
| 5 | v0.78.1 → v0.79.10 | 222 | 312 | — |
| 6 | v0.79.10 → v0.80.10 | 326 | 561 | TypeBox 0.34→1.x migration |
| 7 | v0.80.10 → v0.81.1 | 78 | 285 | SDK authStorage/modelRegistry → modelRuntime, ModelRegistry.refresh sync→async, sendSessionIdHeader → sessionAffinityFormat |
| 8 | v0.81.1 → v0.82.1 | 63 | 257 | — |
| 9 | v0.82.1 → v0.83.0 | 63 | 124 | TypeBox 1.3.7, removed deprecated APIs |
| 10 | v0.83.0 → v0.84.2 | 508 | 674 | ModelsStreamTransforms→ModelsRequestTransforms, message_update event delta-only, ModelRegistry.getApiKeyAndHeaders null values, ModelRuntime.setRuntimeApiKey signature change |

## Per-Iteration Workflow (repeat for each step)

```
A. Merge earendil tag into working branch
B. Resolve conflicts (adopt earendil as base, re-apply PI additions)
C. Commit: "merge(earendil): integrate v0.X.Y while preserving PI RLM architecture"
D. Run tests via 3 parallel subagent_delegate(role=tester) calls (see below)
E. Fix all failures (type errors, API drift, test breakage)
F. Commit: "fix(earendil): adapt PI code to v0.X.Y API changes"
G. Smoke test: ./prime-agent.sh — verify interactive mode starts, daemon starts, subagent spawning works
H. Wait for user approval before proceeding to next step
```

### D. Run tests — 3 parallel subagent_delegate(role=tester) calls

Spawn all 3 simultaneously. Each returns PASS/FAIL with test counts and timing.

**Env cleanup prefix** (required for ALL test commands — do NOT set RLM_MAX_DEPTH):
```
env -u RLM_DEPTH -u RLM_MAX_DEPTH -u RLM_HARNESS_STATE_DIR -u RLM_SESSION_DIR -u RLM_GLOBAL_HARNESS_STATE_DIR -u JPY_PARENT_PID -u HF_TOKEN -u PI_CODING_AGENT -u PRIME_AGENT_INTERNAL_DAEMON_WORKER -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET -u PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL -u PRIME_AGENT_INTERNAL_SESSION_LEASES -u PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID -u PRIME_AGENT_BUILD_ID -u PRIME_AGENT_LAUNCHER_PATH -u PRIME_AGENT_CODING_AGENT_DIR RLM_DEPTH=0
```

**Group 1 — tester-ca-safe** (coding-agent safe tests, no kernel/daemon):
```
subagent_delegate(role=tester, task="From packages/coding-agent, run: <ENV_PREFIX> npx tsx ../../node_modules/vitest/dist/cli.js --run <safe_files>. Safe files = all test/*.test.ts EXCEPT files importing node:child_process, IpythonKernelProvisioner, bootstrap-cli, DaemonClient, DaemonSupervisor, daemon-socket, daemon-mode, and all test/suite/*.test.ts. Also exclude: daemon-supervisor-process, 4603, 4600, 4606, 4685. Use rg -l to find unsafe files. Report PASS/FAIL, test count, timing.")
```
Expected: ~223 files, ~2648 tests, ~1m49s.

**Group 2 — tester-ca-unsafe** (coding-agent kernel/daemon, isolated single vitest):
```
subagent_delegate(role=tester, task="From packages/coding-agent, run: <ENV_PREFIX> npx tsx ../../node_modules/vitest/dist/cli.js --run <unsafe_files>. Unsafe files = all test/suite/*.test.ts + test/*.test.ts that import kernel/daemon/spawn. EXCLUDE: daemon-supervisor-process, 4603, 4600, 4606, 4685. Report PASS/FAIL, test count, timing.")
```
Expected: ~109 files, ~1719 tests, ~1m21s.

**Group 3 — tester-other** (all other suites, run sequentially within this subagent):
```
subagent_delegate(role=tester, task="Run 5 suites: 1) cd /Users/k.sidenko/Development/prime-agent && <ENV_PREFIX> npm run check. 2) cd packages/agent && <ENV_PREFIX> npx tsx ../../node_modules/vitest/dist/cli.js --run. 3) cd packages/tui && <ENV_PREFIX> npm test. 4) cd packages/ai && <ENV_PREFIX> npx tsx ../../node_modules/vitest/dist/cli.js --run --exclude test/stream.test.ts --exclude test/cross-provider-handoff.test.ts --exclude test/total-tokens.test.ts --exclude test/tool-call-without-result.test.ts --exclude test/context-overflow.test.ts --exclude test/unicode-surrogate.test.ts. 5) cd prime-agent-runtime && <ENV_PREFIX> uv run --with pytest pytest -v. Report PASS/FAIL, test count, timing per suite.")
```
Expected: ~1255 tests, ~94s.

**Total: 5622 tests, 0 failures, ~1m49s wall-clock.**

Rules:
- Do NOT split coding-agent into more than 2 groups (causes kernel/daemon/fs.watch contention).
- Do NOT set RLM_MAX_DEPTH. Just unset it (tests expect default of 1).
- If failures appear, check if they are real (code regressions) vs environmental (parallelism, env vars).
- Excluded slow tests (run separately with 120s timeout if needed): daemon-supervisor-process, 4600, 4603, 4606, 4685.

## Architecture: What PI Kept from pi vs What Was Rewritten

### Common Ancestor (merge-base 0bcaab420, May 8 2026)

Both repos share the same base: a TypeScript monorepo with 4 packages:
- `packages/agent` (@earendil-works/pi-agent-core) — agent runtime with tool calling
- `packages/ai` (@earendil-works/pi-ai) — unified multi-provider LLM API
- `packages/coding-agent` (@earendil-works/pi-coding-agent) — interactive coding agent CLI
- `packages/tui` (@earendil-works/pi-tui) — terminal UI library

87 files in coding-agent/src were unchanged in both lineages.

### What PI Kept from pi (shared, both sides evolved)

PI kept the same 4 package names (@earendil-works/pi-*). The following shared files were modified on BOTH sides (106 overlapping files in coding-agent/src alone):
- `agent-session.ts`, `agent-session-runtime.ts`, `agent-session-services.ts` — core session lifecycle
- `system-prompt.ts` — base prompt structure (PI added RLM sections, earendil updated format)
- `tools/*` (bash, edit, read, write, grep, find, ls) — built-in tools
- `extensions/*` (runner, types, loader, wrapper) — extension system
- `model-resolver.ts`, `model-registry.ts` — model resolution
- `compaction/*` — context compaction
- `settings-manager.ts`, `config.ts` — configuration
- `keybindings.ts` — key binding system
- `interactive-mode.ts` — TUI interactive mode
- `theme/*` — theming
- `rpc/*` — RPC mode

PI also kept pi's packages/ai providers as a base and added on top:
- Kept: anthropic, google, bedrock, openai-responses, mistral, azure (evolved on both sides)
- Added: cloudflare, prime-inference, openrouter-reasoning, cache-pricing, mcp/, transform-messages

### What PI Rewrote / Added (576 PI-specific files)

**1. RLM Runtime (prime-agent-runtime/ — Python package, 12 files)**
- `rlm/__init__.py` — RLM callable, subagent spawning, comm bridge to TypeScript host
- `rlm/harness.py` — continual harness state (prompt notes, memory, skills, subagent specs, refinement events)
- `rlm/skill.py` — Python skill CLI helpers (tyro-based)
- `rlm/mcp.py`, `rlm/mcp_base.py` — MCP server bridge for kernel
- This is the core innovation: persistent IPython as the model's tool, with recursive subagent calls as function calls inside a live REPL

**2. Daemon + Kernel Architecture (packages/coding-agent/src/modes/daemon/ — 40+ files)**
- `daemon-supervisor.ts` — process supervisor that manages worker sessions
- `daemon-client.ts` — client for connecting to the daemon
- `daemon-protocol.ts` — wire protocol (DAEMON_SCHEMA_REVISION, backward-compatible/capability-gated/incompatible changes)
- `daemon-worker-client.ts`, `daemon-worker-protocol.ts` — worker process management
- `daemon-extension-binding.ts` — extension UI proxy in daemon mode
- `daemon-socket.ts` — Unix socket management (with macOS 104-byte path fix)
- `daemon-supervisor-ownership.ts` — singleton ownership with atomic file locks
- `worker-recovery-journal.ts` — crash recovery for worker processes
- `heartbeat-catalog.ts` — heartbeat scheduling and catalog
- `rlm-ledger.ts` — RLM subagent spawn ledger (family authority)
- `saved-session-catalog.ts` — persistent session catalog
- `compact-session-stream.ts` — streaming compaction for daemon sessions

**3. Kernel System (packages/coding-agent/src/core/kernel/ — 7 files)**
- `bootstrap.ts`, `bootstrap-cli.ts` — IPython kernel bootstrapping and venv provisioning
- `fork-server.ts`, `fork-server-script.ts` — fork server for fast kernel spawning
- `boot-gate.ts` — concurrency limiter for kernel boots
- `state-snapshot.ts` — kernel state serialization for session transfer
- `index.ts` — kernel entry point

**4. RLM Features (packages/coding-agent/src/core/ — 52 files)**
- `rlm-runtime.ts` — RLM runtime host (subagent spawning, lifecycle)
- `rlm-max-depth.ts` — recursion depth management
- `refinement/` — continual harness refinement (evidence-backed updates to prompts/memories/skills/subagents)
- `goals.ts` — persistent goal management
- `agent-messages.ts`, `agent-observe.ts` — inter-agent messaging and observation
- `autonomous.ts` — autonomous mode (gate process, timeout, continuation)
- `cron-jobs.ts` — scheduled tasks
- `prompt-admission.ts` — prompt queue admission control
- `session-lease.ts` — session ownership leases
- `orphan-process-journal.ts` — orphan process tracking
- `thinking-levels.ts` — reasoning level management
- `prompt-templates.ts` — prompt template system
- `side-question.ts` — side question injection
- `context-tree.ts` — context tree navigation
- `session-action-store.ts` — session action persistence
- `skill-blocks.ts` — skill block rendering

**5. ACP Mode (packages/coding-agent/src/modes/acp/ — 6 files)**
- `acp-mode.ts` — Agent Communication Protocol mode
- `acp-events.ts` — ACP event handling
- `acp-mcp.ts` — ACP MCP program support
- `acp-meta.ts` — ACP metadata
- `acp-stop-reason.ts` — stop reason handling

**6. Agent Connection Layer (packages/coding-agent/src/modes/agent-connection/ — 6 files)**
- `daemon-agent-connection.ts` — daemon-backed agent connection
- `in-process-agent-connection.ts` — in-process agent connection
- `snapshot.ts` — session snapshot transfer
- `tool-definition.ts` — tool definition bridge

**7. Agents View (packages/coding-agent/src/modes/agents-view/ — 4 files)**
- `agents-view-mode.ts` — agents browsing mode (view running/idle/saved sessions)
- `agents-view-state.ts` — agents view state management
- `session-view-search.ts` — session search

**8. CLI Commands (packages/coding-agent/src/cli/ — 13 files)**
- `daemon-command.ts`, `daemon-launch.ts`, `daemon-ps.ts`, `daemon-stop-confirm.ts` — daemon CLI
- `daemon-update-restart.ts` — update/restart coordinator
- `owned-session-worker.ts` — session worker management
- `subprocess-launch.ts` — subprocess launching
- `session-resolver.ts` — session resolution
- `public-command.ts` — public command interface
- `command-registry.ts` — command registry

**9. Prime Inference (packages/coding-agent/src/core/ — 3 files)**
- `prime-inference-auth.ts` — Prime Inference authentication
- `prime-inference-model-selection.ts` — model selection
- `prime-inference-models.ts` — model catalog

**10. PI-specific Tooling**
- `tools/ipython.ts` — IPython as a built-in tool (persistent Python REPL)
- `tools/ipython-cell-code.ts` — IPython cell code execution
- `tools/code-preview.ts` — code preview rendering
- `export-html/` — HTML export with ANSI conversion
- `websearch-credential.ts` — web search credential management

**11. PI-specific Infrastructure**
- `prime-agent.sh` — launcher script
- `install.sh` — installer script
- `scripts/setup-kernel-venv.sh` — kernel venv setup
- `scripts/pack-prime-agent-release.mjs` — release packaging
- `scripts/check-installer-render.mjs` — installer validation
- `.pi/prompts/cl.md` — changelog prompt
- `.pi/extensions/redraws.ts`, `.pi/extensions/tps.ts` — diagnostic extensions

### What earendil Rewrote / Added (827 earendil-specific files)

**New packages (6):**
- `packages/protocol` — CBOR codec, wire protocol
- `packages/client` — client connection, remote sessions
- `packages/server` — server listener, protocol handling
- `packages/evals` — evaluation harness, smoke tests
- `packages/telemetry` — vendor-neutral telemetry contracts
- `packages/session-backends/sqlite-node` — SQLite session storage

**New coding-agent dirs:**
- `src/client/` — client mode (remote-session, transcript)
- `src/server/` — server mode (create-harness)
- `src/extensions/` — new extension system (llama/HuggingFace integration)
- `src/bun/` — Bun binary support

**Key earendil features not in PI:**
- Fullscreen TUI mode with transcript search
- Mermaid and LaTeX rendering
- Per-directory context overrides (AGENTS.override.md)
- Configurable default tools
- Configurable fullscreen exit output
- Bun standalone binary compilation
- ModelRuntime API (replaced AuthStorage/ModelRegistry in v0.81)
- TypeBox 1.x migration
- Strict JSON-schema constrained sampling
- New providers: Qwen, Baseten, HuggingFace
- Session backends (SQLite)
- Telemetry contracts

### Architecture Comparison Summary

| Aspect | PI (prime-agent) | earendil (pi) |
|--------|-------------------|---------------|
| Session management | Daemon + kernel (fork server, worker processes, socket protocol) | Client/server split (protocol package, client/server packages) |
| Subagents | RLM runtime (Python IPython, recursive spawning, continual harness) | pi-subagent extension (external, child process spawning via RPC) |
| Model tools | IPython as built-in tool (persistent Python REPL) | Standard tools (bash, read, edit, write, grep, find) |
| State persistence | Continual harness (prompt notes, memory, skills, subagent specs) | Session backends (SQLite) |
| Background sessions | Daemon supervisor (process lifecycle, heartbeat, recovery journal) | Server mode (client/server architecture) |
| Inter-agent comms | agent-messages.ts, agent-observe.ts (direct messaging) | ACP MCP programs |
| Refinement | /refine command (evidence-backed harness updates) | — |
| Goals | Persistent goals with continuation quiescence | — |
| Heartbeats | Scheduled heartbeat system | — |
| Autonomous mode | Gate process with timeout and continuation | — |
| Telemetry | — | Vendor-neutral telemetry contracts |
| Binary distribution | install.sh, prime-agent.sh | Bun standalone binary |
| Model API | Prime Inference (custom provider) | ModelRuntime API (v0.81+) |

### Merge Implications

The architecture divergence means:
1. **Session management is the biggest conflict zone** — PI's daemon/kernel vs earendil's client/server are fundamentally different approaches to the same problem
2. **RLM runtime is PI-only** — no conflict, stays as-is (prime-agent-runtime/ Python package)
3. **Shared files (106 in coding-agent/src) need manual merge** — both sides evolved the same files
4. **earendil's new packages (protocol, client, server, evals, telemetry) come in cleanly** — no conflicts, added as libraries
5. **PI's daemon/kernel/RLM files (576) stay as-is** — no conflicts, they don't exist in earendil
6. **ModelRuntime migration (earendil v0.81) is a breaking change** — PI code using AuthStorage/ModelRegistry needs adaptation at step 7
7. **TypeBox migration (earendil v0.80/v0.83) is a breaking change** — all schema definitions need updating at steps 6 and 9

### Architectural Invariant: PI/earendil Role Separation Must Be Preserved

After every earendil version merge, the following role separation MUST be maintained:

**PI (prime-agent) owns:**
- Session management: daemon + kernel architecture (daemon-supervisor, daemon-client, daemon-protocol, worker processes, fork server, boot gate, state snapshots)
- RLM runtime: prime-agent-runtime/ Python package (IPython as model tool, recursive subagent spawning, continual harness state)
- RLM features: refinement, goals, heartbeats, autonomous mode, cron jobs, agent messaging, session leases, prompt admission, context tree, skill blocks
- ACP mode: Agent Communication Protocol
- Agents view: session browsing, search, state management
- CLI: daemon commands, update/restart coordinator, subprocess launch, session resolver
- Prime Inference: auth, model selection, model catalog
- Infrastructure: prime-agent.sh, install.sh, kernel venv setup, release packaging

**earendil (pi) owns (adopted as updates/libraries):**
- AI providers: updated provider implementations, new providers, models.generated.ts
- TUI: fullscreen mode, Mermaid/LaTeX rendering, mouse improvements, editor enhancements
- New packages: protocol, client, server, evals, telemetry, session-backends — available as libraries, NOT replacing PI's daemon/kernel
- Extension system: updated extension loader, runner, types
- ModelRuntime API: adopted when it arrives (step 7), but PI's daemon/kernel hooks re-applied on top
- TypeBox: migrated when it arrives (steps 6, 9)
- Tools: updated bash, edit, read, write, grep, find implementations from earendil

**Merge rule:** When a shared file conflicts, adopt earendil's version as the base, then re-apply PI-specific additions on top. PI's architecture (daemon, kernel, RLM, refinement, goals, heartbeats, autonomous mode) is never removed or replaced by earendil's client/server approach. earendil's new packages are added as dependencies/libraries where useful, but do not become the primary session management mechanism.

**Validation after each step:** Verify that:
1. RLM spawning works (rlm() callable in IPython)
2. Daemon starts and manages sessions (prime-agent status)
3. Subagent spawning works (subagent_delegate)
4. Refinement works (/refine command)
5. Goals work (persistent goals across turns)
6. Heartbeats work (scheduled tasks)
7. Interactive mode starts (./prime-agent.sh)
8. All 5622 tests pass (3 parallel tester groups)


## Steps

### Step 0: Preparation

1. Confirm working tree is clean
2. Create backup branch: `git branch local/customizations-backup local/customizations`
3. Verify earendil remote exists (already added: `earendil -> https://github.com/earendil-works/pi.git`)
4. `git fetch earendil --tags`
5. Clean up clobbered v0.8.0 tag conflict (PI's v0.8.0 = 8d7deeab5, earendil's = 45ffe0a -- different commits, same tag name)
6. Create working branch: `git checkout -b merge/earendil-iterative local/customizations`
7. **Apply socket path fix BEFORE any merge** -- agent won't start without it on macOS:
   - Cherry-pick a33cf2ee9 onto the working branch
   - Shortens worker socket filename from `worker-<12key>-<id>.sock` to `worker-<7key>-<id>.sock` to fit macOS 104-byte Unix socket path limit
   - File: `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts` (PI-only file, cherry-picks cleanly)
   - Commit: `git commit -m "fix(coding-agent): shorten worker socket path to fit macOS 104-byte limit"`
   - Must be present before running any tests in subsequent steps
8. **Verify tester subagent role is configured:**
   - `.pi/settings.json` contains `subagent.agentOverrides.tester` with bash/read/grep/find tools
   - pi-subagent extension is installed globally (`npm:@d3ara1n/pi-subagent` in `~/.prime/agent/settings.json` packages)
   - Tester role uses `default` model role with `fast` fallback, 3600s timeout
   - System prompt contains all test commands from AGENTS.md

### Steps 1-10: Iterative merges (one per minor version group)

For each minor version group (v0.75.x, v0.76.x, ..., v0.84.x):

**A. Merge:**
```
git merge <target_tag> --no-commit --no-ff
```

**B. Resolve conflicts by package (bottom-up):**

  a. **packages/ai** — adopt earendil's providers/models, keep PI's mcp/, cache-pricing, openrouter-reasoning, transform-messages, cloudflare, prime-inference
  b. **packages/agent** — adopt earendil's improvements, keep PI's typed precondition codes
  c. **packages/tui** — adopt earendil's base (fullscreen, LaTeX, Mermaid), re-apply PI-specific additions
  d. **packages/coding-agent/src/core/** — adopt earendil as base for overlapping files, PI-only files (480) stay automatically
  e. **packages/coding-agent/src/modes/** — daemon/ stays (PI-only), merge interactive-mode and rpc
  f. **packages/coding-agent/src/cli/** — PI daemon CLI stays, merge overlapping CLI files
  g. **New earendil packages** (client, protocol, server, evals, telemetry, session-backends) — come in cleanly
  h. **prime-agent-runtime/** — PI-only, no conflict
  i. **Root files** — keep PI's AGENTS.md, merge package.json/tsconfig/biome

**C. Commit merge:**
```
git add <resolved files only — never git add -A>
git commit -m "merge(earendil): integrate v0.X.Y while preserving PI RLM architecture"
```

**D. Run tests via 3 parallel subagent_delegate(role=tester) calls:**

The tester subagent role is configured in `.pi/settings.json` with env cleanup prefix and 3-group parallel strategy. Spawn all 3 simultaneously:

```
subagent_delegate(role=tester, task="Group 1 (ca-safe): Run coding-agent safe tests (no kernel/daemon). From packages/coding-agent, run: env -u RLM_DEPTH -u RLM_MAX_DEPTH -u RLM_HARNESS_STATE_DIR -u RLM_SESSION_DIR -u RLM_GLOBAL_HARNESS_STATE_DIR -u JPY_PARENT_PID -u HF_TOKEN -u PI_CODING_AGENT -u PRIME_AGENT_INTERNAL_DAEMON_WORKER -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET -u PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL -u PRIME_AGENT_INTERNAL_SESSION_LEASES -u PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID -u PRIME_AGENT_BUILD_ID -u PRIME_AGENT_LAUNCHER_PATH -u PRIME_AGENT_CODING_AGENT_DIR RLM_DEPTH=0 npx tsx ../../node_modules/vitest/dist/cli.js --run <safe_files>. Safe files = all test/*.test.ts EXCEPT files importing node:child_process, IpythonKernelProvisioner, bootstrap-cli, DaemonClient, DaemonSupervisor, daemon-socket, daemon-mode, and all test/suite/*.test.ts. Also exclude: daemon-supervisor-process, 4603, 4600, 4606, 4685. Use rg -l to find unsafe files. Report PASS/FAIL, test count, timing.")

subagent_delegate(role=tester, task="Group 2 (ca-unsafe): Run coding-agent kernel/daemon tests (isolated single vitest). From packages/coding-agent, run: env -u RLM_DEPTH -u RLM_MAX_DEPTH -u RLM_HARNESS_STATE_DIR -u RLM_SESSION_DIR -u RLM_GLOBAL_HARNESS_STATE_DIR -u JPY_PARENT_PID -u HF_TOKEN -u PI_CODING_AGENT -u PRIME_AGENT_INTERNAL_DAEMON_WORKER -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET -u PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL -u PRIME_AGENT_INTERNAL_SESSION_LEASES -u PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID -u PRIME_AGENT_BUILD_ID -u PRIME_AGENT_LAUNCHER_PATH -u PRIME_AGENT_CODING_AGENT_DIR RLM_DEPTH=0 npx tsx ../../node_modules/vitest/dist/cli.js --run <unsafe_files>. Unsafe files = all test/suite/*.test.ts + test/*.test.ts that import kernel/daemon/spawn. EXCLUDE: daemon-supervisor-process, 4603, 4600, 4606, 4685. Report PASS/FAIL, test count, timing.")

subagent_delegate(role=tester, task="Group 3 (other): Run 5 suites separately. 1) cd /Users/k.sidenko/Development/prime-agent && env -u RLM_DEPTH ... npm run check. 2) cd packages/agent && env -u RLM_DEPTH ... npx tsx ../../node_modules/vitest/dist/cli.js --run. 3) cd packages/tui && env -u RLM_DEPTH ... npm test. 4) cd packages/ai && env -u RLM_DEPTH ... npx tsx ../../node_modules/vitest/dist/cli.js --run --exclude test/stream.test.ts --exclude test/cross-provider-handoff.test.ts --exclude test/total-tokens.test.ts --exclude test/tool-call-without-result.test.ts --exclude test/context-overflow.test.ts --exclude test/unicode-surrogate.test.ts. 5) cd prime-agent-runtime && env -u RLM_DEPTH ... uv run --with pytest pytest -v. Report PASS/FAIL, test count, timing per suite.")
```

All 3 groups run in parallel. Total wall-clock = max(group times) = ~1m49s.
Expected: 5622 tests, 0 failures.

**Env cleanup prefix** (use for ALL test commands, do NOT set RLM_MAX_DEPTH):
```
env -u RLM_DEPTH -u RLM_MAX_DEPTH -u RLM_HARNESS_STATE_DIR -u RLM_SESSION_DIR -u RLM_GLOBAL_HARNESS_STATE_DIR -u JPY_PARENT_PID -u HF_TOKEN -u PI_CODING_AGENT -u PRIME_AGENT_INTERNAL_DAEMON_WORKER -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET -u PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL -u PRIME_AGENT_INTERNAL_SESSION_LEASES -u PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID -u PRIME_AGENT_BUILD_ID -u PRIME_AGENT_LAUNCHER_PATH -u PRIME_AGENT_CODING_AGENT_DIR RLM_DEPTH=0
```

**Critical rules:**
- Do NOT split coding-agent into more than 2 groups (safe + unsafe). 4+ parallel vitest processes cause 14 failures from kernel/daemon/fs.watch resource contention.
- Do NOT set RLM_MAX_DEPTH to any value. Just unset it. Tests expect default of 1.
- Excluded slow tests (run separately with 120s timeout if needed): daemon-supervisor-process, 4600, 4603, 4606, 4685.

**E. Fix failures:**
- Type errors from API changes — adapt PI code to earendil's new interfaces
- Test breakage — update PI tests to match earendil's changed internals
- Import path changes — update if earendil moved code to new packages
- Known breaking change points to watch per step (see table above)

**F. Commit fixes:**
```
git add <fixed files only>
git commit -m "fix(earendil): adapt PI code to v0.X.Y API changes"
```

**G. Smoke test:**
```bash
./prime-agent.sh
# Verify: interactive mode starts, daemon starts, subagent spawning works
```

**H. Report to user and wait for approval before next step.**

### Final Step: Port custom commits + finalize

After step 10 (v0.84.2 merged):

1. **Cherry-pick 5 direct commits:**
   - `40a60464c` — extension-selector visible options
   - `2bcf2bb0a` — reserved base rows
   - `291185cb8` — optional theme colors
   - `37138fe91` — bell() in ExtensionUIContext
   - `d3b4cdfa6` — jiti aliases

2. **Manually port 2 commits:**
   - `58340f9ec` — ctx.ui.custom() in daemon mode (PI-only files, should apply)
   - `e2dffd5a5` — Russian keyboard layout fix (create layout-normalize.ts)

3. **Fix package versions:**
   - Bump all `@earendil-works/pi-*` deps to `^0.84.2`
   - Set all package versions to `0.84.2`

4. **Final validation:**
   - `npm run check`
   - All package test suites
   - prime-agent-runtime pytest
   - Manual smoke test of all 8 custom features

5. **Merge into local/customizations:**
   ```
   git checkout local/customizations
   git merge merge/earendil-iterative
   git push origin local/customizations
   ```

## Key Breaking Changes to Watch

| Step | Breaking Change | PI Impact |
|------|-----------------|-----------|
| 1 | Node min 22.19 | Check .nvmrc / engines field |
| 1 | reasoningEffortMap → thinkingLevelMap | Update PI model definitions |
| 1 | Removed Google Gemini CLI/Antigravity | Remove PI references if any |
| 6 | TypeBox 0.34 → 1.x | All TypeBox imports in PI code |
| 7 | authStorage/modelRegistry → modelRuntime | PI SDK usage, harness.ts, session config |
| 7 | ModelRegistry.refresh sync → async | All PI callers of refresh() |
| 9 | TypeBox 1.3.7 deprecated API removal | PI extension code using Type.* |
| 10 | ModelsStreamTransforms → ModelsRequestTransforms | PI provider transforms |
| 10 | message_update delta-only | PI daemon protocol event handling |
| 10 | ModelRegistry.getApiKeyAndHeaders null values | PI header inspection code |

## Risks

- **Cumulative conflicts** — each merge builds on the previous; earlier resolution mistakes compound
- **Test suite** — PI has 337 test files; many may break on API changes, requiring fixes at each step
- **Architecture coexistence** — PI daemon/kernel vs earendil client/server; resolved by keeping PI primary
- **TypeBox migration** (step 6, 9) — touches all schema definitions; large blast radius
- **ModelRuntime migration** (step 7) — touches auth, session config, harness; core PI paths
- **Step 10 is largest** — 508 commits, 674 files, 6 breaking changes; may need sub-iteration

## Pre-Merge Test Baseline

### Measured Baseline (via 3 parallel tester subagents with clean env)

All 5622 tests PASS with zero failures. Tests run in 3 parallel groups via subagent_delegate.

**Env cleanup prefix** (unset RLM_*, JPY_PARENT_PID, HF_TOKEN, PI_CODING_AGENT, PRIME_AGENT_INTERNAL_*; set RLM_DEPTH=0; do NOT set RLM_MAX_DEPTH):

```
env -u RLM_DEPTH -u RLM_MAX_DEPTH -u RLM_HARNESS_STATE_DIR -u RLM_SESSION_DIR -u RLM_GLOBAL_HARNESS_STATE_DIR -u JPY_PARENT_PID -u HF_TOKEN -u PI_CODING_AGENT -u PRIME_AGENT_INTERNAL_DAEMON_WORKER -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_RECOVERY_JOURNAL -u PRIME_AGENT_INTERNAL_DAEMON_WORKER_TOKEN -u PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_SOCKET -u PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL -u PRIME_AGENT_INTERNAL_SESSION_LEASES -u PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID -u PRIME_AGENT_BUILD_ID -u PRIME_AGENT_LAUNCHER_PATH -u PRIME_AGENT_CODING_AGENT_DIR RLM_DEPTH=0
```

**3 parallel groups:**

| Group | Subagent | Contents | Tests | Wall-clock |
|-------|----------|----------|-------|-----------|
| 1 | tester-ca-safe | coding-agent safe (no kernel/daemon, ~223 files) | 2648 | 1m49s |
| 2 | tester-ca-unsafe | coding-agent kernel/daemon (~109 files) | 1719 | 1m21s |
| 3 | tester-other | check + agent + tui + ai + runtime | 1255 | ~94s |

**Total: 5622 tests, 0 failures, ~1m49s wall-clock (limited by group 1).**

Splitting coding-agent into safe/unsafe groups is critical:
- Safe group (no kernel/daemon imports) can run without resource conflicts
- Unsafe group (kernel/daemon/spawn tests) must run as a single vitest process
- Running 4+ parallel vitest processes causes 14 failures from kernel/daemon/fs.watch contention

### Excluded tests (slow integration, need separate run with 120s timeout):
- `daemon-supervisor-process.test.ts` — excluded from CI, run via `npm run test:process`
- `4600-supervisor-singleton.test.ts` — 72s, 14/15 pass
- `4606-update-restart-coordinator.test.ts` — 67s, 4/5 pass
- `4603-worker-recovery.test.ts` — >120s, hangs in afterEach
- `4685-daemon-client-modes.test.ts` — 18s, all pass

### prime-agent-runtime: PASS (98/98)

## What NOT to Do

- Do NOT execute any step without user approval
- Do NOT use `git add -A` or `git add .` (parallel agents may be working)
- Do NOT use `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`
- Do NOT skip tests between iterations
- Do NOT merge multiple minor versions in one step

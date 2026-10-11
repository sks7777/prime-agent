# Feature: Full ACP compatibility for bb, Zed, JetBrains, and all ACP-compatible editors

## Context

I use [bb](https://getbb.app/) as my primary IDE. The [bb-plugin-prime-agent-acp](https://github.com/rawizhere/bb-plugin-prime-agent-acp) bridge connects bb to Prime Agent through the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/get-started/introduction) — a JSON-RPC 2.0 over stdio protocol for editor/agent communication, maintained by Zed Industries.

Prime Agent already runs as an ACP server (`prime-agent --mode acp`). The bb plugin implements a dialect layer that maps Prime Agent's namespaced [`_meta` fields](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field) onto bb deltas. But the Rust ACP server in upstream `main` does not serve the full method surface the dialect expects.

## Problem

After the v0.10.2 release (2026-10-28), three maintainers landed 43 merged PRs and have 95 open PRs. The [local fork](https://github.com/sks7777/prime-agent/tree/local/v0.10.1-clean) (`local/v0.10.1-clean`) has ~4,500 lines of ACP additions that are not in upstream. Without these, bb users experience:

- **Lost session history** after daemon restart — no [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) (the [`loadSession`](https://agentclientprotocol.com/protocol/v1/initialization#session-capabilities) capability)
- **No mid-turn message injection** — no [steering behavior](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#prompts-during-active-work) (PR #3684 ready, not merged)
- **No context-usage reporting** — no [`usage_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates) in [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates)
- **No autocomplete** — no [`available_commands_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) in `session/update`
- **No mode switching** — no [`session/set_config_option`](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option) for ask/plan/code/debug
- **Invisible subagent threads** — no [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) mirror-thread rebind
- **Cumulative duplication** in thinking blocks — `session/update` coalescer merges [`agent_thought_chunk`](https://agentclientprotocol.com/protocol/v1/prompt-turn#2-agent-reports-output) deltas

This also affects [Zed](https://agentclientprotocol.com/get-started/introduction), [JetBrains Air](https://github.com/PrimeIntellect-ai/prime-agent/discussions/3624), [SuperQode](https://docs.superqode.dev/providers/prime-agent/), and [Neovim (codecompanion.nvim)](https://github.com/olimorris/codecompanion.nvim) — every ACP-compatible client benefits from the full method surface.

## Goal

Bring the ACP layer in upstream `main` to full compatibility with the [ACP v1 spec](https://agentclientprotocol.com/protocol/v1/overview), so that `prime-agent --mode acp` works as a first-class provider in bb — and in any other ACP-compatible editor — without local fork patches.

## High-level approach

The work decomposes into 9 logical blocks across 3 phases. Each block is a separate PR with a changelog fragment, regression tests, and parity-diff evidence.

### Phase 1 (parallel, no inter-block dependencies)

**Block 1 — `session/load` + `session/fork` (critical):**
Cross-process session registry so bb can resume and fork sessions after IDE or daemon restart. Implements [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) (optional, [`loadSession`](https://agentclientprotocol.com/protocol/v1/initialization#session-capabilities) capability) and [`session/fork`](https://agentclientprotocol.com/protocol/v2/migration#scope-stable-v2-and-draft-features) (draft-only in v2, `session.fork` capability). New `session_registry.rs` (~511 lines), `ForkCapability`, `SessionLoadParams`, `SessionForkParams`. [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) mints fresh UUIDs (no [`working directory`](https://agentclientprotocol.com/protocol/v1/session-setup#working-directory) reuse). Cwd validation with `allowForeignCwd` opt-out per [`workspace-root-security`](https://agentclientprotocol.com/protocol/v1/session-setup#workspace-root-security).

**Block 2 — `session/steering` (critical, [PR #3684](https://github.com/PrimeIntellect-ai/prime-agent/pull/3684)):**
Mid-turn message injection without cancelling in-flight tools. [ACP v2 prompt-lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#prompts-during-active-work) describes steering as emergent Agent behavior; this PR makes it explicit via a `session/steering` extension method advertised in [`_meta`](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field) at [`initialize`](https://agentclientprotocol.com/protocol/v1/initialization#capabilities). Port of nano-rlm #205. New `steer_runs.rs` (~232 lines), `DaemonCommand::Steer` variant in pa-types, `SteeringParams`, `_meta.steering.supported` in [`initialize`](https://agentclientprotocol.com/protocol/v1/initialization#agent-capabilities). Full race-condition handling: [`session/cancel`](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) vs admission, prompt failure post-admission, steer vs armed cancel.

**Block 3 — Streaming fixes (high):**
[`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) notifications: [`agent_thought_chunk`](https://agentclientprotocol.com/protocol/v1/prompt-turn#2-agent-reports-output) bypasses the coalescer to deliver per-token chunks (prevents cumulative duplication in bb's thinking-block renderer). Flush superseded delta on kind switch (thought → message) in `park_update`. Matches the [ACP v1 tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls#updating) streaming contract (one chunk per event, not merged).

**Block 4 — `usage_update` + `available_commands_update` (high):**
Two missing [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) kinds: [`usage_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates) (carries `used` = totalTokens + `size` = contextWindow for a completed assistant response) and `available_commands_update` (slash commands for bb autocomplete, using `input.hint` as a nested object per the [session-updates](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) shape). `contextWindow` added to engine `model_metadata` so [`get_connection_state`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) exposes it.

**Block 5 — Session modes: ask/plan/code/debug (PRIMER-4, high):**
Implements [session-modes](https://agentclientprotocol.com/protocol/v1/session-modes) via [session-config-options](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option). New `session_mode.rs` in pa-core (~998 lines). [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) advertises `mode` config option (select: ask/plan/code/debug). [`session/set_config_option`](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option) switches mode. Plan mode blocks write tools (read-only enforcement per [exiting-plan-modes](https://agentclientprotocol.com/protocol/v1/session-modes#exiting-plan-modes), `mode-blocked` flag on [`tool_call`](https://agentclientprotocol.com/protocol/v1/tool-calls#content) content). `AcpSessionUpdate::Plan` from `goal_update` (the [`plan`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) update kind).

### Phase 2 (depends on Block 1)

**Block 6 — bb-mirror threads (critical):**
[`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) mirror-thread rebind for RLM subagents inside bb. New `rlm_bb_mirror.rs` (~766 lines). `rlm.spawn` creates a mirror bb thread: claim file (single-use + TTL) → spawn thread → rebind onto child [`session`](https://agentclientprotocol.com/protocol/v1/session-setup#session-id). Model + reasoning-level forwarding. Stale claim → re-spawn. Waker bridge for parent notification. Uses [`_meta`](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field) `subagents` field for visibility.

**Block 7 — Prompt recovery (critical):**
ACP connection survives daemon restart using [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) to re-attach. Bounded wait (180s, poll 2s) re-attaches to the replacement daemon. `closed_input_pause` for graceful [`session/close`](https://agentclientprotocol.com/protocol/v1/session-setup#closing-a-session) shutdown handling. Without this, [`session/cancel`](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) during a daemon restart orphans the session.

### Phase 3 (depends on Block 7)

**Block 8 — Orphaned worker + bash fixes (high):**
Edge cases at the [cancellation](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) / [session-setup](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) boundary. Passivation path does not skip workers with stale inflight permits (fixes session restore hanging after cancel-during-turn). ACP bridge identity backfill on pre-PRIMER-6 descriptors.

**Block 9 — `_meta.autoRetry` (medium):**
`PrimeAgentAutoRetryMeta` — phase (waiting/recovered/exhausted), attempt, maxAttempts, delayMs, reason, backupModel. Published in [`session_info_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) via [`_meta`](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field) under `ai.primeintellect.prime-agent`. Surfaces provider auto-retry state to ACP clients.

I have a working implementation of all these blocks in the [local fork](https://github.com/sks7777/prime-agent/tree/local/v0.10.1-clean) and I'm ready to contribute them as separate PRs against `main`.

## Detailed steps per block

### Block 1: session/load + session/fork

Implements: [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) (v1 optional, [`loadSession`](https://agentclientprotocol.com/protocol/v1/initialization#session-capabilities) capability) + [`session/fork`](https://agentclientprotocol.com/protocol/v2/migration#scope-stable-v2-and-draft-features) (v2 draft-only, `session.fork` capability). [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) mints fresh [`session id`](https://agentclientprotocol.com/protocol/v1/session-setup#session-id). [`working directory`](https://agentclientprotocol.com/protocol/v1/session-setup#working-directory) validation per [`workspace-root-security`](https://agentclientprotocol.com/protocol/v1/session-setup#workspace-root-security).

1. `session_registry.rs` — registry struct, read/write/prune (7-day TTL), unit tests
2. `types.rs` — `ForkCapability`, `SessionLoadParams`, `SessionForkParams` + parse tests
3. `daemon.rs` — `session/load` handler: resolve ACP id → registry → session file, cwd validation (foreign cwd → explicit error unless `allowForeignCwd`)
4. `daemon.rs` — `session/fork` handler: branched copy of session file, `allowForeignCwd` opt-out
5. `daemon.rs` — `session/new` mints fresh UUID, publishes to registry (no cwd reuse)
6. `daemon.rs` — `initialize` advertises `loadSession: true`, [`sessionCapabilities`](https://agentclientprotocol.com/protocol/v1/initialization#session-capabilities).`fork: {}`
7. E2E tests: load after process restart, fork same/different cwd, foreign lease holder error
8. Changelog fragment: `.changes/prime-8-acp-load-fork-usage.md`

**Files:** `acp/types.rs`, `acp/session_registry.rs` (new), `acp/daemon.rs`, `acp/mod.rs`, `acp/config_options.rs`

**Regression tests:** `acp_session_load_resumes_after_process_restart`, `acp_session_fork_creates_branched_copy`, `acp_session_new_always_mints_fresh_id`, `acp_session_load_foreign_lease_holder_fails`

### Block 2: session/steering

Implements: [steering behavior](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#prompts-during-active-work) (v2 emergent, made explicit via [`_meta` extension](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field)). Race handling per [cancellation](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) spec. [`initialize`](https://agentclientprotocol.com/protocol/v1/initialization#agent-capabilities) advertises support.

1. `types.rs` — `SteeringParams` struct + parse tests (mirrors PromptParams per [session-setup](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session))
2. `meta.rs` — `PrimeAgentSteeringMeta` + `_meta.steering.supported` in [`initialize`](https://agentclientprotocol.com/protocol/v1/initialization#capabilities) response
3. `steer_runs.rs` (new) — steered-work flag set at admission point, cleared only by completed [`session/cancel`](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) stop sequence
4. `prompt_admission.rs` — `busy` flag in steer/follow_up response, ANDed with ACP turn slot (neither side's race window lies)
5. `worker/commands.rs` + `worker/input.rs` — `DaemonCommand::Steer` → worker steering lane (tool-boundary batching per [tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls#updating))
6. `daemon.rs` — `handle_session_steering()`: validate non-empty all-text blocks, translate to `DaemonCommand::Steer`, map `{"outcome": "injected"}` (turn running) / `{"outcome": "queued"}` (idle → next turn)
7. E2E tests: steer mid-tool-call, cancel racing admission, prompt failing after admission, steer vs armed cancel
8. Changelog fragment: `.changes/acp-session-steering.md`

**Files:** `acp/daemon.rs`, `acp/types.rs`, `acp/meta.rs`, `steer_runs.rs` (new), `prompt_admission.rs`, `worker/commands.rs`, `worker/input.rs`, `pa-types/daemon/command.rs`, `pa-cli/tests/acp_mode_e2e.rs`

**Regression tests:** `acp_steering_injects_mid_tool_call`, `acp_steering_queued_on_idle_session`, `acp_cancel_racing_admission_withdraws_steer`, `acp_prompt_fails_after_admission_no_orphan`

### Block 3: Streaming fixes

Fixes: [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) [`agent_thought_chunk`](https://agentclientprotocol.com/protocol/v1/prompt-turn#2-agent-reports-output) coalescer behavior per [tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls#updating) streaming contract.

1. `wire_events.rs` — identify coalescer merge path for `thinking_delta`, bypass for this kind (per-token chunks, not `push_str` merge)
2. `wire_events.rs` — flush superseded delta on kind switch (thought → message) in `park_update`
3. Unit tests: two thinking deltas → two chunks (not one merged), kind switch flushes superseded
4. Changelog fragment: `.changes/fix-thinking-delta-coalescer.md`

**Files:** `acp/wire_events.rs`

**Regression tests:** `acp_thinking_delta_not_coalesced`, `acp_stream_kind_switch_flushes_superseded`

### Block 4: usage_update + available_commands_update

Implements: two missing [`session/update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) kinds — [`usage_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates) and `available_commands_update`.

1. `wire_events.rs` — `AcpSessionUpdate::UsageUpdate` variant + `usage_update()` function (reads `usage.totalTokens` → `used`, `contextWindow` → `size`; error/aborted → no update per [session-usage-updates](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-usage-updates))
2. `session_engine_impl.rs` — add `contextWindow` to `model_metadata` so [`get_connection_state`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) exposes it
3. `config_options.rs` — `PickerModel::from_connection_state` reads `contextWindow`
4. `wire_events.rs` — `AvailableCommandsUpdate` with `input.hint` as nested object (not `inputHint` top-level) per [session-updates](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) shape; fires on session/new, load, fork with builtin slash commands
5. E2E: `usage_update` fires after completed assistant message with correct `used`/`size`; `available_commands_update` fires on session start
6. Changelog fragments: `.changes/prime-53-usage-update.md`, `.changes/fix-commands-update-hint-shape.md`

**Files:** `acp/wire_events.rs`, `acp/config_options.rs`, `agent_engine/session_engine_impl.rs`

**Regression tests:** `acp_usage_update_carries_context_window`, `acp_available_commands_use_nested_hint`

### Block 5: Session modes (ask/plan/code/debug)

Implements: [session-modes](https://agentclientprotocol.com/protocol/v1/session-modes) via [session-config-options](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option). Plan update per [session-updates](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) `plan` kind.

1. `session_mode.rs` (new in pa-core) — `SessionMode` enum (Ask/Plan/Code/Debug), `SessionModeState`, tool-blocking rules (plan = read-only: bash/edit blocked, search/read allowed per [exiting-plan-modes](https://agentclientprotocol.com/protocol/v1/session-modes#exiting-plan-modes))
2. `config_options.rs` — `mode` select option in `session_config_options(current_mode, ...)` with 4 values per [setting-a-config-option](https://agentclientprotocol.com/protocol/v1/session-config-options#setting-a-config-option)
3. `session_engine_impl.rs` — track current mode, enforce tool blocking on each tool dispatch
4. `types.rs` — `mode-blocked` flag on [`tool_call` content](https://agentclientprotocol.com/protocol/v1/tool-calls#content) (bb distinguishes mode-blocks from ordinary tool errors)
5. `wire_events.rs` — `AcpSessionUpdate::Plan` variant from `goal_update` (todos: `{step, text, completed}`, completed/total counts per [session-updates](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates))
6. E2E: mode switch, plan mode blocks write tools, code mode allows all, plan update carries todos
7. Changelog fragment: `.changes/primer-4-session-mode.md`

**Files:** `pa-core/src/session_mode.rs` (new), `acp/config_options.rs`, `acp/types.rs`, `acp/wire_events.rs`, `agent_engine/session_engine_impl.rs`

**Regression tests:** `acp_set_mode_plan_blocks_write_tools`, `acp_set_mode_code_allows_all_tools`, `acp_plan_update_carries_todos`

### Block 6: bb-mirror threads

Uses: [`session/new`](https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session) + [`_meta`](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field) `subagents` field for RLM subagent visibility in bb.

1. `rlm_bb_mirror.rs` (new) — `BbMirrorEnv` from process env (BB_THREAD_ID, BB_PROJECT_ID), claim file format (single-use + 10-min TTL), `bb thread spawn` with timeout (30s), roster wait (20s)
2. `daemon.rs` — `HostedSession.mirror_rebind_attempted` flag (at most once per entry), rebind handler reads claim → validates RLM subagent → notifies parent
3. `session_engine_impl.rs` — `rlm.spawn` → deferred admission → claim file write → mirror thread spawn → rebind
4. Model + reasoning-level forwarding in mirror spawn (`--model`, `--thinking` flags)
5. Waker bridge: parent session resolves mirror child's deferred admission on first prompt arrival
6. Stale claim (TTL expired) → re-spawn, not rebind
7. E2E: spawn → mirror thread visible → rebind → first prompt → parent wake → child runs
8. Changelog fragment: `.changes/prime-62-bb-mirror-subagents.md`

**Files:** `rlm_bb_mirror.rs` (new), `acp/daemon.rs`, `agent_engine/session_engine_impl.rs`

**Regression tests:** `rlm_spawn_creates_mirror_thread`, `rlm_mirror_rebind_at_most_once`, `rlm_stale_claim_re_spawns`, `rlm_mirror_forwards_model_and_reasoning`

### Block 7: Prompt recovery

Uses: [`session/load`](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) re-attach + [`session/cancel`](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) graceful shutdown. [`session/close`](https://agentclientprotocol.com/protocol/v1/session-setup#closing-a-session) for shutdown handling.

1. `daemon.rs` — `session_closed{shutdown}` handler: set `closed_input_pause` (pause ID/key), don't fail the active prompt
2. `daemon.rs` — `PROMPT_RECOVERY_MAX_WAIT_MS` (180s), `PROMPT_RECOVERY_PROBE_MS` (2s): bounded wait loop probes daemon socket, re-attaches to replacement daemon
3. `daemon.rs` — re-attach: reconnect transport, resume prompt turn on replacement
4. E2E: kill daemon mid-prompt → 180s wait → replacement starts → prompt completes with full history
5. Changelog fragment: `.changes/prime-55-prompt-recovery.md`

**Files:** `acp/daemon.rs`, `agent_engine/session_engine_impl.rs`

**Regression tests:** `acp_prompt_recovers_after_daemon_restart`, `acp_prompt_recovery_times_out`

### Block 8: Orphaned worker + bash fixes

Fixes: [cancellation](https://agentclientprotocol.com/protocol/v1/cancellation#internal-cancellation) / [session-setup](https://agentclientprotocol.com/protocol/v1/session-setup#loading-a-session) boundary edge cases.

1. `daemon.rs` — orphaned worker sweep: passivation path does not skip workers holding `stale_inflight_permit` (prevents session/load from blocking)
2. `session_engine_impl.rs` — ACP bridge identity backfill on pre-PRIMER-6 descriptors (so session/load restores history for older sessions)
3. E2E: cancel-during-turn → kill → session/load → succeeds without block
4. Changelog fragment: `.changes/fix-orphaned-worker-stale-permit.md`

**Files:** `acp/daemon.rs`, `agent_engine/session_engine_impl.rs`

**Regression tests:** `acp_cancel_during_turn_then_load_not_blocked`, `acp_pre_primer6_descriptor_backfills_identity`

### Block 9: _meta.autoRetry

Uses: [`_meta` extension](https://agentclientprotocol.com/protocol/v1/extensibility#the-_meta-field) mechanism + [`session_info_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates).

1. `meta.rs` — `PrimeAgentAutoRetryMeta` struct: `phase` (waiting/recovered/exhausted), `attempt`, `maxAttempts`, `delayMs`, `reason`, `backupModel`, `restoredModel`, `errorMessage`; `auto_retry` field on `PrimeAgentSessionMeta`
2. `wire_events.rs` — publish `auto_retry` in [`session_info_update`](https://agentclientprotocol.com/protocol/v1/prompt-turn#session-updates) when retry state changes (phase transitions)
3. E2E: provider 429 → `autoRetry.phase: "waiting"` → retry succeeds → `phase: "recovered"`; exhausted → `phase: "exhausted"` + reason
4. Changelog fragment: `.changes/prime-55-auto-retry-meta.md`

**Files:** `acp/meta.rs`, `acp/wire_events.rs`

**Regression tests:** `acp_auto_retry_meta_waiting_phase`, `acp_auto_retry_meta_recovered`, `acp_auto_retry_meta_exhausted`

## Constraints

- **One logical change per PR.** Fixes ride with the change that introduced them.
- **Changelog fragment** in `.changes/` for every PR.
- **Regression test** for every bug fix (fails without the fix).
- **Zero-warning:** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- **Parity-diff evidence** for every PR touching user-visible ACP surface: (1) rendered output — frame-diff vs TS binary; (2) interactive behavior — same input → same response; (3) wire parity — byte-compare `session/update` notifications; (4) user-visible invariants.
- **Ownership compliance:** state crate README scope, dependency direction, classify (internals / new `pub` / new dependency). Blocks 2 and 5 add new `pub` surface (`DaemonCommand::Steer` in pa-types, `SessionMode` in pa-core) — architectural changes, stated in PR body.
- **No stubs, no `todo!()`, no swallowed errors.**

## Summary

| Block | PRIME | Depends on | New files | LOC | Priority |
|---|---|---|---|---|---|
| 1. session/load + fork | PRIME-8 | — | 1 | ~1,500 | Critical |
| 2. session/steering | PRIME-8 | — | 1 | ~3,300 | Critical |
| 3. Streaming fixes | — | — | 0 | ~200 | High |
| 4. usage_update + commands | PRIME-53 | — | 0 | ~400 | High |
| 5. Session modes | PRIMER-4 | — | 1 | ~1,200 | High |
| 6. bb-mirror threads | PRIME-11/24/28/62 | Block 1 | 1 | ~800 | Critical |
| 7. Prompt recovery | PRIME-55 | Block 1 | 0 | ~400 | Critical |
| 8. Orphaned worker | — | Block 7 | 0 | ~300 | High |
| 9. _meta.autoRetry | PRIME-55 | Block 7 | 0 | ~200 | Medium |


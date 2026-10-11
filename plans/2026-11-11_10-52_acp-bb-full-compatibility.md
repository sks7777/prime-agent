# План: полная совместимость ACP с bb

Дата: 2026-11-11
Цель: доработать ACP-слой prime-agent (upstream main) до полной совместимости с bb-plugin-prime-agent-acp.

## Правила контрибута

- Один логический change на PR. Fix rides с change, который его ввёл.
- Changelog fragment в .changes/ на каждый PR.
- Regression test на каждый bug fix.
- Zero-warning: cargo fmt --all --check, cargo clippy --workspace --all-targets -- -D warnings, cargo test --workspace.
- Parity-diff evidence — merge gate.
- Dependency direction: pa-daemon -> pa-types, pa-core, pa-agent, pa-ai, pa-telemetry, pa-models.
- No stubs, no todo!(), no swallowed errors.
- CONTRIBUTING.md: start with Discussion -> maintainer invite -> PR.

## Зависимости

Phase 1 (parallel): Block 1 + 2 + 3 + 4 + 5 + 10
Phase 2 (after 1): Block 6 + 7
Phase 3 (after 7): Block 8 + 9

## Block 1: session/load + session/fork (PRIME-8, Critical)

Foundation for bb resume/fork. New session_registry.rs (~511 lines), ForkCapability, SessionLoadParams, SessionForkParams. session/load resumes by ACP id via cross-process JSON registry. session/fork branched copy with allowForeignCwd. session/new mints fresh UUID. E2E: load after restart, fork, foreign lease holder.

Files: types.rs, session_registry.rs (new), daemon.rs, mod.rs, config_options.rs
Changelog: .changes/prime-8-acp-load-fork-usage.md
Tests: acp_session_load_resumes_after_process_restart, acp_session_fork_creates_branched_copy, acp_session_new_always_mints_fresh_id, acp_session_load_foreign_lease_holder_fails

## Block 2: session/steering (PRIME-8, Critical, PR #3684)

Mid-turn injection without cancelling in-flight tools. Port nano-rlm #205. New steer_runs.rs (~232 lines). DaemonCommand::Steer -> worker steering lane (tool-boundary batching). _meta.steering.supported in initialize. SteeringParams mirrors PromptParams. Race handling: cancel vs admission, prompt failure post-admission.

Files: daemon.rs, types.rs, meta.rs, steer_runs.rs (new), prompt_admission.rs, worker/commands.rs, worker/input.rs, pa-types/daemon/command.rs, acp_mode_e2e.rs
Changelog: .changes/acp-session-steering.md
Tests: acp_steering_injects_mid_tool_call, acp_steering_queued_on_idle_session, acp_cancel_racing_admission_withdraws_steer, acp_prompt_fails_after_admission_no_orphan

## Block 3: Streaming fixes (High)

thinking_delta bypass coalescer — per-token chunks for bb. Flush superseded delta on kind switch (thought -> message) in park_update.

Files: wire_events.rs
Changelog: .changes/fix-thinking-delta-coalescer.md
Tests: acp_thinking_delta_not_coalesced, acp_stream_kind_switch_flushes_superseded

## Block 4: usage_update + available_commands_update (PRIME-53, High)

AcpSessionUpdate::UsageUpdate — used (totalTokens) + size (contextWindow). contextWindow in model_metadata. AvailableCommandsUpdate — input.hint as nested object.

Files: wire_events.rs, config_options.rs, session_engine_impl.rs
Changelog: .changes/prime-53-usage-update.md, .changes/fix-commands-update-hint-shape.md
Tests: acp_usage_update_carries_context_window, acp_available_commands_use_nested_hint

## Block 5: Session modes ask/plan/code/debug (PRIMER-4, High)

New session_mode.rs in pa-core (~998 lines). Mode tracking, tool blocking (plan = read-only). session/new advertises mode config option. Plan update from goal_update.

Files: pa-core/session_mode.rs (new), config_options.rs, types.rs, wire_events.rs, session_engine_impl.rs
Changelog: .changes/primer-4-session-mode.md
Tests: acp_set_mode_plan_blocks_write_tools, acp_set_mode_code_allows_all_tools, acp_plan_update_carries_todos

## Block 6: bb-mirror threads (PRIME-11/24/28/62, Critical, depends on Block 1)

New rlm_bb_mirror.rs (~766 lines). Mirror lifecycle, claim file (single-use + TTL), rebind. rlm.spawn -> deferred admission -> claim -> bb thread spawn -> rebind. Model + reasoning-level forwarding. Stale claim -> re-spawn. Waker bridge.

Files: rlm_bb_mirror.rs (new), daemon.rs, session_engine_impl.rs
Changelog: .changes/prime-62-bb-mirror-subagents.md
Tests: rlm_spawn_creates_mirror_thread, rlm_mirror_rebind_at_most_once, rlm_stale_claim_re_spawns, rlm_mirror_forwards_model_and_reasoning

## Block 7: Prompt recovery (PRIME-55, Critical, depends on Block 1)

Bounded wait (180s, poll 2s) for daemon restart during active prompt. ACP connection rides out session_closed shutdown, re-attaches on replacement. closed_input_pause for graceful shutdown.

Files: daemon.rs, session_engine_impl.rs
Changelog: .changes/prime-55-prompt-recovery.md
Tests: acp_prompt_recovers_after_daemon_restart, acp_prompt_recovery_times_out

## Block 8: Orphaned worker + bash fixes (High, depends on Block 7)

Passivation path does not skip workers with stale inflight permits. ACP bridge identity backfill on pre-PRIMER-6 descriptors.

Files: daemon.rs, session_engine_impl.rs
Changelog: .changes/fix-orphaned-worker-stale-permit.md
Tests: acp_cancel_during_turn_then_load_not_blocked, acp_pre_primer6_descriptor_backfills_identity

## Block 9: _meta.autoRetry (PRIME-55, Medium, depends on Block 7)

PrimeAgentAutoRetryMeta — phase (waiting/recovered/exhausted), attempt, maxAttempts, delayMs, reason, backupModel. _meta.autoRetry in session_info_update.

Files: meta.rs, wire_events.rs
Changelog: .changes/prime-55-auto-retry-meta.md
Tests: acp_auto_retry_meta_waiting_phase, acp_auto_retry_meta_recovered, acp_auto_retry_meta_exhausted

## Block 10: Security hardening (Parallel)

Independent track. 18+ open PRs by kevinjosethomas: path traversal, OAuth, HTML escaping, daemon peers, file permissions, cross-origin redirects. Each fix is a separate PR.

## Сводная таблица

| Block | PRIME | Depends | New files | LOC | Priority |
|---|---|---|---|---|---|
| 1 | PRIME-8 | — | 1 | ~1500 | Critical |
| 2 | PRIME-8 | — | 1 | ~3300 | Critical |
| 3 | — | — | 0 | ~200 | High |
| 4 | PRIME-53 | — | 0 | ~400 | High |
| 5 | PRIMER-4 | — | 1 | ~1200 | High |
| 6 | PRIME-11/24/28/62 | Block 1 | 1 | ~800 | Critical |
| 7 | PRIME-55 | Block 1 | 0 | ~400 | Critical |
| 8 | — | Block 7 | 0 | ~300 | High |
| 9 | PRIME-55 | Block 7 | 0 | ~200 | Medium |
| 10 | — | — | 0 | ~15000 | Parallel |

## PR order

Phase 1 (parallel): 1 + 2 + 3 + 4 + 5 + 10
Phase 2 (after 1): 6 + 7
Phase 3 (after 7): 8 + 9

## Ownership compliance

Blocks 2, 5 — new pub surface (DaemonCommand::Steer in pa-types, SessionMode in pa-core). State in PR body.
Others — internals.

## Parity-diff evidence (merge gate)

1. Rendered output — frame-diff vs TS binary
2. Interactive behavior — same input -> same response
3. Wire parity — byte-compare session/update notifications
4. User-visible invariants — session/load restores history, mode switch changes tools, usage_update fires

# Plan: bb ↔ prime-agent integration verification after v0.10.0→v0.10.1

## Context

v0.10.1 touched three integration surfaces between bb and prime-agent:

1. **ACP session lifecycle** — `session/new` idempotency after provider crash (PRIMER-3), `session/load` foreign-lease handling + orphan sweep, `session/new` cwd isolation, `python_repl` tool-name rename in wire events.
    - **Status**: print `1 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.
2. **bb mirror threads** (PRIME-62/PRIME-11/PRIME-24/PRIME-28) — auto-mirror of `rlm.spawn` children, claim-rebind mechanism, deferred admission with waker bridge (C1 critical fix), degradation paths, `kill_on_drop`, temperature validation.
    - **Status**: print `2 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.
3. **Supervisor/worker lifecycle** — `RLM_DEPTH` stripping from worker env, orphan generation tracking, dead-worker RLM child delete without handshake, orphan bash-group reaping, monitor epoch supersession.
    - **Status**: print `3 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

## Decisions

- **Fully automated**: one script `scripts/check_bb_prime_integration.py` runs all 21 test cases, exits non-zero on first failure, prints a summary table.
- **Two execution modes in one script**:
  - **Daemon-socket tests** (Tier A + C): own daemon on temp socket, mock provider, `Client` from `lifecycle_lib.py`. No bb CLI — covers ACP lifecycle, supervisor, worker internals. `BB_THREAD_ID`/`BB_PROJECT_ID` set in daemon env to exercise mirror code paths where needed.
  - **Real bb CLI tests** (Tier B): `bb thread spawn --json --prompt-file` to spawn a parent thread whose agent runs `rlm.spawn` and writes results to a temp file; `bb thread list --parent-thread <id> --json` + `bb thread wait --status idle --timeout` + `bb thread output --json` + `bb thread log --json --after-seq` for verification.
- **No TS parity diff**: parity scripts removed in v0.10.1 (`d8e4af19b`).

## Risks

- **C1 waker bridge** (`2767dca12`): without `ResolveRlmMirrorAdmission`, every mirror child waited 10 min then settled as failed. Highest-risk regression — test first.
- **Foreign-lease `session/load`**: false positive would break every bb thread reconnect. Orphan-sweep retry path is new.
- **`python_repl` rename**: bb reads tool name dynamically from wire events (confirmed: `adapter-utils.ts:312`, no hardcoded `ipython`). Safe.
- **cwd isolation**: `session/new` no longer reuses cwd from a loaded session.

## Plan

### Phase 1: `scripts/check_bb_prime_integration.py` — shared infrastructure

1. **Import `lifecycle_lib.py`** (`env_for`, `OwnedProcesses`, `finish`, `verify_worker`, `process_identity`) and `Client` from `check_agent_bounce.py`. Reuse `Provider` (mock HTTP SSE provider) from `check_ledger_liveness.py`.
    - **Status**: print `1 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

2. **Two test groups**: `daemon_tests` (Tier A + C, no bb) and `bb_tests` (Tier B, real bb CLI). Each test is a function `(binary, root) -> dict` that asserts and returns observed state.
    - **Status**: print `2 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

3. **Daemon test harness**: `spawn_daemon(root, env_overrides)` — starts `prime-agent --mode daemon --daemon-socket <temp>`, waits for socket readiness, returns `(Client, daemon_process, OwnedProcesses)`. `env_overrides` adds `BB_THREAD_ID`/`BB_PROJECT_ID` for mirror code path tests.
    - **Status**: print `3 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

4. **bb test harness**: `spawn_bb_thread(prompt_file, env_overrides)` — calls `bb thread spawn --json --prompt-file <path> --provider acp-prime-agent-rust --project $BB_PROJECT_ID`, parses JSON for thread id. `wait_thread(thread_id, timeout=120)` calls `bb thread wait --status idle --timeout <t> --json`. `thread_output(thread_id)` calls `bb thread output --json`. `list_child_threads(parent_id)` calls `bb thread list --parent-thread <id> --json`.
    - **Status**: print `4 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

5. **Result file protocol**: bb-thread prompts instruct the agent to write JSON results to `<tmp>/result-<test>.json`. The harness polls the file with a timeout instead of relying solely on `bb thread output`.
    - **Status**: print `5 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

### Phase 2: Tier A — ACP session lifecycle (daemon-socket, automated)

6. **Basic session create + prompt**: `Client.call('create')` → `attach` → `prompt`. Mock provider responds with SSE `[DONE]`. Assert: session id is non-empty, provider received the request, `Client.call('list')` shows the session.
    - **Status**: print `6 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

7. **python_repl wire event**: Send a `prompt` whose model response includes a `python_repl` tool call (mock provider returns a tool-call chunk). Assert: the wire event from `Client.wire` contains `toolName: "python_repl"`, not `ipython`. Verify the `AcpToolKind` is `Execute`.
    - **Status**: print `7 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

8. **session/load reconnect**: `create` session A → `prompt` (provider responds) → kill the daemon worker for A (SIGKILL the child process) → `create` session B on the same socket → `switch_session` to A's file → assert: history is intact, no foreign-lease error. Daemon log shows `SwitchSession` → `admit`.
    - **Status**: print `8 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

9. **Foreign-lease session/load**: `create` session A on socket-1 → `create` session B on socket-2 (same session file) → assert: second `switch_session` fails with "Session is already active" + `foreign_holder` check. Then kill socket-1's worker → `trigger_orphan_sweep` → retry `switch_session` on socket-2 → assert: retry succeeds. Daemon log shows `orphan sweep` → retry.
    - **Status**: print `9 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

10. **Provider crash + session/new idempotency**: `create` session A → `prompt` (provider holds the request) → kill the provider process → `create` session B (same cwd) → assert: B gets a fresh ACP session id, A's registry entry is not overwritten. Daemon log shows `fresh id`, not `overwrite registered`.
    - **Status**: print `10 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

11. **cwd isolation**: `create` session with cwd `/tmp/dir-a` → `create` session without explicit cwd from `/tmp/dir-b` → assert: second session uses `/tmp/dir-b`, not `/tmp/dir-a`. `switch_session` to first → assert: restores cwd from session header as `/tmp/dir-a`.
    - **Status**: print `11 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

### Phase 3: Tier B — bb mirror threads (real bb CLI, automated)

> **Safety**: Tier B tests spawn bb child threads against the **production daemon** (the one serving this bb thread). No test may kill the production daemon or its workers. Daemon-restart scenarios live in Tier C on temp daemons.

12. **Auto-mirror spawn**: Write a prompt file that instructs the agent to run `await rlm.spawn("test task", name="mirror-test")` and write `{"child_id": ..., "completed": true}` to a result file. `bb thread spawn --json --prompt-file <path>`. Assert: `bb thread list --parent-thread <id> --json` shows a child thread. Assert: result file shows the child completed. Assert: `bb thread log --json` for the parent shows `rlm.spawn` tool call.
    - **Status**: print `12 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

13. **Waker bridge (C1 critical)**: Same as step 12 but the prompt also records timing: the agent writes `{"rebind_time_ms": <elapsed>}` to the result file. Assert: `rebind_time_ms < 60000` (not 10 min). Daemon log (read from the daemon's stdout log) contains `resolve_rlm_mirror_admission` or `ResolveRlmMirrorAdmission`.
    - **Status**: print `13 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

14. **Explicit bb_mirror=True**: Prompt uses `from bb_subagents import spawn_mirror; m = await spawn_mirror("task", name="explicit-mirror")`. Assert: `m["bb_thread_id"]` is non-empty, `bb thread list --parent-thread <id> --json` shows the mirror thread, claim file exists at `~/.prime/agent/acp-mirror-claims/<nonce>.json` before rebind.
    - **Status**: print `14 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

15. **bb_mirror=False (plain child)**: Prompt runs `await rlm.spawn("task", name="plain-child", bb_mirror=False)`. Assert: `bb thread list --parent-thread <id> --json` shows NO child thread. Assert: result file shows the child completed headless.
    - **Status**: print `15 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

16. **Auto-mirror disabled**: Set `PRIME_AGENT_AUTO_MIRROR=0` in the daemon env. Spawn a bb thread with a `rlm.spawn` prompt. Assert: no mirror thread in `bb thread list --parent-thread`.
    - **Status**: print `16 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

17. **bb CLI missing (degradation)**: Set `BB_CLI=/nonexistent/bb` in the daemon env. Spawn a bb thread with `rlm.spawn` prompt. Assert: no mirror thread, child runs headless, result file shows completion. Daemon log shows `SpawnError` degradation.
    - **Status**: print `17 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

18. **Stale claim degradation**: Write a claim file with `createdAtMs` = now - 11 min. Spawn a bb thread with the stale nonce marker in the prompt. Assert: `read_rlm_mirror_claim` returns `None` (thread runs as normal agent), parent child untouched.
    - **Status**: print `18 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

19. **Mirror child cancel/delete**: Prompt spawns a mirror child then calls `rlm.delete_subagent("mirror-test")`. Assert: child settles as cancelled, `bb thread list --parent-thread` shows the mirror thread stopped. Result file shows `{"deleted": true}`.
    - **Status**: print `19 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

20. **Mirror child across daemon restart** (moved to Tier C — daemon-socket): Spawn a **temp daemon** on a temp socket with `BB_THREAD_ID`/`BB_PROJECT_ID` set. `create` parent → `rlm.spawn` child (auto-mirror, provider holds). Kill the temp daemon's worker process (not `pkill` — use the `OwnedProcesses` handle from `lifecycle_lib.py`). Restart the temp daemon on the same socket. Assert: parent session resumes, mirror child's settle watcher exits without a notice (closed-by-parent path), no zombie mirror threads, no orphaned claim files under the temp `agent_dir/acp-mirror-claims/`. **Never `pkill` the production daemon** — it serves the bb thread running these tests.
    - **Status**: print `20 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

### Phase 4: Tier C — supervisor/worker lifecycle (daemon-socket, automated)

21. **Dead-worker RLM child delete**: `create` parent → `rlm.spawn` child (provider holds) → SIGKILL child worker → `Client.call('kill', rlmLedgerDelete='user')` → assert: delete completes without handshake, ledger tombstone written, retry is idempotent (same boundary).
    - **Status**: print `21 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

22. **Orphan bash-group reaping**: `create` session → `bash()` persistent shell → SIGKILL the worker → `trigger_orphan_sweep` → assert: no orphaned bash processes remain (`ps aux | grep <pid>` empty).
    - **Status**: print `22 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

23. **RLM_DEPTH stripping**: `create` session with `RLM_DEPTH=1` in env → prompt the agent to run `import os; print(os.environ.get("RLM_DEPTH"))` → assert: output is `None`. Then `rlm.spawn` from the session → assert: child is depth-1 (parent depth-0, not inherited depth-2).
    - **Status**: print `23 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

24. **Roster live state**: `create` parent → `rlm.spawn` two children → `Client.call('list', all=True)` → assert: `progress_note` populated, `tool_use_count` non-zero, `replied_since_task` true if child messaged. Cross-check with `list_agent_peers` wire output.
    - **Status**: print `24 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

25. **Monitor epoch supersession**: `create` session → `/reload` or model switch → assert: old watch arm exits (no crash-recovery log), new monitor arm owns the resident, no double-crash entries in daemon log.
    - **Status**: print `25 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

### Phase 5: runner + reporting

26. **Main entry point**: `python scripts/check_bb_prime_integration.py [--binary <path>] [--bb-only] [--daemon-only] [--timeout <s>]`. Default binary: `target/fast-release/prime-agent`. Runs all tests, prints a **per-step status line** as each test completes (not just a final table):
    - **Status**: print `26 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

```
[1/21] A1 basic_session_create               PASS  0.3s
[2/21] A2 python_repl_wire_event              PASS  0.5s
[3/21] A3 session_load_reconnect              PASS  1.2s
...
[8/21] B8 auto_mirror_spawn                   PASS  12.3s
[9/21] B9 waker_bridge_c1                      PASS  8.1s
...
[21/21] C5 monitor_epoch_supersession         FAIL  2.0s
  assertion: old watch arm did not exit
  daemon log tail: ...
---
20 passed, 1 failed, 45.2s total
```

27. **Failure output**: on first failure, print the test name, assertion error, observed state dict, and relevant daemon log tail. Exit code 1.
    - **Status**: print `27 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

28. **Isolation**: each test gets its own `tempfile.TemporaryDirectory()`. Daemon started per-test (or per-group with `--group`). Clean shutdown via `finish()` from `lifecycle_lib.py`.
    - **Status**: print `28 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

## Tier B auto-run (after user confirmation)

> **Trigger**: the user confirms "выполняй Tier B" (or equivalent).
> **Execution**: the agent runs `python scripts/check_bb_prime_integration.py --bb-only --binary target/fast-release/prime-agent --timeout 300` in one cell. Each B-test spawns a real bb child thread against the production daemon via `bb thread spawn --json --prompt-file`. The agent monitors per-step PASS/FAIL output and reports results in one summary table. On failure, the agent includes the thread id, daemon log tail, and `bb thread log --json` for the failed test.

1. **Prerequisite**: the user confirms the production daemon is on v0.10.1 and a real model is configured (`bb provider models acp-prime-agent-rust`).
2. **Run**: `python scripts/check_bb_prime_integration.py --bb-only --binary target/fast-release/prime-agent --timeout 300`
3. **Monitor**: print each `[N/8] B1 auto_mirror_spawn ... PASS/FAIL` line as it appears.
4. **Report**: after all 8 tests, print the summary table:
   ```
   B1 auto_mirror_spawn           PASS  12.3s
   B2 waker_bridge_c1              PASS   8.1s
   ...
   B8 mirror_child_cancel          PASS   5.0s
   ---
   8 passed, 0 failed
   ```
5. **On failure**: print the failed test name, assertion, `bb thread log --json <id>` (last 20 events), and the production daemon log tail from `/tmp/prime-agent-$(id -u)/daemon.stdout.log`.

## Validation checklist

- [ ] `cargo fmt --all --check` passes
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` passes
- [ ] `cargo test --workspace` passes (existing tests)
- [ ] `make check` passes
- [ ] `python scripts/check_bb_prime_integration.py` — all 21 tests PASS
- [ ] No orphaned processes after run (`ps aux | grep prime-agent` clean)
- [ ] No orphaned claim files (`ls ~/.prime/agent/acp-mirror-claims/` empty)

## Resolved questions (investigated)

1. **bb hardcodes "ipython"?** — No. `adapter-utils.ts:312` reads `tool_name` dynamically; `system-message.ts:66` uses `toolName: z.string()`. Only hit is in MDX grammar. `python_repl` rename is safe.
    - **Status**: print `1 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

2. **bb CLI for mirror threads?** — No dedicated subcommand. `bb thread list --parent-thread <id> --json` filters; `parentThreadId` in JSON identifies mirror threads. `bb thread wait --status idle --timeout` + `bb thread output --json` for completion.
    - **Status**: print `2 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.

3. **Orphan-sweep retry count?** — Exactly 1 retry. `TriggerOrphanSweep` → `SwitchSession` retry → `internal_error` on failure. 300s periodic sweep is backstop. No extra limit needed.
    - **Status**: print `3 PASS/FAIL <duration>s` — observed state + assertion result + daemon log tail on failure.
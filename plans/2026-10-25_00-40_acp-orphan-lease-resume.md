# ACP session/load fails after bb idle-reap: orphaned Resident worker holds the session lease

## Root cause (verified from live artifacts)

Thread `thr_9cnn4qk8m7` (bb provider `acp-prime-agent-rust`, binary `/Users/k.sidenko/bin/prime-agent-rust-bb` -> `target/fast-release/prime-agent`).

Timeline (local = UTC+7):
1. 23:20:11 — thread started. bb spawns `prime-agent-rust-bb --mode acp`; the CLI create uses `DaemonSessionLifecycle::Resident` (`crates/pa-cli/src/print_runtime.rs`, `daemon_acp_create`); daemon launches worker `3e837883eef1` (pid 69829) on fresh session `01a16eb6-70ce-75de-9d2a-b2430c53f8de.jsonl`; ACP id `cdc1c03d-...` registered in `~/.prime/agent/sessions/acp-session-registry.json`.
2. 23:28 — last turn ends (`3e837883eef1.recovery.jsonl` `turn_end` 16:28:14Z).
3. 23:59:01 — bb host-daemon's idle reaper (30 min, `IDLE_PROVIDER_SESSION_REAP_AFTER_MS`) kills the ACP bridge process ("Reaped idle provider sessions", `idleForMs:1847854`). The daemon worker pid 69829 survives, still holding `~/.prime/agent/session-leases/9db11b9e...lock/owner.json` (sha256 of the session file path).
4. 00:16:10 — user resumes the thread; bb spawns a new `--mode acp` process (pid 85771); it boots its own fresh session `01a16ee9-...` (worker `bc3828db609a`), then bb sends `session/load` for `cdc1c03d-...`.
5. `handle_session_load` (`crates/pa-daemon/src/acp/daemon.rs:1451`) resolves the registry entry and the file fine, but `SwitchSession` is refused: "Session is already active in 3e837883eef1" (foreign holder). The handler detects a foreign holder, calls `TriggerOrphanSweep`, retries once — the sweep does NOT passivate the holder, the retry fails, load returns an internal error.
6. bb's bridge (`packages/provider-bridge-acp/src/bridge/bridge.ts:1851-1900`) catches any `session/load` error, falls back to a fresh session, and emits the warning: "<agentLabel> could not restore the previous session; continuing in a fresh session without in-agent history."

Why the sweep does not release the lease — the actual defect:
- `passivate_orphaned_workers` (`crates/pa-daemon/src/supervisor/worker_lifecycle.rs:727`) skips every worker with `owner_client_id == None` (`let Some(owner) = ... else { continue; }`).
- ACP-mode workers are always created `Resident` (owner None; `ClientOwned` only with `--no-session`), so the sweep's orphan criterion can never match the exact scenario it was written for (its own doc comment: "workers whose ACP connection was reaped (bb host-daemon idle-reap)").
- The worker-driven idle passivation never fires either: the passivation window is armed only inside the turn runner (`crates/pa-daemon/src/worker/turn.rs:130`), and the default threshold is 90 min anyway — past bb's 30-min reap. Result: an ACP worker orphaned by its client's death holds the session lease indefinitely (pid 69829 is still alive and leased >1 h later).
- So every bb thread resumed after >=30 min idle hits this: 15 "could not restore" warnings already in `~/.bb/bb.db` events across threads.

The fix shipped in 7305b35f0 ("orphaned-worker sweep + session/load retry on foreign lease") works in its unit tests (mocked sweep) but never in the real bb-reap case it targets.

## Plan

1. Track the creating ACP client on the worker descriptor: in `Supervisor::handle_create` (`crates/pa-daemon/src/supervisor/sessions.rs:605`), when the create config has `executionMode: "acp"` and lifecycle is `Resident`, store the creating daemon client id in a new descriptor field (e.g. `acp_client_id: Option<String>`). Do NOT flip the lifecycle to `ClientOwned` — the roster row must survive the stop (bb resumes over the session file), and `ClientOwned` stop semantics kill ephemeral rows.
2. Prompt release on ACP client death: when that client's last connection closes, schedule a stop after `OWNED_WORKER_DISCONNECT_GRACE` (30 s, reuse `schedule_owned_worker_cleanup_for_client` machinery in `crates/pa-daemon/src/supervisor/clients.rs`), but run the stop through the graceful passivation path (`passivate_roster_worker` with `ephemeral=false`) so the session row stays visible and the next load re-creates a worker over the file.
3. Fix the sweep criterion: `passivate_orphaned_workers` additionally matches workers with `acp_client_id` set whose client is disconnected (`client_connected` false) and no in-flight routes (keep the existing `inflight` guard). This is the backstop when the 30-s timer misses (crash loops, supervisor restarts) and it also clears the already-orphaned workers currently holding leases (e.g. pid 69829).
4. `session/load` needs no change: its foreign-holder path already triggers `TriggerOrphanSweep` and retries once; with steps 2-3 the sweep now passivates the holder and the retry switches this process onto the restored file (history preserved).
5. Regression tests (red-first, `crates/pa-daemon`):
   - Supervisor test: create an ACP/Resident worker with an attached client; disconnect the client; run the sweep; assert the worker stopped, the session lease released, and the roster row passivated (not dead). Fails today (sweep skips Resident workers).
   - Live-holder guard test: an ACP worker whose client is still connected is NOT passivated by the sweep (keeps `session_load_fails_when_a_foreign_live_worker_holds_the_lease` meaningful).
   - ACP end-to-end mirroring the bb reap: spawn `--mode acp` (or the in-process equivalent), let it register, kill its client, spawn a new one, `session/load` the old ACP id; assert the load succeeds and the restored session file is the original (not a fresh one).
6. Gates: `make check` (fmt, clippy -D warnings, workspace tests). PR notes: internals-only change (no new pub surface, no new deps); parity-diff evidence: user-visible invariant "resuming an idle bb thread restores in-agent history" verified against the TS binary path where applicable; adoption telemetry not required (no new user-visible feature; the invariant restores existing behavior).

## Out of scope / follow-ups
- The idle-passivation arming gap for non-ACP Resident workers (window armed only in the turn runner) — separate change if ever needed.
- bb-side reap tuning (30 min) — not needed once the daemon tolerates client death.
- The already-split history of `thr_9cnn4qk8m7`: the original file `01a16eb6-...jsonl` is intact on disk and can be re-attached manually; the fix only prevents future splits.

## Assumptions to confirm
- 30 s disconnect grace for ACP workers is acceptable (a live-but-idle ACP connection stays attached, so the grace only starts after the bridge process is really gone).
- Scope is `executionMode == "acp"` creates only; interactive Resident workers keep current behavior.

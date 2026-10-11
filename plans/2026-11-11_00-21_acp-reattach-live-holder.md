# Plan: ACP session load — reattach on live holder (parity with TS)

## Root cause

When bb reconnects after a bridge death, the Rust ACP session/load handler
sends SwitchSession to the daemon. If an orphan worker (alive, dead bridge)
holds the lease, the daemon's acquire_session_lease returns
SessionAlreadyActiveError with active_session_id.

The Rust ACP layer **doesn't reattach** — it tries to kill the holder via
TriggerOrphanSweep → retry SwitchSession → PassivateFileHolder → retry
→ internal_error. For a busy orphan worker (long turn), the sweep can't
passivate in time, all retries fail, and bb falls back to a fresh session
with **no history**.

## TS behavior (stable)

The TS switchSession catch block (daemon-agent-connection.ts:1713-1725):

1. SessionAlreadyActiveError with activeSessionId:
   - If activeSessionId === sourceActiveSessionId → no-op success
   - If different → reattachSession(source, target) — sends reattach
     daemon command, streams snapshot from the already-active session,
     preserves all history
2. No orphan sweep, no passivate_file_holder, no retry chain

The lease itself is self-healing: acquireSessionLease reclaims stale
leases (dead owner pid/processStartId) synchronously. A live owner gets
SessionAlreadyActiveError, and the client **reattaches** instead of
killing.

## Rust state

Already matching TS (no changes needed):

| Component | File | Status |
|---|---|---|
| acquire_session_lease — stale reclaim + SessionAlreadyActiveError with active_session_id | lease.rs:472-560 | OK |
| HoldIdentity carries active_session_id | hold_refusal.rs | OK |
| DaemonCommand::Reattach with target_active_session_id | command.rs:285 | OK |
| DaemonResponse.error_info: Option<DaemonErrorInfo> carries SessionAlreadyActive | outbound.rs:17 | OK |

Broken (the fix target):

- acp/daemon.rs:1594-1700 — SwitchSession error handler: no reattach
  path; instead does orphan sweep + passivate + retry → internal_error

## Changes

### 1. acp/daemon.rs — reattach on SessionAlreadyActive

Replace the foreign-holder retry chain with a reattach path, mirroring
the TS switchSession catch block.

When SwitchSession fails with "Session is already active":

1. Check response.error_info for
   DaemonErrorInfo::SessionAlreadyActive with active_session_id.
2. If active_session_id is Some(id):
   - If id == binding.active_session_id → no-op success (self-hosted,
     same as TS: return cancelled: false).
   - If different → send DaemonCommand::Reattach with
     active_session_id = binding.active_session_id,
     target_active_session_id = id.
     On success → proceed with admitAcpSession under the reattached
     session. On failure → internal_error.
3. If active_session_id is None (no typed error info — legacy or
   edge case) → fall back to the existing orphan sweep + passivate +
   retry chain (unchanged). This is the safety net, not the primary
   path.

Remove the immediate retry-after-sweep: the current code fires
TriggerOrphanSweep then retries SwitchSession instantly (no wait).
The sweep is async — the retry races the sweep. Keep the sweep as the
fallback's first step, but the reattach path (step 2) makes it
secondary for the live-holder case.

### 2. Regression test

Add a test in acp/daemon.rs mirroring the existing
session_load_retries_after_orphan_sweep_releases_foreign_lease:

session_load_reattaches_when_holder_is_alive:
- First SwitchSession fails with "Session is already active" and
  error_info: SessionAlreadyActive with active_session_id: "orphan-id".
- The ACP handler sends Reattach with
  target_active_session_id: "orphan-id".
- Reattach succeeds — session loaded with full history.
- No TriggerOrphanSweep, no PassivateFileHolder sent.

## What stays unchanged

- lease.rs — already matches TS (stale reclaim, typed error)
- hold_refusal.rs — already carries active_session_id
- Reattach command — already exists, already has the right fields
- DaemonResponse.error_info — already carries SessionAlreadyActive
- The 300s periodic orphan sweep — stays as the ultimate backstop for
  dead-holder edge cases

## Not in scope

- prime-agent stop writing session_state archived — separate issue
  (stop_cleanup.rs finalize path). Not part of this fix.
- The bb.db event cleanup — manual recovery, not a code fix.
- The PassivateFileHolder path — kept as fallback for None
  active_session_id, but not the primary path.


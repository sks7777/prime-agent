---
name: bb-subagents
description: Spawn RLM subagents that surface as real bb child threads ("mirror threads") in the general thread list. Use from a daemon-backed orchestrator session inside bb when subagents should be visible, openable, and steerable in bb. Outside bb use plain rlm.spawn.
---

# BB Subagents (mirror threads)

`spawn_mirror(task, name)` spawns an RLM subagent **and** a real bb child thread in one call.
The subagent keeps the full RLM runtime (kernel, `agent_message`, `rlm.collect`, family
observation). The bb thread — child of this thread, provider `acp-prime-agent` — streams the
subagent's live transcript: open it to watch, send messages to steer, or stop it.

Call from the kernel:

```python
from bb_subagents import spawn_mirror

mirror = await spawn_mirror("Analyze batch 1 files and write catalog1.md", name="visual-overview")
mirror["bb_thread_id"]      # the visible thread
mirror["active_session_id"] # the RLM session the thread is bound to
mirror["handle"]            # rlm.spawn handle fields (rlm_child_id, session_dir, model)
```

## Mechanics (B-deferred mirror)

- The child is admitted with its admission prompt deferred (`rlm.spawn` `bb_mirror=True`).
- The skill writes a single-use claim file (`<agent dir>/acp-mirror-claims/<nonce>.json`, 10 min
  TTL) naming the child's daemon session, and the mirror thread's prompt carries only a leading
  `[rlm-mirror:<nonce>]` marker line. The mirror thread's ACP frontend resolves the nonce to the
  child, verifies it is an RLM subagent session of the same working directory, rebinds, consumes
  the claim, and the bb prompt becomes the child's admission turn — the whole task runs inside
  the bb turn, so live streaming, status, and the stop button work natively.
- The marker only rebinds a freshly booted frontend; a later prompt on the mirror thread
  steers the same session.
- A waiting child settles on its own: cancellation/`rlm.delete_subagent` resolves it, and an
  unprompted child times out after 10 minutes (failed child, parent unblocked).

## Semantics and limits

- Results reach the parent through `agent_message` replies or files, exactly like plain
  `rlm.spawn`; consume with `rlm.collect` / `rlm.list_subagents`.
- Mirror threads only work on this machine (the daemon socket is local). Cross-machine or
  headless runs must use plain `rlm.spawn`.
- The thread's stop button aborts the child's current turn (not the child itself); the parent
  sees the aborted turn as a failed child turn.
- A stale/invalid claim degrades: the thread runs as a normal agent thread (the parent sees
  the untouched child via `rlm.collect`).
- Finished mirror threads are kept in the list (user preference); archive manually with
  `bbtools_thread_archive` if desired.

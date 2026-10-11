# Fix: bb mirror thread displays wrong LLM model

## Root cause

When `rlm.spawn(model=...)` runs inside a bb session, the child is mirrored
into a real bb thread via `bb thread spawn`. The bb CLI supports `--model`
and `--reasoning-level` flags, but **neither the daemon auto-mirror path nor
the `bb-subagents` skill forwards them**. The bb thread falls back to the
project's remembered default for `acp-prime-agent`, so bb displays that
default model instead of the model actually passed to `rlm.spawn`.

Two independent call sites share the bug:

1. **Daemon auto-mirror** — `crates/pa-daemon/src/rlm_bb_mirror.rs`
   - `BbMirrorSpawnOptions` (line 326) has no `model` / `reasoning_level` fields.
   - `spawn_bb_mirror_thread` (line 345) builds the `bb thread spawn` arg list
     without `--model` or `--reasoning-level`.
   - Caller `crates/pa-daemon/src/rlm_children/host.rs` (line 296) has the
     resolved `model` (line 117) and `thinking` (line 129) in scope but does
     not pass them through `BbMirrorSpawnOptions`.

2. **`bb-subagents` skill** — `skills/bb-subagents/src/bb_subagents/__init__.py`
   - `spawn_mirror` (line 139) builds the `bb thread spawn` arg list
     (line ~180) without `--model` / `--reasoning-level`, even though it
     accepts `model` and `thinking` params and forwards them to `rlm_spawn`.

The child session itself gets the correct model (lifecycle.rs writes it into
`config["model"]` and `runtime_metadata["model"]`), so the actual LLM
inference uses the right model. The bug is purely the bb **display**: bb's
thread list / thread metadata records the spawn-time `--model`, which is the
project default, not the requested model.

## Resolved questions

### `--model` format: id only, not `provider/id`

bb CLI help (`bb thread spawn --help`):
- `--provider <id>` — Provider ID (separate flag).
- `--model <model>` — "Model ID for the thread. Omit to use the project's
  remembered default for the resolved provider."

The daemon's model catalog (`model_catalog.rs`, `catalog_payload`) keys
models as `format!("{}/{}", model.provider, model.id)` and the wire `Model`
object carries separate `provider` + `id` fields. The `--provider` flag
already carries the bridge id (`acp-prime-agent` / `acp-prime-agent-rust`),
so `--model` takes **only the id part** of the resolved `provider/id`
selector — i.e. the value after `split_once('/')`.

Example: `rlm.spawn(model="anthropic/claude-sonnet-4")` resolves to
`provider="anthropic", id="claude-sonnet-4"`; pass `--model claude-sonnet-4`
(the `--provider` flag stays the bridge id, not `anthropic`).

### `--reasoning-level` mapping: omit for off/minimal

bb accepts `--reasoning-level` values: `low, medium, high, xhigh, max`
(plus provider-specific ids). The daemon `ModelThinkingLevel` enum
(`models_generated.rs`) adds `off` and `minimal`, which have **no bb
equivalent**. Mapping:
- `off` → omit `--reasoning-level` (bb uses its default = no reasoning)
- `minimal` → omit `--reasoning-level`
- `low`, `medium`, `high`, `xhigh`, `max` → pass as-is

### Bonus discrepancy: provider name `acp-prime-agent` vs `acp-prime-agent-rust`

`spawn_bb_mirror_thread` hardcodes `--provider acp-prime-agent` (line
362), but `scripts/run-rust-daemon.sh` registers the daemon with bb as
`acp-prime-agent-rust`. If bb rejects `acp-prime-agent` as an unknown
provider, the mirror thread spawn fails. This is a separate bug; flag it
in the PR but do not block the model fix on it. Confirm the live provider
name by checking `bb provider models` / `bb provider list` on the target
host before deciding which to fix.

## Fix

### 1. Daemon: `crates/pa-daemon/src/rlm_bb_mirror.rs`

Add two fields to `BbMirrorSpawnOptions` (line 326):
```rust
pub model: Option<String>,
pub reasoning_level: Option<String>,
```

In `spawn_bb_mirror_thread` (line 345), after the `--prompt-file -` arg
and before the environment arg, append:
```rust
if let Some(model) = &options.model {
    cmd.args(["--model", model]);
}
if let Some(level) = &options.reasoning_level {
    cmd.args(["--reasoning-level", level]);
}
```

### 2. Daemon caller: `crates/pa-daemon/src/rlm_children/host.rs`

At the auto-mirror spawn site (line 296), populate the new fields:

- `model`: the **id part** of the resolved `provider/id` selector. The
  resolved `model` at line 117 is the full `provider/id`; split with
  `model.split_once('/')` and pass `Some(id)`. The `--provider` flag stays
  the bridge id (`acp-prime-agent` / `acp-prime-agent-rust`), not the LLM
  provider.
- `reasoning_level`: map `thinking` (line 129) per the table above. For
  `off` / `minimal` / `None` pass `None` (omit the flag). For
  `low` / `medium` / `high` / `xhigh` / `max` pass `Some(value)`.

Apply the same at the explicit `bb_mirror=True` path further down
host.rs (around line 583) for parity.

### 3. Skill: `skills/bb-subagents/src/bb_subagents/__init__.py`

In `spawn_mirror`, extend the `bb thread spawn` arg list to forward
`--model` and `--reasoning-level` when `model` / `thinking` are set, using
the same format and mapping as the daemon fix:
- `--model` takes the id part after `split_once('/')`
- `--reasoning-level` omitted for `off` / `minimal` / `None`

## Validation

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace` (gates per AGENTS.md).
- New unit test in `rlm_bb_mirror.rs`: assert `spawn_bb_mirror_thread`
  passes `--model` when `BbMirrorSpawnOptions.model` is set, and omits it
  when `None`; same for `--reasoning-level`.
- E2E: inside a bb session, `rlm.spawn(model="anthropic/claude-sonnet-4")`
  produces a mirror thread whose bb thread list row shows the requested
  model (not the project default). Diff the bb thread list against a TS
  binary run with the same spawn — the displayed model must match.
- Regression guard: the `bb-subagents` `spawn_mirror` path also displays
  the forwarded model.

## Out of scope

- The `acp-prime-agent` vs `acp-prime-agent-rust` provider name mismatch
(flagged above; fix in a follow-up PR once the live provider name is
confirmed).
- Any change to the child session's actual model routing (lifecycle.rs
  is correct; only the bb display is wrong).

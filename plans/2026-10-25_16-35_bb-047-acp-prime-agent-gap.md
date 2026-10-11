# bb 0.47.0 → prime-agent ACP integration: required refinements

## What 0.47.0 changes (bb side)

bb 0.47.0 (Oct 23 2026) promotes the rebuilt ACP adapter (introduced in 0.46.1 as
`provider-bridge-acp-next`, commit `fe1a02d7b` #5266) to the default, replacing the
old adapter. The rebuilt adapter:

- Uses the official `@agentclientprotocol/sdk` 1.7.0, pinned to ACP spec 1.x.
- Keeps what the agent reports instead of dropping it (the old adapter hand-parsed
  and discarded): agent reasoning levels, modes, live slash commands, agent
  questions, cost, autonomous work.
- Adds `sourceCode` field to the command/tool-call delta (commit `b4ea24fb7`,
  bumps `HOST_DAEMON_PROTOCOL_VERSION` 241→242 — bb-internal, not ACP wire).
- Adds `bb acp add <agent-id>` CLI for the ACP registry (bb-side; registers
  `AcpAgentDefinition` entries: id, displayName, launch spec, dialect, models,
  reasoning levels, permission modes, native skill roots).

bb source of truth: `/Users/k.sidenko/Development/bb/packages/provider-bridge-acp/src/wire.ts`
defines `ACP_PROTOCOL_VERSION = 1` and six `sessionUpdate` types:
`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`,
`plan`, `usage_update` (+ fallback `z.string()`for unknown).

## What prime-agent already supports

`crates/pa-daemon/src/acp/daemon.rs` handles the JSON-RPC methods the bridge calls:
`initialize`, `session/new`, `session/load`, `session/fork`, `session/set_config_option`,
`session/prompt`, `session/close`, `session/cancel`. `wire_events.rs` maps daemon
session events to ACP session updates:

- `message_start` → starts assistant message
- `message_end` → `usage_update` (confirmed, line 1080)
- `tool_execution_start` → `tool_call` (line 729)
- `tool_execution_end` → `tool_call_update` (line 742)
- `ipython_sent_agent_message` → `agent_message_chunk` / `agent_thought_chunk` (lines 646, 659)
- `compaction_end` → compaction meta (line 760)
- `goal_update` → goal meta (line 670)

`wire_config.rs` publishes picker options via `session/set_config_option` and
`config_option_update`; `session_registry.rs` persists cross-process ACP ids.

## The gap (what prime-agent must add)

### 1. `plan` session update is not emitted
bb's `acpPlanUpdateSchema` (`wire.ts:176`) expects `sessionUpdate: "plan"` with
`entries: [{ content, status: "pending"|"in_progress"|"completed" }]`. prime-agent
has goal/plan data (the goal.create/goal.get/goal.complete harness tools) but
`wire_events.rs` has no `goal_update → plan` mapping. The `goal_update` event
(line 301) currently maps to goal meta only, not to an ACP `plan` update.

### 2. `sourceCode` field in tool-call content
bb commit `b4ea24fb7` adds `sourceCode` to the command delta and
`TimelineCommandWorkRow` so the full ipython cell code is visible in the
expanded view. prime-agent's `rawInput` exists (`types.rs:163`) but the
`tool_call`/`tool_call_update` payload builder in `wire_events.rs` does not
emit `sourceCode`. Verify whether bb extracts it from `rawInput.code` itself
(the commit says "when rawInput.command is absent but rawInput.code exists")
— if bb does the extraction, prime-agent only needs to ensure `rawInput.code`
is populated for ipython cells, which it already does.

### 3. Live slash commands
0.47.0 surfaces live slash commands. bb sends these as standard ACP
`session/update` notifications (or as `session/request_permission` requests);
they do not require a new wire method. Confirm prime-agent emits slash-command
invocations as tool-call updates with `kind: "execute"` (or the matching
dialect shape) so bb's bridge classifies them.

### 4. Agent questions
bb shows agent questions inline. These are standard ACP session updates
(`agent_message_chunk` with a question, or a `session/request_permission`
request). No new wire method needed. Confirm prime-agent's question-shaped
assistant messages map to `agent_message_chunk` (they do).

### 5. ACP registry (`bb acp add`)
This is a bb CLI command that writes `AcpAgentDefinition` entries into bb's
own config. prime-agent is a server, not a registry client; it does not need to
register itself. But prime-agent should be discoverable by the bb probe
(`probeAcpAgent` in `probe.ts`) — it already is, via `initialize`. No change
needed unless prime-agent wants to advertise itself in `bb acp list` output.

## Validation steps

1. Run bb's `probeAcpAgent` against `prime-agent` (bb side) and confirm it
   reports `reachable: true, fork: true` — prime-agent already answers
   `initialize` with `sessionCapabilities.fork`.
2. Start an ACP session from bb to prime-agent, send a goal, and confirm bb
   receives: `agent_message_chunk`, `tool_call`/`tool_call_update`,
   `usage_update`, and `agent_thought_chunk` (5/6 already work).
3. Trigger a goal/plan and confirm bb does NOT receive a `plan` session
   update — that is the regression this plan fixes.
4. After the fix, confirm bb receives `plan` updates with the right
   `entries` shape and `status` values.
5. Run the parity diff against the TS binary for the same goal scenario
   (golden corpus) to ensure byte-identical wire traffic.


## Open questions — resolved

- **`sourceCode` extraction**: bb extracts it client-side itself.
  `extractAcpSourceCode` in `tool-call-operation.ts` (commit `b4ea24fb7`)
  reads `rawInput.code` when present and attaches `sourceCode` to the
  `command` tool-call kind. prime-agent already populates `rawInput.code`
  for ipython cells (`types.rs:163`). No change needed in prime-agent.
- **`authenticate` handler**: not needed. `bridge.ts` only calls
  `authenticate` when `initializeResult.authMethods` is non-empty
  (`resolveAcpAuthMethodId` returns undefined otherwise). prime-agent's
  `initialize_result` (`types.rs:594`) does NOT advertise `authMethods`,
  so the bridge skips `authenticate` entirely. No handler needed unless
  prime-agent wants to add OAuth/API-key auth later.

## Validation results (bb threads thr_2u254ueytb, thr_x7ahgsgxj8)

| Check | Result |
| --- | --- |
| Probe reachable + fork | PASS — `acp-prime-agent-rust` available, health, supportsFork=true |
| 5/6 update types | PASS — tool_call, tool_call_update, agent_thought_chunk, agent_message_chunk, usage_update |
| plan session update | PASS — wire_events.rs goal_update→plan mapping added; unit test `goal_update_publishes_a_plan_entry_besides_the_session_info` green |
| Parity diff (Rust vs TS 0.9.8) | PASS — initialize byte-identical; 5 shared update types identical; `plan` is Rust-only (TS 0.9.8 emits 0 plan frames) |

Report: `acp-validation-report.md`.

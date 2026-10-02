Analyze the LLM efficiency of a Prime Agent session from its JSONL log.

## Input

The session file path is given as an argument. Read it with Python (`json.loads` per line).

## Data model

Each line is a JSON object. Relevant types:

- `session` — metadata: `id`, `timestamp`, `cwd`, `git.branch`, `git.commit`, `rlmDepth`
- `model_change` — `provider`, `modelId`
- `thinking_level_change` — `thinkingLevel`
- `message` with `message.role`:
  - `user` — `content` (string or array of `{type:"text", text}` blocks)
  - `assistant` — `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`), `stopReason`, `content` (array of blocks: `{type:"toolCall", name, arguments}`, `{type:"text", text}`, `{type:"thinking", thinking}`)
  - `toolResult` — `toolName`, `isError`, `toolCallId`
- `child_usage_attributed` — `childUsage` and `aggregateUsage` (token rollup from spawned children)
- `custom_message` with `customType` — `prime-agent.refinement`, `harness_digest`, etc.

## Metrics to extract

### Per-turn metrics (each assistant message = one turn)

1. **Tool calls per turn** — count `type:"toolCall"` blocks in `content`
2. **Has thinking** — any `type:"thinking"` block with non-empty `thinking` text
3. **Stop reason** — `stopReason` field (`toolUse`, `endTurn`, `error`, `aborted`)
4. **Usage** — `input`, `output`, `cacheRead`, `cacheWrite` from `usage`
5. **Timestamp** — `timestamp` for wall-clock calculations

### Session-level aggregates

6. **Total turns** — count of assistant messages
7. **Tool-call rounds** — assistant messages with ≥1 tool call
8. **Single-call rounds** — tool-call rounds with exactly 1 tool call
9. **Batch rounds** — tool-call rounds with ≥2 tool calls
10. **Single-call ratio** — single-call / tool-call rounds × 100%
11. **Avg calls per round** — total tool calls / tool-call rounds
12. **Max calls in one turn** — highest tool-call count in any single turn
13. **Wall-clock** — last timestamp minus first timestamp (exclude gaps >120s as user think time)
14. **LLM time** — sum of gaps from toolResult to next assistant (LLM generation)
15. **Tool time** — sum of gaps from assistant to next toolResult (tool execution)
16. **LLM/tool ratio** — LLM time / tool time
17. **Total input tokens** — sum of `usage.input` across all assistant turns
18. **Total output tokens** — sum of `usage.output`
19. **Total cacheRead** — sum of `usage.cacheRead`
20. **Cache hit ratio** — cacheRead / (cacheRead + input) × 100%
21. **Cache write** — sum of `usage.cacheWrite` (should be 0 for cached sessions)
22. **Thinking turns** — count of turns with non-empty thinking blocks
23. **Thinking ratio** — thinking turns / total turns × 100%
24. **Aborted/error turns** — count of turns with stopReason `aborted` or `error`

### Delegation metrics

25. **rlm.spawn count** — count of tool calls or ipython cells containing `rlm.spawn`
26. **Child sessions** — count of `child_usage_attributed` events
27. **Child token usage** — sum of `childUsage.input`, `childUsage.output`, `childUsage.cacheRead`
28. **Delegation speedup** — if children ran in parallel: sum of child wall-clock / parent wall-clock (approximate)

### Collapsible sequences

29. **Collapsible sequences** — runs of ≥2 consecutive single-call rounds where the calls are independent (different files or different commands). Count the sequences and the total collapsible turns (sequence length - 1 each).

### Quality indicators

30. **Tool errors** — count of `toolResult` with `isError: true`
31. **Self-check present** — does any turn text contain verification language ("recompute", "verify", "self-check", "cross-check")?
32. **Final answer present** — is there a final assistant turn with 0 tool calls and non-empty text?

## Output format

Produce a report with these sections:

### Session metadata
Table: session ID, branch, commit, model, thinking level, start time, duration.

### Efficiency summary
Table with all session-level aggregates (items 6-24).

### Per-turn breakdown
One row per assistant turn: turn #, timestamp, tool calls, stop reason, input tokens, output tokens, cacheRead, has thinking.

### Delegation
Table with items 25-28 if any children were spawned.

### Collapsible sequences
List each sequence with turn numbers and commands. Total collapsible turns.

### Quality
Items 30-32.

### Assessment
2-3 sentences: is this session efficient? Where are the biggest time sinks? What would save the most wall-clock?

## Constraints

- Use only the JSONL file — do not search the repo or read other files.
- Calculate wall-clock by parsing ISO timestamps with `datetime.fromisoformat(ts.replace("Z","+00:00"))`.
- Exclude gaps >120s between consecutive messages (user think time).
- For tool call commands, extract from `arguments.command` (bash tool) or `arguments.code` (ipython tool).
- Report numbers as integers, ratios as percentages with 1 decimal.

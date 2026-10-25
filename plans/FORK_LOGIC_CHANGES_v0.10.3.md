# Отчёт: изменения логики в форке (v0.10.1 → v0.10.3 upgrade)

Дата: 2026-11-12

Базовый тег: v0.10.1 (0d457e8eb6)
Целевой тег: v0.10.3 (178ec89630)
Всего коммитов в форке: 48
Cherry-picked: 41
Пропущено: 7

---

## #1 51b8d314a4 — fix: macOS platform compatibility, baseline tests, build tooling for v0.10.0

**28 files changed, 317 insertions(+), 21 deletions(-)**

### Было

- Baseline: все non-bug тесты проходят. Known baseline bugs v0.10.0:
- - "session lease does not own append target" (race в kill)
- - agents_view_flash_e2e: dead subagents assertion (0 vs 300)
- - acp_mode_e2e: EOF cancellation race
- - differential_cli: требует TS binary

### Стало

- Этап 0 — Инициализация: worktree, config dir, baseline тесты, macOS compat.
- 1. macOS platform compatibility (26 файлов):
- - Non-blocking socket inheritance: UnixListener::set_nonblocking(true)
- наследуется accepted streams на macOS — mock supervisor тесты получают
- EAGAIN. Fix: set_nonblocking(false) после accept() (9 pa-tui test файлов).
- - Linux-only APIs без platform gates: /proc/, ptsname_r, c_line,
- prctl/PR_SET_PDEATHSIG, pty EIO. Fix: gate к target_os = linux
- (11 test файлов). c_line field conditional в shared harness.
- - crossterm vendor warnings: invalid cfg(winapi)/cfg(crossterm_winapi)
- → target_os = windows, dead_code allow на InternalEventFilter,
- unused_parens fix, check-cfg lints в Cargo.toml.
- 2. Baseline test suite (scripts/baseline-tests.sh):
- - Unit-тесты 9 crate'ов, ~80 mock-supervisor headless тестов,
- ~70 daemon e2e тестов, ~14 Linux-only тестов (skip на macOS).
- - sccache для кэширования компиляции (~30% ускорение).

**Файлы (28):**

- `crates/pa-cli/tests/clipboard_auth_commands_e2e.rs`
- `crates/pa-cli/tests/export_live_differential.rs`
- `crates/pa-cli/tests/export_share_e2e.rs`
- `crates/pa-cli/tests/interactive_daemon_e2e.rs`
- `crates/pa-cli/tests/interactive_fork_e2e.rs`
- `crates/pa-cli/tests/kitty_exit_routes_e2e/main.rs`
- `crates/pa-cli/tests/mcp_view_e2e.rs`
- `crates/pa-cli/tests/terminal_state_differential_e2e/harness.rs`
- `crates/pa-cli/tests/terminal_state_differential_e2e/main.rs`
- `crates/pa-cli/tests/termios_process_exit_e2e.rs`
- ... и ещё 18

---

## #2 74e02bd10e — perf: add fast-release build profile and lld linker for local iteration

**3 files changed, 64 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- Добавлен profile.fast-release в Cargo.toml:
- - lto = false (no cross-crate LTO, link ~2x faster)
- - codegen-units = 16 (more parallel codegen)
- - incremental = true (only recompile changed crates)
- - strip = true (smaller binary)
- Билд: cargo build --profile fast-release -p pa-cli --bin prime-agent
- Инкрементальный: 12s (вместо 2.5min для --release --workspace)
- С нуля: 2m26s (вместо 4m+ для --release --workspace)
- .cargo/config.toml: lld linker включён.
- ld64.lld symlink: ~/.local/bin/ld64.lld → rust-lld из Rust toolchain.
- clang передаёт -fuse-ld=lld, ld64.lld обрабатывает Mach-O linking.
- run-rust-daemon.sh: обновлён для поддержки PROFILE=fast-release|release.

**Файлы (3):**

- `.cargo/config.toml`
- `Cargo.toml`
- `scripts/run-rust-daemon.sh`

---

## #3 3355caa197 — feat(pa-core): temperature kwarg for rlm.spawn

**6 files changed, 361 insertions(+), 1204 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- - cdc2973b2 — feat(rlm): temperature kwarg for rlm.run spawns
- - 286f50cd3 — refactor(rlm): import shared MCP helpers from mcp_base (already in v0.10.0)
- TS добавил temperature в AgentOptions → rlm.run kwargs → child Agent.
- Rust v0.10.0: RlmSpawnRequest в pa-core/src/session_engine/rlm_host.rs,
- создание child session в pa-daemon/src/rlm_children/lifecycle.rs create_child.
- :
- - RlmSpawnRequest.temperature: Option<f64>
- - optional_f64_kwarg для парсинга temperature из kwargs
- - spawn_request_from_payload принимает temperature в allowed kwargs
- - create_child пробрасывает temperature в config JSON daemon-воркера
- - Python spawn() принимает temperature: float | None, валидирует finite number
- - probe.rs RUNTIME_READY_CHECK проходит (temperature — optional kwarg)
- Тесты: 27 RLM unit tests pass, rlm_children_e2e (4/4), rlm_spawn_replacement_e2e (1/1).
- Коммит 286f50cd3 (MCP helpers) уже в v0.10.0 — дубликаты функций удалены upstream.

**Файлы (6):**

- `crates/pa-core/src/session_engine/rlm_host.rs`
- `crates/pa-daemon/src/rlm_children/host.rs`
- `crates/pa-daemon/src/rlm_children/lifecycle.rs`
- `crates/pa-daemon/src/rlm_children/spawn_name_reservation_tests.rs`
- `crates/pa-daemon/src/rlm_children/watch_tests.rs`
- `prime-agent-runtime/src/rlm/__init__.py`

---

## #4 d474180e05 — feat(pa-core): batch/compound-cell/delegation guidance in system prompt (PRIME-39)

**2 files changed, 4 insertions(+), 2 deletions(-)**

### Было

Системный промпт (usage.md) содержал базовые правила работы с Python REPL, но не описывал:
- как batching'нуть независимые tool calls в одной ячейке REPL
- speculative first cell pattern (запуск 2-3 независимых поисков одновременно)
- требование верифицировать числа в той же ячейке, которая их произвела
- порог делегирования (delegation threshold) стоял на 2+ turns

Модель работала последовательно: один bash() → ждёт результат → следующий bash(). Для research-задач это означало 3-5 sequential turns там, где достаточно одного compound cell с параллельными вызовами.

В core.md signature `rlm.spawn` не содержал параметр `temperature` — нельзя было задать температуру сэмплинга для child-агента при spawn.

### Стало

**usage.md — 5 новых поведенческих правил:**

1. **Batch/compound-cell guidance** — модель может вызывать несколько `bash()` в одной Python-ячейке REPL. Ядро выполняет их concurrently, каждый `await` — точка наблюдения. Пример: `h1 = bash('rg -n foo src/'); h2 = bash('rg -n bar src/'); r1, r2 = await h1, await h2` запускает оба поиска параллельно.

2. **Speculative first cell** — research-ходы начинать с одной ячейки, запускающей 2-3 независимых `bash()` поиска + чтение наиболее вероятного файла. Решение принимается по всем трём результатам сразу, вместо трёх последовательных turns.

3. **In-cell verification** — числа, которые модель сообщает в ответе, должны пересчитываться в той же ячейке Python, которая их произвела. Не копировать из предыдущей ячейки без проверки.

4. **Delegation threshold 3+ turns** — делегировать subagent'у задачи с 3+ turns research или multi-step работы. Задачи на 1-2 turns — делать inline compound cell'ом. Спавн child'а ради one-liner стоит дороже, чем экономит.

5. **Temperature kwarg в core.md** — `rlm.spawn` signature обновлён: добавлен `temperature: float | None = None`. Позволяет задать температуру сэмплинга LLM-вызовов child-агента (None = provider default).

**Продуктовый эффект:** research-задачи, которые раньше занимали 5-7 turns с одним bash за turn, теперь укладываются в 2-3 turns с compound cells. Модель активно использует batching: 3-5 параллельных bash() в одной ячейке — норма для research-ходов.

**Файлы (2):**

- `crates/pa-core/src/prompts/layers/core.md` — добавлен `temperature: float | None = None` в rlm.spawn signature
- `crates/pa-core/src/prompts/layers/usage.md` — добавлены batch/compound-cell/speculative-cell/verification/delegation правила

---

## #5 f0be750ecb — fix(pa-core): treat nonzero bash exits as data, not tool errors

**3 files changed, 103 insertions(+), 10 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- ran, and its output plus the status line is what the model needs to pick
- the next step. The bash tool used to bail on nonzero exits, which turned
- whole classes of useful results into error tool results (isError=true) —
- e.g. compound probe commands whose trailing grep/ls found nothing, or
- EPERM diagnostics with fully readable output.
- Now the tool resolves normally with 'Command exited with code N' appended
- to the text; real execution failures (spawn errors, timeouts, abort) keep
- rejecting. The normal return path also preserves details (truncation
- info, fullOutputPath) that the bail path dropped.
- - 901505832 — treat nonzero command exits as data, not tool errors
- TS bash.ts bailed on nonzero exit → Err → isError=true. Rust
- execute_bash had the same pattern: anyhow::bail! on nonzero exit. Changed
- to return Ok(ToolExecutionResult) with the status line in the text and
- is_error=false, preserving details. Timeout/abort paths unchanged.
- Тесты: new tests/bash_nonzero_exit.rs covers output+status, silent

**Файлы (3):**

- `crates/pa-core/src/tools/bash.rs`
- `crates/pa-core/tests/bash_nonzero_exit.rs`
- `crates/pa-core/tests/golden/corpus/bash.json`

---

## #6 4d123ad0fc — fix(pa-tui): normalize Cyrillic keybindings to Latin physical keys

**3 files changed, 192 insertions(+)**

### Было

- TS per-intercept raw bytes (addInputListener) before crossterm
- parsing. Rust crossterm already parses into KeyEvent with

### Стало

- keybindings match regardless of the active keyboard layout. When a
- keybinding modifier (ctrl/alt/super) is active, Cyrillic chars are
- mapped to their Latin physical-key equivalents (e.g. щ→o, с→c, г→u).
- Plain text input (no modifier) passes through unchanged — the user's
- Russian input is never altered.
- - e2dffd5a5 — Fixed keybindings not working with Russian keyboard layout
- KeyCode::Char(cyrillic_char). Fix: normalize the char in key_event_to_id
- when ctrl/alt/super is active. Shift-only is text input, not a
- keybinding modifier — Cyrillic uppercase passes through unchanged.
- Тесты: 8 новых тестов (3 в layout_normalize, 3 интеграционных в keys).
- Все ключи с модификаторами (ctrl/alt/super) нормализуются. Plain text
- не изменяется.

**Файлы (3):**

- `crates/pa-tui/src/keys.rs`
- `crates/pa-tui/src/layout_normalize.rs`
- `crates/pa-tui/src/lib.rs`

---

## #7 1669b96188 — fix: platform-dependent test assertions (macOS Alt→Option, git hash)

**3 files changed, 26 insertions(+), 13 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- 1. hotkeys guide_renders_* (3 tests): assertions hardcoded 'Alt' but
- format_key_text renders 'Option' on macOS. Fixed: build expected
- strings via format_key_text (platform-aware). Also fixed false
- positive in disabled-binding test: 'Ctrl+O' substring matched
- 'Ctrl+Option+]' — use backtick-delimited 'Ctrl+O' instead.
- 2. golden_bash_group destructive-reset-clean: git short hash is
- environment-dependent. Fixed: normalize 'HEAD is now at <hash>' to
- '<HASH>' placeholder in norm_string; update corpus to match.

**Файлы (3):**

- `crates/pa-core/src/tools/golden_replay.rs`
- `crates/pa-core/tests/golden/corpus/bash.json`
- `crates/pa-tui/src/hotkeys.rs`

---

## #8 1fffe1b056 — fix(pa-ai): preserve dynamically registered providers across reset

**1 file changed, 98 insertions(+), 1 deletion(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- providers, extension providers, embedders) instead of wiping the entire
- registry. A bare clear + register_builtins would break every later turn
- with 'No API provider registered for api: ...' when a reset reloads
- built-in transport wiring.
- - d587999e7 — resetApiProviders preserves dynamically registered providers
- - a5813cd18 — drop the duplicate builtin provider registration
- TS resetApiProviders filtered apiProviderRegistry by
- BUILTIN_API_IDS. Rust registry uses source_id: None = builtin,
- Some(_) = dynamic. Filter by source_id.is_some() — simpler and
- equivalent.
- Тесты: 2 новых теста — reset_preserves_dynamic_providers,
- reset_reloads_builtins.

**Файлы (1):**

- `crates/pa-ai/src/registry.rs`

---

## #9 578de2a498 — feat(pa-tui): notify bell on turn end + session name footer line

**2 files changed, 26 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- cannot be ported directly — Rust v0.10.0 has no TypeScript extension
- API. Features reimplemented as native TUI behavior:
- 1. Notify bell: rings terminal bell (\x07) on TurnEnded when there is
- no error and no queued messages, alerting the user that input is
- expected (replaces notify.ts agent_end + ctx.ui.bell()).
- 2. Session name footer: renders a dim 'name • cwd' line below the
- prompt tray in the dock (replaces session-name-footer.ts
- ctx.ui.setWidget with placement belowEditor).
- plan-code extension deferred — it requires /plan and /code mode
- infrastructure covered by PRIME-58.
- TS extensions depended on ExtensionAPI (bell, setWidget, notify,
- session lifecycle hooks). Rust v0.10.0 has no extension system — the
- 'extensions' settings key is a dead key. Reimplemented as native TUI
- features using existing ChromeState (chat_name, cwd) and TurnEnded
- handler.

**Файлы (2):**

- `crates/pa-tui/src/session_ui/apply.rs`
- `crates/pa-tui/src/view/panels.rs`

---

## #10 48e1bbd14d — feat(pa-daemon): ACP session/load + session/fork + usage_update (PRIME-53)

**6 files changed, 1417 insertions(+), 118 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- 1. usage_update: AcpSessionUpdate::UsageUpdate variant emitted on
- message_end for completed assistant responses. Reports context size
- (totalTokens or field sum fallback) and model context window. Seeded
- at session/new from connection state, refreshed per turn. Error/
- aborted responses and missing context_window emit nothing.
- 2. session/load: restores in-agent history when bb resumes a thread.
- Cross-process JSON registry (acp-session-registry.json) maps ACP
- session ids to runtime session files. Cwd validation rejects mismatched
- workspaces (PRIME-8 review). Registry resolve prefers recorded file,
- falls back to session-dir scan by runtime id.
- 3. session/fork: clones source session history into a branched file for
- bb thread forks. ForkCapability advertised in initialize. Uses
- SessionManager::fork_from for cloning. allowForeignCwd opt-in via
- _meta namespace (PRIME-25). Re-registers forked session for
- fork-of-fork support.

**Файлы (6):**

- `.changes/prime-53-acp-load-fork-usage.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/mod.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/acp/wire_events.rs`

---

## #11 b9eac19870 — feat: PRIME-55/56/57/59/61 — daemon recovery, quiescence, nameless tool, bare skill, RLM metadata

**53 files changed, 1216 insertions(+), 163 deletions(-)**

### Было

- reconnect loop (2s probe), re-attaches session, re-issues prompt with
- resumePendingUserMessage=true. New DaemonLink + event forwarder.
- - Graceful shutdown recovery: shutdown_recovery_pending flag detected
- from session_closed{shutdown} event. Pre-arms prompt with resume.
- PRIME-56 (quiescence on bash notice):
- before cell_finished.wait(). Host quiescence barrier tracks notice
- delivery, not process liveness. 2 Python tests.
- PRIME-57 (nameless tool call sanitize):
- - transform_messages.rs: drop tool calls with empty function name so
- OpenAI-compatible endpoints don't reject the whole request. 1 test.

### Стало

- PRIME-55 (daemon restart recovery):
- - Auto-retry metadata: auto_retry_start/end → ACP session_info_update
- with PrimeAgentAutoRetryMeta (phase/attempt/reason). 3 tests.
- - resumePendingUserMessage: new PromptInput field flows through
- PromptRequest → QueuedItem → run_turns. TurnAdmission::ResumePending
- variant. AgentSession::dangling_user_message_tail() checks transcript
- tail; when resume=true + dangling tail: skips UserMessage emit, uses
- agent.continue_run(). Wire protocol change across 50 files.
- - Prompt recovery: prompt_with_recovery() wraps link.request_until_close.
- On transport error: publishes autoRetry waiting meta, bounded 180s
- - bash.py: emit {active: True, exited: True} after _wait_reaped(),

**Файлы (53):**

- `crates/pa-ai/src/providers/transform_messages.rs`
- `crates/pa-core/src/session_engine/compaction_arms.rs`
- `crates/pa-core/src/skills/mod.rs`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/meta.rs`
- `crates/pa-daemon/src/acp/wire_events.rs`
- `crates/pa-daemon/src/agent_engine/session_engine_impl.rs`
- `crates/pa-daemon/src/agent_engine/tests.rs`
- `crates/pa-daemon/src/agent_engine/tests/abort.rs`
- `crates/pa-daemon/src/agent_engine/tests/autonomous.rs`
- ... и ещё 43

---

## #12 54be7902cf — feat: plan-code extension — /plan /code /dbg modes (PRIME-63)

**41 files changed, 1493 insertions(+), 4 deletions(-)**

### Было

- - /dbg — systematic diagnosis mode with debug behavioral prompt
- - /exit — exit mode, restore default tools and prompt
- - /todos — show plan progress (completed/total steps)
- Architecture:
- - PlanCodeMode enum (Plan/Code/Debug) + PlanCodeState in plan_code.rs
- - Mode state in SessionEngine, injected via SessionEngineConfig
- - execute_session_command handles all 5 commands
- - before_tool_call hook enforces plan-mode tool gating
- - System prompt builder injects mode-specific layer dynamically:
- plan_mode.md, code_mode.md, debug_mode.md

### Стало

- functionality (Rust v0.10.0 has no extension API):
- Slash commands:
- - /plan — read-only mode: edit tool disabled, bash classified
- (read-only auto-allow, catastrophic hard-block, others confirm),
- ipython checked for dangerous patterns. Plan markdown writes always
- allowed. Trailing args run as immediate prompt.
- - /code — full implementation mode with code behavioral prompt
- для PA v0.10.0 (Rust-порт). Реализовано как встроенная функциональность,
- не extension — Rust v0.10.0 не имеет TypeScript extension API.
- Тесты: 15 plan_code, 11 slash, 57 ACP — all green. Build OK.

**Файлы (41):**

- `crates/pa-agent/src/agent.rs`
- `crates/pa-cli/src/args.rs`
- `crates/pa-cli/src/interactive_mode.rs`
- `crates/pa-cli/src/mode.rs`
- `crates/pa-cli/src/print_boundary/tests.rs`
- `crates/pa-cli/src/print_goal.rs`
- `crates/pa-cli/src/print_runtime.rs`
- `crates/pa-cli/src/print_runtime/faux.rs`
- `crates/pa-cli/src/print_session_command.rs`
- `crates/pa-core/src/lib.rs`
- ... и ещё 31

---

## #13 01c024b621 — chore(scripts): run-rust-daemon.sh - bb-ready daemon lifecycle, TUI by default

**1 file changed, 110 insertions(+), 31 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- "target/*/prime-agent" process, which killed bb clients and other
- agents along with the daemon, and it dodged the macOS SUN_LEN limit by
- overriding TMPDIR. Reworked into the canonical lifecycle for the bb
- provider (acp-prime-agent-rust):
- - always builds (PROFILE=release by default - the exact binary the bb
- wrapper ~/bin/prime-agent-rust-bb launches; fast-release opt-in);
- - stops only the daemon: pkill -f "prime-agent --mode daemon
- --daemon-socket /tmp/prime-agent-rust";
- - sanitizes inherited PRIME_AGENT_INTERNAL_* env so a run from a
- prime-agent-hosted shell no longer boots as a foreign worker
- ("Daemon socket already in use" on a foreign worker socket);
- - starts the daemon on the isolated /tmp/prime-agent-rust/daemon.sock
- with PRIME_AGENT_CODING_AGENT_DIR=~/.prime-v0.10/agent, the same
- isolation the bb clients use; TMPDIR override dropped (the
- worker-socket fix keeps stock macOS TMPDIR within AF_UNIX limits);

**Файлы (1):**

- `scripts/run-rust-daemon.sh`

---

## #14 5cf562d10c — feat: bb-mirror threads for RLM subagents (PRIME-62)

**21 files changed, 2817 insertions(+), 227 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- Claim-rebind mechanism (PRIME-11):
- - rlm.spawn(bb_mirror=True) admits child with deferred admission
- (oneshot waker, 10min timeout, cancel/delete settle)
- - Parent writes single-use claim file (acp-mirror-claims/<nonce>.json,
- TTL 10min) naming the child's daemon session
- - bb thread spawn: bb thread spawn --parent-self --provider acp-prime-agent
- with [rlm-mirror:<nonce>] marker prompt
- - ACP rebind: mirror thread's first prompt parsed for marker, claim
- validated (same cwd + rlmDepth > 0), Reattach to target session,
- re-admit under same ACP id, kill draft session
- - mirror_rebind_attempted flag blocks same-process replay (PRIME-28)
- Auto-mirror (PRIME-24):
- - Plain rlm.spawn in depth-0 bb session (BB_THREAD_ID set) automatically
- creates mirror thread — no explicit bb_mirror=True needed
- - bb_mirror=False forces plain invisible child

**Файлы (21):**

- `.changes/prime-62-bb-mirror-subagents.md`
- `.gitignore`
- `crates/pa-cli/src/print_rlm.rs`
- `crates/pa-core/src/prompts/system_prompt.rs`
- `crates/pa-core/src/session_engine/engine.rs`
- `crates/pa-core/src/session_engine/rlm_host.rs`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/mod.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/lib.rs`
- ... и ещё 11

---

## #15 aeb1f44908 — fix(daemon): ACP session resume — registry race, archive fallback, strip <system_instructions>

**7 files changed, 173 insertions(+), 38 deletions(-)**

### Было

- - Level 1 (types.rs): AdmittedPrompt::parse strips the wrapper before
- sending to the worker — new prompts never record the wrapper.
- - Level 2 (read.rs): SessionFile::strip_instructions_wrapper() strips
- it from existing entries on switch_session/fork — old files are
- clean in-memory.
- 5. run-rust-daemon.sh: updated default profile and socket paths for
- the v0.10 migration (fast-release, ~/.prime/agent).
- Tests: 88 passed (session_registry: 6, session_navigation: 8, session_store: 65, acp::types: 9).

### Стало

- Root causes and fixes:
- 1. Registry race condition (session_registry.rs):
- write_registry wrote directly, racing with concurrent register_session
- calls. read_registry returned empty on a momentarily-empty file,
- causing write_registry to save 1 entry, destroying all 182 entries.
- Fix: atomic write (temp + rename) + retry read on empty file.
- 2. Archive fallback (session_registry.rs):
- resolve_session only searched sessions/, not sessions-archive/.
- When the daemon's periodic sweep archived a session file,
- session/load failed with 'Unknown ACP session'.
- Fix: resolve_session now checks sessions-archive/ and restores
- the file (move) back to sessions/.
- 3. MAX_AGE pruning (session_registry.rs):
- ACP_SESSION_REGISTRY_MAX_AGE_MS was 7 days; TS-era registry entries
- (from the migration) were pruned on the next daemon restart.

**Файлы (7):**

- `.changes/acp-session-resume.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/session_navigation.rs`
- `crates/pa-daemon/src/session_store/read.rs`
- `scripts/run-rust-daemon.sh`

---

## #16 43900ca3af — fix(tui): surface prompt templates in slash-command autocomplete

**8 files changed, 126 insertions(+), 4 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- get_commands, but the TUI only extracted source: skill entries,
- discarding all prompt templates. Add prompt_command_entries parser,
- prompt_commands field throughout the catalog pipeline, and chain it
- in suggestions, takes_argument lookup, and apply_completion.

**Файлы (8):**

- `.changes/fix-prompt-template-autocomplete.md`
- `crates/pa-tui/src/autocomplete.rs`
- `crates/pa-tui/src/editor/mod.rs`
- `crates/pa-tui/src/session_ui.rs`
- `crates/pa-tui/src/session_ui/commands.rs`
- `crates/pa-tui/src/session_ui/lifecycle.rs`
- `crates/pa-tui/src/session_ui/settings.rs`
- `crates/pa-tui/tests/skills_menu_headless.rs`

---

## #17 70bb810c6b — fix(ai): classify proxy keepalive responses as overloaded instead of stream_drop

**4 files changed, 61 insertions(+), 1 deletion(-)**

### Было

- response_model=keepalive before the stream_drop check and classify as
- overloaded (still retryable), producing a clearer error message.

### Стало

- with model=keepalive and empty choices, then closes the stream. The
- stream parser classified this as stream_drop (the stream ended without
- a stop signal), but the real cause is provider unavailability. Detect

**Файлы (4):**

- `.changes/fix-keepalive-response-classification.md`
- `crates/pa-ai/src/providers/openai_completions/stream.rs`
- `crates/pa-ai/src/providers/openai_completions/stream_drop.rs`
- `crates/pa-ai/src/utils_inner/stream_failure.rs`

---

## #18 86e638e879 — fix(daemon): idempotent ACP session/new after a provider crash (PRIMER-3)

**2 files changed, 997 insertions(+), 12 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- fresh runtime session, orphaning the crashed session's history. Two guards:
- - register_session_if_absent keeps an existing registry entry whose
- session_file still exists; a duplicate session/new can no longer
- overwrite it with a stale record.
- - session/new with a cwd whose registry entry resolves to an idle session
- file adopts it: the newest created_at entry wins (deterministic pick
- over the entries sharing one cwd), the file must parse into a header
- this build reads (version guard), the dir scan runs once per admission
- (ranked candidates, not per entry), and archived files restore like
- resolve_session. Adoption requires a clean SwitchSession: a foreign
- live holder ("Session is already active") or any other switch failure
- falls back to a fresh id instead of binding the wrong session file.
- Tests: registry helpers (if_absent preserve/overwrite/insert, cwd match,
- archive restore, schema-reject) and daemon admission flow (reuse, fresh-id
- fallbacks for unknown cwd and switch refusal, newest-entry pick).

**Файлы (2):**

- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`

---

## #19 0f078d14b4 — fix(daemon): ACP session/load fails on a foreign live lease holder instead of dropping history

**2 files changed, 283 insertions(+), 3 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- "Session is already active" on SwitchSession has two meanings: this worker already hosts the target file (genuine no-op, admit), or a still-live worker from the stopped connection holds the lease. The old prefix check treated both as a no-op, so a resume after bb thread stop admitted the fresh boot session, silently losing the session history and overwriting the registry mapping (observed on thr_mawt8iambw, 2026-10-19). The load handler now verifies via GetConnectionState that the current worker hosts the target file before falling through; a foreign holder fails the load with an explicit error, registry mapping preserved. Regression tests cover both branches."

**Файлы (2):**

- `.changes/acp-load-foreign-lease-holder.md`
- `crates/pa-daemon/src/acp/daemon.rs`

---

## #20 b552022762 — docs(changes): note thr_e5uiu8qtw5 second affected thread + registry recovery + deploy note

**1 file changed, 4 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало


**Файлы (1):**

- `.changes/acp-load-foreign-lease-holder.md`

---

## #21 7310da20c9 — fix: use Homebrew lld 23 for macOS 27 SDK TAPI compatibility

**1 file changed, 3 insertions(+), 3 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- architecture tokens in the TAPI v4 .tbd files of the macOS 27 SDK
- (Xcode 27.1). This causes link failures with undefined libc/libSystem
- symbols. Homebrew LLD 23.1.3 (LLVM 23) understands the new tokens.

**Файлы (1):**

- `.cargo/config.toml`

---

## #22 22dca1d909 — fix(daemon): review fixes for session lifecycle (PRIMER-3)

**4 files changed, 63 insertions(+), 50 deletions(-)**

### Было

- - find_session_by_cwd: pre-canonicalize cwd once before filter loop
- - scan_session_dir_ranked: early break on rank-0 (unbeatable) match
- - same_canonical_cwd: extracted from same_cwd for reuse with pre-canonicalized paths
- - .changes: add trailing newline

### Стало

- confirms a mismatch; transient fetch_connection_state failure now
- falls through to admit (regression from PRIMER-3 fix)
- - resolve_session: add schema version validation matching find_session_by_cwd
- - scan_session_dir: add version guard for future-schema files
- - restore_archived_session_file: validate restored file schema version
- - resolve_session: use restore_archived_session_file instead of inline copy

**Файлы (4):**

- `.changes/acp-load-foreign-lease-holder.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/mod.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`

---

## #23 7305b35f0d — fix(daemon): orphaned-worker sweep + session/load retry on foreign lease

**4 files changed, 323 insertions(+), 63 deletions(-)**

### Было

- holder time to release the lease) and retry once before failing
- the load. For orphaned holders, the periodic sweep (300s) is

### Стало

- worker process. The worker stays alive holding a session file lease
- (the worker-driven passivation path never fires — no client to send
- WorkerIdlePassivation through). On the next resume, session/load
- hits a foreign live holder on SwitchSession and bb silently falls
- back to session/new, losing all in-agent history.
- Three fixes targeting the root causes:
- 1. Supervisor orphan sweep (worker_lifecycle.rs, supervisor.rs):
- passivate_orphaned_workers runs every 300s, stopping workers
- whose owner client disconnected but whose process stayed alive.
- Frees the session file lease so session/load can succeed.
- 2. session/load retry on foreign holder (acp/daemon.rs):
- when SwitchSession fails with "Session is already active" and
- the holder is foreign, sleep 500ms (giving a normally-disconnecting
- the backstop — the next session/load after the sweep succeeds.
- 3. Lease reclamation unchanged (lease.rs):

**Файлы (4):**

- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/supervisor.rs`
- `crates/pa-daemon/src/supervisor/clients.rs`
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`

---

## #24 3537562d7b — Trigger orphan sweep on foreign-holder session load

**5 files changed, 51 insertions(+), 8 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- active TriggerOrphanSweep command that passivates orphaned workers and
- releases their leases immediately. The 300s periodic sweep remains as
- backstop. Adds TriggerOrphanSweep variant to DaemonCommand, supervisor
- handler, and dispatch wiring.

**Файлы (5):**

- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/protocol.rs`
- `crates/pa-daemon/src/supervisor/clients.rs`
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`
- `crates/pa-types/src/daemon/command.rs`

---

## #25 536fe7a2a6 — fix: remove cwd-reuse from session/new to prevent cross-thread session adoption

**3 files changed, 214 insertions(+), 536 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- session whose cwd matched. But cwd is per-environment, not per-thread: two
- bb threads in the same env share it. The second thread's session/new
- adopted the first thread's session, both claimed the same providerThreadId,
- and bb's classifyClaim rejected every send with 409 provider_session_unavailable.
- Reconnection after a provider crash is handled by session/load (bb sends
- turn.submit with the stored providerThreadId), not session/new, so cwd-reuse
- served no valid caller.
- Removes the find_session_by_cwd adoption block from handle_session_new.
- Updates two existing tests to assert fresh-id minting. Adds a regression
- test verifying two session/new calls with the same cwd get distinct ids.

**Файлы (3):**

- `.changes/fix-cwd-reuse-cross-thread-adoption.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`

---

## #26 773348efd5 — fix: add ./plans to .gitignore

**2 files changed, 436 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало


**Файлы (2):**

- `.gitignore`
- `plans/UPGRADE_PLAN_v0.10.1_clean.md`

---

## #27 2767dca128 — fix: bb-mirror review findings — waker bridge, kill_on_drop, claim cleanup, temperature validation

**16 files changed, 253 insertions(+), 30 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- the ACP rebind → parent watcher waker. After rebind_to_rlm_mirror_session
- succeeds, the daemon sends ResolveRlmMirrorAdmission to the parent
- session, which fires the oneshot waker via resolve_waiting_mirror_run.
- Without this, every mirror child waited 10min then settled as failed.
- W1: kill_on_drop(true) on bb spawn Command; fix incorrect comment.
- W2: restore temperature validation (isinstance/isfinite) in rlm/__init__.py.
- W3: fix double-lock TOCTOU in registry.rs mirror check.
- W4: tighten is_session_gone_error from contains() to starts_with().
- W5: daemon creates nonce+writes claim for explicit bb_mirror=True
- (not just auto-mirror); nonce returned in RlmSpawnHandle.
- W6: delete stale claim files on read in read_rlm_mirror_claim.
- S1: stale claims now removed on read (same fix as W6).
- S2: add 30s timeout to _run_bb in Python skill.
- S3: fix split_acp_prompt_blocks to split first text block regardless
- of prior instruction_texts.

**Файлы (16):**

- `crates/pa-cli/src/print_rlm.rs`
- `crates/pa-core/src/session_engine/rlm_host.rs`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/agent_engine/session_engine_impl.rs`
- `crates/pa-daemon/src/engine.rs`
- `crates/pa-daemon/src/protocol.rs`
- `crates/pa-daemon/src/rlm_bb_mirror.rs`
- `crates/pa-daemon/src/rlm_children.rs`
- `crates/pa-daemon/src/rlm_children/host.rs`
- ... и ещё 6

---

## #28 b063871e2b — fix: replace cat with Python read in speculative-cell example (usage.md)

**2 files changed, 2 insertions(+), 1 deletion(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- the 'use Python for reading files' rule. Replace with open().read().

**Файлы (2):**

- `.changes/fix-speculative-cell-cat-example.md`
- `crates/pa-core/src/prompts/layers/usage.md`

---

## #29 642016c386 — fix(daemon): passivate orphaned ACP bridge workers so bb session/load restores history

**30 files changed, 580 insertions(+), 39 deletions(-)**

### Было

- uses it before the final switch attempt
- - client ids newline-stripped in the new log lines (log forgery guard)
- - red-first regression: orphan_sweep_passivates_a_disconnected_acp_bridge_worker,
- orphan_sweep_keeps_a_connected_acp_bridge_worker

### Стало

- daemon worker. The worker is Resident (owner_client_id None), so the orphan
- sweep skipped it, the session lease stayed held, session/load's SwitchSession
- was refused (Session is already active in <worker>), and bb fell back to a
- fresh session losing all in-agent history (PRIMER-6).
- - DaemonWorkerDescriptor.acp_client_id: the ACP bridge client recorded at
- launch (executionMode acp); WorkerOwnership carries it into launch_worker
- - schedule_acp_bridge_cleanup: graceful passivation 30s after the bridge
- client's last connection closed (roster row survives; next session/load
- re-creates the worker over the same file)
- - passivate_orphaned_workers: also passivate ACP-bridge workers whose bridge
- client disconnected; keep any worker with live session subscribers
- - reassign_acp_bridge_for_reuse: a reusing ACP create takes over the
- resident's bridge identity (stale ids no longer passivate a served worker)
- - is_acp classifies both the live config and the durable flattened rest
- (update-restart restores keep ACP ownership)

**Файлы (30):**

- `crates/pa-cli/tests/subagent_panel_nested_count_e2e.rs`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/create_reuse.rs`
- `crates/pa-daemon/src/descriptor.rs`
- `crates/pa-daemon/src/messaging.rs`
- `crates/pa-daemon/src/peer_tickets.rs`
- `crates/pa-daemon/src/protocol.rs`
- `crates/pa-daemon/src/registry.rs`
- `crates/pa-daemon/src/revival_gate.rs`
- `crates/pa-daemon/src/supervisor.rs`
- ... и ещё 20

---

## #30 5b703d0b03 — fix(daemon): backfill ACP bridge identity on pre-PRIMER-6 descriptors

**2 files changed, 86 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- with the orphan-passivation fix), so an adopted live ACP worker relaunches
- unowned: the orphan sweep skips it, the lease stays held, and a resumed bb
- thread still loses history. Backward compatibility for existing sessions:
- - backfill_acp_bridge_session at descriptor load: a durable create with
- executionMode acp gains an empty-string bridge marker; a live bridge id
- is never overwritten, non-ACP creates gain nothing
- - orphan criterion treats the empty marker as orphaned (its bridge died
- before the reboot; adoption only happens after that) unless a live client
- still subscribes — the existing subscribers guard covers a resumed thread
- - regression: load_backfills_acp_bridge_id_on_a_pre_fix_descriptor

**Файлы (2):**

- `crates/pa-daemon/src/descriptor.rs`
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`

---

## #31 e9d3f1e00e — fix(daemon): model_metadata carries contextWindow (PRIME-53)

**5 files changed, 41 insertions(+), 2 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- The ACP usage_update seeder reads model.contextWindow off get_connection_state, but the real engine's model_metadata omitted the field (TS toConnectionModel returns the whole model). The nil window left WireMappingState.context_window unset for the whole session, so no usage_update reached bb and the thread context ring stayed empty. Regression test red-first.

**Файлы (5):**

- `crates/pa-daemon/.changes/acp-context-window-in-model-metadata.md`
- `crates/pa-daemon/src/acp/config_options.rs`
- `crates/pa-daemon/src/agent_engine/session_engine_impl.rs`
- `crates/pa-daemon/src/agent_engine/tests/model_resolution.rs`
- `crates/pa-daemon/src/engine.rs`

---

## #32 7be2a78012 — fix(daemon): scrub ambient provider credentials from env in model_resolution tests

**2 files changed, 51 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- get_available counts a provider authenticated when its env key is set, so an ambient HF_TOKEN (or any provider key in the exported env) leaks the compiled-fallback huggingface model into the startup chain over the tests' battery/mock-1 fixture, failing 3 model_resolution tests. ScrubbedProviderEnv removes every generated-provider key var plus PRIME_TEAM_ID for the guard's lifetime, serialized through the crate-wide TELEMETRY_ENV_MUTEX (the CleanTelemetryEnv pattern supervisor tests already use). Red with HF_TOKEN set on HEAD, green with the guard.

**Файлы (2):**

- `crates/pa-daemon/src/agent_engine/tests/model_resolution.rs`
- `crates/pa-daemon/src/test_support.rs`

---

## #33 5922a5446a — bash: handle lone 

**2 files changed, 32 insertions(+), 5 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- ,
- , and a lone
- as line
- breaks, so progress bars (B1 PASS
- B2 idle) count as separate lines and
- the byte limit no longer cuts them mid-phrase.
- Fix 2: on_update appends a streaming marker so the model knows a running
- process snapshot is partial and more output may arrive.
- Fix 1 was reverted: the TS golden fixture has no no-newline marker, so
- adding one is a parity regression.

**Файлы (2):**

- `crates/pa-core/src/tools/bash.rs`
- `crates/pa-core/src/tools/output_accumulator.rs`

---

## #34 2b94ea52c7 — bash: add regression tests for lone \r line counting

**1 file changed, 61 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- \r, and current_line_bytes after \r. Verified the tests fail without the
- fix (3 fail, 1 pass) and pass with it (4 pass).

**Файлы (1):**

- `crates/pa-core/src/tools/output_accumulator.rs`

---

## #35 e41d7f4cc3 — bash: fix current_line_bytes for \r\n in append_decoded_text

**1 file changed, 11 insertions(+), 2 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- always returns 1 (the \r position), never 2 for \r\n. So
- current_line_bytes counted the \n of \r\n as part of the trailing
- line. Store last_break_len and use text[last + last_break_len..].
- Added cr_lf_current_line_bytes_skips_both regression test; verified
- it fails without the fix (left=5, right=4) and passes with it.

**Файлы (1):**

- `crates/pa-core/src/tools/output_accumulator.rs`

---

## #36 0fc4027b4c — clippy: fix pre-existing warnings in 3 crates

**5 files changed, 961 insertions(+), 9 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- - pa-telemetry/client.rs:39: Duration::from_mins(1) instead of from_secs(60) (clippy::duration_suboptimal_units)
- - pa-core/session_commands.rs:550: map_or instead of map(...).unwrap_or(...) (clippy::map_unwrap_or)
- - pa-core/session_commands.rs:571: drop redundant Result wrapper, wrap call site in Ok(...) (clippy::unnecessary_wraps)

**Файлы (5):**

- `crates/pa-agent/src/agent.rs`
- `crates/pa-core/src/session_engine/session_commands.rs`
- `crates/pa-telemetry/src/client.rs`
- `scripts/check_bb_prime_integration.py`
- `skills/bb-subagents/build/lib/bb_subagents/__init__.py`

---

## #37 8ab6498068 — fix(bb-mirror): forward model and reasoning-level to bb thread spawn

**3 files changed, 88 insertions(+)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- Daemon: add model/reasoning_level fields to BbMirrorSpawnOptions and pass --model/--reasoning-level in spawn_bb_mirror_thread. host.rs: populate the new fields at the auto-mirror spawn site from the resolved model id and the thinking wire name. Skill: forward --model/--reasoning-level in spawn_mirror.
- The child session already received the correct model (lifecycle.rs); this fix is purely the bb display.

**Файлы (3):**

- `crates/pa-daemon/src/rlm_bb_mirror.rs`
- `crates/pa-daemon/src/rlm_children/host.rs`
- `skills/bb-subagents/src/bb_subagents/__init__.py`

---

## #38 4e4b4cb58a — streaming: flush superseded delta on kind switch in park_update

**4 files changed, 143 insertions(+), 17 deletions(-)**

### Было

- park_update now flushes the superseded pending run before the new kind
- parks. The call site in turn.rs passes the event pump; the existing
- a_kind_switch test now asserts the superseded flush; a new regression
- test pins the no-settling-event case.
- Also: fmt the pa-agent clone_from call that the earlier clippy pass
- introduced.

### Стало

- kind switched (e.g. text_delta -> toolcall_start with no settling
- text_end between them). A delta-mapping ACP consumer (bb) then lost
- the tail of the previous channel and showed the assistant text
- truncated mid-phrase.

**Файлы (4):**

- `crates/pa-agent/src/agent.rs`
- `crates/pa-daemon/src/streaming.rs`
- `crates/pa-daemon/src/worker/turn.rs`
- `crates/pa-daemon/src/worker/turn_stream_tests/burst.rs`

---

## #39 72ab4e06ad — feat(acp): emit plan session update from goal_update

**2 files changed, 145 insertions(+), 7 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- sessionUpdate alongside the goal meta. Map goal_update to
- AcpSessionUpdate::Plan { entries } so bb renders the goal objective
- as a plan entry; status derived from goal status (complete->completed,
- active->in_progress, else pending). A goal without an objective emits
- no plan entry. Regression test
- goal_update_publishes_a_plan_entry_besides_the_session_info added.

**Файлы (2):**

- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/acp/wire_events.rs`

---

## #40 970e546083 — feat(daemon): track session mode via ACP configOptions and session/set_mode (PRIMER-4)

**62 files changed, 656 insertions(+), 312 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало


**Файлы (62):**

- `crates/pa-cli/src/args.rs`
- `crates/pa-cli/src/interactive_mode.rs`
- `crates/pa-cli/src/mode.rs`
- `crates/pa-cli/src/print_boundary/tests.rs`
- `crates/pa-cli/src/print_goal.rs`
- `crates/pa-cli/src/print_runtime.rs`
- `crates/pa-cli/src/print_runtime/faux.rs`
- `crates/pa-cli/src/print_session_command.rs`
- `crates/pa-core/src/lib.rs`
- `crates/pa-core/src/prompts/layers.rs`
- ... и ещё 52

---

## #41 9345801a40 — Merge pull request #3 from sks7777/local/primer-4-session-mode-v3

****

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- feat(daemon): track session mode via ACP configOptions (PRIMER-4)

**Файлы (0):**


---

## #42 2ae7721d9f — fix: remove dead session-mode code and add session_mode to test fixtures\n\nRemove unused session_mode_saved_tools in engine.rs, unused previous_mode\ndestructure and no-op adjust_tools_for_mode in session_commands.rs,\nmerge identical ask/plan/code/debug match arms.\n\nAdd missing session_mode: None field to InteractiveOptions struct\nliterals in all pa-tui and pa-cli headless test fixtures.

**64 files changed, 84 insertions(+), 23 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало


**Файлы (64):**

- `crates/pa-cli/tests/agents_view_refusal_panel_e2e.rs`
- `crates/pa-cli/tests/agents_view_subagents_e2e.rs`
- `crates/pa-cli/tests/chat_agents_chat_roundtrip_e2e.rs`
- `crates/pa-cli/tests/chat_open_first_frame_pty_e2e.rs`
- `crates/pa-cli/tests/clipboard_auth_commands_e2e.rs`
- `crates/pa-cli/tests/cursor_visibility_e2e.rs`
- `crates/pa-cli/tests/dock_scope_exit_focus_e2e.rs`
- `crates/pa-cli/tests/exit_backfill_pty_e2e.rs`
- `crates/pa-cli/tests/export_share_e2e.rs`
- `crates/pa-cli/tests/input_live_open_pty_e2e.rs`
- ... и ещё 54

---

## #43 50b165acc1 — fix: bb mode hints + websearch in /ask (PRIMER-4 regressions)

**11 files changed, 128 insertions(+), 4 deletions(-)**

### Было

- Bug #2: web_search перестал работать в /ask режиме
- - ask_mode.md: remove "or execute code" prohibition; allow read-only Python
- skills via python_repl (websearch, data analysis)
- - tool_call.rs: before_tool_call block sets details {"blocked":true,...}
- so UI can distinguish mode-block from ordinary error
- - acp/types.rs: ToolCallUpdate.blocked field
- - wire_events.rs: propagate blocked from result details
- - tool_card/mod.rs: PanelStatus::Blocked variant renders "blocked"
- Tests:
- - session_mode.rs: websearch_code_is_not_dangerous, blocked_python_pattern_still_detected

### Стало

- - Add AcpSessionUpdate::AvailableCommands variant + AvailableCommand struct
- - Publish available_commands_update on session/new, load, fork with builtin
- slash commands from SlashCommandRegistry::builtin()
- - Add EngineEvent::ModeChanged variant; emit from worker (ACP) session
- command path when session_mode changes (parity with RPC path)
- - Map ModeChanged to {"type":"mode_changed","mode":...} session event
- in worker/turn.rs so daemon.rs refresh_wire_config triggers

**Файлы (11):**

- `crates/pa-agent/src/agent_loop/tool_call.rs`
- `crates/pa-core/src/prompts/layers/ask_mode.md`
- `crates/pa-core/src/session_engine/session_commands.rs`
- `crates/pa-core/src/session_mode.rs`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/acp/wire_events.rs`
- `crates/pa-daemon/src/agent_engine/session_engine_impl.rs`
- `crates/pa-daemon/src/engine/wire.rs`
- `crates/pa-daemon/src/worker/turn.rs`
- ... и ещё 1

---

## #44 c15d4e0084 — fix: available_commands_update input.hint shape for bb autocomplete

**2 files changed, 15 insertions(+), 3 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- Change AvailableCommand to use nested AvailableCommandInput { hint }.
- 71 ACP tests pass.

**Файлы (2):**

- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/types.rs`

---

## #45 7012a2992d — fix: agent loses connection with long-running bash processes

**5 files changed, 71 insertions(+), 11 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- to repeatedly ask 'выведи статус' during long bash commands:
- 1. usage.md: loosen the no-polling rule — allow one re-await after a
- degraded bash() (BashSnapshot), and mandate proactive handle checks
- (poll/output/tail) on the next turn if [bash-done] does not arrive.
- The blanket ban on 'repeated awaits of a still-running handle' is
- removed; time.sleep() and shell sleep stay forbidden.
- 2. bash.py: remove _MAX_DEGRADE_HINTS cap (was 3) — every degrade now
- prints the stderr hint reminding the agent to end the turn and expect
- a [bash-done] notification. After 3 degrades the agent previously
- forgot the contract.
- 3. bash.py: add _degraded_awaited flag — a degraded handle that was later
- polled/output() must still send the [bash-done] notice. Previously
- _result_consumed suppression killed the only wake-up for a handle the
- agent had checked but not collected.
- Evidence: 381 session logs, 0 async_bash_completion customMessages

**Файлы (5):**

- `crates/pa-core/src/prompts/layers/usage.md`
- `crates/pa-core/src/session_engine/bash_notices.rs`
- `crates/pa-core/tests/prompt_guards.rs`
- `prime-agent-runtime/src/rlm/bash.py`
- `prime-agent-runtime/test/test_bash.py`

---

## #46 9ab7b62754 — fix: orphaned worker with stale inflight permit blocks session restore

**1 file changed, 144 insertions(+), 8 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- process and starts a new one, but the daemon detects the old worker's
- death asynchronously. During the gap, the old worker still holds the
- session-file lease. session/load's retry (orphan sweep + passivate file
- holder) tries to stop it, but both passivation paths skip workers with
- saturated inflight permits. The cancelled prompt's route holds a stale
- permit that releases only when the socket closure is processed — which
- lags behind the sweep. Both retries fail, session/load errors, and the
- bridge falls back to session/new (fresh session, history lost).
- Fix: remove the inflight-skip guard from passivate_orphaned_workers
- (orphan criterion + subscriber guard are sufficient) and from
- handle_passivate_file_holder (add an explicit client-connected check
- so a live ACP client is never stopped, but a disconnected one is
- passivated despite stale permits).
- Regression tests: an_orphaned_worker_with_stale_inflight_is_passivated
- and passivate_file_holder_stops_worker_with_stale_inflight verify the

**Файлы (1):**

- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`

---

## #47 7e2f9c2d5d — fix: bypass coalescer for thinking_delta to prevent cumulative duplication in bb

**1 file changed, 6 insertions(+), 1 deletion(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- ACP consumer (bb) expects per-token chunks — merged thinking deltas
- cause cumulative duplication in bb thinking-block renderer.
- The TS product (v0.9.8) has no coalescer at all; every event goes
- direct. This makes thinking_delta events go direct too, matching the
- TS behavior. text_delta and toolcall_delta continue through the
- coalescer (their merging does not cause duplication in bb).

**Файлы (1):**

- `crates/pa-daemon/src/worker/turn.rs`

---

## #48 2a5f80f81c — fix(acp): reattach to live holder instead of orphan sweep on session load

**1 file changed, 303 insertions(+), 108 deletions(-)**

### Было

- Описание «до» отсутствует в сообщении коммита. См. логику изменения в «Стало».

### Стало

- error_info carries the holder active_session_id, reattach to the
- holder session instead of trying to kill it via orphan sweep +
- passivate + retry. TS parity: switchSession catch block reattaches
- to the live holder; the Rust port now does the same.
- The orphan sweep + passivate + retry chain stays as the fallback
- for the None active_session_id case (legacy/edge). A busy orphan
- worker holding a long turn could not be passivated in time, causing
- bb to fall back to a fresh session with no history.
- Regression test: session_load_reattaches_when_holder_is_alive.

**Файлы (1):**

- `crates/pa-daemon/src/acp/daemon.rs`

---

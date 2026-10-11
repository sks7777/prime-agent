# План: чистый апгрейд v0.10.1 → v0.10.3 с сохранением истории

Дата: 2026-11-12
Базовый тег: v0.10.1 (0d457e8eb6)
Целевой тег: v0.10.3 (178ec89630)
Стратегия: cherry-pick 42 из 49 локальных коммитов на чистую ветку от v0.10.3,
с разрешением конфликтов и внесением миграционных исправлений **внутри каждого коммита** (amend).
7 коммитов пропущены (verdict в анализе ниже).
Цель: 42 коммита с оригинальными сообщениями, без отдельных fix-коммитов.

## Ключевые архитектурные изменения upstream (v0.10.1 → v0.10.3)

108 upstream-коммитов. Главные:

1. **bash/edit Rust-инструменты удалены** (c13415b442, #3823): `bash.rs`, `bash_guard.rs`,
   `bash_local.rs`, `edit.rs`, `edit_diff.rs`, `file_mutation_queue.rs`, `output_accumulator.rs`,
   `shell_utils.rs`, `truncate.rs`, `jsdiff.rs` — 4965 строк удалено. Bash-инструмент
   переехал в Python runtime (`prime-agent-runtime/src/rlm/bash.py`).

2. **bash: await всегда yields через 1с; yield_after удалён** (98bf740b00, #3828):
   `yield_after` параметр убран из `bash()`, `BashHandle`, `_spawn_persistent`.
   Передача `yield_after` вызывает `TypeError`. Зафиксированный `_YIELD_AFTER_SECONDS = 1.0`.

3. **rlm.end_turn()** (74591cddef, #3830) — новый API, добавлен в `core.md`.
4. **rlm.session.messages** (c8cbb5ba71, #3769) — модель читает свой транскрипт из REPL, добавлен в `core.md`.
5. **rlm.spawn: cwd** (c6d4da9421, #3849) — новый `cwd` параметр для `rlm.spawn`, изменён `core.md` и `rlm_host.rs`.
6. **prompt: drop stale 'await commands' rule** (1d9daf73b9, #3511) — удалено правило из `usage.md`.
7. **rlm: keep factory children from waking parent** (8a912aff40, #3820) — изменён `rlm_host.rs`, `lifecycle.rs`.
8. **factory.py massively expanded** (+604 строки) — `rlm/__init__.py` (+163 строки).
9. **live auth refresh** (a05bcb6951, #4019) — `lifecycle.rs`.
10. **bound project settings to 4 MiB** (91b90f1dc1, #3916).
11. **web search provider selection** (6aaa3a2551, #3974) — Serper or You.com Eco.
12. **fix(ai): function-call arguments on done item** (42a07c13ce, #4014).
13. **fix(ai): Bedrock thinking blocks** (61e94ce8a9, #4013).
14. **codex: release session WebSocket** (c4800c8ebd, #4010).
15. **golden_replay.rs gutted** — из 323 строк ~10, corpus bash.json/edit.json удалены.

## Правила всего апгрейда

1. **Таймаут тестов**: все crates — 60с, `pa-daemon` — 120с.
   ```
   timeout 60 cargo test -p <crate> --lib
   timeout 120 cargo test -p pa-daemon --lib
   ```
2. **Таймаут отдельного теста при отладке**: 30с.
   ```
   timeout 30 cargo test -p <crate> --lib -- <test_name>
   ```
3. **Сборка (шаг из v0.10.3) после каждого этапа**:
   ```
   cargo fmt --all
   cargo clippy -p <crates этапа> -- -D warnings
   cargo check --workspace
   ```
   0 ошибок, 0 предупреждений — иначе этап не закрыт. Pre-existing pa-telemetry/pa-tui
   clippy-падения игнорировать (verified на чистом v0.10.3).
4. **/local-review на тяжёлых этапах** (5, 7, 8, 9, 10, 12): после разрешения конфликтов,
   до `--continue`. `/local-review` речью: прочитать
   `~/.prime/agent/prompts/local-review.md` и выполнить как собственные инструкции.
   Ревьюеры — сабагенты `rlm.spawn`. База ревью — `v0.10.3`. Все CRITICAL-находки
   исправляются и вносятся в тот же коммит через `git add -A && git cherry-pick --continue`
   (или `git commit --amend --no-edit`). WARNING/SUGGESTION — только в отчёт.

5. **Валидация упрощения fork-реализации** (обязательно для каждого cherry-pick):
   Если upstream предоставил новый механизм, который решает ту же задачу
   проще — переписать fork-правку на upstream-механизм или убрать её совсем.
   - Пример: upstream удалил Rust bash.rs и перенёс логику в Python `bash.py`.
     Fork-правки к bash.rs → port в `bash.py`, не восстановление Rust-файла.
   - Пример: upstream добавил `rlm.spawn(cwd=...)`. Если fork-правка
     дублирует это — убрать дублирование.
   - Если fork-фикс уже реализован upstream — пропустить коммит (SKIP).
   - Решение фиксируется в плане с причиной.

6. **Сохранение полной истории** (обязательно):
   Каждый cherry-pick сохраняет оригинальное сообщение коммита без изменений.
   Миграционные правки вносятся в коммит через `--amend --no-edit` —
   оригинальное сообщение не редактируется. Полное описание каждого
   коммита приведено в разделе «Каталог коммитов» ниже.


## Маппинг исправлений → коммиты

| # | Проблема | Коммит | Действие при cherry-pick |
|---|----------|--------|--------------------------|
| 1 | `yield_after` удалён из `bash()` | #45 (7012a2992d) | Удалить упоминания `yield_after` из usage.md; адаптировать bash.py к `_YIELD_AFTER_SECONDS = 1.0` |
| 2 | `rlm.spawn` получил `cwd` параметр | #3 (3355caa197) | Объединить `temperature` и `cwd` параметры в `rlm_host.rs`, `rlm_children/host.rs` |
| 3 | `core.md` содержит `rlm.end_turn()`, `rlm.session.messages` | #4 (d474180e05) | Внести fork-правки batch/compound-cell/delegation guidance поверх upstream-версии core.md |
| 4 | `usage.md`: upstream удалил "await commands" правило | #4, #28, #45 | Учесть удаление правила при мерже fork-правок в usage.md |
| 5 | `bash.rs` и `output_accumulator.rs` удалены | #5, #33-35 (SKIP) | Port bash 
 logic в Python runtime `bash.py` если нужно |
| 6 | `golden_replay.rs` gutted | #7 (SKIP) | Пропустить; platform-dependent assertions больше не нужны (golden corpus удалён) |
| 7 | `factory.py` massively expanded | #11, #14, #40 | Адаптировать fork-правки к новой factory.py структуре |
| 8 | `agent.rs` изменён upstream | #36, #38 | Разрешить конфликты в agent.rs |
| 9 | `session_registry.rs` — fork-created, нет в upstream | #10, #15, #18, #22, #25 | Cherry-pick создаёт файл; конфликты только в acp/daemon.rs и acp/mod.rs |
| 10 | `rlm_bb_mirror.rs` — fork-created, нет в upstream | #14, #27, #37 | Cherry-pick создаёт файл; конфликты в rlm_host.rs, rlm_children/ |
| 11 | `session_mode.rs` — fork-created, нет в upstream | #40 | Cherry-pick создаёт файл; конфликты в engine.rs, system_prompt.rs |
| 12 | `plan_code.rs` — fork-created, нет в upstream | #12 | Cherry-pick создаёт файл; конфликты в engine.rs, system_prompt.rs |
| 13 | `layout_normalize.rs` — fork-created, нет в upstream | #6 | Cherry-pick создаёт файл; конфликты в keys.rs, lib.rs |

## Каталог коммитов

Полные описания всех cherry-pick коммитов в порядке применения.

### #1 51b8d314a4 — fix: macOS platform compatibility, baseline tests, build tooling for v0.10.0

```
fix: macOS platform compatibility, baseline tests, build tooling for v0.10.0

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-46 (bb tasks)

Этап 0 — Инициализация: worktree, config dir, baseline тесты, macOS compat.

1. macOS platform compatibility (26 файлов):
   - Non-blocking socket inheritance: UnixListener::set_nonblocking(true)
     наследуется accepted streams на macOS — mock supervisor тесты получают
     EAGAIN. Fix: set_nonblocking(false) после accept() (9 pa-tui test файлов).
   - Linux-only APIs без platform gates: /proc/, ptsname_r, c_line,
     prctl/PR_SET_PDEATHSIG, pty EIO. Fix: gate к target_os = linux
     (11 test файлов). c_line field conditional в shared harness.
   - crossterm vendor warnings: invalid cfg(winapi)/cfg(crossterm_winapi)
     → target_os = windows, dead_code allow на InternalEventFilter,
     unused_parens fix, check-cfg lints в Cargo.toml.

2. Baseline test suite (scripts/baseline-tests.sh):
   - Unit-тесты 9 crate'ов, ~80 mock-supervisor headless тестов,
     ~70 daemon e2e тестов, ~14 Linux-only тестов (skip на macOS).
   - sccache для кэширования компиляции (~30% ускорение).

3. Build tooling:
   - profile.fast-release в Cargo.toml: lto=false, codegen-units=16,
     incremental=true, strip=true. Инкрементальный билд: 11s (вместо 2.5min).
   - scripts/run-rust-daemon.sh: запуск Rust-демона с изолированным config dir.
   - .cargo/config.toml: lld linker закомментирован (нужен symlink ld64.lld).

4. Изолированный config dir ~/.prime-v0.10/agent/:
   - auth.json, settings.json, models.json, keybindings.json.
   - 4 user skills: architect, context7, ozon-orders, playwright.

Baseline: все non-bug тесты проходят. Known baseline bugs v0.10.0:
- "session lease does not own append target" (race в kill)
- agents_view_flash_e2e: dead subagents assertion (0 vs 300)
- acp_mode_e2e: EOF cancellation race
- differential_cli: требует TS binary
```

Файлы (28):
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
- ... и ещё 18 файлов

### #2 74e02bd10e — perf: add fast-release build profile and lld linker for local iteration

```
perf: add fast-release build profile and lld linker for local iteration

Задача: PRIME-46 (bb tasks)

Добавлен profile.fast-release в Cargo.toml:
- lto = false (no cross-crate LTO, link ~2x faster)
- codegen-units = 16 (more parallel codegen)
- incremental = true (only recompile changed crates)
- strip = true (smaller binary)

Билд: cargo build --profile fast-release -p pa-cli --bin prime-agent
Инкрементальный: 12s (вместо 2.5min для --release --workspace)
С нуля: 2m26s (вместо 4m+ для --release --workspace)

.cargo/config.toml: lld linker включён.
ld64.lld symlink: ~/.local/bin/ld64.lld → rust-lld из Rust toolchain.
clang передаёт -fuse-ld=lld, ld64.lld обрабатывает Mach-O linking.

run-rust-daemon.sh: обновлён для поддержки PROFILE=fast-release|release.
```

Файлы (3):
- `.cargo/config.toml`
- `Cargo.toml`
- `scripts/run-rust-daemon.sh`

### #3 3355caa197 — feat(pa-core): temperature kwarg for rlm.spawn

```
feat(pa-core): temperature kwarg for rlm.spawn

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-47 (bb tasks)

Коммиты-источники (TS-форк):
- cdc2973b2 — feat(rlm): temperature kwarg for rlm.run spawns
- 286f50cd3 — refactor(rlm): import shared MCP helpers from mcp_base (already in v0.10.0)

Анализ: TS добавил temperature в AgentOptions → rlm.run kwargs → child Agent.
Rust v0.10.0: RlmSpawnRequest в pa-core/src/session_engine/rlm_host.rs,
создание child session в pa-daemon/src/rlm_children/lifecycle.rs create_child.
Реализовано:
- RlmSpawnRequest.temperature: Option<f64>
- optional_f64_kwarg для парсинга temperature из kwargs
- spawn_request_from_payload принимает temperature в allowed kwargs
- create_child пробрасывает temperature в config JSON daemon-воркера
- Python spawn() принимает temperature: float | None, валидирует finite number
- probe.rs RUNTIME_READY_CHECK проходит (temperature — optional kwarg)

Тесты: 27 RLM unit tests pass, rlm_children_e2e (4/4), rlm_spawn_replacement_e2e (1/1).
Коммит 286f50cd3 (MCP helpers) уже в v0.10.0 — дубликаты функций удалены upstream.
```

Файлы (6):
- `crates/pa-core/src/session_engine/rlm_host.rs`
- `crates/pa-daemon/src/rlm_children/host.rs`
- `crates/pa-daemon/src/rlm_children/lifecycle.rs`
- `crates/pa-daemon/src/rlm_children/spawn_name_reservation_tests.rs`
- `crates/pa-daemon/src/rlm_children/watch_tests.rs`
- `prime-agent-runtime/src/rlm/__init__.py`

### #4 d474180e05 — feat(pa-core): batch/compound-cell/delegation guidance in system prompt (PRIME-39)

```
feat(pa-core): batch/compound-cell/delegation guidance in system prompt (PRIME-39)

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-48 (bb tasks)

Коммиты-источники (TS-форк):
- 3de24b59d — feat(agent,coding-agent): batch tool calls with parallelSafe and compound-cell guidance (PRIME-39)
- 0d13c96b7 — feat(coding-agent): require in-cell verification of reported numbers (PRIME-39 review)
- a17aad380 — feat(coding-agent): default response shape — 2-4 tool calls per response (PRIME-39 grill, round 2)
- 8f55ee184 — feat(coding-agent): compound-cell prompt, delegation threshold, speculative first cell (PRIME-39)
- bc96fffbb — test(coding-agent): compress PRIME-39 review tests (PORT_RUST — нет аналога в v0.10.0)

Анализ: TS добавил prompt-policy в packages/coding-agent/src/core/prompts/rlm.ts
(REPL_CONTROL_PROMPT + buildRlmPrompt). Rust v0.10.0: prompt layers в
crates/pa-core/src/prompts/layers/{core,usage,opinionated}.md.
Реализовано в usage.md:
- batch/compound-cell guidance (compound cells, несколько bash() в одной ячейке)
- speculative first cell (2-3 независимых поиска в первой ячейке)
- in-cell verification (пересчёт чисел в ячейке, которая их произвела)
- delegation threshold 3+ turns (вместо 2+)
- temperature kwarg в rlm.spawn signature в core.md
Обновлён golden snapshot system-prompt.json.

Тесты: golden_system_prompt passes. 5 pre-existing baseline failures
(TS parity, env issues) — не регрессии.
```

Файлы (2):
- `crates/pa-core/src/prompts/layers/core.md`
- `crates/pa-core/src/prompts/layers/usage.md`

### #5 f0be750ecb — fix(pa-core): treat nonzero bash exits as data, not tool errors

```
fix(pa-core): treat nonzero bash exits as data, not tool errors

A nonzero exit of a successfully executed command is data: the command
ran, and its output plus the status line is what the model needs to pick
the next step. The bash tool used to bail on nonzero exits, which turned
whole classes of useful results into error tool results (isError=true) —
e.g. compound probe commands whose trailing grep/ls found nothing, or
EPERM diagnostics with fully readable output.

Now the tool resolves normally with 'Command exited with code N' appended
to the text; real execution failures (spawn errors, timeouts, abort) keep
rejecting. The normal return path also preserves details (truncation
info, fullOutputPath) that the bail path dropped.

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-49 (bb tasks)

Коммиты-источники (TS-форк):
- 901505832 — treat nonzero command exits as data, not tool errors

Анализ: TS bash.ts bailed on nonzero exit → Err → isError=true. Rust
execute_bash had the same pattern: anyhow::bail! on nonzero exit. Changed
to return Ok(ToolExecutionResult) with the status line in the text and
is_error=false, preserving details. Timeout/abort paths unchanged.

Тесты: new tests/bash_nonzero_exit.rs covers output+status, silent
failure, and the timeout path (3 tests). Golden corpus bash.json
exit-code-3 case updated from ok=false/isError=true to ok=true/
isError=false with text+details.
```

Файлы (3):
- `crates/pa-core/src/tools/bash.rs`
- `crates/pa-core/tests/bash_nonzero_exit.rs`
- `crates/pa-core/tests/golden/corpus/bash.json`

### #6 4d123ad0fc — fix(pa-tui): normalize Cyrillic keybindings to Latin physical keys

```
fix(pa-tui): normalize Cyrillic keybindings to Latin physical keys

Added Cyrillic-to-Latin codepoint normalization in key_event_to_id so
keybindings match regardless of the active keyboard layout. When a
keybinding modifier (ctrl/alt/super) is active, Cyrillic chars are
mapped to their Latin physical-key equivalents (e.g. щ→o, с→c, г→u).
Plain text input (no modifier) passes through unchanged — the user's
Russian input is never altered.

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-50 (bb tasks)

Коммиты-источники (TS-форк):
- e2dffd5a5 — Fixed keybindings not working with Russian keyboard layout

Анализ: TS per-intercept raw bytes (addInputListener) before crossterm
parsing. Rust crossterm already parses into KeyEvent with
KeyCode::Char(cyrillic_char). Fix: normalize the char in key_event_to_id
when ctrl/alt/super is active. Shift-only is text input, not a
keybinding modifier — Cyrillic uppercase passes through unchanged.

Тесты: 8 новых тестов (3 в layout_normalize, 3 интеграционных в keys).
Все ключи с модификаторами (ctrl/alt/super) нормализуются. Plain text
не изменяется.
```

Файлы (3):
- `crates/pa-tui/src/keys.rs`
- `crates/pa-tui/src/layout_normalize.rs`
- `crates/pa-tui/src/lib.rs`

### #7 1669b96188 — fix: platform-dependent test assertions (macOS Alt→Option, git hash)

```
fix: platform-dependent test assertions (macOS Alt→Option, git hash)

Two pre-existing test failures on macOS, not caused by any port work:

1. hotkeys guide_renders_* (3 tests): assertions hardcoded 'Alt' but
   format_key_text renders 'Option' on macOS. Fixed: build expected
   strings via format_key_text (platform-aware). Also fixed false
   positive in disabled-binding test: 'Ctrl+O' substring matched
   'Ctrl+Option+]' — use backtick-delimited 'Ctrl+O' instead.

2. golden_bash_group destructive-reset-clean: git short hash is
   environment-dependent. Fixed: normalize 'HEAD is now at <hash>' to
   '<HASH>' placeholder in norm_string; update corpus to match.
```

Файлы (3):
- `crates/pa-core/src/tools/golden_replay.rs`
- `crates/pa-core/tests/golden/corpus/bash.json`
- `crates/pa-tui/src/hotkeys.rs`

### #8 1fffe1b056 — fix(pa-ai): preserve dynamically registered providers across reset

```
fix(pa-ai): preserve dynamically registered providers across reset

reset_api_providers now preserves providers with a source_id (faux test
providers, extension providers, embedders) instead of wiping the entire
registry. A bare clear + register_builtins would break every later turn
with 'No API provider registered for api: ...' when a reset reloads
built-in transport wiring.

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-51 (bb tasks)

Коммиты-источники (TS-форк):
- d587999e7 — resetApiProviders preserves dynamically registered providers
- a5813cd18 — drop the duplicate builtin provider registration

Анализ: TS resetApiProviders filtered apiProviderRegistry by
BUILTIN_API_IDS. Rust registry uses source_id: None = builtin,
Some(_) = dynamic. Filter by source_id.is_some() — simpler and
equivalent.

Тесты: 2 новых теста — reset_preserves_dynamic_providers,
reset_reloads_builtins.
```

Файлы (1):
- `crates/pa-ai/src/registry.rs`

### #9 578de2a498 — feat(pa-tui): notify bell on turn end + session name footer line

```
feat(pa-tui): notify bell on turn end + session name footer line

Replaces two TS extensions (notify.ts, session-name-footer.ts) that
cannot be ported directly — Rust v0.10.0 has no TypeScript extension
API. Features reimplemented as native TUI behavior:

1. Notify bell: rings terminal bell (\x07) on TurnEnded when there is
   no error and no queued messages, alerting the user that input is
   expected (replaces notify.ts agent_end + ctx.ui.bell()).

2. Session name footer: renders a dim 'name • cwd' line below the
   prompt tray in the dock (replaces session-name-footer.ts
   ctx.ui.setWidget with placement belowEditor).

plan-code extension deferred — it requires /plan and /code mode
infrastructure covered by PRIME-58.

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-52 (bb tasks)

Анализ: TS extensions depended on ExtensionAPI (bell, setWidget, notify,
session lifecycle hooks). Rust v0.10.0 has no extension system — the
'extensions' settings key is a dead key. Reimplemented as native TUI
features using existing ChromeState (chat_name, cwd) and TurnEnded
handler.

Тесты: hotkeys 3/3, keys::cyrillic 2/2 — no regressions. Build OK.
```

Файлы (2):
- `crates/pa-tui/src/session_ui/apply.rs`
- `crates/pa-tui/src/view/panels.rs`

### #10 48e1bbd14d — feat(pa-daemon): ACP session/load + session/fork + usage_update (PRIME-53)

```
feat(pa-daemon): ACP session/load + session/fork + usage_update (PRIME-53)

Three ACP protocol features for bb integration:

1. usage_update: AcpSessionUpdate::UsageUpdate variant emitted on
   message_end for completed assistant responses. Reports context size
   (totalTokens or field sum fallback) and model context window. Seeded
   at session/new from connection state, refreshed per turn. Error/
   aborted responses and missing context_window emit nothing.

2. session/load: restores in-agent history when bb resumes a thread.
   Cross-process JSON registry (acp-session-registry.json) maps ACP
   session ids to runtime session files. Cwd validation rejects mismatched
   workspaces (PRIME-8 review). Registry resolve prefers recorded file,
   falls back to session-dir scan by runtime id.

3. session/fork: clones source session history into a branched file for
   bb thread forks. ForkCapability advertised in initialize. Uses
   SessionManager::fork_from for cloning. allowForeignCwd opt-in via
   _meta namespace (PRIME-25). Re-registers forked session for
   fork-of-fork support.

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-53 (bb tasks)

Коммиты-источники (TS-форк):
- 0a62474d0 — report ACP usage_update
- 56f56109d — support ACP session/fork for bb thread forks
- e059c4609 — implement ACP session/load (PRIME-8)
- 6e429c59f — reject session/load when cwd differs (PRIME-8 review)
- 35f20ec9a — allow foreign-cwd session/fork via _meta opt-in (PRIME-25)

Анализ: TS extensions used connection.switchSession and in-process
SessionManager. Rust uses daemon DaemonCommand::SwitchSession and
SessionManager::fork_from. Registry reimplemented as standalone module
with file-based JSON storage, prune by age, dir-scan fallback.

Тесты: 54/54 ACP passed (11 new: 5 usage_update, 6 session_registry).
Build OK.
```

Файлы (6):
- `.changes/prime-53-acp-load-fork-usage.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/mod.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/acp/wire_events.rs`

### #11 b9eac19870 — feat: PRIME-55/56/57/59/61 — daemon recovery, quiescence, nameless tool, bare skill, RLM metadata

```
feat: PRIME-55/56/57/59/61 — daemon recovery, quiescence, nameless tool, bare skill, RLM metadata

Five ported features for the v0.10.0 Rust upgrade:

PRIME-55 (daemon restart recovery):
- Auto-retry metadata: auto_retry_start/end → ACP session_info_update
  with PrimeAgentAutoRetryMeta (phase/attempt/reason). 3 tests.
- resumePendingUserMessage: new PromptInput field flows through
  PromptRequest → QueuedItem → run_turns. TurnAdmission::ResumePending
  variant. AgentSession::dangling_user_message_tail() checks transcript
  tail; when resume=true + dangling tail: skips UserMessage emit, uses
  agent.continue_run(). Wire protocol change across 50 files.
- Prompt recovery: prompt_with_recovery() wraps link.request_until_close.
  On transport error: publishes autoRetry waiting meta, bounded 180s
  reconnect loop (2s probe), re-attaches session, re-issues prompt with
  resumePendingUserMessage=true. New DaemonLink + event forwarder.
- Graceful shutdown recovery: shutdown_recovery_pending flag detected
  from session_closed{shutdown} event. Pre-arms prompt with resume.

PRIME-56 (quiescence on bash notice):
- bash.py: emit {active: True, exited: True} after _wait_reaped(),
  before cell_finished.wait(). Host quiescence barrier tracks notice
  delivery, not process liveness. 2 Python tests.

PRIME-57 (nameless tool call sanitize):
- transform_messages.rs: drop tool calls with empty function name so
  OpenAI-compatible endpoints don't reject the whole request. 1 test.
- Reconnect prompt drift (PRIME-40): DROP — no <system_instructions>
  wrapper concept in Rust.

PRIME-59 (bare /skill-name slash):
- skills/mod.rs: expand_skill_command now handles bare /<skill-name>
  when name matches a loaded skill exactly and no builtin claims it.
  Extracted expand_skill_body helper. 4 tests.

PRIME-61 (RLM child metadata):
- meta.rs: PrimeAgentSubagentMeta enriched with progress_note,
  activity, answer_preview, recap, last_activity_at.
- wire_events.rs: rlm_child_update handler extracts new fields.
- Grace-period eviction guard: DROP — no empty-session eviction in Rust.

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задачи: PRIME-55, PRIME-56, PRIME-57, PRIME-59, PRIME-61 (bb tasks)

Тесты: 57 ACP, 4 transform_messages, 46 skills — all green.
Build OK.
```

Файлы (53):
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
- ... и ещё 43 файлов

### #12 54be7902cf — feat: plan-code extension — /plan /code /dbg modes (PRIME-63)

```
feat: plan-code extension — /plan /code /dbg modes (PRIME-63)

Three-mode plan/code/debug system implemented as native session engine
functionality (Rust v0.10.0 has no extension API):

Slash commands:
- /plan — read-only mode: edit tool disabled, bash classified
  (read-only auto-allow, catastrophic hard-block, others confirm),
  ipython checked for dangerous patterns. Plan markdown writes always
  allowed. Trailing args run as immediate prompt.
- /code — full implementation mode with code behavioral prompt
- /dbg — systematic diagnosis mode with debug behavioral prompt
- /exit — exit mode, restore default tools and prompt
- /todos — show plan progress (completed/total steps)

Architecture:
- PlanCodeMode enum (Plan/Code/Debug) + PlanCodeState in plan_code.rs
- Mode state in SessionEngine, injected via SessionEngineConfig
- execute_session_command handles all 5 commands
- before_tool_call hook enforces plan-mode tool gating
- System prompt builder injects mode-specific layer dynamically:
  plan_mode.md, code_mode.md, debug_mode.md
- Plan tracking: TodoItem extraction from Plan sections, [DONE:n]
  step tracking, mark_completed, progress label
- CLI flag --plan-code <plan|code|debug> wired through all layers:
  Args -> RuntimeConfig -> InteractiveOptions -> create_config ->
  daemon worker -> AgentEngineConfig -> SessionEngineConfig

Перенос из TS-форка ~/.prime/agent/extensions/plan-code/ (974 строки TS)
для PA v0.10.0 (Rust-порт). Реализовано как встроенная функциональность,
не extension — Rust v0.10.0 не имеет TypeScript extension API.

Задача: PRIME-63 (bb tasks)

Тесты: 15 plan_code, 11 slash, 57 ACP — all green. Build OK.
```

Файлы (41):
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
- ... и ещё 31 файлов

### #13 01c024b621 — chore(scripts): run-rust-daemon.sh - bb-ready daemon lifecycle, TUI by default

```
chore(scripts): run-rust-daemon.sh - bb-ready daemon lifecycle, TUI by default

The script used to exec the interactive TUI and pkill every
"target/*/prime-agent" process, which killed bb clients and other
agents along with the daemon, and it dodged the macOS SUN_LEN limit by
overriding TMPDIR. Reworked into the canonical lifecycle for the bb
provider (acp-prime-agent-rust):

- always builds (PROFILE=release by default - the exact binary the bb
  wrapper ~/bin/prime-agent-rust-bb launches; fast-release opt-in);
- stops only the daemon: pkill -f "prime-agent --mode daemon
  --daemon-socket /tmp/prime-agent-rust";
- sanitizes inherited PRIME_AGENT_INTERNAL_* env so a run from a
  prime-agent-hosted shell no longer boots as a foreign worker
  ("Daemon socket already in use" on a foreign worker socket);
- starts the daemon on the isolated /tmp/prime-agent-rust/daemon.sock
  with PRIME_AGENT_CODING_AGENT_DIR=~/.prime-v0.10/agent, the same
  isolation the bb clients use; TMPDIR override dropped (the
  worker-socket fix keeps stock macOS TMPDIR within AF_UNIX limits);
- readiness = a real client connection (`prime-agent --daemon-socket
  ... list --json`); plain `status` cannot see custom sockets;
- default mode is the TUI attached to that daemon (the daemon boots
  itself and outlives the TUI); TUI=0 + FOREGROUND=1 keep the
  detached/foreground daemon flows.

Verified: red/green daemon restart, bb thread on the restarted daemon
replies end-to-end (PRIME-65 setup context).

Task: PRIME-45 (v0.10.0 Rust upgrade)
```

Файлы (1):
- `scripts/run-rust-daemon.sh`

### #14 5cf562d10c — feat: bb-mirror threads for RLM subagents (PRIME-62)

```
feat: bb-mirror threads for RLM subagents (PRIME-62)

Signature fork feature: RLM subagents become visible bb threads.

Claim-rebind mechanism (PRIME-11):
- rlm.spawn(bb_mirror=True) admits child with deferred admission
  (oneshot waker, 10min timeout, cancel/delete settle)
- Parent writes single-use claim file (acp-mirror-claims/<nonce>.json,
  TTL 10min) naming the child's daemon session
- bb thread spawn: bb thread spawn --parent-self --provider acp-prime-agent
  with [rlm-mirror:<nonce>] marker prompt
- ACP rebind: mirror thread's first prompt parsed for marker, claim
  validated (same cwd + rlmDepth > 0), Reattach to target session,
  re-admit under same ACP id, kill draft session
- mirror_rebind_attempted flag blocks same-process replay (PRIME-28)

Auto-mirror (PRIME-24):
- Plain rlm.spawn in depth-0 bb session (BB_THREAD_ID set) automatically
  creates mirror thread — no explicit bb_mirror=True needed
- bb_mirror=False forces plain invisible child

Hardening (PRIME-28):
- cancel_outstanding_rlm_children skips mirror children
  (waitingMirrorAdmission + autoMirrorThread)
- close_children_inner settles parked mirror children
- Session-gone errors in settlement loop degrade to clean terminal
  release (EndTurn) instead of poisoning
- is_session_gone_error() classifies retryable transport failures

New files:
- crates/pa-daemon/src/rlm_bb_mirror.rs (~580 lines): claim I/O, nonce,
  marker parsing, env detection, bb thread spawn, auto-mirror decision
- skills/bb-subagents/: Python skill with spawn_mirror() function
- .changes/prime-62-bb-mirror-subagents.md

Modified:
- rlm_host.rs: bb_mirror field in RlmSpawnRequest, optional_bool_kwarg
- rlm_children.rs: ChildRecord mirror fields + snapshot
- rlm_children/host.rs: deferred admission, auto-mirror path
- rlm_children/registry.rs: skip_mirror in cancel/close/delete
- acp/daemon.rs: rebind logic, session-gone degradation, cancel filter
- acp/types.rs: split_acp_prompt_blocks, AcpPromptSplit
- acp/mod.rs: same_cwd pub(crate)
- engine.rs: inside_bb detection (BB_THREAD_ID env)
- system_prompt.rs: inside_bb field, delegation doctrine for bb depth-0
- prime-agent-runtime/src/rlm/__init__.py: bb_mirror param in spawn()

Перенос из TS-форка local/customizations для PA v0.10.0 (Rust-порт).
Задача: PRIME-62 (bb tasks)

Коммиты-источники (TS-форк):
- 35d1776f3 — bb mirror threads for RLM subagents (PRIME-11)
- 3a0e42e2f — harden bb mirror rebind after review (PRIME-11)
- d6d857465 — keep bb mirror rebind and parked children working E2E
- 7fe2a7e52 — route mirror claim probes via supervisor (PRIME-11)
- 6f613caef — settle parked mirror children on cancel (PRIME-11)
- b8f8f696f — auto-mirror plain rlm.spawn children (PRIME-24)
- 7b4835c98 — survive parent-turn aborts for bb-mirror batches (PRIME-28)
- 35a86a859 — keep running auto-mirror children across stop/close/dispose
- 955f9b1cb — clear autoMirrorThread on degradation (PRIME-28)
- e5639bfba — address review findings (PRIME-28 review)
- 2d6d002ad — add completed-spawn mirror test, auto-mirror close tests
- 3008d0487 — expand PRIME-28 coverage to 16/21 scenarios
- 8d2eeaad3 — gate mirror rebind on per-entry flag (PRIME-28)

Тесты: 60 ACP, 92 RLM daemon, 27 RLM core — all green.
Build OK (fast-release, 0 warnings).
```

Файлы (21):
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
- ... и ещё 11 файлов

### #15 aeb1f44908 — fix(daemon): ACP session resume — registry race, archive fallback, strip <system_instructions>

```
fix(daemon): ACP session resume — registry race, archive fallback, strip <system_instructions>

Fixes #3592

Root causes and fixes:

1. Registry race condition (session_registry.rs):
   write_registry wrote directly, racing with concurrent register_session
   calls. read_registry returned empty on a momentarily-empty file,
   causing write_registry to save 1 entry, destroying all 182 entries.
   Fix: atomic write (temp + rename) + retry read on empty file.

2. Archive fallback (session_registry.rs):
   resolve_session only searched sessions/, not sessions-archive/.
   When the daemon's periodic sweep archived a session file,
   session/load failed with 'Unknown ACP session'.
   Fix: resolve_session now checks sessions-archive/ and restores
   the file (move) back to sessions/.

3. MAX_AGE pruning (session_registry.rs):
   ACP_SESSION_REGISTRY_MAX_AGE_MS was 7 days; TS-era registry entries
   (from the migration) were pruned on the next daemon restart.
   Fix: 7 -> 30 days.

4. <system_instructions> wrapper pollution (types.rs, read.rs, session_navigation.rs):
   bb-bridge injects a 20K <system_instructions> metadata block as the
   first text block in the first prompt. It was stored in the session
   file as the first user message, loaded into the LLM context window on
   resume, and broke prefix caching (prompt hash changed every resume).
   Fix: two-level stripping:
   - Level 1 (types.rs): AdmittedPrompt::parse strips the wrapper before
     sending to the worker — new prompts never record the wrapper.
   - Level 2 (read.rs): SessionFile::strip_instructions_wrapper() strips
     it from existing entries on switch_session/fork — old files are
     clean in-memory.

5. run-rust-daemon.sh: updated default profile and socket paths for
   the v0.10 migration (fast-release, ~/.prime/agent).

Tests: 88 passed (session_registry: 6, session_navigation: 8, session_store: 65, acp::types: 9).

fix(daemon): treat 'Session is already active' as no-op in session/load

When a session is interrupted and resumed, the worker may still hold
the session file lease. SwitchSession then fails with 'Session is
already active' because the lease is held by the current worker.

session/load treated this as a fatal error → bb fell back to
session/new → new PTID → 7-line fresh session (original had 55+ lines)
→ PTID drift cycle.

Fix: in handle_session_load, when SwitchSession fails with a message
starting 'Session is already active', fall through to the admit logic
instead of returning an error. The session is already loaded in the
current worker — the switch is a no-op, not a failure.

Fixes #3592 (continuation: interrupt+resume path)
```

Файлы (7):
- `.changes/acp-session-resume.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/session_navigation.rs`
- `crates/pa-daemon/src/session_store/read.rs`
- `scripts/run-rust-daemon.sh`

### #16 43900ca3af — fix(tui): surface prompt templates in slash-command autocomplete

```
fix(tui): surface prompt templates in slash-command autocomplete

The daemon sends prompt-template commands (source: prompt) via
get_commands, but the TUI only extracted source: skill entries,
discarding all prompt templates. Add prompt_command_entries parser,
prompt_commands field throughout the catalog pipeline, and chain it
in suggestions, takes_argument lookup, and apply_completion.
```

Файлы (8):
- `.changes/fix-prompt-template-autocomplete.md`
- `crates/pa-tui/src/autocomplete.rs`
- `crates/pa-tui/src/editor/mod.rs`
- `crates/pa-tui/src/session_ui.rs`
- `crates/pa-tui/src/session_ui/commands.rs`
- `crates/pa-tui/src/session_ui/lifecycle.rs`
- `crates/pa-tui/src/session_ui/settings.rs`
- `crates/pa-tui/tests/skills_menu_headless.rs`

### #17 70bb810c6b — fix(ai): classify proxy keepalive responses as overloaded instead of stream_drop

```
fix(ai): classify proxy keepalive responses as overloaded instead of stream_drop

When the omnirouter proxy has no available upstream, it sends SSE chunks
with model=keepalive and empty choices, then closes the stream. The
stream parser classified this as stream_drop (the stream ended without
a stop signal), but the real cause is provider unavailability. Detect
response_model=keepalive before the stream_drop check and classify as
overloaded (still retryable), producing a clearer error message.
```

Файлы (4):
- `.changes/fix-keepalive-response-classification.md`
- `crates/pa-ai/src/providers/openai_completions/stream.rs`
- `crates/pa-ai/src/providers/openai_completions/stream_drop.rs`
- `crates/pa-ai/src/utils_inner/stream_failure.rs`

### #18 86e638e879 — fix(daemon): idempotent ACP session/new after a provider crash (PRIMER-3)

```
fix(daemon): idempotent ACP session/new after a provider crash (PRIMER-3)

A bb reconnect re-sending session/new previously minted a fresh ACP id and a
fresh runtime session, orphaning the crashed session's history. Two guards:

- register_session_if_absent keeps an existing registry entry whose
  session_file still exists; a duplicate session/new can no longer
  overwrite it with a stale record.

- session/new with a cwd whose registry entry resolves to an idle session
  file adopts it: the newest created_at entry wins (deterministic pick
  over the entries sharing one cwd), the file must parse into a header
  this build reads (version guard), the dir scan runs once per admission
  (ranked candidates, not per entry), and archived files restore like
  resolve_session. Adoption requires a clean SwitchSession: a foreign
  live holder ("Session is already active") or any other switch failure
  falls back to a fresh id instead of binding the wrong session file.

Tests: registry helpers (if_absent preserve/overwrite/insert, cwd match,
archive restore, schema-reject) and daemon admission flow (reuse, fresh-id
fallbacks for unknown cwd and switch refusal, newest-entry pick).
```

Файлы (2):
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`

### #19 0f078d14b4 — fix(daemon): ACP session/load fails on a foreign live lease holder instead of dropping history

```
fix(daemon): ACP session/load fails on a foreign live lease holder instead of dropping history

"Session is already active" on SwitchSession has two meanings: this worker already hosts the target file (genuine no-op, admit), or a still-live worker from the stopped connection holds the lease. The old prefix check treated both as a no-op, so a resume after bb thread stop admitted the fresh boot session, silently losing the session history and overwriting the registry mapping (observed on thr_mawt8iambw, 2026-10-19). The load handler now verifies via GetConnectionState that the current worker hosts the target file before falling through; a foreign holder fails the load with an explicit error, registry mapping preserved. Regression tests cover both branches."
```

Файлы (2):
- `.changes/acp-load-foreign-lease-holder.md`
- `crates/pa-daemon/src/acp/daemon.rs`

### #20 b552022762 — docs(changes): note thr_e5uiu8qtw5 second affected thread + registry recovery + deploy note

```
docs(changes): note thr_e5uiu8qtw5 second affected thread + registry recovery + deploy note
```

Файлы (1):
- `.changes/acp-load-foreign-lease-holder.md`

### #21 7310da20c9 — fix: use Homebrew lld 23 for macOS 27 SDK TAPI compatibility

```
fix: use Homebrew lld 23 for macOS 27 SDK TAPI compatibility

LLD 22.1.2 bundled with Rust 1.96 cannot parse the arm64e.x1-macos
architecture tokens in the TAPI v4 .tbd files of the macOS 27 SDK
(Xcode 27.1). This causes link failures with undefined libc/libSystem
symbols. Homebrew LLD 23.1.3 (LLVM 23) understands the new tokens.
```

Файлы (1):
- `.cargo/config.toml`

### #22 22dca1d909 — fix(daemon): review fixes for session lifecycle (PRIMER-3)

```
fix(daemon): review fixes for session lifecycle (PRIMER-3)

- session/load: only fail on foreign holder when state positively
  confirms a mismatch; transient fetch_connection_state failure now
  falls through to admit (regression from PRIMER-3 fix)
- resolve_session: add schema version validation matching find_session_by_cwd
- scan_session_dir: add version guard for future-schema files
- restore_archived_session_file: validate restored file schema version
- resolve_session: use restore_archived_session_file instead of inline copy
- find_session_by_cwd: pre-canonicalize cwd once before filter loop
- scan_session_dir_ranked: early break on rank-0 (unbeatable) match
- same_canonical_cwd: extracted from same_cwd for reuse with pre-canonicalized paths
- .changes: add trailing newline
```

Файлы (4):
- `.changes/acp-load-foreign-lease-holder.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/mod.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`

### #23 7305b35f0d — fix(daemon): orphaned-worker sweep + session/load retry on foreign lease

```
fix(daemon): orphaned-worker sweep + session/load retry on foreign lease

Root cause: bb reaps idle ACP connections but does not kill the
worker process. The worker stays alive holding a session file lease
(the worker-driven passivation path never fires — no client to send
WorkerIdlePassivation through). On the next resume, session/load
hits a foreign live holder on SwitchSession and bb silently falls
back to session/new, losing all in-agent history.

Three fixes targeting the root causes:

1. Supervisor orphan sweep (worker_lifecycle.rs, supervisor.rs):
   passivate_orphaned_workers runs every 300s, stopping workers
   whose owner client disconnected but whose process stayed alive.
   Frees the session file lease so session/load can succeed.

2. session/load retry on foreign holder (acp/daemon.rs):
   when SwitchSession fails with "Session is already active" and
   the holder is foreign, sleep 500ms (giving a normally-disconnecting
   holder time to release the lease) and retry once before failing
   the load. For orphaned holders, the periodic sweep (300s) is
   the backstop — the next session/load after the sweep succeeds.

3. Lease reclamation unchanged (lease.rs):
   the original lease_reclaimable logic (reclaim only dead/missing
   owners) is preserved. An age-based reclamation on the lease
   directory mtime was considered but rejected: the directory mtime
   is set at acquisition and never updates during normal operation,
   so any session held > 3h would become reclaimable even with a
   live, active worker — risking concurrent writes and JSONL
   corruption.

Regression test: session_load_retries_after_orphan_sweep_releases_
foreign_lease verifies the retry path restores history instead of
falling back to a fresh session.

Observed on thr_w27mgasa3d (2026-10-20/22).
```

Файлы (4):
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/supervisor.rs`
- `crates/pa-daemon/src/supervisor/clients.rs`
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`

### #24 3537562d7b — Trigger orphan sweep on foreign-holder session load

```
Trigger orphan sweep on foreign-holder session load

Replace the 500ms passive sleep before retrying SwitchSession with an
active TriggerOrphanSweep command that passivates orphaned workers and
releases their leases immediately. The 300s periodic sweep remains as
backstop. Adds TriggerOrphanSweep variant to DaemonCommand, supervisor
handler, and dispatch wiring.
```

Файлы (5):
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/protocol.rs`
- `crates/pa-daemon/src/supervisor/clients.rs`
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`
- `crates/pa-types/src/daemon/command.rs`

### #25 536fe7a2a6 — fix: remove cwd-reuse from session/new to prevent cross-thread session adoption

```
fix: remove cwd-reuse from session/new to prevent cross-thread session adoption

find_session_by_cwd made session/new idempotent by reusing any registered
session whose cwd matched. But cwd is per-environment, not per-thread: two
bb threads in the same env share it. The second thread's session/new
adopted the first thread's session, both claimed the same providerThreadId,
and bb's classifyClaim rejected every send with 409 provider_session_unavailable.

Reconnection after a provider crash is handled by session/load (bb sends
turn.submit with the stored providerThreadId), not session/new, so cwd-reuse
served no valid caller.

Removes the find_session_by_cwd adoption block from handle_session_new.
Updates two existing tests to assert fresh-id minting. Adds a regression
test verifying two session/new calls with the same cwd get distinct ids.
```

Файлы (3):
- `.changes/fix-cwd-reuse-cross-thread-adoption.md`
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/session_registry.rs`

### #26 773348efd5 — fix: add ./plans to .gitignore

```
fix: add ./plans to .gitignore
```

Файлы (2):
- `.gitignore`
- `plans/UPGRADE_PLAN_v0.10.1_clean.md`

### #27 2767dca128 — fix: bb-mirror review findings — waker bridge, kill_on_drop, claim cleanup, temperature validation

```
fix: bb-mirror review findings — waker bridge, kill_on_drop, claim cleanup, temperature validation

C1 (CRITICAL): resolve_rlm_mirror_admission daemon command bridges
the ACP rebind → parent watcher waker. After rebind_to_rlm_mirror_session
succeeds, the daemon sends ResolveRlmMirrorAdmission to the parent
session, which fires the oneshot waker via resolve_waiting_mirror_run.
Without this, every mirror child waited 10min then settled as failed.

W1: kill_on_drop(true) on bb spawn Command; fix incorrect comment.
W2: restore temperature validation (isinstance/isfinite) in rlm/__init__.py.
W3: fix double-lock TOCTOU in registry.rs mirror check.
W4: tighten is_session_gone_error from contains() to starts_with().
W5: daemon creates nonce+writes claim for explicit bb_mirror=True
    (not just auto-mirror); nonce returned in RlmSpawnHandle.
W6: delete stale claim files on read in read_rlm_mirror_claim.
S1: stale claims now removed on read (same fix as W6).
S2: add 30s timeout to _run_bb in Python skill.
S3: fix split_acp_prompt_blocks to split first text block regardless
    of prior instruction_texts.
S4: parse_bb_spawn_outcome returns thread_created=false for unparseable
    output instead of assuming success.

Also: add parent_session_id to RlmMirrorClaim for the rebind notification.
Add mirror_claim_nonce to RlmSpawnHandle. Add ResolveRlmMirrorAdmission
to DaemonCommand enum, protocol routing, worker dispatch, engine trait.
```

Файлы (16):
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
- ... и ещё 6 файлов

### #28 b063871e2b — fix: replace cat with Python read in speculative-cell example (usage.md)

```
fix: replace cat with Python read in speculative-cell example (usage.md)

Address PRIME-39 review WARNING: bash('cat src/likely.ts') contradicted
the 'use Python for reading files' rule. Replace with open().read().
```

Файлы (2):
- `.changes/fix-speculative-cell-cat-example.md`
- `crates/pa-core/src/prompts/layers/usage.md`

### #29 642016c386 — fix(daemon): passivate orphaned ACP bridge workers so bb session/load restores history

```
fix(daemon): passivate orphaned ACP bridge workers so bb session/load restores history

bb host-daemon reaps idle ACP bridge processes (30 min) without stopping the
daemon worker. The worker is Resident (owner_client_id None), so the orphan
sweep skipped it, the session lease stayed held, session/load's SwitchSession
was refused (Session is already active in <worker>), and bb fell back to a
fresh session losing all in-agent history (PRIMER-6).

- DaemonWorkerDescriptor.acp_client_id: the ACP bridge client recorded at
  launch (executionMode acp); WorkerOwnership carries it into launch_worker
- schedule_acp_bridge_cleanup: graceful passivation 30s after the bridge
  client's last connection closed (roster row survives; next session/load
  re-creates the worker over the same file)
- passivate_orphaned_workers: also passivate ACP-bridge workers whose bridge
  client disconnected; keep any worker with live session subscribers
- reassign_acp_bridge_for_reuse: a reusing ACP create takes over the
  resident's bridge identity (stale ids no longer passivate a served worker)
- is_acp classifies both the live config and the durable flattened rest
  (update-restart restores keep ACP ownership)
- PassivateFileHolder: targeted passivation for the sweep's blind spot
  (wake-launched holders with no owner/bridge id); the session/load retry
  uses it before the final switch attempt
- client ids newline-stripped in the new log lines (log forgery guard)
- red-first regression: orphan_sweep_passivates_a_disconnected_acp_bridge_worker,
  orphan_sweep_keeps_a_connected_acp_bridge_worker
```

Файлы (30):
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
- ... и ещё 20 файлов

### #30 5b703d0b03 — fix(daemon): backfill ACP bridge identity on pre-PRIMER-6 descriptors

```
fix(daemon): backfill ACP bridge identity on pre-PRIMER-6 descriptors

Descriptors persisted by older builds carry no acp_client_id (the field shipped
with the orphan-passivation fix), so an adopted live ACP worker relaunches
unowned: the orphan sweep skips it, the lease stays held, and a resumed bb
thread still loses history. Backward compatibility for existing sessions:

- backfill_acp_bridge_session at descriptor load: a durable create with
  executionMode acp gains an empty-string bridge marker; a live bridge id
  is never overwritten, non-ACP creates gain nothing
- orphan criterion treats the empty marker as orphaned (its bridge died
  before the reboot; adoption only happens after that) unless a live client
  still subscribes — the existing subscribers guard covers a resumed thread
- regression: load_backfills_acp_bridge_id_on_a_pre_fix_descriptor
```

Файлы (2):
- `crates/pa-daemon/src/descriptor.rs`
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`

### #31 e9d3f1e00e — fix(daemon): model_metadata carries contextWindow (PRIME-53)

```
fix(daemon): model_metadata carries contextWindow (PRIME-53)

The ACP usage_update seeder reads model.contextWindow off get_connection_state, but the real engine's model_metadata omitted the field (TS toConnectionModel returns the whole model). The nil window left WireMappingState.context_window unset for the whole session, so no usage_update reached bb and the thread context ring stayed empty. Regression test red-first.
```

Файлы (5):
- `crates/pa-daemon/.changes/acp-context-window-in-model-metadata.md`
- `crates/pa-daemon/src/acp/config_options.rs`
- `crates/pa-daemon/src/agent_engine/session_engine_impl.rs`
- `crates/pa-daemon/src/agent_engine/tests/model_resolution.rs`
- `crates/pa-daemon/src/engine.rs`

### #32 7be2a78012 — fix(daemon): scrub ambient provider credentials from env in model_resolution tests

```
fix(daemon): scrub ambient provider credentials from env in model_resolution tests

get_available counts a provider authenticated when its env key is set, so an ambient HF_TOKEN (or any provider key in the exported env) leaks the compiled-fallback huggingface model into the startup chain over the tests' battery/mock-1 fixture, failing 3 model_resolution tests. ScrubbedProviderEnv removes every generated-provider key var plus PRIME_TEAM_ID for the guard's lifetime, serialized through the crate-wide TELEMETRY_ENV_MUTEX (the CleanTelemetryEnv pattern supervisor tests already use). Red with HF_TOKEN set on HEAD, green with the guard.
```

Файлы (2):
- `crates/pa-daemon/src/agent_engine/tests/model_resolution.rs`
- `crates/pa-daemon/src/test_support.rs`

### #33 5922a5446a — bash: handle lone 

```
bash: handle lone 
 as line break and mark mid-stream snapshots

Fix 3: append_decoded_text now treats
,
, and a lone 
 as line
breaks, so progress bars (B1 PASS
B2 idle) count as separate lines and
the byte limit no longer cuts them mid-phrase.

Fix 2: on_update appends a streaming marker so the model knows a running
process snapshot is partial and more output may arrive.

Fix 1 was reverted: the TS golden fixture has no no-newline marker, so
adding one is a parity regression.
```

Файлы (3):
- `as line break and mark mid-stream snapshots`
- `crates/pa-core/src/tools/bash.rs`
- `crates/pa-core/src/tools/output_accumulator.rs`

### #34 2b94ea52c7 — bash: add regression tests for lone \r line counting

```
bash: add regression tests for lone \r line counting

Four tests in output_accumulator cover Fix 3: lone \r, CRLF, trailing
\r, and current_line_bytes after \r. Verified the tests fail without the
fix (3 fail, 1 pass) and pass with it (4 pass).
```

Файлы (1):
- `crates/pa-core/src/tools/output_accumulator.rs`

### #35 e41d7f4cc3 — bash: fix current_line_bytes for \r\n in append_decoded_text

```
bash: fix current_line_bytes for \r\n in append_decoded_text

Review of 5922a5446 found a bug: text[last..].find(['\n','\r'])
always returns 1 (the \r position), never 2 for \r\n. So
current_line_bytes counted the \n of \r\n as part of the trailing
line. Store last_break_len and use text[last + last_break_len..].

Added cr_lf_current_line_bytes_skips_both regression test; verified
it fails without the fix (left=5, right=4) and passes with it.
```

Файлы (1):
- `crates/pa-core/src/tools/output_accumulator.rs`

### #36 0fc4027b4c — clippy: fix pre-existing warnings in 3 crates

```
clippy: fix pre-existing warnings in 3 crates

- pa-agent/agent.rs:580: use clone_from instead of clone+assign (clippy::assigning_clones)
- pa-telemetry/client.rs:39: Duration::from_mins(1) instead of from_secs(60) (clippy::duration_suboptimal_units)
- pa-core/session_commands.rs:550: map_or instead of map(...).unwrap_or(...) (clippy::map_unwrap_or)
- pa-core/session_commands.rs:571: drop redundant Result wrapper, wrap call site in Ok(...) (clippy::unnecessary_wraps)
```

Файлы (5):
- `crates/pa-agent/src/agent.rs`
- `crates/pa-core/src/session_engine/session_commands.rs`
- `crates/pa-telemetry/src/client.rs`
- `scripts/check_bb_prime_integration.py`
- `skills/bb-subagents/build/lib/bb_subagents/__init__.py`

### #37 8ab6498068 — fix(bb-mirror): forward model and reasoning-level to bb thread spawn

```
fix(bb-mirror): forward model and reasoning-level to bb thread spawn

When rlm.spawn(model=...) runs inside a bb session, the child is mirrored into a real bb thread via bb thread spawn. The bb CLI supports --model and --reasoning-level, but neither the daemon auto-mirror path nor the bb-subagents skill forwarded them — bb fell back to the project default and displayed the wrong model.

Daemon: add model/reasoning_level fields to BbMirrorSpawnOptions and pass --model/--reasoning-level in spawn_bb_mirror_thread. host.rs: populate the new fields at the auto-mirror spawn site from the resolved model id and the thinking wire name. Skill: forward --model/--reasoning-level in spawn_mirror.

The child session already received the correct model (lifecycle.rs); this fix is purely the bb display.
```

Файлы (3):
- `crates/pa-daemon/src/rlm_bb_mirror.rs`
- `crates/pa-daemon/src/rlm_children/host.rs`
- `skills/bb-subagents/src/bb_subagents/__init__.py`

### #38 4e4b4cb58a — streaming: flush superseded delta on kind switch in park_update

```
streaming: flush superseded delta on kind switch in park_update

park_update silently dropped the accumulated delta when the stream-event
kind switched (e.g. text_delta -> toolcall_start with no settling
text_end between them). A delta-mapping ACP consumer (bb) then lost
the tail of the previous channel and showed the assistant text
truncated mid-phrase.

park_update now flushes the superseded pending run before the new kind
parks. The call site in turn.rs passes the event pump; the existing
a_kind_switch test now asserts the superseded flush; a new regression
test pins the no-settling-event case.

Also: fmt the pa-agent clone_from call that the earlier clippy pass
introduced.
```

Файлы (4):
- `crates/pa-agent/src/agent.rs`
- `crates/pa-daemon/src/streaming.rs`
- `crates/pa-daemon/src/worker/turn.rs`
- `crates/pa-daemon/src/worker/turn_stream_tests/burst.rs`

### #39 72ab4e06ad — feat(acp): emit plan session update from goal_update

```
feat(acp): emit plan session update from goal_update

bb 0.47.0 rebuilt ACP adapter (commit fe1a02d7b) expects a plan
sessionUpdate alongside the goal meta. Map goal_update to
AcpSessionUpdate::Plan { entries } so bb renders the goal objective
as a plan entry; status derived from goal status (complete->completed,
active->in_progress, else pending). A goal without an objective emits
no plan entry. Regression test
goal_update_publishes_a_plan_entry_besides_the_session_info added.
```

Файлы (2):
- `crates/pa-daemon/src/acp/types.rs`
- `crates/pa-daemon/src/acp/wire_events.rs`

### #40 970e546083 — feat(daemon): track session mode via ACP configOptions and session/set_mode (PRIMER-4)

```
feat(daemon): track session mode via ACP configOptions and session/set_mode (PRIMER-4)
```

Файлы (62):
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
- ... и ещё 52 файлов

### #41 9345801a40 — Merge pull request #3 from sks7777/local/primer-4-session-mode-v3

```
Merge pull request #3 from sks7777/local/primer-4-session-mode-v3

feat(daemon): track session mode via ACP configOptions (PRIMER-4)
```

Файлы (0):

### #42 2ae7721d9f — fix: remove dead session-mode code and add session_mode to test fixtures\n\nRemove unused session_mode_saved_tools in engine.rs, unused previous_mode\ndestructure and no-op adjust_tools_for_mode in session_commands.rs,\nmerge identical ask/plan/code/debug match arms.\n\nAdd missing session_mode: None field to InteractiveOptions struct\nliterals in all pa-tui and pa-cli headless test fixtures.

```
fix: remove dead session-mode code and add session_mode to test fixtures\n\nRemove unused session_mode_saved_tools in engine.rs, unused previous_mode\ndestructure and no-op adjust_tools_for_mode in session_commands.rs,\nmerge identical ask/plan/code/debug match arms.\n\nAdd missing session_mode: None field to InteractiveOptions struct\nliterals in all pa-tui and pa-cli headless test fixtures.
```

Файлы (64):
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
- ... и ещё 54 файлов

### #43 50b165acc1 — fix: bb mode hints + websearch in /ask (PRIMER-4 regressions)

```
fix: bb mode hints + websearch in /ask (PRIMER-4 regressions)

Bug #1: bb не показывает подсказки session mode команд (/code, /ask, /debug)
- Add AcpSessionUpdate::AvailableCommands variant + AvailableCommand struct
- Publish available_commands_update on session/new, load, fork with builtin
  slash commands from SlashCommandRegistry::builtin()
- Add EngineEvent::ModeChanged variant; emit from worker (ACP) session
  command path when session_mode changes (parity with RPC path)
- Map ModeChanged to {"type":"mode_changed","mode":...} session event
  in worker/turn.rs so daemon.rs refresh_wire_config triggers

Bug #2: web_search перестал работать в /ask режиме
- ask_mode.md: remove "or execute code" prohibition; allow read-only Python
  skills via python_repl (websearch, data analysis)
- tool_call.rs: before_tool_call block sets details {"blocked":true,...}
  so UI can distinguish mode-block from ordinary error
- acp/types.rs: ToolCallUpdate.blocked field
- wire_events.rs: propagate blocked from result details
- tool_card/mod.rs: PanelStatus::Blocked variant renders "blocked"

Tests:
- session_mode.rs: websearch_code_is_not_dangerous, blocked_python_pattern_still_detected
- 28 session_mode tests pass, 71 ACP tests pass, 49 tool_card tests pass
```

Файлы (11):
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
- ... и ещё 1 файлов

### #44 c15d4e0084 — fix: available_commands_update input.hint shape for bb autocomplete

```
fix: available_commands_update input.hint shape for bb autocomplete

bb parses input.hint (nested object), not inputHint (top-level field).
Change AvailableCommand to use nested AvailableCommandInput { hint }.
71 ACP tests pass.
```

Файлы (2):
- `crates/pa-daemon/src/acp/daemon.rs`
- `crates/pa-daemon/src/acp/types.rs`

### #45 7012a2992d — fix: agent loses connection with long-running bash processes

```
fix: agent loses connection with long-running bash processes

Three changes address the [bash-done] notification loss that forced users
to repeatedly ask 'выведи статус' during long bash commands:

1. usage.md: loosen the no-polling rule — allow one re-await after a
   degraded bash() (BashSnapshot), and mandate proactive handle checks
   (poll/output/tail) on the next turn if [bash-done] does not arrive.
   The blanket ban on 'repeated awaits of a still-running handle' is
   removed; time.sleep() and shell sleep stay forbidden.

2. bash.py: remove _MAX_DEGRADE_HINTS cap (was 3) — every degrade now
   prints the stderr hint reminding the agent to end the turn and expect
   a [bash-done] notification. After 3 degrades the agent previously
   forgot the contract.

3. bash.py: add _degraded_awaited flag — a degraded handle that was later
   polled/output() must still send the [bash-done] notice. Previously
   _result_consumed suppression killed the only wake-up for a handle the
   agent had checked but not collected.

Evidence: 381 session logs, 0 async_bash_completion customMessages
delivered, 24 sessions with 2+ user status-check prompts. Worst session
(01a16eb6-70c): 11 of 18 'Жду' turns required user intervention.
```

Файлы (5):
- `crates/pa-core/src/prompts/layers/usage.md`
- `crates/pa-core/src/session_engine/bash_notices.rs`
- `crates/pa-core/tests/prompt_guards.rs`
- `prime-agent-runtime/src/rlm/bash.py`
- `prime-agent-runtime/test/test_bash.py`

### #46 9ab7b62754 — fix: orphaned worker with stale inflight permit blocks session restore

```
fix: orphaned worker with stale inflight permit blocks session restore

Cancel-during-turn causes a session split: the ACP bridge kills the old
process and starts a new one, but the daemon detects the old worker's
death asynchronously. During the gap, the old worker still holds the
session-file lease. session/load's retry (orphan sweep + passivate file
holder) tries to stop it, but both passivation paths skip workers with
saturated inflight permits. The cancelled prompt's route holds a stale
permit that releases only when the socket closure is processed — which
lags behind the sweep. Both retries fail, session/load errors, and the
bridge falls back to session/new (fresh session, history lost).

Fix: remove the inflight-skip guard from passivate_orphaned_workers
(orphan criterion + subscriber guard are sufficient) and from
handle_passivate_file_holder (add an explicit client-connected check
so a live ACP client is never stopped, but a disconnected one is
passivated despite stale permits).

Regression tests: an_orphaned_worker_with_stale_inflight_is_passivated
and passivate_file_holder_stops_worker_with_stale_inflight verify the
worker is removed from the registry when a permit is held and the ACP
client is disconnected.
```

Файлы (1):
- `crates/pa-daemon/src/supervisor/worker_lifecycle.rs`

### #47 7e2f9c2d5d — fix: bypass coalescer for thinking_delta to prevent cumulative duplication in bb

```
fix: bypass coalescer for thinking_delta to prevent cumulative duplication in bb

The coalescer merges same-kind deltas with push_str. A delta-mapping
ACP consumer (bb) expects per-token chunks — merged thinking deltas
cause cumulative duplication in bb thinking-block renderer.

The TS product (v0.9.8) has no coalescer at all; every event goes
direct. This makes thinking_delta events go direct too, matching the
TS behavior. text_delta and toolcall_delta continue through the
coalescer (their merging does not cause duplication in bb).
```

Файлы (1):
- `crates/pa-daemon/src/worker/turn.rs`

### #48 2a5f80f81c — fix(acp): reattach to live holder instead of orphan sweep on session load

```
fix(acp): reattach to live holder instead of orphan sweep on session load

When SwitchSession fails with SessionAlreadyActive and the typed
error_info carries the holder active_session_id, reattach to the
holder session instead of trying to kill it via orphan sweep +
passivate + retry. TS parity: switchSession catch block reattaches
to the live holder; the Rust port now does the same.

The orphan sweep + passivate + retry chain stays as the fallback
for the None active_session_id case (legacy/edge). A busy orphan
worker holding a long turn could not be passivated in time, causing
bb to fall back to a fresh session with no history.

Regression test: session_load_reattaches_when_holder_is_alive.
```

Файлы (1):
- `crates/pa-daemon/src/acp/daemon.rs`

## Пропущенные коммиты (SKIP)

| # | Hash | Причина |
|---|------|---------|
| 5 | f0be750ecb | `bash.rs` DELETED upstream. Nonzero-exit логика теперь в Python `bash.py`. Port при необходимости отдельно. |
| 7 | 1669b96188 | `golden_replay.rs` gutted, `bash.json` DELETED. Platform-dependent assertions для golden corpus больше не нужны. |
| 20 | b552022762 | `.changes/` файл, no-op documentation. |
| 33 | 5922a5446a | `bash.rs`, `output_accumulator.rs` DELETED. \r handling port в `bash.py` отдельно. |
| 34 | 2b94ea52c7 | `output_accumulator.rs` DELETED. Regression tests для удалённого кода. |
| 35 | e41d7f4cc3 | `output_accumulator.rs` DELETED. Fix для удалённого кода. |
| 41 | 9345801a40 | Merge commit. Cherry-pick реальных коммитов вместо merge. |

## Этап 0: Подготовка

**Направление мержа:** fork накладывается поверх upstream. Берём чистый
`v0.10.3` (detached HEAD), создаём новую ветку `local/v0.10.3-clean` и
cherry-pick'им каждый локальный коммит поверх upstream-кода. Не наоборот
(upstream поверх fork) — так upstream-нововведения (rlm.end_turn,
rlm.session.messages, bash.py rewrite, factory.py expansion) уже на месте,
а fork-правки адаптируются к ним. Эталон для проверки результата — tree of
`local/v0.10.1-clean` (текущая ветка до апгрейда): все fork-возможности должны
присутствовать, upstream-нововведения не затёрты.

```
git fetch upstream --tags
git branch local/v0.10.3-backup local/v0.10.1-clean     # backup текущей ветки
git checkout v0.10.3 --detach
git checkout -b local/v0.10.3-clean                      # новая чистая ветка от upstream
```

Эталон контента = tree of `local/v0.10.1-clean` (текущая ветка до апгрейда).

## Этап 1: Build config & platform compat

Коммиты: #1 (51b8d314a4), #2 (74e02bd10e), #13 (01c024b621), #21 (7310da20c9), #26 (773348efd5)

```
git cherry-pick 51b8d314a4
# Конфликты: test files изменены upstream. export_live_differential.rs DELETED upstream —
#   удалить из cherry-pick. Остальные test files — разрешить по upstream-версии.
# vendor/crossterm — fork-only, clean add.
git cherry-pick 74e02bd10e
# Конфликт: Cargo.toml — upstream изменил для v0.10.2/v0.10.3 release.
#   Сохранить fork-правки (fast-release profile, lld), внести upstream-версии зависимостей.
#   scripts/run-rust-daemon.sh — fork-created, cherry-pick отдельно (см. ниже).
git cherry-pick 7310da20c9
# .cargo/config.toml — fork-only change, clean.
git cherry-pick 01c024b621
# scripts/run-rust-daemon.sh — fork-created файл, нет в upstream. Clean add.
git cherry-pick 773348efd5
# .gitignore — clean add.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-cli -p pa-tui -p pa-types -- -D warnings
cargo check --workspace
```

## Этап 2: TUI features

Коммиты: #6 (4d123ad0fc), #9 (578de2a498), #16 (43900ca3af)

```
git cherry-pick 4d123ad0fc
# keys.rs — upstream не менял. layout_normalize.rs — fork-created, clean add.
# lib.rs — конфликт возможен, upstream менял lib.rs.
git cherry-pick 578de2a498
# session_ui/apply.rs — 1 upstream commit трогает. view/panels.rs — clean.
git cherry-pick 43900ca3af
# autocomplete.rs — 1 upstream commit. Остальные — clean.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-tui -- -D warnings
cargo check --workspace
```

## Этап 3: AI provider fixes

Коммиты: #8 (1fffe1b056), #17 (70bb810c6b), #36 (0fc4027b4c), #38 (4e4b4cb58a)

```
git cherry-pick 1fffe1b056
# registry.rs — upstream не менял. Clean.
git cherry-pick 70bb810c6b
# openai_completions/stream.rs — upstream изменил (#4014, #4013).
#   Разрешить конфликт: сохранить fork-классификацию keepalive как overloaded,
#   учесть upstream-исправления для function-call arguments и Bedrock thinking.
git cherry-pick 0fc4027b4c
# agent.rs — upstream изменил. Разрешить конфликт.
# transform_messages.rs — upstream изменил. Разрешить конфликт.
git cherry-pick 4e4b4cb58a
# agent.rs, worker/turn.rs — upstream изменил. Разрешить конфликт.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-ai -p pa-agent -- -D warnings
cargo check --workspace
```

## Этап 4: System prompt guidance

Коммиты: #4 (d474180e05), #28 (b063871e2b)

**Тяжёлый этап — /local-review.**

```
git cherry-pick d474180e05
# HEAVY CONFLICT:
#   core.md — upstream добавил rlm.end_turn(), rlm.session.messages, rlm.spawn cwd,
#     удалил websearch.run из списка.
#   usage.md — upstream удалил "await commands before ending the turn" правило,
#     добавил "interrupt python_repl cells at time limit".
#   Действие: вручную внести fork-правки (batch/compound-cell/delegation guidance)
#   поверх upstream-версии core.md и usage.md. Сохранить upstream-нововведения.
git cherry-pick b063871e2b
# usage.md — конфликт с upstream-версией.
#   Fork меняет "cat → Python" рекомендацию. Внести поверх upstream usage.md.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-core -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-core --lib -- prompt
```

## Этап 5: rlm.spawn temperature kwarg

Коммиты: #3 (3355caa197)

**Тяжёлый этап — /local-review.**

```
git cherry-pick 3355caa197
# HEAVY CONFLICT:
#   rlm_host.rs — upstream добавил cwd параметр, изменил spawn signature.
#     Объединить temperature и cwd в одной сигнатуре.
#   rlm_children/host.rs — upstream изменил (cwd, factory children).
#   rlm_children/lifecycle.rs — upstream изменил.
#   rlm_children/spawn_name_reservation_tests.rs — upstream добавил cwd field.
#   rlm_children/watch_tests.rs — upstream добавил cwd field.
#   prime-agent-runtime/src/rlm/__init__.py — upstream massively expanded (+163 lines).
#     Адаптировать fork-правки к новой __init__.py.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-core -p pa-daemon -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-core --lib -- rlm
timeout 120 cargo test -p pa-daemon --lib -- rlm_child
```

## Этап 6: ACP daemon foundation

Коммиты: #10 (48e1bbd14d), #15 (aeb1f44908), #18 (86e638e879), #19 (0f078d14b4), #22 (22dca1d909), #25 (536fe7a2a6)

```
git cherry-pick 48e1bbd14d
# acp/daemon.rs — upstream изменил (#3679, #4009). Разрешить конфликт.
# acp/mod.rs — upstream изменил. Разрешить конфликт.
# acp/config_options.rs — upstream изменил. Разрешить конфликт.
# session_registry.rs — fork-created, clean add.
git cherry-pick aeb1f44908
# acp/daemon.rs — конфликт. session_registry.rs — fork, clean.
git cherry-pick 86e638e879
# acp/daemon.rs — конфликт.
git cherry-pick 0f078d14b4
# acp/daemon.rs — конфликт.
git cherry-pick 22dca1d909
# acp/daemon.rs — конфликт. session_registry.rs — fork.
git cherry-pick 536fe7a2a6
# acp/daemon.rs — конфликт. session_registry.rs — fork.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-daemon -- -D warnings
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- acp
```

## Этап 7: ACP orphan recovery

Коммиты: #23 (7305b35f0d), #24 (3537562d7b), #29 (642016c386), #30 (5b703d0b03), #46 (9ab7b62754), #48 (2a5f80f81c)

**Тяжёлый этап — /local-review.**

```
git cherry-pick 7305b35f0d
# acp/daemon.rs — конфликт. supervisor/ — upstream изменил.
# worker_lifecycle.rs — upstream изменил (#3407, #3751, #4010).
git cherry-pick 3537562d7b
# acp/daemon.rs — конфликт. protocol.rs — конфликт. worker_lifecycle.rs — конфликт.
git cherry-pick 642016c386
# supervisor/ — конфликт. worker_lifecycle.rs — конфликт.
git cherry-pick 5b703d0b03
# worker_lifecycle.rs — конфликт.
git cherry-pick 9ab7b62754
# worker_lifecycle.rs — конфликт. supervisor/ — конфликт.
git cherry-pick 2a5f80f81c
# acp/daemon.rs — конфликт. supervisor/ — конфликт.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-daemon -- -D warnings
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- worker
timeout 120 cargo test -p pa-daemon --lib -- orphan
```

## Этап 8: PRIME-55/56/57/59/61

Коммиты: #11 (b9eac19870)

**Тяжёлый этап — /local-review.**

```
git cherry-pick b9eac19870
# MASSIVE: 53 файла. Главные конфликты:
#   engine.rs — upstream изменил.
#   system_prompt.rs — upstream изменил.
#   session_engine_impl.rs — upstream изменил.
#   lifecycle.rs — upstream изменил (#4019, #3820, #3676, #3855, #3751).
#   rlm_host.rs — upstream изменил (#3849, #3769, #3820).
#   skills/mod.rs — upstream изменил.
#   lib.rs — upstream изменил.
#   factory.py — upstream massively expanded (+604 lines).
#   __init__.py — upstream expanded (+163 lines).
#   .changes/ — upstream README.md only.
#   Fork-created files (clean adds): session_registry.rs, rlm_bb_mirror.rs,
#     quiescence.rs, nameless_tool.rs, etc.
#   Действие: пофайловый разбор конфликтов. Внести fork-возможности поверх upstream.
#   Проверить, что upstream-нововведения (rlm.end_turn, rlm.session.messages,
#   cwd kwarg) не затёрты.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-core -p pa-daemon -- -D warnings
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib
timeout 60 cargo test -p pa-core --lib
```

## Этап 9: Plan-code extension

Коммиты: #12 (54be7902cf), #40 (970e546083), #42 (2ae7721d9f), #43 (50b165acc1)

**Тяжёлый этап — /local-review.**

```
git cherry-pick 54be7902cf
# MASSIVE: 41 файл. Главные конфликты:
#   engine.rs — upstream изменил.
#   system_prompt.rs — upstream изменил.
#   Fork-created files (clean adds): plan_code.rs, session_mode.rs.
git cherry-pick 970e546083
# session mode via ACP configOptions.
#   acp/daemon.rs, acp/config_options.rs — конфликт.
#   session_engine_impl.rs — конфликт.
#   session_mode.rs — fork-created, clean add.
git cherry-pick 2ae7721d9f
# remove dead session-mode code.
#   engine.rs — конфликт с upstream.
git cherry-pick 50b165acc1
# bb mode hints + websearch /ask.
#   session_engine_impl.rs — конфликт.
#   worker/turn.rs — конфликт.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-core -p pa-daemon -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-core --lib -- plan_code
timeout 120 cargo test -p pa-daemon --lib -- session_mode
```

## Этап 10: bb-mirror threads

Коммиты: #14 (5cf562d10c), #27 (2767dca128), #37 (8ab6498068)

**Тяжёлый этап — /local-review.**

```
git cherry-pick 5cf562d10c
# 21 файл. Главные конфликты:
#   rlm_host.rs — upstream изменил (#3849, #3769, #3820).
#   system_prompt.rs — upstream изменил.
#   rlm_children/ — upstream изменил.
#   rlm_bb_mirror.rs — fork-created, clean add.
git cherry-pick 2767dca128
# rlm_host.rs — конфликт. rlm_children/ — конфликт.
# system_prompt.rs — конфликт.
git cherry-pick 8ab6498068
# rlm_children/host.rs — конфликт (upstream изменил).
# rlm_bb_mirror.rs — fork-created.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-core -p pa-daemon -- -D warnings
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- rlm_child
```

## Этап 11: Model & streaming fixes

Коммиты: #31 (e9d3f1e00e), #32 (7be2a78012), #47 (7e2f9c2d5d)

```
git cherry-pick e9d3f1e00e
# config_options.rs — конфликт. session_engine_impl.rs — конфликт.
git cherry-pick 7be2a78012
# model_resolution.rs — конфликт. test_support.rs — конфликт.
git cherry-pick 7e2f9c2d5d
# worker/turn.rs — конфликт. coalescer — конфликт.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-daemon -p pa-ai -- -D warnings
cargo check --workspace
```

## Этап 12: Bash behavior port

Коммиты: #45 (7012a2992d)

**Тяжёлый этап — /local-review.**

```
git cherry-pick 7012a2992d
# КОНФЛИКТЫ:
#   usage.md — upstream удалил "await commands" правило (#3511).
#     Fork ослабляет это правило (разрешает один re-await после degraded bash).
#     Внести fork-правку поверх upstream usage.md (правило уже удалено upstream,
#     fork-правка может быть избыточна — проверить).
#   bash.py — upstream изменил: yield_after → _YIELD_AFTER_SECONDS, удалил
#     _effective_yield_after, изменил BashHandle.__init__.
#     Fork удаляет _MAX_DEGRADE_HINTS cap. Адаптировать к новой bash.py.
#   prompt_guards.rs — upstream изменил.
#   test_bash.py — upstream изменил.
```

### Port 
 handling и nonzero-exit логики из удалённых Rust-файлов в Python runtime

Коммиты #5 (f0be750ecb), #33 (5922a5446a), #34 (2b94ea52c7), #35 (e41d7f4cc3)
изменяли `bash.rs` и `output_accumulator.rs`, которые upstream удалил (#3823).
Логика переехала в `prime-agent-runtime/src/rlm/bash.py`.

Port выполняется вручную в рамках Этапа 12, после cherry-pick #45:

1. **Nonzero-exit как data, не tool error** (#5 f0be750ecb):
   В `bash.py` найти обработку exit code команды. Если bash-команда завершается с
   ненулевым кодом, возвращать результат как данные (BashResult с exit_code),
   а не как ошибку инструмента. Проверить, не сделал ли upstream этого сам.

2. **\r как line break** (#33 5922a5446a):
   В `bash.py` найти `append_decoded_text` (или аналог в новой версии).
   Убедиться, что lone `\r`, `\r\n`, и `\n` все обрабатываются как line breaks,
   чтобы progress bars (`B1 PASS\rB2 idle`) считались отдельными строками.
   Проверить upstream-версию bash.py — возможно, это уже исправлено.

3. **Streaming snapshot marker** (#33 5922a5446a):
   Проверить, что on_update в bash.py добавляет streaming marker,
   чтобы модель знала, что snapshot partial.

4. **_MAX_DEGRADE_HINTS removal** (#34 2b94ea52c7, #35 e41d7f4cc3):
   Fork удалял cap на degrade hints (было 3). В новой bash.py найти
   `_note_degrade` и проверить, есть ли cap. Если есть — убрать.

Каждое изменение в bash.py вносится в коммит #45 через `git commit --amend --no-edit`.
```
# После port:
git add prime-agent-runtime/src/rlm/bash.py
git commit --amend --no-edit
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-core -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-core --lib -- prompt_guard
```

## Этап 13: Misc fixes

Коммиты: #39 (72ab4e06ad), #44 (c15d4e0084)

```
git cherry-pick 72ab4e06ad
# acp/types.rs, wire_events.rs — upstream не менял. Clean.
git cherry-pick c15d4e0084
# acp/daemon.rs — конфликт.
```

**Проверка:**
```
cargo fmt --all
cargo clippy -p pa-daemon -- -D warnings
cargo check --workspace
```

## Этап 14: Финальная проверка

```
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

0 ошибок, 0 предупреждений. Pre-existing pa-telemetry/pa-tui clippy — игнорировать
(verified на чистом v0.10.3).

Дополнительно:
```
# Проверить, что upstream-нововведения не затёрты:
rg "rlm.end_turn" crates/pa-core/src/prompts/layers/core.md
rg "rlm.session.messages" crates/pa-core/src/prompts/layers/core.md
rg "cwd" crates/pa-core/src/prompts/layers/core.md
rg "_YIELD_AFTER_SECONDS" prime-agent-runtime/src/rlm/bash.py
# Проверить, что fork-возможности на месте:
rg "temperature" crates/pa-core/src/session_engine/rlm_host.rs
rg "bb_mirror" crates/pa-daemon/src/rlm_children/
rg "plan_code" crates/pa-core/src/session_engine/engine.rs
rg "session_mode" crates/pa-daemon/src/acp/config_options.rs
```

## Этап 15: Замена ветки

```
git branch -D local/v0.10.1-clean-old 2>/dev/null  # удалить старый backup если есть
git branch local/v0.10.1-clean-old local/v0.10.3-clean  # промежуточный rename
git branch -M local/v0.10.3-clean local/v0.10.3-clean  # финальное имя
```

push — только по явной команде.

## Сводка этапов

| Этап | Коммиты | Файлов | Конфликтов | /local-review |
|------|---------|--------|------------|---------------|
| 0 | — | — | — | — |
| 1 | 5 (#1,#2,#13,#21,#26) | ~36 | Cargo.toml, test files | нет |
| 2 | 3 (#6,#9,#16) | ~13 | minor | нет |
| 3 | 4 (#8,#17,#36,#38) | ~10 | openai_completions, agent.rs | нет |
| 4 | 2 (#4,#28) | 4 | core.md, usage.md HEAVY | **да** |
| 5 | 1 (#3) | 6 | rlm_host.rs, rlm_children HEAVY | **да** |
| 6 | 6 (#10,#15,#18,#19,#22,#25) | ~20 | acp/daemon.rs | нет |
| 7 | 6 (#23,#24,#29,#30,#46,#48) | ~15 | supervisor, worker_lifecycle | **да** |
| 8 | 1 (#11) | 53 | massive, many files | **да** |
| 9 | 4 (#12,#40,#42,#43) | ~45 | engine.rs, system_prompt.rs | **да** |
| 10 | 3 (#14,#27,#37) | ~25 | rlm_host.rs, rlm_children | **да** |
| 11 | 3 (#31,#32,#47) | ~8 | config_options, worker/turn | нет |
| 12 | 1 (#45) | ~5 | usage.md, bash.py | **да** |
| 13 | 2 (#39,#44) | ~4 | acp/daemon.rs | нет |
| 14 | — | — | финальная проверка | — |
| 15 | — | — | замена ветки | — |
| **Итого** | **42 cherry-pick** | | | **6 /local-review** |

## Пропущенные: 7 коммитов

| # | Hash | Причина |
|---|------|---------|
| 5 | f0be750ecb | bash.rs DELETED → port в bash.py отдельно |
| 7 | 1669b96188 | golden_replay.rs gutted, bash.json DELETED |
| 20 | b552022762 | .changes/ docs, no-op |
| 33 | 5922a5446a | bash.rs, output_accumulator.rs DELETED |
| 34 | 2b94ea52c7 | output_accumulator.rs DELETED |
| 35 | e41d7f4cc3 | output_accumulator.rs DELETED |
| 41 | 9345801a40 | merge commit |

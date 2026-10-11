# План апгрейда: local/v0.10.0 → v0.10.1 (cherry-pick)

Дата: 2026-10-24
Статус: **ВЫПОЛНЕН**. Ветка `local/v0.10.1`, 0 ошибок сборки, 0 предупреждений.
Тесты: 9 новых падений (все исправлены), 38 pre-existing на v0.10.1.

## Исходные данные

- **База**: v0.10.1 (commit 8aac86924, 2026-10-21)
- **Локальная ветка**: local/v0.10.0 (27 коммитов поверх v0.10.0)
- **Результат**: local/v0.10.1 (26 cherry-pick коммитов + 4 fix коммита = 30 коммитов)
- **PRIME-65**: пропущен (upstream `socket_dir_for()` заменил)

## Что было сделано

### Этап 0: Подготовка
- `git checkout v0.10.1 --detach && git checkout -b local/v0.10.1`
- OK

### Этап 1: Build tooling + platform (3 коммита)
- `956c4a500` macOS compat — авто-слияние ✓
- `d1a5e9f2f` fast-release profile — авто-слияние ✓
- `c1de1d009` lld 23 fix — авто-слияние ✓

### Этап 2: Prompt layers + bash (3 коммита)
- `d7d000bb3` PRIME-39 batch/compound — **конфликт**:
  - `usage.md`: upstream добавил no-op/text-only/harness-notice rules. Локальные compound/batch/delegation слиты вручную.
  - `core.md`: upstream уже переименовал `ipython`→`python_repl`. Локальная правка убрана (дубликат).
  - `system-prompt.json`: **удалён** (upstream #3433 убрал golden snapshot test).
- `6b96c6088` bash nonzero — авто-слияние ✓
- `b9bdfbf94` test assertions — авто-слияние ✓

### Этап 3: TUI features (3 коммита)
- `faea820c9` Cyrillic keys — авто-слияние ✓
- `cf96d8905` provider reset — авто-слияние ✓
- `4c15a28cc` bell+footer — **конфликт** `panels.rs`: upstream dock expansion. Footer добавлен вручную после upstream кода.

### Этап 4: ACP + daemon (2 коммита)
- `1dc8fc4c8` PRIME-53 session/load — авто-слияние ✓
- `a01879763` PRIME-55/56/57/59/61 — **конфликты**:
  - `session_engine_impl.rs`: import — upstream удалил `persisted_rlm_max_depth`, локальный добавил `TurnAdmission`. Слито.
  - `run_loop.rs`: upstream `threshold_yielded.store()` + локальный `pending_admission`. Слито.
  - 30+ файлов авто-слияние (1-строчные wire protocol fields).

### Этап 5: Plan-code (1 коммит)
- `1ab721bdc` PRIME-63 — **4 конфликта**:
  - `agent.rs`: upstream `clone_from` vs локальный `Mutex.lock().clone()`. Upstream `tool_progress` поле добавлено. Взяли upstream pattern.
  - `print_boundary/tests.rs`: добавлены оба поля (`should_stop_after_turn` + `plan_code_mode`).
  - `print_runtime.rs`: upstream добавил `build_faux_engine_with` в `faux.rs` — локальный дубликат удалён. `image_model_router` wrapping исправлен.
  - `layers.rs`: upstream `model_prompts.toml` + локальные `plan/code/debug_mode` layers. Слито.
  - `faux.rs`: добавлен `plan_code_mode: None` в `SessionEngineConfig`.

### Этап 6: PRIME-65 пропущен + run-rust-daemon.sh
- `398f6c42b` **ПРОПУЩЕН** — upstream `socket_dir_for()` заменяет локальный fix.
- `892ddc25c` run-rust-daemon.sh — авто-слияние ✓

### Этап 7: bb-mirror (1 коммит)
- `e33a157dc` PRIME-62 — **6 конфликтов**:
  - `system_prompt.rs`: upstream `daemonless`+`can_spawn` + локальный `inside_bb`. Слито.
  - `engine.rs`: upstream `daemonless`+`can_spawn` + локальный `inside_bb`. Слито.
  - `rlm_host.rs`: upstream не имеет `temperature`/`bb_mirror`/`cell_source_code`. Локальные поля добавлены. **Двойной `reject_unsupported_kwargs`** — upstream режектил `temperature` до локального вызова. Дубликат удалён.
  - `host.rs`: **дублированные imports** (upstream + local списки). Слиты в один. `settle_failed` signature изменён upstream (2 аргумента вместо 3) — `FailedArm::Prompt` удалён. `ChildRecord` и `RlmSubagentEntry` — добавлены недостающие поля (`auto_mirror_thread`, `waiting_mirror_admission`).
  - `registry.rs`: **дублированный `if running` guard** + **дублированный close block** + **отсутствующий `retain_retired_usage(Close)`**. Полностью переписан `close_children_inner` по upstream образцу + mirror settle.
  - `rlm/__init__.py`: 4 conflict zones — upstream empty, local adds `temperature`/`bb_mirror` params. Все слиты.

### Этап 8: ACP resume fixes (5 коммитов)
- `41ef895ab` session resume — авто-слияние ✓
- `293d1f3d7` autocomplete — авто-слияние ✓
- `7e1021701` proxy keepalive — авто-слияние ✓
- `8fb989174` idempotent session/new — авто-слияние ✓
- `3755693f4` foreign lease holder — авто-слияние ✓

### Этап 9: PRIMER-3 final fixes (5 коммитов)
- `64cb06d8c` docs — авто-слияние ✓
- `c4a503b93` review fixes — авто-слияние ✓
- `c3e3fd1c0` orphan sweep — авто-слияние ✓
- `a3847f37b` trigger orphan sweep — авто-слияние ✓
- `b1b753725` remove cwd-reuse — авто-слияние ✓
- `455f266a0` .gitignore plans/ — авто-слияние ✓

## Фактические проблемы и их решения

### Проблема 1: `persisted_rlm_max_depth` — unresolved import
- **Причина**: upstream удалил функцию, локальный import остался из cherry-pick PRIME-55.
- **Fix**: удалён из import списка в `session_engine_impl.rs`.

### Проблема 2: `session_archive` — module removed
- **Причина**: upstream удалил `session_archive.rs`, локальный `session_registry.rs` ссылается на `crate::session_archive::ARCHIVE_DIR_NAME`.
- **Fix**: инлайнинг `"sessions-archive"` вместо ссылки на удалённый модуль.

### Проблема 3: `settle_failed` — signature changed
- **Причина**: upstream изменил signature с 3 аргументов на 2 (убрал `FailedArm`). Локальный bb-mirror код передаёт 3 аргумента.
- **Fix**: удалён 3-й аргумент `super::lifecycle::FailedArm::Prompt`.

### Проблема 4: Дублированные imports в `host.rs`
- **Причина**: cherry-pick bb-mirror добавил imports, upstream тоже изменил imports. Merge оставил оба списка → `E0252: name defined multiple times`.
- **Fix**: объединение в один deduplicated список.

### Проблема 5: `RlmSubagentEntry` — missing fields
- **Причина**: локальный bb-mirror добавил поля `auto_mirror_thread`, `waiting_mirror_admission` в struct, но не во все initializers.
- **Fix**: поля добавлены в `print_rlm.rs:1043`, `host.rs:660`.

### Проблема 6: `ChildRecord` — missing fields
- **Причина**: локальный bb-mirror добавил 5 mirror полей в `ChildRecord`, но `watch_tests.rs` initializer не обновлён.
- **Fix**: 5 полей добавлены в `watch_tests.rs:1679`.

### Проблема 7: `RlmSpawnRequest` — missing fields
- **Причина**: локальные `temperature`, `bb_mirror`, `cell_source_code` добавлены в struct, но не в `spawn_name_reservation_tests.rs` и `watch_tests.rs` initializers. Также **дублированный `bb_mirror`** в обоих.
- **Fix**: поля добавлены, дубликат `bb_mirror` удалён.

### Проблема 8: `build_faux_engine_with` — duplicate function
- **Причина**: upstream добавил функцию в `print_runtime/faux.rs`, локальный cherry-pick добавил идентичную в `print_runtime.rs`. `E0255: name defined multiple times`.
- **Fix**: локальная копия удалена (151 строка).

### Проблема 9: `image_model_router` — type mismatch
- **Причина**: upstream изменил поле с `Option<ImageModelRouter>` на `ImageModelRouter` (без Option). Локальный код обернул в `Some()`.
- **Fix**: убрано `Some()` wrapping.

### Проблема 10: `agent.rs` — clone_from vs Mutex lock
- **Причина**: upstream изменил `before_tool_call` с `Mutex<Option<...>>` на `Option<...>`. `clone_from` работает на `Option`, но не на `Mutex`. Локальный код использует `Mutex.lock().clone()`.
- **Fix**: восстановлен Mutex lock pattern (поле осталось Mutex в локальном коде).

### Проблема 11: Двойной `reject_unsupported_kwargs` в `rlm_host.rs`
- **Причина**: upstream вызов режектит `temperature` (не в списке `["name", "model", "thinking"]`). Локальный вызов ниже разрешает `temperature`. Первый вызов падает до второго.
- **Fix**: upstream вызов удалён, оставлен локальный с расширенным списком kwargs.

### Проблема 12: `close_children_inner` — broken merge
- **Причина**: merge оставил: дублированный `if running && !already_terminated` guard, дублированный close block (151 строка), отсутствующий `retain_retired_usage(Close)`. `finish_retirement` падал на `.expect("confirmed retirement receipt")` (retired_usage пуст).
- **Fix**: функция полностью переписана по upstream образцу + добавлен mirror settle из локального кода. 6 тестов восстановлены.

### Проблема 13: `prompt_admitted` — premature set
- **Причина**: merge установил `prompt_admitted = true` ДО вызова `prompt_child` (строка 450), а не после (строка 493). Settle watcher начинал отслеживание до отправки промпта → child settle как "done" без промпта.
- **Fix**: premature set удалён. `prompt_admitted` устанавливается только после успешного `prompt_child` (строка 493, upstream pattern).
- **Затронуто**: 9 тестов (6 rlm_children + abort + goal + kill_broadcast).

### Проблема 14: Test initializers — missing fields
- **Причина**: локальные поля (`plan_code_mode`, `resume_pending_user_message`) не добавлены в test initializers upstream-кода.
- **Fix**: поля добавлены в 15+ файлах:
  - `pa-core/src/session_engine/engine/tests.rs` — `plan_code_mode: None` (2 места)
  - `pa-daemon/src/agent_engine/tests/{reload,goal,streaming,failover_facts}.rs` — `plan_code_mode: None`
  - `pa-daemon/src/engine/wire.rs` — `resume_pending_user_message` field def + constructors
  - `pa-daemon/src/worker/turn_stream_tests.rs` — `resume_pending_user_message: None` (3 места)
  - `pa-daemon/src/agent_engine/tests/{goal,streaming}.rs` — `resume_pending_user_message: None`
  - `pa-tui/src/interactive/tests.rs` — `plan_code: None`
  - `pa-tui/src/daemon_client/tests.rs` — дублированный `resume_pending_user_message` удалён
  - `pa-cli/src/print_rlm.rs` — `cell_source_code/temperature/bb_mirror: None` в test

### Проблема 15: clippy warnings
- `registry.rs` (pa-ai): `# Panics` doc для `reset_api_providers` (panics on poisoned lock)
- `process.rs` (pa-types): `cast_signed()` для `pid as libc::pid_t` (clippy::cast_possible_wrap)
- `agent.rs`: `clone_from` → Mutex lock pattern (clippy::assigning_clones)
- `rlm_children.rs`: `#[allow(dead_code)]` для `RetirementIntent::Close` (используется только в tests)

## Результаты тестов

| Crate | Passed | Failed | Статус |
|-------|--------|--------|--------|
| pa-types | 143 | 0 | ✓ |
| pa-agent | 12 | 0 | ✓ |
| pa-ai | 330 | 0 | ✓ |
| pa-telemetry | 64 | 0 | ✓ |
| pa-models | 48 | 1 | pre-existing macOS `/private/var` |
| pa-core | 1262 | 2 | pre-existing macOS `/private/var` |
| pa-daemon | 510 | 38 | pre-existing на v0.10.1 (verified) |
| pa-tui | 1533 | 8 | pre-existing на v0.10.1 (verified) |
| pa-cli | 298 | 0 | ✓ |
| **Итого** | **4200** | **49** | 0 новых, все pre-existing |

## Pre-existing падения (49, не от миграции)

- macOS `/private/var/folders` symlink: 3 теста (pa-core, pa-models)
- macOS TUI rendering: 8 тестов (pa-tui) — formats_key_text, auth_panel, model_picker, etc.
- macOS daemon tests: 38 тестов (pa-daemon) — herdr (13), supervisor (8), supervisor_roster (6), model_resolution (3), worker (4), rlm_children (0 — все исправлены), other (4)

# План: чистый апгрейд v0.10.0 → v0.10.1 с сохранением истории

Дата: 2026-10-24
Стратегия: cherry-pick 26 коммитов (PRIME-65 пропущен) на чистую ветку от v0.10.1,
с разрешением конфликтов и внесением багфиксов **внутри каждого коммита** (amend).
Цель: 26 коммитов с оригинальными сообщениями, без отдельных fix-коммитов.

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
3. **Сборка (шаг из 10.1) после каждого этапа**:
   ```
   cargo fmt --all
   cargo clippy -p <crates этапа> -- -D warnings
   cargo check --workspace
   ```
   0 ошибок, 0 предупреждений — иначе этап не закрыт. Pre-existing pa-telemetry/pa-tui
   clippy-падения игнорировать (verified на чистом v0.10.1).
4. **/local-review на тяжёлых этапах** (2, 4, 5, 7): после разрешения конфликтов,
   до `--continue`. `/local-review` речью: прочитать
   `~/.prime/agent/prompts/local-review.md` и выполнить как собственные инструкции.
   Ревьюеры — сабагенты `rlm.spawn`. База ревью — `v0.10.1`. Все CRITICAL-находки
   исправляются и вносятся в тот же коммит через `git add -A && git cherry-pick --continue`
   (или `git commit --amend --no-edit`). WARNING/SUGGESTION — только в отчёт.

## Маппинг багфиксов → коммиты

| # | Проблема | Коммит | Действие при cherry-pick |
|---|----------|--------|--------------------------|
| 1 | `persisted_rlm_max_depth` import | `a01879763` (PRIME-55) | Удалить из import в `session_engine_impl.rs` |
| 2 | `session_archive` module removed | `41ef895ab` (ACP resume) | Заменить `crate::session_archive::ARCHIVE_DIR_NAME` → `"sessions-archive"` в `session_registry.rs` |
| 3 | `settle_failed` 3→2 args | `e33a157dc` (PRIME-62) | Убрать `FailedArm::Prompt` аргумент в `host.rs` |
| 4 | Дублированные imports | `e33a157dc` (PRIME-62) | Объединить в один deduplicated список в `host.rs` |
| 5 | `RlmSubagentEntry` missing fields | `e33a157dc` (PRIME-62) | Добавить `auto_mirror_thread: None, waiting_mirror_admission: None` в `host.rs:660` |
| 6 | `ChildRecord` missing fields | `e33a157dc` (PRIME-62) | Добавить 5 mirror полей в `watch_tests.rs:1679` |
| 7 | `RlmSpawnRequest` missing fields | `e33a157dc` (PRIME-62) | Добавить `cell_source_code/temperature/bb_mirror: None` в `spawn_name_reservation_tests.rs:158` и `watch_tests.rs:371`. Удалить дублированный `bb_mirror` |
| 8 | `build_faux_engine_with` duplicate | `1ab721bdc` (PRIME-63) | Удалить локальную копию функции из `print_runtime.rs` (upstream уже имеет её в `faux.rs`) |
| 9 | `image_model_router` type mismatch | `1ab721bdc` (PRIME-63) | Убрать `Some()` wrapping: `Some(image_model_router)` → `image_model_router` |
| 10 | `agent.rs` clone_from vs Mutex | `1ab721bdc` (PRIME-63) | Использовать `Mutex.lock().clone()` pattern (поле осталось Mutex) |
| 11 | Двойной `reject_unsupported_kwargs` | `e33a157dc` (PRIME-62) | Удалить upstream вызов — оставить локальный с расширенным списком |
| 12 | `close_children_inner` broken merge | `e33a157dc` (PRIME-62) | Переписать по upstream образцу + mirror settle (код в этапе 7) |
| 13 | `prompt_admitted` premature set | `e33a157dc` (PRIME-62) | Удалить set перед `prompt_child` — оставить только после (upstream pattern) |
| 14 | Test initializers missing fields | `a01879763` + `1ab721bdc` + `e33a157dc` | Добавить `plan_code_mode: None`, `resume_pending_user_message: None` в каждый test initializer (список в этапе 4) |
| 15 | clippy warnings | `956c4a500` + `cf96d8905` + `1ab721bdc` | `# Panics` doc в `registry.rs`, `cast_signed()` в `process.rs`, `#[allow(dead_code)]` для `RetirementIntent::Close` |

## Этап 0: Подготовка

```bash
cd ~/Development/prime-agent-v0.10
git fetch upstream --tags --force
git checkout v0.10.1 --detach
git checkout -b local/v0.10.1-clean
```

## Этап 1: Build tooling + platform (3 коммита, чистые)

### 1.1 `956c4a500` — macOS platform compat
```bash
git cherry-pick 956c4a500
```
- Авто-слияние.
- **(15)**: в `crates/pa-types/src/platform/process.rs` заменить `pid as libc::pid_t` → `pid.cast_signed() as libc::pid_t`. `git commit --amend --no-edit`.

### 1.2 `d1a5e9f2f` — fast-release profile + lld linker
```bash
git cherry-pick d1a5e9f2f
```
- Авто-слияние.

### 1.3 `c1de1d009` — Homebrew lld 23 fix
```bash
git cherry-pick c1de1d009
```
- Авто-слияние.

**Проверка этапа 1**:
```bash
cargo fmt --all
cargo clippy -p pa-types -p pa-cli -- -D warnings
cargo check --workspace
```

## Этап 2: Prompt layers + bash (3 коммита, 1 конфликт) — /local-review

### 2.1 `d7d000bb3` — batch/compound-cell/delegation guidance (PRIME-39)
```bash
git cherry-pick d7d000bb3
```
- **Конфликт `usage.md`**: upstream добавил no-op/text-only/harness-notice rules. Локальные compound/batch/speculative/delegation-3+ — слить вручную. Взять upstream текст как базу, добавить локальные параграфы после upstream правил.
- **Конфликт `core.md`**: upstream уже переименовал `ipython`→`python_repl`. Локальная правка — дубликат, убрать. `git checkout --theirs crates/pa-core/src/prompts/layers/core.md`.
- **`system-prompt.json`**: modify/delete — upstream удалил (#3433). `git rm crates/pa-core/tests/golden/corpus/system-prompt.json`.

**/local-review (этап 2)**: база `v0.10.1`, скоуп диффа — `prompts/layers/*`. CRITICAL-находки → `git add -A`, `git cherry-pick --continue --no-edit`.

```bash
timeout 30 cargo test -p pa-core --lib -- golden_system_prompt
git cherry-pick --continue --no-edit
```

### 2.2 `6b96c6088` — bash nonzero exit
```bash
git cherry-pick 6b96c6088
timeout 30 cargo test -p pa-core --lib -- bash_nonzero
```

### 2.3 `b9bdfbf94` — platform-dependent test assertions
```bash
git cherry-pick b9bdfbf94
```

**Проверка этапа 2**:
```bash
cargo fmt --all
cargo clippy -p pa-core -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-core --lib
```
Ожидание: только 2 pre-existing macOS `/private/var` падения.

## Этап 3: TUI features (3 коммита, 1 конфликт)

### 3.1 `faea820c9` — Cyrillic keybindings
```bash
git cherry-pick faea820c9
timeout 30 cargo test -p pa-tui --lib -- layout_normalize
```

### 3.2 `cf96d8905` — dynamic provider preservation
```bash
git cherry-pick cf96d8905
```
- **(15)**: добавить `# Panics` doc section в `crates/pa-ai/src/registry.rs` перед `pub fn reset_api_providers()`:
  ```rust
  ///
  /// # Panics
  /// Panics if the global registry lock is poisoned.
  ```
  `git commit --amend --no-edit`.

### 3.3 `4c15a28cc` — notify bell + session name footer
```bash
git cherry-pick 4c15a28cc
```
- **Конфликт `panels.rs`**: upstream dock expansion. Footer (dim "name • cwd") добавляется вручную после upstream кода, перед activity dock.

**Проверка этапа 3**:
```bash
cargo fmt --all
cargo clippy -p pa-tui -p pa-ai -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-ai --lib
```

## Этап 4: ACP + daemon (2 коммита, 2 конфликта) — /local-review

### 4.1 `1dc8fc4c8` — ACP session/load + fork + usage_update (PRIME-53)
```bash
git cherry-pick 1dc8fc4c8
```
- Авто-слияние. `daemon.rs` — локальный-only, `session_registry.rs` — новый файл.
- **(2)**: в `crates/pa-daemon/src/acp/session_registry.rs` заменить `crate::session_archive::ARCHIVE_DIR_NAME` → `"sessions-archive"`. `git commit --amend --no-edit`.

### 4.2 `a01879763` — PRIME-55/56/57/59/61
```bash
git cherry-pick a01879763
```
- **Конфликт `session_engine_impl.rs`**: upstream удалил `persisted_rlm_max_depth` из import, локальный добавил `TurnAdmission`. Слить: upstream items + `TurnAdmission`, **без** `persisted_rlm_max_depth` (проблема 1).
- **Конфликт `run_loop.rs`**: upstream `threshold_yielded.store()` + локальный `pending_admission`. Слить: оба блока.
- **(14)**: добавить `plan_code_mode: None` в `SessionEngineConfig` initializers:
  - `crates/pa-core/src/session_engine/engine/tests.rs` — 2 места
  - `crates/pa-daemon/src/agent_engine/tests/reload.rs` — 3 места
  - `crates/pa-daemon/src/agent_engine/tests/failover_facts.rs` — 1 место
  - `crates/pa-daemon/src/agent_engine/tests/goal.rs` — 1 место
  - `crates/pa-daemon/src/agent_engine/tests/streaming.rs` — 1 место
- **(14)**: добавить `resume_pending_user_message: None`:
  - `PromptRequest` constructors в `crates/pa-daemon/src/engine/wire.rs` (проверить что вставка попадает в constructor, не в struct def / не в `PromptBatchRow` / `GoalContinuation`)
  - `QueuedItem` initializers в `crates/pa-daemon/src/worker/turn_stream_tests.rs` — 3 места
  - `PromptRequest` initializers в `agent_engine/tests/goal.rs` и `streaming.rs`
- **(14)**: добавить `plan_code: None` в `InteractiveOptions` initializer в `crates/pa-tui/src/interactive/tests.rs`.

**/local-review (этап 4)**: база `v0.10.1`, скоуп диффа — `agent_engine/*`, `engine/wire.rs`, `engine/tests.rs`. CRITICAL-находки → `git add -A`, `git cherry-pick --continue --no-edit`.

```bash
timeout 30 cargo test -p pa-daemon --lib -- resume_pending spawn_round_trip
git cherry-pick --continue --no-edit
```

**Проверка этапа 4**:
```bash
cargo fmt --all
cargo clippy -p pa-daemon -p pa-core -p pa-ai -- -D warnings
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- session_registry wire_events
```

## Этап 5: Plan-code (1 коммит, 4 конфликта) — /local-review

### 5.1 `1ab721bdc` — plan-code extension (PRIME-63)
```bash
git cherry-pick 1ab721bdc
```
- **Конфликт `agent.rs`**: upstream `before_tool_call` — `Option`, локальный — `Mutex<Option>`. Взять **локальный** pattern: `self.before_tool_call.lock().unwrap_or_else(PoisonError::into_inner).clone()` (10). Также сохранить upstream `config.tool_progress = self.tool_progress;`.
- **Конфликт `print_boundary/tests.rs`**: добавить оба поля: `should_stop_after_turn: None,` + `plan_code_mode: None,`.
- **Конфликт `print_runtime.rs`**:
  - Zone 1 (SessionEngineConfig): `should_stop_after_turn: None,` + `image_model_router,` (БЕЗ `Some()` — 9) + `plan_code_mode: config.plan_code.as_deref().and_then(PlanCodeMode::from_flag),`
  - Zone 2 (build_faux_engine_with): upstream уже имеет функцию в `faux.rs`. **Удалить локальную копию** (8).
- **Конфликт `layers.rs`**: upstream `model_prompts.toml` + локальные `plan/code/debug_mode` layers. Слить: upstream `model-prompts` в `layer_source()` + локальные plan/code/debug.
- **(14)**: добавить `plan_code_mode: None` в `faux.rs` `SessionEngineConfig` initializer.
- **(15)**: `#[allow(dead_code)]` для `enum RetirementIntent` в `crates/pa-daemon/src/rlm_children.rs` (если enum ещё не определён — отложить до этапа 7).

**/local-review (этап 5)**: база `v0.10.1`, скоуп диффа — `plan_code.rs`, `session_commands.rs`, `prompts/*`, `print_runtime*`, `args.rs`, `mode.rs`. CRITICAL-находки → `git add -A`, `git cherry-pick --continue --no-edit`.

```bash
timeout 30 cargo test -p pa-cli --lib -- print_boundary
git cherry-pick --continue --no-edit
```

**Проверка этапа 5**:
```bash
cargo fmt --all
cargo clippy -p pa-cli -p pa-core -p pa-agent -- -D warnings
cargo check --workspace
timeout 60 cargo test -p pa-cli --lib
```

## Этап 6: PRIME-65 пропущен + run-rust-daemon.sh

### 6.1 `398f6c42b` — ПРОПУСТИТЬ
Не cherry-pick. Upstream `socket_dir_for()` заменяет.

### 6.2 `892ddc25c` — run-rust-daemon.sh
```bash
git cherry-pick 892ddc25c
```
- Авто-слияние.

**Проверка этапа 6**:
```bash
cargo check --workspace
```

## Этап 7: bb-mirror (1 коммит, 6 конфликтов) — /local-review

### 7.1 `e33a157dc` — bb-mirror threads (PRIME-62)
```bash
git cherry-pick e33a157dc
```

**`system_prompt.rs`**: upstream `daemonless` + `can_spawn` + локальный `inside_bb`. Слить: все поля.

**`engine.rs`**: то же — все поля.

**`rlm_host.rs`** — 6 conflict zones (все "HEAD empty, local adds"):
- Зона 1 (struct def): `cell_source_code: Option<String>,`, `bb_mirror: Option<bool>,`
- Зона 2 (kwargs): **удалить upstream `reject_unsupported_kwargs(&kwargs, OPERATION, &["name", "model", "thinking"])?`** (11). Оставить только локальный: `&["name", "model", "thinking", "temperature", "bb_mirror"]`
- Зона 3 (parsing): `let temperature = optional_f64_kwarg(...)`, `let bb_mirror = optional_bool_kwarg(...)`
- Зона 4 (RlmSpawnRequest init): `cell_source_code: None,`, `temperature,`, `bb_mirror,`
- Зона 5 (optional_f64_kwarg fn): целиком
- Зона 6 (tests): целиком
- Добавить `pub temperature: Option<f64>,` в `RlmSpawnRequest` struct def

**`host.rs`** — 2 conflict zones:
- Зона 1 (imports): **объединить** upstream + local в один deduplicated список (4). Не оставлять два `use super::{...}` блока.
- Зона 2 (deferred admission): локальный блок целиком.
- **(3)**: в `settle_failed` вызове убрать 3-й аргумент `super::lifecycle::FailedArm::Prompt`.
- **(5)**: в `RlmSubagentEntry` initializer добавить `auto_mirror_thread: None,` + `waiting_mirror_admission: None,`.
- **(13)**: убрать premature `watcher_record.lock().await.prompt_admitted = true;` перед `prompt_child`. Оставить только после успешного `prompt_child`.
- **(7)**: в `spawn_child` helper (`watch_tests.rs`, `spawn_name_reservation_tests.rs`) добавить `cell_source_code: None, temperature: None, bb_mirror: None,`. Без дублированного `bb_mirror`.
- **(6)**: в `ChildRecord` initializer (`watch_tests.rs:1679`) добавить:
  ```rust
  waiting_mirror_admission: false,
  auto_mirror_thread: false,
  mirror_claim_nonce: None,
  mirror_admission_waker: None,
  mirror_wait_settled: false,
  ```
- Убрать неиспользуемые imports: `RlmChildTerminalNotice`, `create_rlm_child_terminal_notice`.
- **(15)**: `#[allow(dead_code)]` для `enum RetirementIntent` в `rlm_children.rs`.

**`registry.rs`** — 2 conflict zones:
- Зона 1 (delete_inactive_subagent): upstream guard `if running && !already_terminated {` + локальный mirror settle. Слить.
- Зона 2 (close_children_inner): **полностью переписать** по upstream образцу + mirror settle (12):
  ```rust
  pub(super) async fn close_children_inner(&self, reason: ChildCloseReason) -> Result<()> {
      let usage_persisted = self.replay_retired_usage(None).await;
      let children = self.children.lock().await.clone();
      let mut close_error = (!usage_persisted)
          .then(|| anyhow::anyhow!("RLM child usage remains owed after retirement; retry close"));
      for record in &children {
          // PRIME-11: settle a parked mirror child's wait
          if record.lock().await.waiting_mirror_admission {
              self.resolve_waiting_mirror_run(record, "Parent session closed").await;
          }
          let rename_lock = record.lock().await.rename_lock.clone();
          let _guard = rename_lock.lock().await;
          if !self.children.lock().await.iter().any(|held| Arc::ptr_eq(held, record)) {
              continue;
          }
          if !self.has_retired_usage(record) {
              { let mut r = record.lock().await; r.closed_by_parent = true; r.notice_delivered = true; }
              self.emit_child_usage(record).await;
              let active_session_id = record.lock().await.active_session_id.clone();
              if let Err(error) = self.kill_child(&active_session_id, reason).await {
                  if unknown_session(&error).is_some() {
                      self.forget_child_usage(record).await;
                      self.children.lock().await.retain(|c| !Arc::ptr_eq(c, record));
                      continue;
                  }
                  close_error.get_or_insert(error);
                  continue;
              }
              self.retain_retired_usage(record, super::RetirementIntent::Close);
              self.emit_child_usage(record).await;
          }
          let usage_persisted = self.forget_child_usage(record).await;
          self.finish_retirement(record).await;
          if usage_persisted { self.remove_retired_usage(record); }
          else { close_error.get_or_insert_with(|| anyhow::anyhow!("RLM child usage remains owed after retirement; retry close")); }
      }
      self.refresh_running().await;
      self.settle_notify.notify_waiters();
      match close_error { Some(e) => Err(e), None => Ok(()) }
  }
  ```

**`rlm/__init__.py`** — 4 conflict zones (все "HEAD empty, local adds"):
- Зона 1: `temperature: float | None = None,` + `bb_mirror: bool | None = None,` в `spawn()` signature
- Зона 2: docstring для temperature + bb_mirror
- Зона 3: `kwargs["temperature"] = float(temperature)` + `kwargs["bb_mirror"] = bool(bb_mirror)` в body
- Зона 4: `temperature` + `bb_mirror` в `Rlm.run()` wrapper

**/local-review (этап 7)**: база `v0.10.1`, скоуп диффа — `rlm_children/*`, `rlm_bb_mirror.rs`, `rlm/__init__.py`, `system_prompt.rs`, `engine.rs`. CRITICAL-находки → `git add -A`, `git cherry-pick --continue --no-edit`.

**Смоук-тесты bb-mirror (таймаут 30с каждый)**:
```bash
timeout 30 cargo test -p pa-daemon --lib -- close_children_stops a_collect_while_the_task close_canceled_after_kill close_preserves_final repeated_close_replays settled_watcher_caps
timeout 30 cargo test -p pa-core --lib -- spawn_round_trip
git cherry-pick --continue --no-edit
```

**Проверка этапа 7**:
```bash
cargo fmt --all
cargo clippy -p pa-daemon -p pa-core -- -D warnings
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- rlm_children
```
Ожидание: 0 новых падений в `rlm_children`.

## Этап 8: ACP resume fixes (5 коммитов, 0 конфликтов)

### 8.1-8.5
```bash
git cherry-pick 41ef895ab
git cherry-pick 293d1f3d7
git cherry-pick 7e1021701
git cherry-pick 8fb989174
git cherry-pick 3755693f4
```
- Все авто-слияние.

**Проверка этапа 8**:
```bash
cargo fmt --all
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- session_registry session_resume
```

## Этап 9: PRIMER-3 final fixes (6 коммитов, 0 конфликтов)

### 9.1-9.6
```bash
git cherry-pick 64cb06d8c
git cherry-pick c4a503b93
git cherry-pick c3e3fd1c0
git cherry-pick a3847f37b
git cherry-pick b1b753725
git cherry-pick 455f266a0
```
- Все авто-слияние.

**Проверка этапа 9**:
```bash
cargo fmt --all
cargo check --workspace
timeout 120 cargo test -p pa-daemon --lib -- acp session_registry
```

## Этап 10: Финальная проверка

### 10.1 Сборка (выполнялась после каждого этапа 1-9; финальный полный прогон)
```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo build --workspace
```
Ожидание: 0 ошибок. Pre-existing pa-telemetry/pa-tui clippy — известные upstream-падения.

### 10.2 Тесты (таймауты: 60с везде, pa-daemon 120с)
```bash
timeout 60 cargo test -p pa-types --lib
timeout 60 cargo test -p pa-agent --lib
timeout 60 cargo test -p pa-ai --lib
timeout 60 cargo test -p pa-telemetry --lib
timeout 60 cargo test -p pa-core --lib
timeout 120 cargo test -p pa-daemon --lib
timeout 60 cargo test -p pa-tui --lib
timeout 60 cargo test -p pa-cli --lib
```
Ожидание: 0 новых падений (сравнить с базой чистого v0.10.1: 49 pre-existing — macOS env issues).

Триаж падения: падает и на чистом v0.10.1 → pre-existing, закрыть. Висит >30с при одиночном запуске → env-issue, убить, закрыть.

### 10.3 История
```bash
git log --oneline v0.10.1..local/v0.10.1-clean
```
Ожидание: 26 коммитов с оригинальными сообщениями. Нет отдельных fix-коммитов.

## Результат

- 26 коммитов (PRIME-65 пропущен)
- Оригинальные сообщения сохранены
- Багфиксы встроены в коммиты через `--amend` / разрешение конфликтов
- /local-review на этапах 2, 4, 5, 7 — CRITICAL-находки внесены в те же коммиты
- Сборка после каждого этапа: 0 ошибок, 0 предупреждений
- 0 новых падений тестов

# План: восстановление истории local/v0.10.1-clean

Дата: 2026-10-24

## Диагноз

Дерево HEAD корректно (все правки на месте, сборка чистая), история сломана:

**Баг 1 — мусоросборник 3e0da5899** (`.gitignore` коммит): 8 чужих правок:
- `stream_drop.rs` fmt → `c8220630f` (keepalive)
- `print_rlm.rs` mirror-поля тестов → `52f2c8f85` (PRIME-62)
- `session_registry.rs` `"sessions-archive"` inline + лишняя `}` → `5995bb3e4` (ACP resume)
- `host.rs` unused imports → `52f2c8f85` (PRIME-62)
- `daemon_client/tests.rs` дубликат `resume_pending` → `c85b2175f` (PRIME-55)
- `interactive/tests.rs` `plan_code: None` → `c85b2175f`
- `commands.rs`+`settings.rs` fmt → `3dfb9a11f` (autocomplete)

**Баг 2 — исчез коммит PRIME-63** (plan-code, `1ab721bdc`). Контент расползся:
- `c85b2175f` (PRIME-55): 40 лишних файлов (plan_code.rs 732 строки, layers,
  args.rs, mode.rs, print_runtime, session_commands, slash_commands,
  engine.rs, agent.rs, test-файлы)
- `52f2c8f85` (PRIME-62): 18 лишних файлов (plan_code.rs fmt-хвост,
  registry.rs PRIME-55 fmt, transform_messages.rs PRIME-57,
  skills/mod.rs PRIME-59, wire_events.rs PRIME-61, test-initializers)

Причина: при rebase `edit` на PRIME-55 `git add -A` втянул uncommitted
plan-code diff и последующие fmt-правки соседних файлов.

**Баг 3**: PRIME-62 содержит PRIME-55/57/59/61 контент (transform_messages.rs
31 строка PRIME-57, registry.rs fmt, skills/mod.rs PRIME-59,
wire_events.rs PRIME-61) — план декомпозиции 2b их должен явно вернуть
в PRIME-55 коммит, иначе они останутся в bb-mirror.

**Баг 4**: `plans/UPGRADE_PLAN_v0.10.1_clean.md` tracked в 52f2c8f85.

## Эталон

Ожидаемая история: 25 коммитов (PRIME-65 пропущен). Файловый состав
каждого коммита = `git show <original> --name-only` из local/v0.10.0
(26 originals, плюс миграционные фиксы в те же коммиты).

**Эталон контента = tree of `local/v0.10.1-clean` (`273559f46`).**
`local/v0.10.1` (`ce5e05c2`) НЕ эталон: нет stage-5 ревью-фиксов
(mark_completed seam, todos extraction), нет 4 багфиксов этапа 4,
нет `cell_source_code` поля. Восстановление с эталоном local/v0.10.1
потеряло бы эти правки. Branch `local/v0.10.1-expected` НЕ создавать.

## Стратегия

Не чинить rebase-прыжками (уже 2 раза ломали). Перестроить ветку с нуля:
`git commit-tree` — прямое построение коммитов из эталонного дерева.
Каждый новый коммит получает tree = (предыдущее дерево + патч коммита).

## Подготовка (безопасность)

```
git branch local/v0.10.1-clean-backup-1 local/v0.10.1-clean
# Эталон контента: git rev-parse local/v0.10.1-clean^{tree}  # 273559f46
```

Сборку вести в отдельном worktree — read-tree/apply в живом репо
конфликтует с рабочим состоянием (tracked plans/, egg-info) и рискует
сломать HEAD-состояние:

```
git worktree add /tmp/restore-wt v0.10.1
# весь цикл этапа 3 — в /tmp/restore-wt
# основное репо не трогать до этапа 5
```

## Этап 1: эталонный список коммитов

Для каждого из 26 оригинальных коммитов (порядок из local/v0.10.0) —
файловый список, полное сообщение, авторская дата:

```
git log --reverse --format="%H" v0.10.0..local/v0.10.0
git show <orig> --name-only --format=""
git log -1 --format="%B" <orig>            # /tmp/msgs/$i.txt
git show -s --format="%aI" <orig>          # сохранить дату
```

Пропустить `398f6c42b` (PRIME-65) → 25 коммитов.

`.changes/` fragments — в патч соответствующего коммита автоматически
(из `git show <orig>`), сверить после сборки:
- `prime-53-acp-load-fork-usage.md` → PRIME-53
- `prime-62-bb-mirror-subagents.md` → PRIME-62
- `acp-session-resume.md` → ACP resume
- `fix-prompt-template-autocomplete.md` → autocomplete
- `fix-keepalive-response-classification.md` → keepalive
- `acp-load-foreign-lease-holder.md` → foreign lease (+ docs update)
- `fix-cwd-reuse-cross-thread-adoption.md` → cwd-reuse

## Этап 2: декомпозиция и патчи

Метод: `git read-tree <base_tree>` → `git apply --3way <patch>` → `git write-tree`.

**2a. Раздать 8 правок из 3e0da5899 по владельцам** (баг 1):
```
git diff 3e0da589~1..3e0da589 -- <file> > /tmp/commits/fixup-<owner>.patch
```
Каждый патч вклеивается в патч соответствующего коммита этапа 2b.

**2b. Декомпозиция PRIME-55/62 и восстановление PRIME-63.**

Скелетное правило (без него PRIME-55' не компилируется):
`plan_code_mode: None` и `resume_pending_user_message: None` живут в одних
initializer-ах (15+ файлов) — ручная разрезка хрупкая. Поэтому:

**PRIME-55'** (сообщение a01879763) получает:
- оригинальные 50 файлов PRIME-55/56/57/59/61
- + возврат из 52f2c8f85: transform_messages.rs (PRIME-57), registry.rs fmt,
  compaction_arms.rs, skills/mod.rs (PRIME-59), wire_events.rs (PRIME-61),
  session_engine_impl.rs, layout_normalize.rs/apply.rs fmt
- + МИНИМАЛЬНЫЙ PRIME-63-скелет: `lib.rs mod plan_code`, `plan_code.rs`
  (полный, HEAD-версия), `engine.rs` plan_code-поля, `slash_commands.rs`
  plan-arms, `plan_code_mode: None` во всех test-initializer-ах
- + test-initializer resume-поля (resume_pending_user_message: None)
- + из 3e0da589: daemon_client/tests.rs дубликат-удаление, interactive/tests.rs

Скелет — отклонение состава от оригинала PRIME-55 (оригинал engine.rs
не трогает). Зафиксировать в отчёте.

**PRIME-63** (сообщение 1ab721bdc) получает:
- session_commands.rs plan-code команды + todos extraction (stage-5 fix)
- prompts/layers.rs plan/code/debug константы, {plan,code,debug}_mode.md
- system_prompt.rs plan_code_mode-инъекция
- args.rs, mode.rs, interactive_mode.rs, print_runtime.rs, faux.rs (CLI-флаг)
- run_loop.rs mark_completed seam (stage-5 fix; hunk СМЕЖНЫЙ с PRIME-55
  pending_admission — резать аккуратно, оба должны остаться)
- print_boundary/tests.rs, engine/tests.rs, slash_session_tests.rs,
  abort_kernel_cell.rs, turn_boundary_kernel.rs и остальные test-файлы
  (сверх скелета PRIME-55')
- из 3e0da589: ничего

**PRIME-62'** (сообщение e33a157dc) получает:
- только оригинальные 20 bb-mirror файлов
- + из 3e0da589: print_rlm.rs mirror-поля, host.rs unused imports
- БЕЗ plans/, БЕЗ plan_code.rs fmt, БЕЗ PRIME-55/57/59/61 файлов

**Остальные коммиты** — оригинальные файлы + миграционные фиксы:
- ACP resume (5995bb3e4'): + session_registry.rs `"sessions-archive"` inline
  + из 3e0da589: session_registry.rs
- autocomplete (3dfb9a11f'): + commands.rs, settings.rs fmt (из 3e0da589)
- keepalive (c8220630f'): + stream_drop.rs fmt (из 3e0da589)
- `.gitignore` (последний): только .gitignore + `git rm --cached plans/*.md`
  (tracked plans/ файлы уходят из git, остаются локально)

Разъединение пересекающихся файлов — hunk-ами по ключевым словам:
`inside_bb` → PRIME-62, `plan_code_mode`/`mod plan_code`/`plan`-arm → PRIME-63
(в PRIME-55' — только скелетные), `daemonless`/`TurnAdmission`/`resume` → PRIME-55.
session_commands.rs: `plan`/`code`/`dbg`-arms → PRIME-63.

Порядок:
```
... PRIME-53
→ PRIME-55' (скелет plan_code внутри)
→ PRIME-63
→ run-rust-daemon.sh
→ PRIME-62'
→ ACP resume' → autocomplete' → keepalive' → остальные 9
→ .gitignore'
```

## Этап 3: сборка через commit-tree

В worktree /tmp/restore-wt:

```
TREE_BASE=$(git rev-parse v0.10.1^{tree})
PREV_TREE=$TREE_BASE; PREV_COMMIT=$(git rev-parse v0.10.1)
for i in 01..25:
    git read-tree $PREV_TREE
    git apply --3way /tmp/commits/$i.patch
    git add -A
    NEW_TREE=$(git write-tree)
    NEW_COMMIT=$(git commit-tree $NEW_TREE -p $PREV_COMMIT \
        -F /tmp/msgs/$i.txt)
    PREV_COMMIT=$NEW_COMMIT; PREV_TREE=$NEW_TREE
git update-ref refs/heads/local/v0.10.1-restored $PREV_COMMIT
```

Даты коммитов сохранять (иначе commit-tree поставит текущую дату):
```
GIT_AUTHOR_DATE=$(git show -s --format=%aI <orig>) \
GIT_COMMITTER_DATE=$(git show -s --format=%cI <orig>) \
git commit-tree ...
```

## Этап 4: верификация

**4a. Контент идентичен:**
```
git rev-parse local/v0.10.1-clean^{tree} local/v0.10.1-restored^{tree}
# одинаковый tree hash 273559f46 (плановые plans/ tracked-файлы:
# либо входят в эталон, либо .gitignore'-коммит их снимает —
# сверить полный список с HEAD до начала работ)
```

Ремонт при провале: пофайловый `git diff local/v0.10.1-restored
local/v0.10.1-clean -- <файл>`, дефектный патч этапа 2 перегенерировать
(HEAD-версия минус предыдущие патчи). Следующие коммиты не трогать.

**4b. Состав:**
```
git log --oneline v0.10.1..local/v0.10.1-restored | wc -l   # 25
git show <c> --name-only — сверить с оригиналом + скелет PRIME-55'
+ миграционные фиксы (маппинг 2b)
```

**4c. Утечки:**
```
git log --all --oneline -- skills/bb-subagents/src/bb_subagents.egg-info/   # пусто
git ls-files plans/                                                          # пусто после .gitignore'-коммита
```

**4d. Сборка и тесты:**
```
cargo check --workspace     # 0 ошибок, 0 предупреждений
cargo fmt --all --check
timeout 60  cargo test -p pa-types --lib
timeout 60  cargo test -p pa-agent --lib
timeout 60  cargo test -p pa-ai --lib
timeout 60  cargo test -p pa-telemetry --lib
timeout 60  cargo test -p pa-core --lib      # 2 pre-existing
timeout 120 cargo test -p pa-daemon --lib    # 38 pre-existing
timeout 120 cargo test -p pa-tui --lib       # 8 pre-existing
timeout 120 cargo test -p pa-cli --lib
```

**4e. Bisect-гигиена** (с допуском для пары PRIME-55'/63):
```
git rebase --exec 'cargo check --workspace 2>&1 | grep -q "^error" && exit 1' v0.10.1 local/v0.10.1-restored
```
PRIME-55' компилируется за счёт скелета — это осознанный допуск
(альтернатива — разрезка initializer-ов по 15+ файлам, отвергнута
как хрупкая). Все остальные 24 коммита — строго.

## Этап 5: замена ветки

```
git checkout local/v0.10.1-restored
git branch -m local/v0.10.1-clean local/v0.10.1-clean-broken
git branch -m local/v0.10.1-restored local/v0.10.1-clean
git worktree remove /tmp/restore-wt
# backup-ветки остаются до ручной проверки
```

## Риски

1. **Hunk-разъединение PRIME-55/63**: скелет в PRIME-55' снимает
   главный риск (initializer-ы). Оставшиеся пересечения — system_prompt.rs,
   session_commands.rs: резать по ключевым словам, `cargo check` после каждого.
2. **session_commands.rs**: `plan`/`code`/`dbg`-arms → PRIME-63;
   resume-хвост → PRIME-55.
3. **`git apply --3way` отказ** на сдвинутом контексте → fallback:
   cherry-pick оригинала с ручной резолюцией в worktree.
4. **run_loop.rs смежные hunk-и** (PRIME-55 pending_admission +
   PRIME-63 mark_completed): раздельно, без потери.

## Откат

```
git branch -f local/v0.10.1-clean local/v0.10.1-clean-backup-1
```

## Итог

- 25 коммитов, оригинальные сообщения и даты, PRIME-63 восстановлен
- PRIME-55' несёт минимальный plan_code-скелет (зафиксированное отступление)
- PRIME-62' чист: только bb-mirror
- Дерево идентично эталону 273559f46
- 0 утечек (egg-info, plans/ — снят с tracking)
- Каждый коммит компилируется (допуск: скелет в PRIME-55')

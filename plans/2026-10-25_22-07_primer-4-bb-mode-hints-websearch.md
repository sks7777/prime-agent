# Fix PRIMER-4 regressions: bb mode hints + websearch in /ask

Branch: local/v0.10.1-clean (HEAD: e5b3225c11)

## Bug #1: bb не показывает подсказки session mode команд (/code, /ask, /debug)

### Root cause (two parts)

**A. Builtin slash commands never reach bb.**
bb получает slash-команды для автокомплита из session update available_commands_update
(поле availableCommands: массив {name, description, inputHint?}).
AcpSessionUpdate enum (crates/pa-daemon/src/acp/types.rs:142) не имеет варианта
AvailableCommands — daemon никогда его не шлёт. get_commands
(crates/pa-daemon/src/rpc/session_commands.rs:579) возвращает только prompt templates +
skills (skill:*), не builtin commands. TS reference тоже не шлёт available_commands_update.
Поэтому /plan, /code, /ask, /debug, /exit, /todos не появляются в bb autocomplete.

**B. mode_changed не эмитится в ACP (worker) пути.**
PRIMER-4 добавил mode config option в configOptions. bb обновляет currentValue этого
select через config_option_update, который daemon шлёт после refresh_wire_config.
refresh_wire_config триггерится событием mode_changed (daemon.rs:409).
mode_changed эмитится только в RPC пути (rpc/prompt_commands.rs:183),
не в worker/ACP пути (agent_engine/session_engine_impl.rs:1372 -> session_commands::run_session_command).
Когда bb (ACP) выполняет /code через session/prompt -> worker, mode_changed не выходит ->
refresh_wire_config не запускается -> bb не видит обновлённый mode currentValue.

### Fix plan

1. Добавить AvailableCommands вариант в AcpSessionUpdate (types.rs):
   #[serde(rename = "available_commands_update")]
   AvailableCommands { available_commands: Vec<AvailableCommand> }
   где AvailableCommand { name: String, description: String, #[serde(skip_serializing_if)] input_hint: Option<String> }.

2. Шлать available_commands_update при session/new и при изменении команд.
   В handle_session_new (daemon.rs) — после построения response, опубликовать
   AvailableCommands с builtin session slash commands из SlashCommandRegistry::builtin()
   (pa-types/src/slash_commands.rs:104, CANONICAL_BUILTIN_SLASH_COMMANDS).
   Маппинг: BuiltinSlashCommand -> AvailableCommand { name, description, input_hint: argument_hint }.

3. Эмитить mode_changed в worker (ACP) пути.
   В session_engine_impl.rs session command path (после run_session_command, ~L1374):
   сравнить session_mode до и после; если изменился — отправить mode_changed event
   через emit(EngineEvent::CustomMessage(...)) с {"type":"mode_changed","mode":label}.
   Это заставит daemon.rs:409 trigger refresh_wire_config -> config_option_update
   с обновлённым mode currentValue.

4. Тест: ACP e2e — отправить /code через session/prompt, проверить что
   config_option_update пришёл с mode=code и available_commands_update содержит
   /code, /ask, /plan, /debug.

### Parity note
TS reference не шлёт available_commands_update — это новая поверхность (Rust опережает TS).
Обоснование: PRIMER-4 явно требует "они должны выводится" — user-visible invariant.
mode_changed в RPC пути уже есть — добавление в worker пути это parity fix.

---

## Bug #2: web_search перестал работать в /ask режиме

### Root cause
ask_mode.md (crates/pa-core/src/prompts/layers/ask_mode.md) содержит строку:
  "You must NOT modify files, run write commands, or execute code — you are read-only"
Фраза "execute code" запрещает модели использовать python_repl целиком.
websearch — Python skill, вызывается через python_repl: await websearch("query").
Tool gating (session_mode.rs:683 before_tool_call) разрешает python_repl в Ask mode —
он блокирует только write-паттерны (BLOCKED_PYTHON_PATTERNS). Но промпт запрещает
python_repl -> модель не вызывает websearch.

### Fix plan

1. Разрешить websearch в ask_mode.md.
   Заменить строку "You must NOT modify files, run write commands, or execute code"
   на "You must NOT modify files or run write commands".
   Добавить отдельный пункт:
   "You MAY use read-only Python skills via python_repl — websearch, data analysis,
   read-only inspection. The system blocks write operations automatically; if a
   tool call is blocked you will see the reason in the result."

2. Добавить явный UI-вывод запрета при блокировке tool в Ask/Plan mode.
   Сейчас block reason уходит модели как AgentToolResult::error(reason)
   (agent_loop/tool_call.rs) -> tool_call_update status=Failed + content.
   bb показывает "Failed" + текст причины. Но причина не выделяется как
   mode-block — она выглядит как обычная tool error.
   Изменения:
   a. В before_tool_call (session_mode.rs) — уже есть reason с "Ask mode:" / "Plan mode:"
      префиксом. Оставить как есть.
   b. В tool_call.rs — при block=true, добавить в AgentToolResult метаданные
      (details или _meta) с {"blocked": true, "mode": "ask"|"plan", "reason": reason},
      чтобы UI мог явно показать "Blocked by mode" вместо "Error".
   c. В AcpSessionUpdate::ToolCallUpdate — добавить поле blocked: Option<bool>
      (skip_serializing_if = Option::is_none), чтобы bb мог различить mode-block
      от обычной ошибки. Wire mapping в wire_events.rs: при is_error + block-флаг
      ставить status=Failed + content с reason + blocked=true.
   d. В TUI tool_card/mod.rs — PanelStatus::Blocked (новый вариант) когда
      result.details.blocked == true, рендерит "blocked" вместо "error".

3. Тест: regression test — код await websearch("test") не должен триггерить
   BLOCKED_PYTHON_PATTERNS. Integration: Ask mode + websearch query -> модель
   вызывает python_repl с websearch(...). Unit: before_tool_call в Ask mode
   для python_repl с websearch-кодом возвращает None (не блокирует).

### Verification
- await websearch("query") не матчит BLOCKED_PYTHON_PATTERNS (подтверждено).
- websearch.py не содержит заблокированных паттернов (подтверждено).
- Единственный блокатор — промпт ask_mode.md.

---

## Implementation order
1. Fix ask_mode.md (Bug #2 part 1) — разрешить read-only Python в Ask.
2. Add blocked flag to tool result (Bug #2 part 2) — UI-вывод запрета.
   a. session_mode.rs: reason уже есть (без изменений).
   b. tool_call.rs: добавить blocked metadata в AgentToolResult.
   c. types.rs: ToolCallUpdate.blocked field.
   d. wire_events.rs: propagate blocked flag.
   e. tool_card/mod.rs: PanelStatus::Blocked + render.
3. Add mode_changed emit in worker path (Bug #1B) — parity fix.
4. Add AvailableCommands to AcpSessionUpdate + send on session/new (Bug #1A) — new surface.
5. Tests for both bugs.
6. cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace

## Risks
- Bug #1A добавляет новую session update поверхность (опережает TS). Если bb не парсит
  available_commands_update для ACP агентов — нужен ручной тест в bb.
- mode_changed emit в worker пути должен идти через тот же emit канал, что и другие
  custom messages, чтобы daemon.rs:409 его увидел.
- ToolCallUpdate.blocked — новое поле в ACP wire. bb должен игнорировать неизвестные
  поля (serde passthrough). Проверить что TS binary тоже passthrough.
- PanelStatus::Blocked — новый enum вариант в pa-tui. Обновить все match arms.

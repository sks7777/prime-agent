# Детальный аудит итеративного merge earendil-works/pi (v0.74.1 → v0.84.2) в prime-agent

**Ветка:** `merge/earendil-iterative`
**Дата:** 2026-08-23
**Базовая ветка:** `local/customizations` (на основе PI v0.8.0)
**Целевая версия:** earendil-works/pi v0.84.2

## Сводка

| Метрика | Значение |
|---------|----------|
| Шагов слияния | 11 (v0.74.1 → v0.84.2) |
| Всего коммитов на ветке | 1717 |
| Файлов в v0.84.2 | 1373 |
| Файлов в merge/earendil-iterative | 1353 |
| Отсутствующих файлов earendil | 576 |
| PI-специфичных файлов (нет в v0.84.2) | 556 |
| Файлов с отличающимся содержимым | 580 |
| Тестов проходит | 5662 (0 сбоев) |
| npm run check | PASS |

## Стратегия слияния

**Принцип:** PI (prime-agent) код остаётся первичным. При конфликте общих файлов сохраняется версия PI (HEAD), изменения earendil принимаются только для новых файлов, не конфликтующих с архитектурой PI.

**Метод:** Для каждого шага:
1. `git merge <tag> --no-commit --no-ff`
2. Для файлов, существующих в PI: `git show HEAD:<file> > <file>` (сохранить PI)
3. Для новых файлов earendil: `git checkout --theirs <file>` + fix `.ts` → `.js` imports
4. Удаление несовместимых новых пакетов/директорий
5. Добавление типов совместимости в PI
6. `git commit`

---

## 1. Детализация по шагам

### Шаг 1: v0.74.1 (merge-base → v0.74.1)

**Конфликты:** 72 файла
**Ключевые конфликтующие файлы:**
- `packages/agent/src/agent-loop.ts` — PI имеет abort-aware stop/steering, earendil заменил на prepareNextTurn
- `packages/agent/src/agent.ts` — PI имеет shouldStopAfterTurn, shouldStopBeforeTurn, getContinuationMessages, serviceTier
- `packages/agent/src/types.ts` — PI имеет ThinkingLevel с "max", GetContinuationMessagesContext
- `packages/coding-agent/src/core/agent-session.ts` — PI имеет RLM child management
- `packages/coding-agent/src/core/session-manager.ts` — PI имеет rlmDepth, AgentStatus, flushNow
- `packages/coding-agent/src/core/skills.ts` — PI имеет PythonSkillRuntimeInfo
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — PI имеет daemon/heartbeat/refinement
- `packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts` — PI имеет expandCollapseHint
- `packages/coding-agent/src/cli.ts` — PI имеет node version check, earendil имеет undici proxy setup
- `packages/ai/src/types.ts` — PI имеет prime-inference provider, ThinkingLevel "max"
- `packages/ai/src/providers/openai-completions.ts` — PI имеет isPrimeInference

**Стратегия разрешения:**
- KEEP HEAD (PI): agent-loop.ts, agent.ts, types.ts, agent-session.ts, session-manager.ts, skills.ts, interactive-mode.ts, keybinding-hints.ts, extension-selector.ts, config-selector.ts, settings-selector.ts, sdk.ts, mime.ts, tools-manager.ts, prompt-templates.ts, package-manager.ts, main.ts, args.ts, tool-execution-component.test.ts
- TAKE THEIRS (earendil): models.generated.ts, все ai/test/*.test.ts, markdown.ts, markdown.test.ts, theme.ts, render-utils.ts, docs, examples, CHANGELOG, package-lock.json, .github/
- MANUAL MERGE: package.json (все — версия PI + новые deps earendil), ai/index.ts (оба экспорта), ai/types.ts (ThinkingLevel "max" + image types), ai/providers/anthropic.ts (session affinity), ai/providers/openai-completions.ts (isPrimeInference + isTogether), provider-display-names.ts (оба), cli.ts (version check + undici setup)

**Удалённые файлы:**
- `packages/web-ui/CHANGELOG.md`, `packages/web-ui/example/package.json`, `packages/web-ui/package.json` — удалены в PI, изменены в earendil → `git rm`

**Удалённые тесты:** Нет

**Добавленные типы:**
- `QueueMode` в `packages/agent/src/types.ts`
- `AgentLoopTurnUpdate` в `packages/agent/src/types.ts`
- `PrepareNextTurnContext` в `packages/agent/src/types.ts`
- `prepareNextTurn` (optional) в `AgentLoopConfig` в `packages/agent/src/types.ts`
- `KnownImagesProvider`, `ImagesProvider` в `packages/ai/src/types.ts`
- `forceAdaptiveThinking` в `Model` в `packages/ai/src/types.ts`
- `forceAdaptiveThinking` в `AnthropicMessagesCompat` в `packages/ai/src/types.ts`
- `allowEmptySignature` в `AnthropicMessagesCompat` (добавлено в шаге 4)
- `"together"` в `KnownProvider` в `packages/ai/src/types.ts`
- `"together"` в `thinkingFormat` union в `packages/ai/src/types.ts`
- `together` models добавлены в `packages/ai/src/models.generated.ts`
- `ignore` и `yaml` deps в `packages/agent/package.json`

**Тесты PI:** Все проходят (5622 → ~5751 тестов после удаления некоторых earendil тестов)

---

### Шаг 2: v0.75.5 (v0.74.1 → v0.75.5)

**Конфликты:** 277 файлов
**Breaking changes:** Node 22.19 min, xiaomi provider, reasoningEffortMap→thinkingLevelMap, removed Google Gemini CLI/Antigravity, OSC 9;4 default off

**Стратегия разрешения:**
- KEEP HEAD: Все PI-критичные файлы (те же, что в шаге 1, плюс все coding-agent/src, coding-agent/test, tui/src, tui/test)
- TAKE THEIRS: CHANGELOG, новые файлы earendil (harness/, bun/, extensions/)
- Удалены image files (image-models.ts, images.ts, images-api-registry.ts, providers/images/) — ссылаются на типы ImagesApi, ImagesModel, ImagesContext, ImagesFunction, ImagesOptions, ImagesModel, ProviderImagesOptions, AssistantImages, ImagesOutputContent, ImagesStopReason — отсутствуют в PI types.ts
- Удалены новые TUI файлы (word-navigation.ts, alt-screen-*.ts, layout*.ts) — ссылаются на earendil TUI API (fullscreen, clippedFullscreenDockHeight, enterFullscreen, suspendFullscreenMouse)
- Удалены orchestrator, server пакеты
- Reverted build scripts (build-binaries.sh, release.mjs) — PI тесты ожидают PI-версии

**Удалённые тесты:**
- `packages/coding-agent/test/prompt-templates.test.ts` — earendil добавил тесты на newline-as-separator (PI не поддерживает)
- `packages/coding-agent/test/skills.test.ts` — earendil изменил validateName сигнатуру
- `packages/coding-agent/test/package-manager.test.ts` — earendil изменил auto-discovery metadata
- `packages/ai/test/openai-completions-tool-choice.test.ts` — earendil изменил cache_write_tokens (50→20)
- `packages/agent/test/harness/agent-harness-stream.test.ts` — earendil использует fauxProvider API
- `packages/agent/test/harness/agent-harness.test.ts` — earendil использует fauxProvider API

**Добавленные типы:** `forceAdaptiveThinking` в `AnthropicMessagesCompat`, `getAnthropicCompat` default

**Исправления:**
- `.ts` → `.js` imports во всех новых файлах earendil
- `tsconfig.base.json` reverted to PI (earendil добавил `erasableSyntaxOnly: true` — ломает PI's parameter properties и enum syntax)
- `models.generated.ts` reverted to PI (earendil версия несовместима с PI KnownProvider типами)

---

### Шаг 3: v0.76.0 (v0.75.5 → v0.76.0)

**Конфликты:** 39 файлов
**Breaking changes:** Нет

**Стратегия:** KEEP HEAD для всех PI файлов, TAKE THEIRS для CHANGELOG и новых файлов
**Удалённые тесты:**
- `packages/coding-agent/test/rpc-client-process-exit.test.ts` — earendil RPC API несовместим
- TUI word-navigation tests — ссылаются на удалённый word-navigation.ts

---

### Шаг 4: v0.77.0 (v0.76.0 → v0.77.0)

**Конфликты:** 46 файлов
**Breaking changes:** Нет

**Стратегия:** KEEP HEAD для PI файлов
**Добавленные типы:** `allowEmptySignature` в `AnthropicMessagesCompat`, `allowEmptySignature` в `getAnthropicCompat` default
**Удалённые тесты:**
- `packages/coding-agent/test/agent-session-dynamic-tools.test.ts` — earendil API
- `packages/coding-agent/test/config-value-migration.test.ts` — earendil config API
- `packages/coding-agent/test/suite/regressions/5080-signal-shutdown-extension-cleanup.test.ts` — earendil shutdown API
- `packages/ai/test/anthropic-adaptive-thinking-models.test.ts` — earendil adaptive thinking API
- `packages/ai/test/anthropic-force-adaptive-thinking.test.ts` — earendil forceAdaptiveThinking compat
- `packages/ai/test/xiaomi-models.test.ts` — earendil xiaomi model metadata
- `packages/agent/test/harness/agent-harness.test.ts` — fauxProvider API

---

### Шаг 5: v0.78.1 (v0.77.0 → v0.78.1)

**Конфликты:** 74 файла
**Breaking changes:** Нет

**Стратегия:** KEEP HEAD для всех PI src/test/example/docs файлов, TAKE THEIRS для CHANGELOG
**Удалённые тесты:**
- `packages/coding-agent/test/suite/regressions/5080-signal-shutdown-extension-cleanup.test.ts` — снова появился из merge

---

### Шаг 6: v0.79.10 (v0.78.1 → v0.79.10)

**Конфликты:** 195 файлов
**Breaking changes:** Нет

**Стратегия:** KEEP HEAD для всех PI файлов, TAKE THEIRS для CHANGELOG
**Удалено:**
- `packages/ai/src/base.ts` — ссылаются на image-models.js (удалён)
- `packages/agent/src/base.ts` — .ts imports, ссылаются на pi-ai/base subpath export
- Browser smoke check reverted — earendil добавил base subpath exports
- `packages/ai/package.json`, `packages/agent/package.json` reverted — earendil добавил base subpath exports

---

### Шаг 7: v0.80.10 (v0.79.10 → v0.80.10)

**Конфликты:** 278 файлов
**Breaking changes:** TypeBox 0.34 → 1.x migration

**Стратегия:** KEEP HEAD для всех PI файлов, TAKE THEIRS для CHANGELOG
**Удалено:**
- `packages/orchestrator/` — новый пакет, ссылаются на RpcExtensionUIResponse (нет в PI)
- `packages/ai/src/base.ts` — image types
- Все image files (image-models, images, images-api-registry, providers/images/)
- `packages/agent/test/harness/agent-harness-stream.test.ts` — fauxProvider API
- `packages/agent/test/harness/agent-harness.test.ts` — fauxProvider API
- `packages/agent/test/harness/compaction.test.ts` — fauxProvider API
- Восстановлены удалённые провайдеры (google-shared, openai-codex-responses, openai-completions, openai-responses, simple-options, transform-messages, github-copilot-headers, openai-prompt-cache)
- `scripts/browser-smoke-entry.ts` reverted — earendil импортирует из compat.ts (нет нужных экспортов в PI)
- `packages/ai/src/compat.ts` reverted
- `packages/ai/src/mcp/oauth.ts` восстановлен

**Добавленные типы:** `metadata` поле в `SessionCreateOptions` и `JsonlSessionMetadata` в `packages/agent/src/harness/types.ts`

---

### Шаг 8: v0.81.1 (v0.80.10 → v0.81.1)

**Конфликты:** 181 файл
**Breaking changes:** SDK authStorage/modelRegistry → modelRuntime, ModelRegistry.refresh sync→async, sendSessionIdHeader → sessionAffinityFormat

**Стратегия:** KEEP HEAD для всех PI файлов
**Удалено:**
- `packages/server/` — новый пакет, ссылаются на RpcExtensionUIRequest/Response (нет в PI)
- `packages/storage/` — новый пакет, ссылаются на SessionEntryCursorOptions, uuidv7 (нет в PI)
- `packages/agent/test/harness/session.test.ts` — earendil session API changes
- `packages/agent/test/harness/sqlite-migrations.test.ts` — .ts imports + storage API
- `packages/agent/test/harness/sqlite-node.test.ts` — ссылаются на удалённый storage пакет

---

### Шаг 9: v0.82.1 (v0.81.1 → v0.82.1)

**Конфликты:** 170 файлов
**Breaking changes:** Нет

**Стратегия:** KEEP HEAD для PI файлов
**Удалено:**
- `packages/agent/src/harness/tools/` (bash.ts, edit.ts, read.ts, write.ts, index.ts, tool-context.ts, path-utils.ts, file-mutation-queue.ts, edit-diff.ts, image.ts) — ссылаются на AgentHarnessTool, ShellCaptureProgress (нет в PI)
- `packages/agent/test/harness/tool-context.types.ts` — ссылаются на удалённые harness/tools
- `packages/agent/test/harness/tools.test.ts` — ссылаются на удалённые harness/tools
- `packages/agent/test/harness/compaction.test.ts` — fauxProvider API

**Добавленные типы:**
- `ShellExecOptions` в `packages/agent/src/harness/types.ts` (с полями: command?, timeout?, cwd?, env?, abortSignal?, inheritEnv?, onStdout?, onStderr?)

---

### Шаг 10: v0.83.0 (v0.82.1 → v0.83.0)

**Конфликты:** 84 файла
**Breaking changes:** TypeBox 1.3.7, removed deprecated APIs

**Стратегия:** KEEP HEAD для PI файлов, TAKE THEIRS для CHANGELOG
**Удалено:** Нет (все конфликты разрешены стандартной стратегией)

---

### Шаг 11: v0.84.2 (v0.83.0 → v0.84.2)

**Конфликты:** 325 файлов
**Breaking changes:** ModelsStreamTransforms→ModelsRequestTransforms, message_update event delta-only, ModelRegistry.getApiKeyAndHeaders null values, ModelRuntime.setRuntimeApiKey signature change

**Стратегия:** KEEP HEAD для PI файлов
**Удалено:**
- `packages/agent/scripts/generate-telemetry-docs.ts` — ссылаются на @earendil-works/pi-telemetry (нет в PI)
- `packages/agent/src/harness/reducer.ts` — ссылаются на DeferredHandle, "deferred" stop reason (нет в PI)
- `packages/agent/src/harness/session/context.ts` — "deferred" stop reason
- `packages/agent/src/harness/session/jsonl/` (repo.ts, codec.ts, errors.ts, storage.ts, types.ts) — uuidv7 from pi-ai (нет в PI)
- `packages/agent/src/harness/session/memory.ts` — uuidv7, InMemorySessionStorage несовместим с PI SessionStorage
- `packages/agent/src/harness/session/index.ts` — duplicate export of buildSessionContext
- `packages/agent/src/harness/session/jsonl.ts` — ссылаются на удалённый jsonl/repo
- Все оставшиеся harness тесты (19 файлов) — fauxProvider API, reducer API, session context API, jsonl API

---

## 2. Пропущенные пакеты earendil

| Пакет | Файлов | Причина | Сложность портирования |
|-------|--------|---------|----------------------|
| `packages/protocol/` | 14 | CBOR codec, wire protocol — standalone, не зависит от PI API | Тривиально (add as-is, fix .ts imports) |
| `packages/client/` | 22 | Session client, Unix transport — зависит от protocol package | Тривиально (add protocol first) |
| `packages/server/` | 22 | Protocol server — зависит на RpcExtensionUIRequest/Response из coding-agent | Средне (нужно добавить RpcExtensionUIRequest/Response типы в PI) |
| `packages/evals/` | 16 | Evaluation harness — зависит на AgentHarness, fauxProvider | Сложно (требует fauxProvider API в pi-ai) |
| `packages/telemetry/` | 11 | Telemetry contracts — standalone | Тривиально (add as-is, fix .ts imports) |
| `packages/orchestrator/` | ~5 | Experimental orchestrator — зависит на RpcExtensionUIResponse | Средне (добавить типы) |
| `packages/storage/` → `session-backends/` | 37 | SQLite session storage — уже в ветке (частично), но имеет API несовместимости (SessionEntryCursorOptions, uuidv7) | Средне (добавить недостающие типы) |

**Оценка:** protocol, client, telemetry можно добавить тривиально. server, orchestrator требуют добавления RpcExtensionUIRequest/Response типов. evals требует fauxProvider API.

---

## 3. Пропущенные директории earendil

| Директория | Файлов | Причина | Сложность |
|-----------|--------|---------|-----------|
| `packages/agent/src/harness/tools/` | 10 | AgentHarnessTool, ShellCaptureProgress — нет в PI types | Средне (добавить типы) |
| `packages/agent/src/harness/session/context.ts` | 1 | "deferred" stop reason — нет в PI StopReason | Средне (добавить "deferred" в StopReason) |
| `packages/agent/src/harness/session/jsonl/` | 5 | uuidv7 from pi-ai, JsonlSessionMetadata changes | Средне (добавить uuidv7 export) |
| `packages/agent/src/harness/session/memory.ts` | 1 | InMemorySessionStorage не реализует PI SessionStorage interface | Средне (адаптировать интерфейс) |
| `packages/agent/src/harness/reducer.ts` | 1 | DeferredHandle, "deferred" stop reason | Сложно (требует "deferred" в StopReason + DeferredHandle type) |
| `packages/agent/src/harness/events.ts` | 1 | Harness event types | Тривиально (add as-is) |
| `packages/agent/src/harness/result.ts` | 1 | Harness result types | Тривиально (add as-is) |
| `packages/agent/src/harness/telemetry.ts` | 1 | Harness telemetry | Тривиально (add as-is) |
| `packages/agent/src/search/` | 2 | Search index, scanning | Тривиально (add as-is) |
| `packages/agent/src/stream-fn.ts` | 1 | Stream function | Тривиально (add as-is) |
| `packages/ai/src/api/` | 26 | Lazy API loaders, constrained sampling | Средне (требует compat.ts изменения) |
| `packages/ai/src/auth/` | 13 | Auth context, credential store, OAuth providers | Средне (требует auth storage изменения) |
| `packages/ai/src/providers/` (new) | 80 | Per-provider model files, new providers (baseten, nvidia, etc.) | Тривиально-Средне (add as-is, fix imports) |
| `packages/ai/src/` (images, base, etc.) | 10 | Image models, base entrypoint, model catalog, models store | Сложно (требует image types в types.ts) |
| `packages/ai/src/utils/` (new) | 9 | abort, deferred-tools, error-body, estimate, pi-user-agent, provider-env, provider-retry, retry, text | Тривиально-Средне |
| `packages/coding-agent/src/client/` | 3 | Remote session, transcript — зависит на protocol package | Средне |
| `packages/coding-agent/src/server/` | 1 | Create harness — зависит на server package | Средне |
| `packages/coding-agent/src/extensions/llama/` | 5 | HuggingFace llama.cpp integration | Тривиально (add as-is) |
| `packages/coding-agent/src/cli/experimental/` | 8 | Experimental CLI commands | Средне |
| `packages/coding-agent/src/core/` (new) | 21 | model-runtime, model-config, models-store, provider-attribution, project-trust, trust-manager, radius, etc. | Сложно (ModelRuntime migration) |
| `packages/coding-agent/src/modes/interactive/` (new) | 12 | mermaid, markdown-transform, session-selector, theme-controller, model-catalog-refresh, etc. | Средне (TUI API несовместимости) |
| `packages/coding-agent/src/utils/` (new) | 7 | abort, image-process, image-resize, management-http, open-browser, tool-result-images | Тривиально-Средне |
| `packages/tui/src/` (new) | 11 | alt-screen, layout, word-navigation, fullscreen | Сложно (TUI API полностью переписан earendil) |
| `packages/tui/test/` (new) | 11 | latex, layout, word-navigation, alt-screen, settings tests | Средне |

---

## 4. API-несовместимости

### 4.1. prepareNextTurn vs shouldStopAfterTurn/shouldStopBeforeTurn/getContinuationMessages

- **Что несовместимо:** earendil заменил три callback'а на один `prepareNextTurn` в `AgentLoopConfig`
- **Где используется:** `packages/agent/src/harness/agent-harness.ts`, все harness тесты
- **Что нужно в PI:** Добавить `prepareNextTurn` в `AgentLoopConfig` (уже сделано — optional field)
- **Можно ли добавить совместимость:** Да, уже добавлено. PI agent-loop.ts не вызывает prepareNextTurn, но тип существует. Для полной поддержки нужно добавить вызов prepareNextTurn в agent-loop.ts после shouldStopAfterTurn

### 4.2. ModelRuntime vs AuthStorage/ModelRegistry

- **Что несовместимо:** earendil заменил AuthStorage/ModelRegistry на ModelRuntime (v0.81+)
- **Где используется:** `packages/coding-agent/src/core/model-runtime.ts`, `packages/coding-agent/src/core/models-store.ts`, `packages/coding-agent/src/core/runtime-credentials.ts`
- **Что нужно в PI:** Создать ModelRuntime класс, обёртывающий PI's ModelRegistry + AuthStorage
- **Можно ли добавить совместимость:** Да, через shim/adapter pattern. Не удаляет PI-функциональность

### 4.3. TypeBox 0.34 → 1.x

- **Что несовместимо:** TypeBox API изменения (Type.* → Type.*, Compile import)
- **Где используется:** `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- **Что нужно в PI:** Обновить typebox dependency до 1.x (PI уже имеет ^1.3.9)
- **Можно ли добавить совместимость:** Да, PI уже использует typebox 1.3.9. earendil theme.ts можно принять после обновления import путей

### 4.4. .ts import extensions

- **Что несовместимо:** earendil использует `.ts` расширения в import путях вместо `.js`
- **Где используется:** Все новые файлы earendil
- **Что нужно в PI:** Либо включить `allowImportingTsExtensions` в tsconfig, либо конвертировать .ts → .js (выбран второй вариант)
- **Можно ли добавить совместимость:** Да, через `allowImportingTsExtensions: true` в tsconfig. Но это конфликтует с `erasableSyntaxOnly` (см. 4.5)

### 4.5. erasableSyntaxOnly

- **Что несовместимо:** earendil добавил `erasableSyntaxOnly: true` в tsconfig.base.json, что запрещает parameter properties (`constructor(public mode: QueueMode)`) и enum declarations
- **Где используется:** `tsconfig.base.json`
- **Что нужно в PI:** Убрать `erasableSyntaxOnly` (PI использует parameter properties в agent.ts и других файлах)
- **Можно ли добавить совместимость:** Нет, без рефакторинга всего PI кода. Альтернатива: использовать отдельный tsconfig для earendil файлов

### 4.6. Fullscreen TUI API

- **Что несовместимо:** earendil добавил fullscreen mode (`enterFullscreen`, `exitFullscreen`, `clippedFullscreenDockHeight`, `suspendFullscreenMouse`, alt-screen renderer, layout nodes)
- **Где используется:** `packages/tui/src/tui-alt-screen.ts`, `packages/tui/src/tui-main-screen.ts`, `packages/tui/src/layout.ts`, `packages/tui/src/components/scroll-view.ts`, `packages/tui/src/components/stack.ts`, и др.
- **Что нужно в PI:** Добавить fullscreen API в TUI (enterFullscreen, exitFullscreen, OverlayOptions.suspendFullscreenMouse, etc.)
- **Можно ли добавить совместимость:** Да, через расширение TUI интерфейса. Не удаляет PI-функциональность

### 4.7. DeferredHandle / "deferred" stop reason

- **Что несовместимо:** earendil добавил "deferred" stop reason и DeferredHandle type
- **Где используется:** `packages/agent/src/harness/reducer.ts`, `packages/agent/src/harness/session/context.ts`
- **Что нужно в PI:** Добавить "deferred" в StopReason union, добавить DeferredHandle type
- **Можно ли добавить совместимость:** Да, тривиально

### 4.8. uuidv7 from pi-ai

- **Что несовместимо:** earendil экспортирует uuidv7 из @earendil-works/pi-ai, PI использует `uuid` package
- **Где используется:** `packages/agent/src/harness/session/jsonl/repo.ts`, `packages/agent/src/harness/session/memory.ts`
- **Что нужно в PI:** Добавить uuidv7 export в pi-ai (re-export из uuid package)
- **Можно ли добавить совместимость:** Да, тривиально

### 4.9. fauxProvider / createModels / FauxProviderHandle

- **Что несовместимо:** earendil добавил fauxProvider API для тестирования (createModels, FauxProviderHandle, fauxProvider)
- **Где используется:** Все harness тесты
- **Что нужно в PI:** Добавить fauxProvider в pi-ai (mock provider for testing)
- **Можно ли добавить совместимость:** Да, через добавление mock provider

### 4.10. RpcExtensionUIRequest / RpcExtensionUIResponse

- **Что несовместимо:** earendil экспортирует RpcExtensionUIRequest/Response из coding-agent, PI не имеет этих типов
- **Где используется:** `packages/server/`, `packages/orchestrator/`
- **Что нужно в PI:** Добавить RpcExtensionUIRequest/Response типы в coding-agent exports
- **Можно ли добавить совместимость:** Да, тривиально (типы уже существуют в PI's rpc-mode.ts, нужно экспортировать)

### 4.11. SessionStorage interface changes

- **Что несовместимо:** earendil расширил SessionStorage interface (getLeafId, setLeafId, createEntryId, getPathToRoot, getEntries)
- **Где используется:** `packages/agent/src/harness/session/memory.ts`, `packages/storage/sqlite-node/`
- **Что нужно в PI:** Расширить SessionStorage interface в harness/types.ts
- **Можно ли добавить совместимость:** Да, добавление методов не ломает PI

### 4.12. AnthropicMessagesCompat changes

- **Что несовместимо:** earendil добавил forceAdaptiveThinking, allowEmptySignature, supportsTemperature в AnthropicMessagesCompat
- **Где используется:** `packages/ai/src/providers/anthropic.ts`, тесты
- **Что нужно в PI:** Добавить поля (forceAdaptiveThinking и allowEmptySignature уже добавлены, supportsTemperature нужен)
- **Можно ли добавить совместимость:** Да, уже частично сделано

---

## 5. Файлы .ts импортов

- **Всего файлов earendil с .ts импортами:** ~600+ (все новые файлы используют .ts расширения)
- **Исправлено:** Все файлы в merge/earendil-iterative (0 оставшихся .ts импортов)
- **Метод:** `find packages/ -name '*.ts' -exec sed -i '' 's/from "\(.*\)\.ts"/from "\1.js"/g' {} \;` + `s/await import("\(.*\)\.ts")/await import("\1.js")/g`
- **Риск пропуска:** Минимальный. Проверка: `grep -rn 'from ".*\.ts"' packages/ --include='*.ts' | grep -v node_modules | grep -v '.d.ts'` → 0 результатов
- **Альтернатива:** Включить `allowImportingTsExtensions: true` в tsconfig (но конфликтует с `erasableSyntaxOnly`)

---

## 6. Harness-файлы

### Перенесённые harness-файлы (из v0.74.1, сохранились через все шаги):
- `packages/agent/src/harness/agent-harness.ts` — основной harness (требует QueueMode, prepareNextTurn — добавлены)
- `packages/agent/src/harness/compaction/branch-summarization.ts`
- `packages/agent/src/harness/compaction/compaction.ts`
- `packages/agent/src/harness/compaction/utils.ts`
- `packages/agent/src/harness/env/nodejs.ts` — требует ShellExecOptions (добавлен)
- `packages/agent/src/harness/messages.ts` — CompactionSummaryMessage (добавлены retainedMessageCount, customInstructions)
- `packages/agent/src/harness/prompt-templates.ts`
- `packages/agent/src/harness/session/jsonl-repo.ts` (ранняя версия)
- `packages/agent/src/harness/session/jsonl-storage.ts` (ранняя версия)
- `packages/agent/src/harness/session/memory-repo.ts` (ранняя версия)
- `packages/agent/src/harness/session/repo-utils.ts`
- `packages/agent/src/harness/session/session.ts`
- `packages/agent/src/harness/session/uuid.ts`
- `packages/agent/src/harness/skills.ts`
- `packages/agent/src/harness/system-prompt.ts`
- `packages/agent/src/harness/types.ts` — расширены (QueueMode, AgentLoopTurnUpdate, ShellExecOptions, metadata)
- `packages/agent/src/harness/utils/shell-output.ts`
- `packages/agent/src/harness/utils/truncate.ts`

### Удалённые harness-файлы:
- `packages/agent/src/harness/events.ts` — harness events (тривиально добавить)
- `packages/agent/src/harness/reducer.ts` — требует DeferredHandle, "deferred" stop reason
- `packages/agent/src/harness/result.ts` — harness result types (тривиально добавить)
- `packages/agent/src/harness/telemetry.ts` — harness telemetry (тривиально добавить)
- `packages/agent/src/harness/tools/` (10 файлов) — требуют AgentHarnessTool, ShellCaptureProgress
- `packages/agent/src/harness/session/context.ts` — требует "deferred" stop reason
- `packages/agent/src/harness/session/index.ts` — duplicate export
- `packages/agent/src/harness/session/jsonl.ts` — ссылается на удалённый jsonl/repo
- `packages/agent/src/harness/session/jsonl/` (5 файлов) — требует uuidv7 from pi-ai
- `packages/agent/src/harness/session/memory.ts` — InMemorySessionStorage несовместим
- `packages/agent/src/harness/session/state.ts` — session state
- `packages/agent/src/harness/session/testing/` (3 файла) — testing utilities
- `packages/agent/src/harness/session/types.ts` — session types
- `packages/agent/src/search/` (2 файла) — search index
- `packages/agent/src/stream-fn.ts` — stream function

### Требуют доработки для полной совместимости:
1. **agent-harness.ts** — добавить вызов prepareNextTurn в agent-loop.ts
2. **harness/types.ts** — добавить SessionStorage methods (getLeafId, setLeafId, createEntryId, getPathToRoot, getEntries)
3. **harness/session/memory.ts** — реализовать недостающие методы SessionStorage
4. **harness/session/jsonl/** — добавить uuidv7 export в pi-ai
5. **harness/reducer.ts** — добавить "deferred" в StopReason, добавить DeferredHandle type
6. **harness/tools/** — добавить AgentHarnessTool, ShellCaptureProgress типы

---

## 7. Тесты harness

**Все harness тесты удалены (19 файлов):**

| Тест | Причина удаления | Можно восстановить? |
|------|-----------------|-------------------|
| agent-harness-scaffold.test.ts | fauxProvider API | Да, после добавления fauxProvider |
| agent-harness-stream.test.ts | fauxProvider API | Да, после добавления fauxProvider |
| agent-harness.test.ts | fauxProvider API | Да, после добавления fauxProvider |
| branch-summarization.test.ts | session/index.js missing | Да, после восстановления session/index.ts |
| compaction.test.ts | fauxProvider API | Да, после добавления fauxProvider |
| events.test.ts | events.js missing | Да, после восстановления events.ts |
| nodejs-env.test.ts | renameFile method missing | Да, после добавления renameFile в NodeExecutionEnv |
| prompt-templates.test.ts | .ts imports | Да, после fix imports |
| reducer.test.ts | reducer.js missing, DeferredHandle | Да, после восстановления reducer.ts |
| resource-formatting.test.ts | .ts imports | Да, после fix imports |
| session/context.test.ts | context.js missing | Да, после восстановления context.ts |
| session/jsonl-codec.test.ts | jsonl/codec missing | Да, после восстановления jsonl/ |
| session/jsonl-storage.test.ts | jsonl/storage missing | Да, после восстановления jsonl/ |
| session/jsonl.test.ts | jsonl/repo missing | Да, после восстановления jsonl/ |
| session/memory.test.ts | memory.ts missing | Да, после восстановления memory.ts |
| session/search.test.ts | search/ missing | Да, после восстановления search/ |
| skills.test.ts | .ts imports | Да, после fix imports |
| system-prompt.test.ts | .ts imports | Да, после fix imports |
| telemetry.test.ts | telemetry.ts missing | Да, после восстановления telemetry.ts |
| tools.test.ts | harness/tools/ missing | Да, после восстановления harness/tools/ |
| truncate.test.ts | .ts imports | Да, после fix imports |

**Оценка:** Все 19 harness тестов можно восстановить после:
1. Добавления fauxProvider API в pi-ai
2. Восстановления удалённых harness файлов (events, reducer, result, telemetry, tools/, session/)
3. Добавления недостающих типов (DeferredHandle, "deferred" stop reason, AgentHarnessTool, ShellCaptureProgress)
4. Исправления .ts → .js imports

---

## 8. Проверка целостности

### Файлы earendil v0.84.2, отсутствующие в merge/earendil-iterative (576 файлов):

**По категориям:**

| Категория | Файлов | Причина |
|-----------|--------|---------|
| agent/harness (новые) | 28 | API несовместимости (reducer, tools, session/context, jsonl, memory) |
| agent/test/harness | 19 | fauxProvider API, удалённые harness модули |
| agent/docs | 3 | Документация (тривиально добавить) |
| agent/scripts | 1 | Ссылается на telemetry package |
| agent/search | 2 | Search index (тривиально добавить) |
| agent/src | 1 | stream-fn.ts (тривиально добавить) |
| ai/api | 26 | Lazy API loaders (требует compat.ts изменения) |
| ai/providers (новые) | 80 | Per-provider model files, новые провайдеры |
| ai/test (новые) | 63 | Тесты новых провайдеров и API |
| ai/src (новые) | 10 | Image models, base, model catalog, models store |
| ai/utils (новые) | 9 | Utility функции |
| ai/auth | 13 | Auth context, credential store, OAuth |
| coding-agent/src (новые) | 21 | model-runtime, model-config, trust-manager, radius, etc. |
| coding-agent/test (новые) | 117 | Тесты новых фич |
| coding-agent/cli (новые) | 17 | Experimental CLI, auth, session-picker |
| coding-agent/utils (новые) | 7 | image-process, abort, management-http |
| coding-agent/modes (новые) | 12 | mermaid, markdown-transform, theme-controller |
| coding-agent/extensions | 6 | llama/HuggingFace integration |
| tui (новые) | 22 | alt-screen, layout, word-navigation, fullscreen |
| new_packages | 102 | protocol, client, server, evals, telemetry |
| pi_config | 5 | .pi extensions, prompts |
| root | 12 | docs, examples, pi-test.ps1 |

### Файлы PI, отсутствующие в v0.84.2 (556 файлов):

**PI-архитектура (208 файлов):**
- daemon/ (27 файлов) — daemon-supervisor, daemon-client, daemon-protocol, worker processes, fork server, socket, recovery journal, heartbeat catalog, rlm-ledger, saved-session-catalog, compact-session-stream
- kernel/ (7 файлов) — bootstrap, bootstrap-cli, fork-server, fork-server-script, boot-gate, state-snapshot, index
- RLM features (52 файла) — rlm-runtime, rlm-max-depth, refinement/, goals, agent-messages, agent-observe, autonomous, cron-jobs, prompt-admission, session-lease, orphan-process-journal, thinking-levels, prompt-templates, side-question, context-tree, session-action-store, skill-blocks
- ACP mode (6 файлов) — acp-mode, acp-events, acp-mcp, acp-meta, acp-stop-reason
- Agents view (4 файла) — agents-view-mode, agents-view-state, session-view-search
- CLI (13 файлов) — daemon-command, daemon-launch, daemon-ps, daemon-stop-confirm, daemon-update-restart, owned-session-worker, subprocess-launch, session-resolver, public-command, command-registry
- Prime Inference (3 файла) — prime-inference-auth, prime-inference-model-selection, prime-inference-models
- IPython tool (2 файла) — ipython.ts, ipython-cell-code.ts
- Other PI tooling (10 файлов) — code-preview, export-html/, websearch-credential
- Infrastructure (8 файлов) — prime-agent.sh, install.sh, kernel venv setup, release packaging
- Skills (5 файлов) — agent-message, agent-observe, goal, refine, rlm-heartbeat (Python packages)
- Tests (168 файлов) — PI-specific test files

---

## 9. Breaking changes earendil и их обработка

| Breaking change | Шаг | Обработка | Статус |
|----------------|------|-----------|--------|
| Node 22.19 min | 2 | Не применено (PI уже требует Node 22+) | OK |
| xiaomi provider | 2 | KnownProvider уже имеет xiaomi в PI | OK |
| reasoningEffortMap → thinkingLevelMap | 2 | KEEP HEAD (PI использует thinkingLevelMap) | OK |
| Removed Google Gemini CLI/Antigravity | 2 | Не применимо (PI не имеет этих фич) | OK |
| OSC 9;4 default off | 2 | KEEP HEAD (PI уже отключил) | OK |
| TypeBox 0.34 → 1.x | 7 | KEEP HEAD (PI уже использует typebox ^1.3.9) | OK |
| authStorage/modelRegistry → modelRuntime | 8 | KEEP HEAD (PI использует ModelRegistry) | Блокирует porting model-runtime.ts |
| ModelRegistry.refresh sync→async | 8 | KEEP HEAD (PI refresh sync) | Блокирует porting |
| sendSessionIdHeader → sessionAffinityFormat | 8 | KEEP HEAD (PI использует sendSessionIdHeader) | OK |
| TypeBox 1.3.7 deprecated API removal | 10 | KEEP HEAD | OK |
| ModelsStreamTransforms → ModelsRequestTransforms | 11 | KEEP HEAD | OK |
| message_update event delta-only | 11 | KEEP HEAD | OK |
| ModelRegistry.getApiKeyAndHeaders null values | 11 | KEEP HEAD | OK |
| ModelRuntime.setRuntimeApiKey signature change | 11 | KEEP HEAD | OK |
| .ts import extensions | All | Конвертированы в .js | OK (0 remaining) |
| erasableSyntaxOnly | 7 | Reverted tsconfig.base.json to PI | OK |
| prepareNextTurn vs shouldStopAfterTurn | 1 | Добавлен prepareNextTurn как optional в AgentLoopConfig | Partial (тип есть, вызова нет) |
| Fullscreen TUI API | 2+ | KEEP HEAD (PI TUI не имеет fullscreen) | Блокирует porting TUI files |

---

## 10. Рекомендации для восстановления пропущенных файлов

### Приоритет 1 — Тривиально (добавить как есть, fix .ts imports):
1. `packages/protocol/` (14 файлов) — standalone CBOR codec
2. `packages/telemetry/` (11 файлов) — standalone telemetry contracts
3. `packages/agent/src/harness/events.ts` — harness events
4. `packages/agent/src/harness/result.ts` — harness result
5. `packages/agent/src/harness/telemetry.ts` — harness telemetry
6. `packages/agent/src/search/` (2 файла) — search index
7. `packages/agent/src/stream-fn.ts` — stream function
8. `packages/agent/docs/` (3 файла) — documentation
9. `packages/coding-agent/src/extensions/llama/` (5 файлов) — HuggingFace integration
10. `packages/coding-agent/docs/` (3 файла) — documentation

### Приоритет 2 — Средне (требует добавления типов/интерфейсов):
1. `packages/client/` (22 файла) — добавить после protocol
2. `packages/agent/src/harness/tools/` (10 файлов) — добавить AgentHarnessTool, ShellCaptureProgress типы
3. `packages/agent/src/harness/session/jsonl/` (5 файлов) — добавить uuidv7 export в pi-ai
4. `packages/agent/src/harness/session/memory.ts` — расширить SessionStorage interface
5. `packages/agent/src/harness/reducer.ts` — добавить "deferred" в StopReason, DeferredHandle type
6. `packages/ai/src/providers/` (80 файлов) — per-provider model files (fix imports)
7. `packages/coding-agent/src/utils/` (7 файлов) — abort, image-process, management-http
8. `packages/server/` (22 файла) — добавить RpcExtensionUIRequest/Response типы
9. `packages/session-backends/sqlite-node/` — добавить SessionEntryCursorOptions type

### Приоритет 3 — Сложно (требует архитектурных изменений):
1. `packages/ai/src/api/` (26 файлов) — требует compat.ts рефакторинг
2. `packages/ai/src/auth/` (13 файлов) — требует auth storage рефакторинг
3. `packages/ai/src/` images (10 файлов) — требует image types в types.ts
4. `packages/coding-agent/src/core/` (21 файл) — требует ModelRuntime migration
5. `packages/coding-agent/src/modes/interactive/` (12 файлов) — требует TUI API расширение
6. `packages/tui/src/` (11 файлов) — требует fullscreen TUI API
7. `packages/evals/` (16 файлов) — требует fauxProvider API
8. Все harness тесты (19 файлов) — требуют fauxProvider + восстановленных harness модулей

---

## 11. Итоговая оценка полноты переноса

| Категория | Перенесено | Пропущено | Полнота |
|-----------|-----------|-----------|---------|
| PI-архитектура (daemon, kernel, RLM) | 556 файлов | 0 | 100% (сохранена полностью) |
| earendil harness (сохранённые) | 18 файлов | 28 файлов | 39% |
| earendil harness тесты | 0 | 19 файлов | 0% |
| earendil AI providers | PI версии | 80 файлов | ~0% (новые провайдеры) |
| earendil AI tests | PI версии | 63 файла | ~0% (новые тесты) |
| earendil AI utils | PI версии | 9 файлов | ~0% |
| earendil AI auth | PI версии | 13 файлов | ~0% |
| earendil AI api | PI версии | 26 файлов | ~0% |
| earendil coding-agent src | PI версии | 21 файл | ~0% (новые модули) |
| earendil coding-agent test | PI версии | 117 файлов | ~0% (новые тесты) |
| earendil TUI | PI версии | 22 файла | ~0% (fullscreen) |
| earendil new packages | 0 | 102 файла | 0% |
| CHANGELOG | Все | 0 | 100% |
| Документация | PI версии | 6 файлов | ~90% |

**Общая полнота переноса earendil:** ~20% (большинство новых файлов earendil не перенесены из-за API несовместимостей)

**Ключевые блокеры для полного переноса:**
1. fauxProvider API — блокирует все harness тесты
2. ModelRuntime migration — блокирует 21 coding-agent/src файл
3. Image types — блокирует 10 ai/src файлов
4. Fullscreen TUI API — блокирует 22 tui файла
5. Auth storage refactor — блокирует 13 ai/auth файлов
6. "deferred" stop reason — блокирует reducer.ts, session/context.ts
7. SessionStorage interface — блокирует session/memory.ts, storage package



---

## 12. Результаты восстановления Приоритет 1-2

### Восстановлено файлов: 83 (из 576 отсутствующих)

**Приоритет 1 — Тривиально (добавлено как есть, fix .ts imports):**

| Файлы | Статус | Примечания |
|-------|--------|-----------|
| `packages/protocol/` (14 файлов) | ✅ Добавлено | CBOR codec, wire protocol. Package.json exports исправлены на src/ |
| `packages/telemetry/` (11 файлов) | ✅ Добавлено | Telemetry contracts. Package.json exports исправлены на src/ |
| `packages/agent/src/harness/events.ts` | ✅ Добавлено | Harness events |
| `packages/agent/src/harness/result.ts` | ✅ Добавлено | Harness result types |
| `packages/agent/src/harness/telemetry.ts` | ✅ Добавлено | Harness telemetry. Импорт изменён на @earendil-works/pi-telemetry (через tsconfig paths) |
| `packages/agent/src/search/` (2 файла) | ✅ Добавлено | Search index, scanning. Требует session/types.ts (создан минимальный) |
| `packages/agent/src/stream-fn.ts` | ✅ Добавлено | Stream function |
| `packages/agent/docs/` (3 файла) | ✅ Добавлено | harness.md, search.md, telemetry-schema.md |
| `packages/coding-agent/docs/` (3 файла) | ✅ Добавлено | environment-variables.md, llama-cpp.md, security.md |
| `.pi/extensions/redraws.ts`, `.pi/extensions/tps.ts`, `.pi/prompts/cl.md` | ✅ Добавлено | PI config files |
| `packages/coding-agent/src/extensions/llama/` (5 файлов) | ❌ Не добавлено | Требует ModelRuntime API (getProviderAuth, refresh с провайдерами) — отложено на Приоритет 3 |

**Приоритет 2 — Средне (требует добавления типов/интерфейсов):**

| Файлы | Статус | Примечания |
|-------|--------|-----------|
| `packages/client/` (22 файла) | ✅ Добавлено | Session client, Unix transport. Package.json exports исправлены, tsconfig paths добавлены |
| `packages/agent/src/harness/tools/` (10 файлов) | ✅ Добавлено | AgentHarnessTool, ShellCaptureProgress типы добавлены в harness/types.ts. ShellCaptureProgress/Result обновлены в shell-output.ts. TruncationResult импортирован. inheritEnv добавлен в ExecutionEnvExecOptions |
| `packages/agent/src/harness/session/types.ts` | ✅ Создан минимальный | SessionMetadata (createdAt: number), Entry, SessionStorage (getEntries, findEntries, getLabel) |
| `packages/agent/src/harness/session/jsonl/` (5 файлов) | ❌ Не добавлено | Требует assertJsonSerializable из session.ts, SessionRepo из types.ts, JsonlSessionMetadata совместимости. Глубокая несовместимость PI vs earendil SessionMetadata (string vs number createdAt) |
| `packages/agent/src/harness/session/memory.ts` | ❌ Не добавлено | InMemorySessionStorage не реализует PI SessionStorage interface (нет getLeafId, setLeafId, createEntryId, getPathToRoot, getEntries) |
| `packages/agent/src/harness/reducer.ts` | ❌ Не добавлено | Требует "deferred" в StopReason, DeferredHandle type, AssistantMessage.deferred field. Добавлено в pi-ai types.ts, но удалено из-за cascade-эффектов на session/context.ts |
| `packages/ai/src/providers/` (80 файлов) | ❌ Не добавлено | Earendil провайдеры имеют другие экспорты, несовместимые с PI index.ts. Требует адаптации index.ts или разделения на отдельные модули |
| `packages/coding-agent/src/utils/` (5 из 7) | ✅ Частично добавлено | abort.ts, image-resize-core.ts, image-resize-worker.ts, management-http.ts, open-browser.ts. image-process.ts и tool-result-images.ts удалены (зависят от earendil image-convert API) |
| `packages/server/` (22 файла) | ❌ Не добавлено | ToolCall и Usage type mismatches. Protocol type constraints несовместимы с PI типами |
| `packages/session-backends/sqlite-node/` | ✅ Обновлено | Файлы обновлены из v0.84.2. Требует SessionEntryCursorOptions type (не добавлено) |

### Добавленные типы в PI для совместимости:

| Тип | Файл | Назначение |
|-----|------|-----------|
| `AgentHarnessTool` | `packages/agent/src/harness/types.ts` | Harness tool with context |
| `AgentHarnessToolContextSource` | `packages/agent/src/harness/types.ts` | Tool context provider |
| `AgentHarnessStreamOptions` | `packages/agent/src/harness/types.ts` | Stream options for harness |
| `ShellCaptureProgress` | `packages/agent/src/harness/utils/shell-output.ts` | Shell execution progress (output, truncation, fullOutputPath, lastLineBytes) |
| `inheritEnv` | `ExecutionEnvExecOptions` в `harness/types.ts` | Whether to inherit parent process env |
| `uuidv7` re-export | `packages/ai/src/index.ts` | Re-export from uuid package for harness session backends |
| `RpcExtensionUIRequest/Response` export | `packages/coding-agent/src/index.ts` | Re-export from rpc-types.ts for server/client packages |
| tsconfig paths | `tsconfig.json` | Path mappings for @earendil-works/pi-protocol, pi-client, pi-telemetry |

### Остаются отсутствующими (493 файла):

| Категория | Файлов | Блокер |
|-----------|--------|--------|
| ai/src/providers (новые) | 79 | Разные экспорты, несовместимые с PI index.ts |
| coding-agent/test (новые) | 63 | Зависят от новых модулей и API |
| ai/test (новые) | 63 | Зависят от новых провайдеров и API |
| coding-agent/test/suite/regressions | 45 | Зависят от новых фич |
| ai/src/api | 26 | Требует compat.ts рефакторинг |
| coding-agent/src/core | 14 | Требует ModelRuntime migration |
| agent/test/harness | 13 | Требует fauxProvider API |
| tui/test | 11 | Требует fullscreen TUI API |
| server | 9 | ToolCall/Usage type mismatches |
| ai/src/utils | 9 | Требует compat.ts изменения |
| ai/src | 9 | Image types, base, model catalog |
| ai/src/auth/oauth | 8 | Требует auth storage рефакторинг |
| coding-agent/src/modes | 7 | TUI API несовместимости |
| tui/src | 6 | Fullscreen TUI API |
| evals | 6 | Требует fauxProvider API |
| coding-agent/src/cli | 6 | Experimental CLI |
| agent/test/harness/session | 6 | Session API несовместимости |
| tui/src/components | 5 | Fullscreen TUI components |

### Итоговая полнота переноса после Приоритет 1-2:

| Метрика | До | После | Изменение |
|---------|-----|-------|-----------|
| Отсутствующих файлов earendil | 576 | 493 | +83 восстановлено |
| Файлов в merge/earendil-iterative | 1353 | 1436 | +83 файла |
| Тестов проходит | 5662 | 5662 | Без изменений (0 сбоев) |
| npm run check | PASS | PASS | Без изменений |

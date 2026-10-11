# PRIMER-7: Обрезка вывода — ИСПРАВЛЕНО

## Корневая причина

`park_update` (`crates/pa-daemon/src/streaming.rs`) дропал запаркованный `text_delta` при смене вида stream-события (`text_delta` → `toolcall_start` без `text_end` между ними). bb накапливает `agent_message_chunk` deltas; потеря последнего delta → обрезка текста ассистента посередине фразы.

Дополнительная причина: `append_decoded_text` (`output_accumulator.rs`) не считал одиночный `` переносом строки → прогресс-бары (`B1 PASSB2 idle`) считались одной строкой → байт-лимит резал посередине.

## Коммиты (local/v0.10.1-clean)

1. **`5922a5446`** — Fix 3 (`` как перенос) + Fix 2 (`⟨streaming…⟩` маркер в `on_update`)
   - `output_accumulator.rs:367`: `append_decoded_text` трактует `
`, `
`, `` как переносы
   - `bash.rs:401`: `on_update` добавляет `
⟨streaming…⟩` к snapshot running-процесса
2. **`2b94ea52c`** — 4 regression-теста Fix 3 (FAIL без, PASS с)
3. **`e41d7f4cc`** — review-фикс `current_line_bytes` для `
` (баг: `find(['
',''])` всегда давал 1, не 2)
4. **`0fc4027b4`** — 4 clippy-правки в 3 crate (предсуществующие)
5. **`4e4b4cb58`** — **корневой фикс**: `park_update` flush старого pending при смене вида

## Отклонено

- **Fix 1** (маркер `⟨no trailing newline⟩` в `format_output`): ломает golden parity `unicode-output` (TS fixture не имеет маркер). Revert.

## Тесты

- `streaming::` 9/9 pass (вкл. `a_kind_switch_without_settling_flushes_the_superseded_delta`)
- `turn_stream_tests::` 54/54 pass (вкл. `the_accumulated_text_delta_chunks_equal_the_final_message`)
- `output_accumulator` 5/5 pass
- `golden_bash` 1/1 pass
- regression: `a_kind_switch_without_settling` FAIL без `4e4b4cb58`, PASS с ним

//! Static system-prompt layers assembled into the cache-stable prefix. Layers must never
//! contain session-specific values (the cache-safety guard test pins the boundary).

pub const CORE_LAYER: &str = include_str!("layers/core.md");
pub const USAGE_LAYER: &str = include_str!("layers/usage.md");
pub const OPINIONATED_LAYER: &str = include_str!("layers/opinionated.md");
pub const PLAN_MODE_LAYER: &str = include_str!("layers/plan_mode.md");
pub const CODE_MODE_LAYER: &str = include_str!("layers/code_mode.md");
pub const DEBUG_MODE_LAYER: &str = include_str!("layers/debug_mode.md");
pub const ASK_MODE_LAYER: &str = include_str!("layers/ask_mode.md");

/// Source file of one layer (breakdown provenance).
#[must_use]
pub fn layer_source(name: &str) -> Option<&'static str> {
    match name {
        "core" => Some("prompts/layers/core.md"),
        "usage" => Some("prompts/layers/usage.md"),
        "opinionated" => Some("prompts/layers/opinionated.md"),
        "model-prompts" => Some("prompts/layers/model_prompts.toml"),
        "plan-mode" => Some("prompts/layers/plan_mode.md"),
        "code-mode" => Some("prompts/layers/code_mode.md"),
        "debug-mode" => Some("prompts/layers/debug_mode.md"),
        _ => None,
    }
}

//! ACP stdio mode served over a daemon session; see `daemon.rs`.

mod config_options;
pub mod daemon;
mod jsonrpc;
mod mcp;
mod meta;
mod producer;
pub mod session_registry;
mod types;
mod wire_config;
mod wire_events;

use std::path::Path;

use serde_json::{json, Value};

fn internal_error(id: &Value, details: &str) -> Value {
    jsonrpc::error_response(
        id,
        jsonrpc::INTERNAL_ERROR,
        "Internal error",
        Some(&json!({ "details": details })),
    )
}

/// Two paths are the same cwd when their canonical forms match, or when they
/// are the same directory on disk (dev/inode) — the bind-mount and
/// case-normalized-FS cases a lexical comparison misses.
pub(crate) fn same_cwd(requested: &Path, actual: &Path) -> bool {
    let requested = std::fs::canonicalize(requested).unwrap_or_else(|_| requested.to_path_buf());
    same_canonical_cwd(&requested, actual)
}

/// Same as `same_cwd` but the `requested` path is already canonicalized.
/// Lets callers canonicalize once and reuse across many entries.
pub(crate) fn same_canonical_cwd(canonical_requested: &Path, actual: &Path) -> bool {
    let actual = std::fs::canonicalize(actual).unwrap_or_else(|_| actual.to_path_buf());
    if canonical_requested == actual {
        return true;
    }
    #[cfg(unix)]
    {
        let identity = |path: &Path| -> Option<(u64, u64)> {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(path).ok()?;
            if metadata.dev() == 0 || metadata.ino() == 0 {
                return None;
            }
            Some((metadata.dev(), metadata.ino()))
        };
        if let (Some(left), Some(right)) = (identity(canonical_requested), identity(&actual)) {
            return left == right;
        }
    }
    false
}

//! Cross-process ACP session registry.
//!
//! bb forks/resumes an ACP provider by spawning a fresh agent process and
//! sending it `session/fork` or `session/load` with the source session's
//! ACP id, so the forked process must be able to map that id back to a
//! session file on disk. ACP session ids are per-process random UUIDs, so
//! `session/new` publishes `{ACP sessionId -> runtime session id + session
//! file}` into a small JSON registry inside the session directory; the fork
//! and load handlers read it back. The source and fork processes share the
//! session directory because bb reuses the source thread's environment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::session_store::session_file_name;

use serde::{Deserialize, Serialize};

/// The registry file name, placed inside the session directory.
const ACP_SESSION_REGISTRY_FILENAME: &str = "acp-session-registry.json";
/// Entries older than this are pruned on every read/write (7 days).
const ACP_SESSION_REGISTRY_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// One registered ACP session: the protocol-level id (registry map key),
/// the runtime session id, the session file at registration time, the cwd,
/// and the creation timestamp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionRegistryEntry {
    /// The runtime session id; `None` before the first persist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<String>,
    /// Session file path at registration time; `None` before the first persist.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    pub cwd: String,
    pub created_at: u64,
}

/// The registry map: `{ ACP sessionId -> entry }`.
type AcpSessionRegistry = HashMap<String, AcpSessionRegistryEntry>;

/// The registry file path inside `session_dir`.
fn registry_path(session_dir: &Path) -> PathBuf {
    session_dir.join(ACP_SESSION_REGISTRY_FILENAME)
}

/// Current time in milliseconds since the UNIX epoch.
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// Read the registry from disk; an empty map on any failure (missing file,
/// invalid JSON, non-object).
fn read_registry(session_dir: &Path) -> AcpSessionRegistry {
    let path = registry_path(session_dir);
    let read_once = || -> Option<AcpSessionRegistry> {
        let content = std::fs::read_to_string(&path).ok()?;
        if content.is_empty() {
            return None;
        }
        serde_json::from_str::<AcpSessionRegistry>(&content).ok()
    };
    // Retry once after a brief delay to handle a concurrent atomic rename.
    if let Some(registry) = read_once() {
        return registry;
    }
    std::thread::sleep(std::time::Duration::from_millis(10));
    read_once().unwrap_or_default()
}

/// Write the registry to disk as pretty-printed JSON; best-effort (a
/// failed write only degrades fork/load support).
fn write_registry(session_dir: &Path, registry: &AcpSessionRegistry) {
    let _ = std::fs::create_dir_all(session_dir);
    let path = registry_path(session_dir);
    let mut content = serde_json::to_string_pretty(registry).unwrap_or_default();
    content.push('\n');
    // Atomic write: write to a temp file, then rename. This prevents
    // concurrent readers from seeing a partially-written (empty) file.
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, &content).is_ok() {
        let _ = std::fs::rename(&temp, &path);
    }
}

/// Drop entries older than the max age.
fn prune_registry(registry: &mut AcpSessionRegistry, now: u64) {
    registry.retain(|_, entry| now.saturating_sub(entry.created_at) <= ACP_SESSION_REGISTRY_MAX_AGE_MS);
}

/// Register or update one ACP session in the registry.
///
/// Best-effort: a failed write only degrades fork/load support for this
/// session; `session/new` must not fail because of it.
pub fn register_session(
    session_dir: &Path,
    session_id: &str,
    runtime_session_id: Option<String>,
    session_file: Option<String>,
    cwd: &str,
) {
    let mut registry = read_registry(session_dir);
    prune_registry(&mut registry, now_millis());
    registry.insert(
        session_id.to_string(),
        AcpSessionRegistryEntry {
            runtime_session_id,
            session_file,
            cwd: cwd.to_string(),
            created_at: now_millis(),
        },
    );
    write_registry(session_dir, &registry);
}

/// The resolution result: the registry entry plus the resolved session
/// file path (if one exists on disk).
pub struct ResolvedSession {
    pub entry: AcpSessionRegistryEntry,
    pub session_file: Option<PathBuf>,
}

/// Resolve a registered ACP session id to its session file.
///
/// Prefers the file recorded at registration time; falls back to scanning
/// the session directory for the runtime session id, which covers sessions
/// whose file only appeared after the first persist. Returns `None` when
/// the id is not in the registry.
pub fn resolve_session(session_dir: &Path, session_id: &str) -> Option<ResolvedSession> {
    let mut registry = read_registry(session_dir);
    prune_registry(&mut registry, now_millis());
    let entry = registry.get(session_id)?.clone();
    // Prefer the recorded file if it still exists.
    if let Some(file_path) = entry.session_file.as_deref() {
        let path = PathBuf::from(file_path);
        if path.exists() {
            return Some(ResolvedSession {
                entry,
                session_file: Some(path),
            });
        }
    }
    // Fall back to scanning the session directory for the runtime session id.
    if let Some(runtime_id) = entry.runtime_session_id.as_deref() {
        if let Some(found) = scan_session_dir(session_dir, runtime_id) {
            return Some(ResolvedSession {
                entry,
                session_file: Some(found),
            });
        }
        // The session may have been archived (moved to sessions-archive/ by
        // the daemon's periodic sweep). Restore it from the archive before
        // giving up — the archive is a sibling of the sessions directory.
        if let Some(archive_dir) = session_dir
            .parent()
            .map(|parent| parent.join(crate::session_archive::ARCHIVE_DIR_NAME))
        {
            if archive_dir.is_dir() {
                let archive_file = archive_dir.join(session_file_name(runtime_id));
                if archive_file.is_file() {
                    let dest = session_dir.join(session_file_name(runtime_id));
                    if !dest.exists() && std::fs::rename(&archive_file, &dest).is_ok() {
                        return Some(ResolvedSession {
                            entry,
                            session_file: Some(dest),
                        });
                    }
                }
            }
        }
    }
    Some(ResolvedSession {
        entry,
        session_file: None,
    })
}

/// Scan `session_dir` for a `.jsonl` file whose header session id matches
/// `runtime_session_id`. Returns the first match.
fn scan_session_dir(session_dir: &Path, runtime_session_id: &str) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(session_dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        if let Some(header) = pa_core::session::manager::read_session_header(&path) {
            if header.id == runtime_session_id {
                return Some(path);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_resolve_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            Some("/tmp/session-1.jsonl".to_string()),
            "/tmp",
        );
        // The recorded file doesn't exist; resolve falls back to a scan.
        let resolved = resolve_session(&session_dir, "acp-1");
        assert!(resolved.is_some());
        let resolved = resolved.unwrap();
        assert_eq!(resolved.entry.cwd, "/tmp");
        assert_eq!(resolved.entry.runtime_session_id.as_deref(), Some("runtime-1"));
        // No matching file on disk.
        assert!(resolved.session_file.is_none());
    }

    #[test]
    fn resolve_returns_none_for_unknown_session() {
        let dir = tempfile::tempdir().unwrap();
        assert!(resolve_session(dir.path(), "unknown").is_none());
    }

    #[test]
    fn prune_drops_expired_entries() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        // Insert an entry, then manually backdate it.
        register_session(
            &session_dir,
            "old-session",
            None,
            None,
            "/tmp",
        );
        {
            let mut registry = read_registry(&session_dir);
            let entry = registry.get_mut("old-session").unwrap();
            entry.created_at = now_millis() - ACP_SESSION_REGISTRY_MAX_AGE_MS - 1000;
            write_registry(&session_dir, &registry);
        }
        // A subsequent read prunes the expired entry.
        assert!(resolve_session(&session_dir, "old-session").is_none());
    }

    #[test]
    fn register_updates_existing_entry() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        register_session(&session_dir, "acp-1", None, None, "/tmp");
        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            Some("/tmp/session-1.jsonl".to_string()),
            "/tmp",
        );
        let resolved = resolve_session(&session_dir, "acp-1").unwrap();
        assert_eq!(resolved.entry.runtime_session_id.as_deref(), Some("runtime-1"));
        assert_eq!(
            resolved.entry.session_file.as_deref(),
            Some("/tmp/session-1.jsonl")
        );
    }

    #[test]
    fn resolve_prefers_existing_recorded_file() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        // Create a real session file.
        let session_file = session_dir.join("real-session.jsonl");
        std::fs::write(
            &session_file,
            format!(
                "{{\"type\":\"session\",\"id\":\"runtime-1\",\"timestamp\":\"2026-09-20T00:00:00.000Z\",\"cwd\":\"{}\"}}\n",
                dir.path().to_string_lossy()
            ),
        )
        .unwrap();

        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            Some(session_file.to_string_lossy().to_string()),
            &dir.path().to_string_lossy(),
        );
        let resolved = resolve_session(&session_dir, "acp-1").unwrap();
        assert_eq!(resolved.session_file, Some(session_file));
    }

    #[test]
    fn resolve_falls_back_to_dir_scan_for_runtime_id() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        // Create a real session file with a known runtime id.
        let session_file = session_dir.join("discovered.jsonl");
        std::fs::write(
            &session_file,
            format!(
                "{{\"type\":\"session\",\"id\":\"runtime-42\",\"timestamp\":\"2026-09-20T00:00:00.000Z\",\"cwd\":\"{}\"}}\n",
                dir.path().to_string_lossy()
            ),
        )
        .unwrap();

        // Register without a session_file path — the scan should find it.
        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-42".to_string()),
            None,
            &dir.path().to_string_lossy(),
        );
        let resolved = resolve_session(&session_dir, "acp-1").unwrap();
        assert_eq!(resolved.session_file, Some(session_file));
    }
}

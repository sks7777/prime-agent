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
    registry
        .retain(|_, entry| now.saturating_sub(entry.created_at) <= ACP_SESSION_REGISTRY_MAX_AGE_MS);
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

/// Register a session only if no entry for `session_id` already exists
/// with a `session_file` that points to an existing file on disk.
///
/// This prevents a repeated `session/new` (e.g. bb reconnecting) from
/// overwriting a valid registry entry with a stale one. Returns `true`
/// when the entry was inserted, `false` when the existing entry was kept.
#[must_use]
pub fn register_session_if_absent(
    session_dir: &Path,
    session_id: &str,
    runtime_session_id: Option<String>,
    session_file: Option<String>,
    cwd: &str,
) -> bool {
    let mut registry = read_registry(session_dir);
    prune_registry(&mut registry, now_millis());
    if let Some(existing) = registry.get(session_id) {
        if let Some(file_path) = existing.session_file.as_deref() {
            if PathBuf::from(file_path).exists() {
                return false;
            }
        }
    }
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
    true
}

/// Search the registry for an entry whose `cwd` matches `cwd` and whose
/// `session_file` (if recorded) still exists on disk, or whose
/// `runtime_session_id` resolves to a file via a directory scan.
///
/// Used by `session/new` to make reconnections idempotent: when bb
/// reconnects with the same cwd, the existing session is reused instead
/// of creating a new one.
#[must_use]
pub fn find_session_by_cwd(session_dir: &Path, cwd: &str) -> Option<ResolvedSession> {
    let mut registry = read_registry(session_dir);
    prune_registry(&mut registry, now_millis());
    let cwd_path = Path::new(cwd);
    // Canonicalize once: same_cwd would re-canonicalize the requested
    // path on every registry entry, repeating blocking syscalls.
    let canonical_cwd =
        std::fs::canonicalize(cwd_path).unwrap_or_else(|_| cwd_path.to_path_buf());
    // Newest-first candidates: several entries can share one cwd (forks,
    // probe sessions, earlier threads), and the arbitrary HashMap order
    // made the adoption nondeterministic. Resolve the newest entry whose
    // session file survives on disk.
    let mut candidates: Vec<(String, AcpSessionRegistryEntry)> = registry
        .into_iter()
        .filter(|(_, entry)| super::same_canonical_cwd(&canonical_cwd, Path::new(&entry.cwd)))
        .collect();
    candidates.sort_by_key(|(_, entry)| std::cmp::Reverse(entry.created_at));
    // First preference: a recorded session file that still passes a header
    // sanity check (parseable, a version this build reads — a same-id file
    // from an incompatible schema must not be switched onto).
    for (acp_session_id, entry) in &candidates {
        if let Some(file_path) = entry.session_file.as_deref() {
            if let Some(path) = validated_session_file(Path::new(file_path)) {
                return Some(ResolvedSession {
                    acp_session_id: acp_session_id.clone(),
                    entry: entry.clone(),
                    session_file: Some(path),
                });
            }
        }
    }
    // Second preference: one bounded directory scan for every candidate's
    // runtime id (one first-line read per .jsonl file, not one scan per
    // entry), adopting the NEWEST matching candidate.
    let runtime_ids: Vec<(&str, u64)> = candidates
        .iter()
        .enumerate()
        .filter_map(|(rank, (_, entry))| {
            entry
                .runtime_session_id
                .as_deref()
                .map(|id| (id, rank as u64))
        })
        .collect();
    if runtime_ids.is_empty() {
        return None;
    }
    if let Some((best_rank, best_file)) =
        scan_session_dir_ranked(session_dir, runtime_ids.as_slice())
    {
        let (acp_session_id, entry) = candidates.swap_remove(best_rank);
        return Some(ResolvedSession {
            acp_session_id,
            entry,
            session_file: Some(best_file),
        });
    }
    // Neither a recorded file nor the dir scan resolved: the periodic sweep
    // may have archived a candidate's file — restore the newest one that
    // has an archive copy (parity with `resolve_session`'s archive fallback).
    for (acp_session_id, entry) in &candidates {
        let Some(runtime_id) = entry.runtime_session_id.as_deref() else {
            continue;
        };
        if let Some(restored) = restore_archived_session_file(session_dir, runtime_id) {
            return Some(ResolvedSession {
                acp_session_id: acp_session_id.clone(),
                entry: entry.clone(),
                session_file: Some(restored),
            });
        }
    }
    None
}

/// A session file path that exists and parses into a header this build
/// reads (`None` versions are v1 files). Guards the cwd-reuse adoption:
/// a same-id file from an incompatible schema must not be switched onto.
fn validated_session_file(path: &Path) -> Option<PathBuf> {
    let header = pa_core::session::manager::read_session_header(path)?;
    if header
        .version
        .is_some_and(|version| version > pa_core::session::CURRENT_SESSION_VERSION)
    {
        return None;
    }
    Some(path.to_path_buf())
}

/// One walk of `session_dir` matching every `.jsonl` first line against the
/// candidate runtime ids. Returns `(rank, path)` of the best (lowest-rank =
/// newest-candidate) match.
fn scan_session_dir_ranked(
    session_dir: &Path,
    runtime_ids: &[(&str, u64)],
) -> Option<(usize, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(session_dir) else {
        return None;
    };
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|ext| ext != "jsonl") {
            continue;
        }
        // The same schema guard the recorded-file check applies: a
        // same-id file from an incompatible schema is not adopted.
        let Some(header) = pa_core::session::manager::read_session_header(&path) else {
            continue;
        };
        if header
            .version
            .is_some_and(|version| version > pa_core::session::CURRENT_SESSION_VERSION)
        {
            continue;
        }
        let Some(&(_, rank)) = runtime_ids.iter().find(|(id, _)| *id == header.id) else {
            continue;
        };
        if best.as_ref().is_none_or(|(best_rank, _)| rank < *best_rank) {
            best = Some((rank, path));
            // Rank 0 (newest candidate) is unbeatable — stop scanning.
            if rank == 0 {
                break;
            }
        }
    }
    best.map(|(best_rank, path)| (best_rank as usize, path))
}

/// Restore one runtime session file from the sessions archive (the
/// periodic sweep moves idle files there) into `session_dir`, mirroring
/// `resolve_session`'s archive fallback.
fn restore_archived_session_file(session_dir: &Path, runtime_session_id: &str) -> Option<PathBuf> {
    let archive_dir = session_dir
        .parent()?
        .join(crate::session_archive::ARCHIVE_DIR_NAME);
    let archive_file = archive_dir.join(session_file_name(runtime_session_id));
    if !archive_file.is_file() {
        return None;
    }
    let dest = session_dir.join(session_file_name(runtime_session_id));
    if dest.exists() {
        return validated_session_file(&dest);
    }
    std::fs::rename(&archive_file, &dest).ok()?;
    validated_session_file(&dest)
}

/// The resolution result: the registered ACP session id (the registry map
/// key), the registry entry, and the resolved session file path (if one
/// exists on disk).
pub struct ResolvedSession {
    pub acp_session_id: String,
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
    // Prefer the recorded file if it still exists and passes the
    // schema version guard.
    if let Some(file_path) = entry.session_file.as_deref() {
        let path = PathBuf::from(file_path);
        if let Some(validated) = validated_session_file(&path) {
            return Some(ResolvedSession {
                acp_session_id: session_id.to_string(),
                entry,
                session_file: Some(validated),
            });
        }
    }
    // Fall back to scanning the session directory for the runtime session id.
    if let Some(runtime_id) = entry.runtime_session_id.as_deref() {
        if let Some(found) = scan_session_dir(session_dir, runtime_id) {
            return Some(ResolvedSession {
                acp_session_id: session_id.to_string(),
                entry,
                session_file: Some(found),
            });
        }
        // The session may have been archived (moved to sessions-archive/ by
        // the daemon's periodic sweep). Restore it from the archive before
        // giving up.
        if let Some(restored) = restore_archived_session_file(session_dir, runtime_id) {
            return Some(ResolvedSession {
                acp_session_id: session_id.to_string(),
                entry,
                session_file: Some(restored),
            });
        }
    }
    Some(ResolvedSession {
        acp_session_id: session_id.to_string(),
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
        let Some(header) = pa_core::session::manager::read_session_header(&path) else {
            continue;
        };
        if header
            .version
            .is_some_and(|version| version > pa_core::session::CURRENT_SESSION_VERSION)
        {
            continue;
        }
        if header.id == runtime_session_id {
            return Some(path);
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
        assert_eq!(
            resolved.entry.runtime_session_id.as_deref(),
            Some("runtime-1")
        );
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
        register_session(&session_dir, "old-session", None, None, "/tmp");
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
        assert_eq!(
            resolved.entry.runtime_session_id.as_deref(),
            Some("runtime-1")
        );
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

    #[test]
    fn register_if_absent_preserves_existing_with_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        let session_file = session_dir.join("existing.jsonl");
        std::fs::write(
            &session_file,
            format!(
                r#"{{"type":"session","id":"runtime-1","timestamp":"2026-09-20T00:00:00.000Z","cwd":"{}"}}"#,
                dir.path().to_string_lossy()
            ),
        )
        .unwrap();

        // Register the original entry with a valid session file.
        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            Some(session_file.to_string_lossy().to_string()),
            &dir.path().to_string_lossy(),
        );

        // Attempt to re-register with different runtime data — should be
        // rejected because the existing file still exists.
        let inserted = register_session_if_absent(
            &session_dir,
            "acp-1",
            Some("runtime-NEW".to_string()),
            Some("/tmp/other.jsonl".to_string()),
            &dir.path().to_string_lossy(),
        );
        assert!(!inserted);

        // The original entry is preserved.
        let resolved = resolve_session(&session_dir, "acp-1").unwrap();
        assert_eq!(
            resolved.entry.runtime_session_id.as_deref(),
            Some("runtime-1")
        );
    }

    #[test]
    fn register_if_absent_overwrites_when_file_missing() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        // Register with a session_file that doesn't exist on disk.
        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            Some("/tmp/nonexistent.jsonl".to_string()),
            "/tmp",
        );

        // register_session_if_absent should overwrite since the file is gone.
        let inserted = register_session_if_absent(
            &session_dir,
            "acp-1",
            Some("runtime-2".to_string()),
            Some("/tmp/new.jsonl".to_string()),
            "/tmp",
        );
        assert!(inserted);

        let resolved = resolve_session(&session_dir, "acp-1").unwrap();
        assert_eq!(
            resolved.entry.runtime_session_id.as_deref(),
            Some("runtime-2")
        );
    }

    #[test]
    fn register_if_absent_inserts_new_entry() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        let inserted = register_session_if_absent(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            Some("/tmp/session.jsonl".to_string()),
            "/tmp",
        );
        assert!(inserted);
        assert!(resolve_session(&session_dir, "acp-1").is_some());
    }

    #[test]
    fn find_session_by_cwd_returns_matching_entry() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        let session_file = session_dir.join("by-cwd.jsonl");
        std::fs::write(
            &session_file,
            format!(
                r#"{{"type":"session","id":"runtime-1","timestamp":"2026-09-20T00:00:00.000Z","cwd":"{}"}}"#,
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

        let found = find_session_by_cwd(&session_dir, &dir.path().to_string_lossy()).unwrap();
        assert_eq!(found.entry.cwd, dir.path().to_string_lossy());
        assert_eq!(found.session_file, Some(session_file));
    }

    #[test]
    fn find_session_by_cwd_returns_none_when_no_match() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        register_session(
            &session_dir,
            "acp-1",
            Some("runtime-1".to_string()),
            None,
            "/some/other/cwd",
        );

        assert!(find_session_by_cwd(&session_dir, &dir.path().to_string_lossy()).is_none());
    }

    #[test]
    fn find_session_by_cwd_skips_entries_with_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();

        // Register with a session_file that doesn't exist and no
        // runtime_session_id to fall back to.
        register_session(
            &session_dir,
            "acp-1",
            None,
            Some("/tmp/nonexistent.jsonl".to_string()),
            &dir.path().to_string_lossy(),
        );

        assert!(find_session_by_cwd(&session_dir, &dir.path().to_string_lossy()).is_none());
    }

    #[test]
    fn find_session_by_cwd_restores_an_archived_session_file() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();
        let cwd = dir.path().to_string_lossy().to_string();

        // The recorded file is gone; the sweep archived it to the sibling
        // sessions-archive/ directory.
        let archive_dir = dir.path().join("sessions-archive");
        std::fs::create_dir_all(&archive_dir).unwrap();
        std::fs::write(
            archive_dir.join("runtime-9.jsonl"),
            format!(
                r#"{{"type":"session","id":"runtime-9","timestamp":"2026-10-17T00:00:00.000Z","cwd":"{cwd}"}}"#,
            ),
        )
        .unwrap();
        register_session(
            &session_dir,
            "acp-9",
            Some("runtime-9".to_string()),
            Some(
                session_dir
                    .join("runtime-9.jsonl")
                    .to_string_lossy()
                    .to_string(),
            ),
            &cwd,
        );

        let found = find_session_by_cwd(&session_dir, &cwd).unwrap();
        assert_eq!(found.acp_session_id, "acp-9");
        let restored = found.session_file.unwrap();
        assert_eq!(restored, session_dir.join("runtime-9.jsonl"));
        assert!(
            restored.is_file(),
            "the archived file is restored into sessions/"
        );
    }

    #[test]
    fn find_session_by_cwd_rejects_a_newer_schema_recorded_file() {
        let dir = tempfile::tempdir().unwrap();
        let session_dir = dir.path().join("sessions");
        std::fs::create_dir_all(&session_dir).unwrap();
        let cwd = dir.path().to_string_lossy().to_string();

        // The recorded file parses but carries a version this build does
        // not read: the adoption must skip it.
        let future_file = session_dir.join("runtime-future.jsonl");
        std::fs::write(
            &future_file,
            format!(
                r#"{{"type":"session","version":99,"id":"runtime-future","timestamp":"2026-10-17T00:00:00.000Z","cwd":"{cwd}"}}"#,
            ),
        )
        .unwrap();
        register_session(
            &session_dir,
            "acp-future",
            Some("runtime-future".to_string()),
            Some(future_file.to_string_lossy().to_string()),
            &cwd,
        );

        assert!(find_session_by_cwd(&session_dir, &cwd).is_none());
    }
}

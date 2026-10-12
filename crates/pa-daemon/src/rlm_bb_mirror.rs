//! bb mirror threads for RLM subagents (PRIME-11/PRIME-24).
//!
//! A depth-0 session inside bb (BB_THREAD_ID/BB_PROJECT_ID set) mirrors
//! every plain `rlm.spawn` by default: the child is admitted with a
//! deferred turn, and this module writes the single-use claim file and
//! spawns the mirror bb thread whose first prompt rebinds onto the child.
//! Explicit `bb_mirror=True` keeps the PRIME-11 semantics (the caller
//! brings its own thread); `bb_mirror=False` forces a plain, invisible
//! child. Everything degrades locally: when the bb CLI is missing or the
//! thread spawn fails, the child falls back to a plain headless admission
//! turn.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
use serde_json::json;
use tokio::process::Command;

/// The task-frame label prepended to the mirror prompt body.
pub const RLM_MIRROR_TASK_FRAME: &str = "[task from parent]";

/// How long the parent waits for the roster to expose the child's daemon
/// session before spawning the mirror thread.
pub const RLM_MIRROR_ROSTER_TIMEOUT_MS: u64 = 20_000;
const RLM_MIRROR_ROSTER_POLL_MS: u64 = 300;

/// How long `bb thread spawn` may take before it times out.
const RLM_MIRROR_SPAWN_TIMEOUT_MS: u64 = 30_000;

/// The regex pattern for the mirror marker line. The nonce is 32 hex chars.
pub const RLM_MIRROR_MARKER_PATTERN: &str = r"^\[rlm-mirror:([a-f0-9]{32})\][ \t]*$";

/// A stale claim must not rebind; the parent re-spawns instead.
pub const RLM_MIRROR_CLAIM_TTL_MS: u64 = 10 * 60_000;

const RLM_MIRROR_CLAIMS_DIR: &str = "acp-mirror-claims";

/// How long a deferred-admission mirror child waits for its mirror
/// thread's first prompt before settling as failed (PRIME-11).
pub const BB_MIRROR_WAIT_TIMEOUT_MS: u64 = 10 * 60_000;

/// The bb mirror environment extracted from process env vars.
#[derive(Debug, Clone)]
pub struct BbMirrorEnv {
    pub thread_id: String,
    pub project_id: String,
    pub environment_id: Option<String>,
    /// bb binary override; falls back to "bb" on PATH.
    pub bb_cli: Option<String>,
}

/// The kind of bb spawn failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BbSpawnFailureKind {
    /// `bb` could not be spawned (proven no thread exists).
    SpawnError,
    /// `bb` exited with a non-zero code (thread existence unknown).
    NonzeroExit,
    /// `bb` did not exit within the timeout (thread existence unknown).
    Timeout,
}

/// Error from `bb thread spawn`. The `kind` tells the caller whether
/// the thread provably does not exist (`SpawnError`) or existence is
/// ambiguous (`NonzeroExit` / `Timeout`).
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct BbSpawnFailed {
    pub kind: BbSpawnFailureKind,
    pub message: String,
}

impl BbSpawnFailed {
    /// True only when bb definitely created no thread, so the caller may
    /// fall back to a plain headless child.
    pub fn definitive(&self) -> bool {
        self.kind == BbSpawnFailureKind::SpawnError
    }
}

/// A parsed mirror marker from a prompt's first post-wrapper text block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RlmMirrorMarker {
    pub claim_nonce: String,
    pub remaining: String,
}

/// The claim file payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct RlmMirrorClaim {
    pub(crate) target: String,
    #[serde(rename = "createdAtMs")]
    pub(crate) created_at_ms: u64,
}

/// True when this session runs inside a bb thread (the ACP plugin injects
/// both ids).
pub fn is_inside_bb_thread_session(env: &HashMap<String, String>) -> bool {
    env.get("BB_THREAD_ID").is_some_and(|id| !id.is_empty())
        && env.get("BB_PROJECT_ID").is_some_and(|id| !id.is_empty())
}

/// Extract the bb mirror env from process env vars, or `None` outside bb.
pub fn bb_mirror_env_from_process(env: &HashMap<String, String>) -> Option<BbMirrorEnv> {
    let thread_id = env.get("BB_THREAD_ID").filter(|id| !id.is_empty())?;
    let project_id = env.get("BB_PROJECT_ID").filter(|id| !id.is_empty())?;
    let environment_id = env
        .get("BB_ENVIRONMENT_ID")
        .filter(|id| !id.is_empty())
        .cloned();
    let bb_cli = env.get("BB_CLI").filter(|s| !s.is_empty()).cloned();
    Some(BbMirrorEnv {
        thread_id: thread_id.clone(),
        project_id: project_id.clone(),
        environment_id,
        bb_cli,
    })
}

/// Auto-mirror default: plain `rlm.spawn` in a depth-0 bb session mirrors
/// the child into the thread list. `PRIME_AGENT_AUTO_MIRROR=0|false|off`
/// disables it.
pub fn should_auto_mirror_rlm_child(depth: u32, env: &HashMap<String, String>) -> bool {
    if depth != 0 {
        return false;
    }
    if !is_inside_bb_thread_session(env) {
        return false;
    }
    let override_val = env
        .get("PRIME_AGENT_AUTO_MIRROR")
        .map(|s| s.trim().to_lowercase());
    !matches!(override_val.as_deref(), Some("0" | "false" | "off"))
}

/// Generate a new 32-char hex nonce for a mirror claim.
pub fn new_mirror_claim_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Build the mirror prompt: leading claim-nonce marker line, then the
/// task body.
pub fn build_rlm_mirror_prompt(nonce: &str, prompt: &str) -> String {
    format!("[rlm-mirror:{nonce}]\n{RLM_MIRROR_TASK_FRAME}\n\n{prompt}")
}

/// The claims directory under the agent dir.
fn mirror_claims_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.join(RLM_MIRROR_CLAIMS_DIR)
}

/// Write the single-use claim the mirror thread's ACP frontend consumes on
/// boot.
pub fn write_rlm_mirror_claim(nonce: &str, target: &str, agent_dir: &Path) -> Result<()> {
    let claims_dir = mirror_claims_dir(agent_dir);
    std::fs::create_dir_all(&claims_dir)
        .with_context(|| format!("create mirror claims dir {}", claims_dir.display()))?;
    let claim = RlmMirrorClaim {
        target: target.to_string(),
        created_at_ms: crate::util::now_ms(),
    };
    let path = claims_dir.join(format!("{nonce}.json"));
    let content =
        serde_json::to_string(&claim).with_context(|| format!("serialize mirror claim {nonce}"))?;
    std::fs::write(&path, content)
        .with_context(|| format!("write mirror claim {}", path.display()))?;
    Ok(())
}

/// Remove a claim file (best-effort; a leftover claim only stays valid
/// until its TTL expires).
pub fn remove_rlm_mirror_claim(nonce: &str, agent_dir: &Path) {
    let _ = std::fs::remove_file(mirror_claims_dir(agent_dir).join(format!("{nonce}.json")));
}

/// Resolve the claim a mirror marker points at. Stale claims return
/// `None`. The caller consumes the claim after a successful rebind.
pub(crate) fn read_rlm_mirror_claim(nonce: &str, agent_dir: &Path) -> Option<RlmMirrorClaim> {
    let path = mirror_claims_dir(agent_dir).join(format!("{nonce}.json"));
    let content = std::fs::read_to_string(&path).ok()?;
    let claim: RlmMirrorClaim = serde_json::from_str(&content).ok()?;
    if claim.target.is_empty() {
        return None;
    }
    let now = crate::util::now_ms();
    if now.saturating_sub(claim.created_at_ms) > RLM_MIRROR_CLAIM_TTL_MS {
        return None;
    }
    Some(claim)
}

/// Consume a claim after a successful rebind so its nonce cannot be
/// replayed (best-effort removal).
pub fn consume_rlm_mirror_claim(nonce: &str, agent_dir: &Path) {
    remove_rlm_mirror_claim(nonce, agent_dir);
}

/// Remove the marker line from the full prompt text; the wrapper text
/// must survive.
pub fn strip_rlm_mirror_marker_line(text: &str, claim_nonce: &str) -> String {
    let marker_line = format!("[rlm-mirror:{claim_nonce}]");
    let lines: Vec<&str> = text.lines().collect();
    let mut result = Vec::with_capacity(lines.len());
    let mut removed = false;
    for line in &lines {
        if !removed && line.trim() == marker_line {
            removed = true;
            continue;
        }
        result.push(*line);
    }
    result.join("\n").trim().to_string()
}

/// Strip leading bb tell attribution lines from the head text (TS
/// `headWithoutTellAttribution`): bb prepends an attribution block
/// before steered prompts.
pub fn head_without_tell_attribution(head: &str) -> String {
    // bb tell attribution: a leading block of lines that start with `>` or
    // are blank, ending at the first non-attribution line. Keep it simple:
    // strip leading lines that start with `>` (quoted attribution).
    let mut lines = head.lines();
    let mut result = Vec::new();
    let mut past_attribution = false;
    for line in &mut lines {
        if !past_attribution && (line.trim().is_empty() || line.trim_start().starts_with('>')) {
            continue;
        }
        past_attribution = true;
        result.push(line);
    }
    result.join("\n").trim().to_string()
}

/// Parse a mirror marker from the text. Returns the nonce and the
/// remaining text (after the marker line). bb tell attribution may
/// precede the marker.
pub fn parse_rlm_mirror_marker(text: &str) -> Option<RlmMirrorMarker> {
    let stripped = head_without_tell_attribution(text);
    let first_break = stripped.find('\n');
    let head = match first_break {
        None => stripped.as_str(),
        Some(idx) => &stripped[..idx],
    }
    .trim();
    // Manual regex-free match: `[rlm-mirror:<32 hex>]`
    let prefix = "[rlm-mirror:";
    let suffix = "]";
    if !head.starts_with(prefix) || !head.ends_with(suffix) {
        return None;
    }
    let nonce = &head[prefix.len()..head.len() - suffix.len()];
    if nonce.len() != 32 || !nonce.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')) {
        return None;
    }
    let remaining = match first_break {
        None => String::new(),
        Some(idx) => stripped[idx + 1..].trim().to_string(),
    };
    Some(RlmMirrorMarker {
        claim_nonce: nonce.to_string(),
        remaining,
    })
}

/// Mirror thread titles read `<name> · <task summary>` (60-char summary).
pub fn mirror_thread_title(name: &str, task: &str) -> String {
    let summary: String = task
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(60)
        .collect();
    if summary.is_empty() {
        name.to_string()
    } else {
        format!("{name} · {summary}")
    }
}

/// Whether a target session summary is a valid RLM mirror target: it must
/// be an RLM subagent session (rlmDepth > 0) of the same cwd.
pub fn is_rlm_mirror_target_summary(summary: &Value, requested_cwd: &Path) -> bool {
    let summary_cwd = match summary.get("cwd").and_then(Value::as_str) {
        Some(cwd) => Path::new(cwd),
        None => return false,
    };
    if !crate::acp::same_cwd(summary_cwd, requested_cwd) {
        return false;
    }
    // Daemon RLM subagent sessions always carry rlmDepth > 0.
    summary
        .get("rlmDepth")
        .and_then(Value::as_u64)
        .is_some_and(|depth| depth > 0)
}

/// The outcome of a bb mirror thread spawn.
#[derive(Debug, Clone)]
pub struct BbMirrorSpawnOutcome {
    /// Thread id when bb reported it; a created-but-unreported thread
    /// stays `None`.
    pub thread_id: Option<String>,
    pub thread_created: bool,
}

/// The options for spawning a bb mirror thread.
#[derive(Debug, Clone)]
pub struct BbMirrorSpawnOptions {
    pub project_id: String,
    pub environment_id: Option<String>,
    pub title: String,
    /// Full mirror prompt: `[rlm-mirror:<nonce>]` marker line plus the
    /// task body.
    pub prompt: String,
    /// bb binary override; defaults to `BB_CLI` or "bb".
    pub bb_command: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// Spawn the mirror bb thread via the bb CLI and parse the thread id.
///
/// A zero exit with unparsable output still created a thread, so it is
/// reported as created without an id and the caller must not retry
/// blindly. A timeout or a late nonzero exit leaves thread existence
/// unknown (`kind != SpawnError`), so the caller keeps the claim and
/// parks instead of falling back.
pub async fn spawn_bb_mirror_thread(options: BbMirrorSpawnOptions) -> Result<BbMirrorSpawnOutcome> {
    let timeout_ms = options.timeout_ms.unwrap_or(RLM_MIRROR_SPAWN_TIMEOUT_MS);
    let bb_command = options
        .bb_command
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("bb");
    let mut cmd = Command::new(bb_command);
    cmd.args([
        "thread",
        "spawn",
        "--json",
        "--project",
        &options.project_id,
        "--parent-self",
        "--provider",
        "acp-prime-agent",
        "--title",
        &options.title,
        "--prompt-file",
        "-",
    ]);
    if let Some(env_id) = &options.environment_id {
        cmd.args(["--environment", env_id]);
    }
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|error| BbSpawnFailed {
        kind: BbSpawnFailureKind::SpawnError,
        message: format!("bb thread spawn failed: {error}"),
    })?;
    // Write the prompt to stdin.
    if let Some(stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let mut stdin = stdin;
        let _ = stdin.write_all(options.prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let wait_future = child.wait_with_output();
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        let output = wait_future.await.map_err(|error| BbSpawnFailed {
            kind: BbSpawnFailureKind::SpawnError,
            message: format!("bb thread spawn failed: {error}"),
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            return Err(BbSpawnFailed {
                kind: BbSpawnFailureKind::NonzeroExit,
                message: format!(
                    "bb thread spawn failed with exit code {:?}: {}",
                    output.status.code(),
                    if stderr.trim().is_empty() {
                        stdout.trim().to_string()
                    } else {
                        stderr.trim().to_string()
                    }
                ),
            });
        }
        let stdout_text = String::from_utf8_lossy(&output.stdout);
        Ok(parse_bb_spawn_outcome(&stdout_text))
    })
    .await;
    match result {
        Ok(Ok(outcome)) => Ok(outcome),
        Ok(Err(error)) => Err(anyhow!(error)),
        Err(_) => {
            // The timeout elapsed: kill the child process. `wait_with_output`
            // already consumed `child`, so we rely on the process being
            // killed by the timeout drop.
            Err(anyhow!(BbSpawnFailed {
                kind: BbSpawnFailureKind::Timeout,
                message: format!("bb thread spawn timed out after {timeout_ms}ms"),
            }))
        }
    }
}

/// Parse the bb thread spawn JSON output.
fn parse_bb_spawn_outcome(stdout_text: &str) -> BbMirrorSpawnOutcome {
    if let Ok(parsed) = serde_json::from_str::<Value>(stdout_text) {
        if let Some(id) = parsed.get("id").and_then(Value::as_str) {
            if is_valid_thread_id(id) {
                return BbMirrorSpawnOutcome {
                    thread_id: Some(id.to_string()),
                    thread_created: true,
                };
            }
        }
    }
    // The thread exists but bb printed nothing parsable.
    BbMirrorSpawnOutcome {
        thread_id: None,
        thread_created: true,
    }
}

/// Check whether a string matches the bb thread id pattern.
fn is_valid_thread_id(id: &str) -> bool {
    // Simple check: starts with "thr_" and has at least one more alphanumeric char.
    id.starts_with("thr_") && id.len() > 4 && id[4..].chars().all(|c| c.is_ascii_alphanumeric())
}

/// Poll the parent-scoped roster until the admitted child has a live
/// daemon session. The exact child id wins over a same-named passive row.
///
/// `list_fn` returns the current child roster snapshots (each a JSON
/// object with `id`, `activeSessionId`, `sessionName`).
pub async fn resolve_child_active_session_id(
    list_fn: impl AsyncFn() -> Result<Vec<Value>>,
    child_id: &str,
    session_name: &str,
    timeout_ms: u64,
) -> Result<String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut last_error = "roster never listed the child".to_string();
    while Instant::now() < deadline {
        match list_fn().await {
            Ok(children) => {
                let by_id = children.iter().find(|child| {
                    child.get("id").and_then(Value::as_str) == Some(child_id)
                        && child
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty())
                });
                let by_name = children.iter().find(|child| {
                    child.get("sessionName").and_then(Value::as_str) == Some(session_name)
                        && child
                            .get("activeSessionId")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty())
                });
                if let Some(matched) = by_id.or(by_name) {
                    if let Some(id) = matched.get("activeSessionId").and_then(Value::as_str) {
                        return Ok(id.to_string());
                    }
                }
                last_error = format!("child {session_name} ({child_id}) has no active session yet");
            }
            Err(error) => {
                last_error = error.to_string();
            }
        }
        tokio::time::sleep(Duration::from_millis(RLM_MIRROR_ROSTER_POLL_MS)).await;
    }
    Err(anyhow!(
        "bb mirror spawn failed: {last_error} after {}s",
        timeout_ms / 1000
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_parsing_extracts_nonce_and_remaining() {
        let text = "[rlm-mirror:0123456789abcdef0123456789abcdef]\n[task from parent]\n\nDo work";
        let marker = parse_rlm_mirror_marker(text).unwrap();
        assert_eq!(marker.claim_nonce, "0123456789abcdef0123456789abcdef");
        assert_eq!(marker.remaining, "[task from parent]\n\nDo work");
    }

    #[test]
    fn marker_parsing_rejects_non_hex_nonce() {
        let text = "[rlm-mirror:GGGG456789abcdef0123456789abcdef]\nbody";
        assert!(parse_rlm_mirror_marker(text).is_none());
    }

    #[test]
    fn marker_parsing_rejects_wrong_length() {
        let text = "[rlm-mirror:abc]\nbody";
        assert!(parse_rlm_mirror_marker(text).is_none());
    }

    #[test]
    fn marker_only_prompt_has_empty_remaining() {
        let text = "[rlm-mirror:0123456789abcdef0123456789abcdef]";
        let marker = parse_rlm_mirror_marker(text).unwrap();
        assert_eq!(marker.claim_nonce, "0123456789abcdef0123456789abcdef");
        assert_eq!(marker.remaining, "");
    }

    #[test]
    fn strip_marker_removes_only_first_match() {
        let text = "[rlm-mirror:0123456789abcdef0123456789abcdef]\nbody line\ntext";
        let stripped = strip_rlm_mirror_marker_line(text, "0123456789abcdef0123456789abcdef");
        assert_eq!(stripped, "body line\ntext");
    }

    #[test]
    fn strip_marker_preserves_text_when_no_match() {
        let text = "no marker here";
        let stripped = strip_rlm_mirror_marker_line(text, "0123456789abcdef0123456789abcdef");
        assert_eq!(stripped, "no marker here");
    }

    #[test]
    fn claim_write_read_consume_roundtrip() {
        let dir = std::env::temp_dir().join("test-mirror-claim-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        let nonce = new_mirror_claim_nonce();
        assert_eq!(nonce.len(), 32);
        write_rlm_mirror_claim(&nonce, "session-123", &dir).unwrap();
        let claim = read_rlm_mirror_claim(&nonce, &dir).unwrap();
        assert_eq!(claim.target, "session-123");
        consume_rlm_mirror_claim(&nonce, &dir);
        assert!(read_rlm_mirror_claim(&nonce, &dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_claim_returns_none() {
        let dir = std::env::temp_dir().join("test-mirror-claim-stale");
        let _ = std::fs::remove_dir_all(&dir);
        let nonce = "abcdef0123456789abcdef0123456789";
        // Write a claim with an old timestamp.
        let claims_dir = dir.join(RLM_MIRROR_CLAIMS_DIR);
        std::fs::create_dir_all(&claims_dir).unwrap();
        let claim = json!({"target": "old-session", "createdAtMs": 0});
        std::fs::write(claims_dir.join(format!("{nonce}.json")), claim.to_string()).unwrap();
        assert!(read_rlm_mirror_claim(nonce, &dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_claim_returns_none() {
        let dir = std::env::temp_dir().join("test-mirror-claim-missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read_rlm_mirror_claim("nonexistent0123456789abcdef01234", &dir).is_none());
    }

    #[test]
    fn build_mirror_prompt_formats_correctly() {
        let prompt = build_rlm_mirror_prompt("abc123", "Do the task");
        assert!(prompt.starts_with("[rlm-mirror:abc123]\n"));
        assert!(prompt.contains("[task from parent]"));
        assert!(prompt.contains("Do the task"));
    }

    #[test]
    fn mirror_thread_title_formats_name_and_summary() {
        let title = mirror_thread_title("worker", "Analyze files and write report");
        assert_eq!(title, "worker · Analyze files and write report");
    }

    #[test]
    fn mirror_thread_title_truncates_long_summary() {
        let long_task = "word ".repeat(50);
        let title = mirror_thread_title("worker", &long_task);
        assert!(title.starts_with("worker · "));
        // Summary is at most 60 chars.
        let summary = &title["worker · ".len()..];
        assert!(summary.len() <= 60);
    }

    #[test]
    fn mirror_thread_title_empty_task_uses_name_only() {
        let title = mirror_thread_title("worker", "   ");
        assert_eq!(title, "worker");
    }

    #[test]
    fn auto_mirror_detection() {
        let mut env = HashMap::new();
        env.insert("BB_THREAD_ID".to_string(), "thr_abc".to_string());
        env.insert("BB_PROJECT_ID".to_string(), "proj1".to_string());
        assert!(should_auto_mirror_rlm_child(0, &env));
        assert!(!should_auto_mirror_rlm_child(1, &env));

        env.insert("PRIME_AGENT_AUTO_MIRROR".to_string(), "0".to_string());
        assert!(!should_auto_mirror_rlm_child(0, &env));

        env.insert("PRIME_AGENT_AUTO_MIRROR".to_string(), "false".to_string());
        assert!(!should_auto_mirror_rlm_child(0, &env));

        env.insert("PRIME_AGENT_AUTO_MIRROR".to_string(), "off".to_string());
        assert!(!should_auto_mirror_rlm_child(0, &env));

        env.remove("PRIME_AGENT_AUTO_MIRROR");
        env.remove("BB_THREAD_ID");
        assert!(!should_auto_mirror_rlm_child(0, &env));
    }

    #[test]
    fn is_inside_bb_thread_session_checks_both_vars() {
        let mut env = HashMap::new();
        assert!(!is_inside_bb_thread_session(&env));
        env.insert("BB_THREAD_ID".to_string(), "thr_abc".to_string());
        assert!(!is_inside_bb_thread_session(&env));
        env.insert("BB_PROJECT_ID".to_string(), "proj1".to_string());
        assert!(is_inside_bb_thread_session(&env));
    }

    #[test]
    fn is_rlm_mirror_target_summary_validates_cwd_and_depth() {
        let summary = json!({"cwd": "/some/path", "rlmDepth": 1});
        assert!(is_rlm_mirror_target_summary(
            &summary,
            Path::new("/some/path")
        ));

        let summary = json!({"cwd": "/other/path", "rlmDepth": 1});
        assert!(!is_rlm_mirror_target_summary(
            &summary,
            Path::new("/some/path")
        ));

        let summary = json!({"cwd": "/some/path", "rlmDepth": 0});
        assert!(!is_rlm_mirror_target_summary(
            &summary,
            Path::new("/some/path")
        ));

        let summary = json!({"cwd": "/some/path"});
        assert!(!is_rlm_mirror_target_summary(
            &summary,
            Path::new("/some/path")
        ));
    }

    #[test]
    fn head_without_tell_attribution_strips_leading_quotes() {
        let text = "> steered by user\n\n[rlm-mirror:abc]\nbody";
        let stripped = head_without_tell_attribution(text);
        assert!(stripped.starts_with("[rlm-mirror:abc]"));
    }

    #[test]
    fn head_without_tell_attribution_preserves_no_attribution() {
        let text = "[rlm-mirror:abc]\nbody";
        let stripped = head_without_tell_attribution(text);
        assert_eq!(stripped, text);
    }
}

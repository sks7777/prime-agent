//! Plan/code/debug mode: built-in three-mode workflow for the Rust port.
//!
//! - [`PlanCodeMode::Plan`] — read-only exploration: edit tool disabled,
//!   bash mutations gated, plan markdown writes allowed.
//! - [`PlanCodeMode::Code`] — full implementation mode with adapted prompt.
//! - [`PlanCodeMode::Debug`] — systematic diagnosis with full tool access.
//!
//! The mode state lives in the session engine; slash commands
//! (`/plan`, `/code`, `/dbg`, `/exit`, `/todos`) and the `--plan-code` CLI
//! flag drive transitions.

use std::sync::Arc;

use fancy_regex::Regex;
use pa_agent::types::{BeforeToolCallContext, BeforeToolCallResult};

/// The three operational modes plus the absent (normal) state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanCodeMode {
    Plan,
    Code,
    Debug,
}

impl PlanCodeMode {
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Code => "code",
            Self::Debug => "debug",
        }
    }

    /// Parse a `--plan-code` flag value.
    #[must_use]
    pub fn from_flag(value: &str) -> Option<Self> {
        match value.to_ascii_lowercase().as_str() {
            "plan" => Some(Self::Plan),
            "code" => Some(Self::Code),
            "debug" | "dbg" => Some(Self::Debug),
            _ => None,
        }
    }
}

/// A tracked plan step extracted from the model's "Plan:" section.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TodoItem {
    pub step: u32,
    pub text: String,
    pub completed: bool,
}

/// Mutable plan-code session state. Owned by the session engine behind a
/// `Mutex<PlanCodeState>`.
#[derive(Debug, Clone, Default)]
pub struct PlanCodeState {
    /// `None` when no mode is active.
    pub mode: Option<PlanCodeMode>,
    /// Whether execution mode is active (plan steps being tracked).
    pub executing: bool,
    /// Tracked plan steps.
    pub todos: Vec<TodoItem>,
}

impl PlanCodeState {
    /// Whether plan-mode tool gating should apply.
    #[must_use]
    pub fn is_plan_mode(&self) -> bool {
        self.mode == Some(PlanCodeMode::Plan)
    }

    /// Enter a mode, clearing todos and execution state.
    pub fn enter(&mut self, mode: PlanCodeMode) {
        self.mode = Some(mode);
        self.executing = false;
        self.todos.clear();
    }

    /// Exit mode entirely.
    pub fn exit(&mut self) {
        self.mode = None;
        self.executing = false;
        self.todos.clear();
    }

    /// Set tracked todos.
    pub fn set_todos(&mut self, todos: Vec<TodoItem>) {
        self.todos = todos;
    }

    /// Mark completed steps from `[DONE:n]` tags in assistant text.
    /// Returns the count of newly completed steps.
    pub fn mark_completed(&mut self, text: &str) -> usize {
        let done_steps = extract_done_steps(text);
        let mut count = 0;
        for step in done_steps {
            if let Some(item) = self.todos.iter_mut().find(|t| t.step == step) {
                if !item.completed {
                    item.completed = true;
                    count += 1;
                }
            }
        }
        count
    }

    /// Whether all plan steps are complete.
    #[must_use]
    pub fn all_complete(&self) -> bool {
        !self.todos.is_empty() && self.todos.iter().all(|t| t.completed)
    }

    /// Progress summary: `"3/5"` or the mode label.
    #[must_use]
    pub fn status_label(&self) -> String {
        if self.executing && !self.todos.is_empty() {
            let completed = self.todos.iter().filter(|t| t.completed).count();
            format!("{}/{}", completed, self.todos.len())
        } else if let Some(mode) = self.mode {
            mode.label().to_string()
        } else {
            String::new()
        }
    }

    /// Remaining (incomplete) steps in order.
    #[must_use]
    pub fn remaining_steps(&self) -> Vec<&TodoItem> {
        self.todos.iter().filter(|t| !t.completed).collect()
    }
}

// ---------------------------------------------------------------------------
// Plan-file path classification
// ---------------------------------------------------------------------------

/// Whether a path is a plan file: `PLAN*.md`, a `.md` inside a `plans/`
/// directory, or under the system tmp dir. Rejects path traversal.
#[must_use]
pub fn is_plan_file_path(path: &str) -> bool {
    let parts: Vec<&str> = path.split('/').collect();
    if parts.iter().any(|p| *p == "..") {
        return false;
    }
    let base = parts.last().copied().unwrap_or("");
    if parts.iter().any(|p| *p == "plans") {
        return base.ends_with(".md");
    }
    is_plan_filename(base)
}

/// Matches `PLAN*.md` (case-insensitive).
fn is_plan_filename(base: &str) -> bool {
    let upper = base.to_ascii_uppercase();
    if !upper.starts_with("PLAN") || !base.ends_with(".md") {
        return false;
    }
    let mid = &base[4..base.len() - 3];
    mid.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || mid.is_empty()
}

/// Whether a path is under the system tmp directory.
#[must_use]
pub fn is_tmp_path(path: &str) -> bool {
    if path.starts_with("/tmp/") || path.starts_with("/private/tmp/") || path.starts_with("/var/tmp/") {
        return true;
    }
    let tmp = std::env::temp_dir();
    let resolved = std::path::Path::new(path);
    let canonical = resolved.canonicalize().unwrap_or_else(|_| resolved.to_path_buf());
    let tmp_canonical = tmp.canonicalize().unwrap_or(tmp);
    canonical.starts_with(&tmp_canonical)
}

/// Whether a redirect target is a plan file or tmp path.
fn is_plan_redirect_target(target: &str) -> bool {
    if target == "/dev/null" {
        return true;
    }
    if target.contains("..") {
        return false;
    }
    if target.starts_with("/tmp/") || target.starts_with("/private/tmp/") {
        return true;
    }
    is_plan_file_path(target) || is_tmp_path(target)
}

// ---------------------------------------------------------------------------
// Bash command classification for plan mode
// ---------------------------------------------------------------------------

/// Plan-mode bash classification result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BashDecision {
    /// Read-only — auto-allow.
    Allow,
    /// Not read-only — needs user confirmation.
    Confirm,
    /// Catastrophic — hard block, no confirm.
    Block,
}

// Catastrophic patterns: irreversible system damage.
static CATASTROPHIC_PATTERNS: &[&str] = &[
    r"\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/(?:\s|$)",
    r"\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?~/",
    r"\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/Users\b",
    r"\bdd\s+.*of=/dev/",
    r"\bmkfs\b",
    r"\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b",
    r":\s*\(\s*\)\s*\{\s*:.*\};",
    r"\bsudo\s+rm\b",
    r"\bchmod\s+[-+]?\d*\s+\s*/\s",
    r"\bfind\s+.*-(?:exec|delete)\b",
];

// Read-only command prefixes.
const READONLY_PREFIXES: &[&str] = &[
    "cat", "head", "tail", "less", "more", "ls", "tree", "pwd",
    "echo", "printf", "wc", "which", "type", "whereis", "file",
    "diff", "du", "df", "date", "cal", "uptime", "uname",
    "whoami", "id", "printenv", "env", "man", "stat",
    "grep", "egrep", "fgrep", "rg", "ag", "ack",
    "sort", "uniq", "cut", "tr", "jq", "bat", "eza", "fd",
    "fold", "expand", "unexpand", "rev", "tac", "nl", "pr",
    "git log", "git show", "git diff", "git status", "git blame",
    "git rev-parse", "git rev-list", "git ls-files", "git ls-tree",
    "git ls-remote", "git shortlog", "git describe", "git cat-file",
    "git name-rev", "git stash list", "git stash show",
    "git tag -l", "git tag --list", "git tag -n",
    "git tag --contains", "git tag --merged", "git tag --points-at",
    "git branch --list", "git branch -a", "git branch -r", "git branch -v",
    "git remote -v", "git remote show", "git fetch",
    "npm list", "npm ls", "npm view", "npm info", "npm outdated", "npm audit",
    "yarn list", "yarn info", "yarn why", "yarn audit",
    "pnpm list", "pnpm ls", "pnpm why", "pnpm outdated",
    "node --version", "node -v", "python --version", "python3 --version",
    "python -V", "python3 -V", "npm --version", "npx --version",
    "cd", "ps", "top", "htop", "free",
    "docker run --rm", "docker ps", "docker images", "docker inspect",
    "docker logs", "docker version", "docker info",
    "gh", "curl",
    "wget -O -", "wget -O /dev/stdout",
    "sed -n",
    "find",
    "xargs",
    "cargo build", "cargo check", "cargo test", "cargo clippy",
    "cargo metadata", "cargo tree", "cargo locate-project",
    "rustc --version", "rustc -V", "cargo --version", "cargo -V",
];

const SEGMENT_SPLIT: &str = r"\s*(?:&&|\|\||;|\|(?=\s|$)|\n)\s*";
const REDIRECT_RE: &str = r"(?:^|\s)\d*(?:>>|>)\s*(\S+)";

fn strip_wrappers(segment: &str) -> String {
    let mut stripped = segment.trim().to_string();
    let mut changed = true;
    while changed {
        changed = false;
        for wrapper in &["timeout", "time", "nice", "nohup", "stdbuf"] {
            let re = Regex::new(&format!(r"^{wrapper}\s+(?:\S+\s+)?")).unwrap();
            if re.is_match(&stripped).unwrap_or(false) && stripped.len() > wrapper.len() {
                let after = re.replace(&stripped, "").to_string();
                if !after.trim().is_empty() {
                    stripped = after;
                    changed = true;
                }
            }
        }
        for wrapper in &["command", "env"] {
            let re = Regex::new(&format!(r"^{wrapper}\s+")).unwrap();
            if re.is_match(&stripped).unwrap_or(false) && stripped.len() > wrapper.len() {
                let after = re.replace(&stripped, "").to_string();
                if !after.trim().is_empty() {
                    stripped = after;
                    changed = true;
                }
            }
        }
    }
    stripped.trim().to_string()
}

fn strip_assignment(segment: &str) -> String {
    let re = Regex::new(r"^\s*[A-Za-z_][A-Za-z0-9_]*=\s*").unwrap();
    re.replace(segment, "").to_string()
}

fn starts_with_prefix(segment: &str) -> bool {
    let lower = segment.to_ascii_lowercase();
    READONLY_PREFIXES.iter().any(|prefix| {
        lower == *prefix || lower.starts_with(&format!("{prefix} "))
    })
}

/// Classify a bash command for plan mode.
#[must_use]
pub fn classify_bash_command(command: &str) -> BashDecision {
    // Check catastrophic patterns against the full command.
    for pattern in CATASTROPHIC_PATTERNS {
        let re = Regex::new(pattern).expect("catastrophic pattern regex");
        if re.is_match(command).unwrap_or(false) {
            return BashDecision::Block;
        }
    }
    let split_re = Regex::new(SEGMENT_SPLIT).expect("segment split regex");
    let redirect_re = Regex::new(REDIRECT_RE).expect("redirect regex");
    let segments: Vec<&str> = split_re
        .split(command)
        .filter_map(|s| s.ok())
        .filter(|s| !s.trim().is_empty())
        .collect();
    let mut all_read_only = true;
    for seg in &segments {
        let mut stripped = strip_wrappers(seg);
        stripped = strip_assignment(&stripped);
        // Check plan-file redirect first.
        if let Some(caps) = redirect_re.captures(&stripped).unwrap_or(None) {
            let target = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            if is_plan_redirect_target(target) {
                continue;
            }
            all_read_only = false;
            continue;
        }
        if starts_with_prefix(&stripped) {
            continue;
        }
        // Check mkdir into plans/ or tmp.
        let mkdir_re = Regex::new(r"(?i)^mkdir\s+(?:-p\s+)?(.+)$").unwrap();
        if let Some(caps) = mkdir_re.captures(&stripped).unwrap_or(None) {
            let targets: Vec<&str> = caps.get(1)
                .map(|m| m.as_str().trim().split_whitespace().collect())
                .unwrap_or_default();
            if targets.iter().all(|t| {
                !t.contains("..")
                    && !t.starts_with('~')
                    && !t.contains('$')
                    && (t.starts_with("/tmp/")
                        || t.contains("plans")
                        || t.starts_with("/private/tmp/"))
            }) {
                continue;
            }
        }
        all_read_only = false;
    }
    if all_read_only {
        BashDecision::Allow
    } else {
        BashDecision::Confirm
    }
}

// ---------------------------------------------------------------------------
// IPython dangerous pattern detection
// ---------------------------------------------------------------------------

static BLOCKED_PYTHON_PATTERNS: &[&str] = &[
    r"\bedit\s*\.\s*run\s*\(",
    r"\bedit\s*\(\s*path\s*=",
    r"\bos\.system\s*\(",
    r"\bos\.popen\s*\(",
    r"\beval\s*\(",
    r"\bexec\s*\(",
    r"\b__import__\s*\(",
    r"\bgetattr\s*\(\s*os\b",
    r"\bcompile\s*\(",
    r"(?:from\s+edit\s+import)|(?:import\s+edit\s+as\s+)",
];

/// Check IPython code for dangerous operations in plan mode.
/// Returns a description of the first violation, or `None` if clean.
#[must_use]
pub fn check_dangerous_ipython(code: &str) -> Option<String> {
    for pattern in BLOCKED_PYTHON_PATTERNS {
        let re = Regex::new(pattern).expect("blocked python pattern regex");
        if re.is_match(code).unwrap_or(false) {
            return Some(format!(
                "Dangerous Python pattern detected: {pattern}"
            ));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Todo / step extraction
// ---------------------------------------------------------------------------

/// Clean step text: strip formatting, remove leading verbs, truncate.
#[must_use]
pub fn clean_step_text(text: &str) -> String {
    let bold_re = Regex::new(r"\*{1,2}([^*]+)\*{1,2}").unwrap();
    let code_re = Regex::new(r"`([^`]+)`").unwrap();
    let verb_re = Regex::new(
        r"(?i)^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?",
    ).unwrap();
    let ws_re = Regex::new(r"\s+").unwrap();
    let mut cleaned = bold_re.replace_all(text, "$1").to_string();
    cleaned = code_re.replace_all(&cleaned, "$1").to_string();
    cleaned = verb_re.replace_all(&cleaned, "").to_string();
    cleaned = ws_re.replace_all(&cleaned, " ").trim().to_string();
    if !cleaned.is_empty() {
        let first = cleaned.chars().next().unwrap();
        cleaned = format!("{}{}", first.to_uppercase(), &cleaned[first.len_utf8()..]);
    }
    if cleaned.len() > 50 {
        cleaned = format!("{}...", &cleaned[..47]);
    }
    cleaned
}

/// Extract todo items from a "Plan:" section in an assistant message.
#[must_use]
pub fn extract_todo_items(message: &str) -> Vec<TodoItem> {
    let header_re = Regex::new(r"(?i)\*{0,2}Plan:\*{0,2}\s*\n").unwrap();
    let Some(header_match) = header_re.find(message).unwrap_or(None) else {
        return Vec::new();
    };
    let plan_section = &message[header_match.end()..];
    let numbered_re = Regex::new(r"(?m)^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)").unwrap();
    let mut items = Vec::new();
    for caps in numbered_re.captures_iter(plan_section) {
        let caps = match caps {
            Ok(c) => c,
            Err(_) => continue,
        };
        let raw_text = caps.get(2).map(|m| m.as_str()).unwrap_or("").trim();
        let text = raw_text
            .trim_end_matches(|c: char| c == '*')
            .trim()
            .to_string();
        if text.len() > 5
            && !text.starts_with('`')
            && !text.starts_with('/')
            && !text.starts_with('-')
        {
            let cleaned = clean_step_text(&text);
            if cleaned.len() > 3 {
                items.push(TodoItem {
                    step: u32::try_from(items.len() + 1).unwrap_or(u32::MAX),
                    text: cleaned,
                    completed: false,
                });
            }
        }
    }
    items
}

/// Extract `[DONE:n]` step numbers from text.
#[must_use]
pub fn extract_done_steps(text: &str) -> Vec<u32> {
    let re = Regex::new(r"(?i)\[DONE:(\d+)\]").expect("done steps regex");
    re.captures_iter(text)
        .filter_map(|result| {
            let caps = result.ok()?;
            caps.get(1)?
                .as_str()
                .parse::<u32>()
                .ok()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Plan-mode tool-call gating (before_tool_call hook)
// ---------------------------------------------------------------------------

/// Build a `before_tool_call` hook that enforces plan-mode restrictions.
///
/// - Edit tool: allow plan files (`PLAN*.md`, `plans/*.md`, `/tmp/`), block
///   everything else.
/// - Bash tool: classify as allow/confirm/block.
/// - IPython tool: block dangerous patterns (edit bypass, shell exec, eval).
///
/// The hook is only active when plan mode is engaged (checked via the
/// shared `PlanCodeState` mutex). In non-plan modes it passes through.
#[must_use]
pub fn plan_mode_before_tool_call(
    state: Arc<std::sync::Mutex<PlanCodeState>>,
) -> pa_agent::agent_loop::BeforeToolCallFn {
    Arc::new(move |context: BeforeToolCallContext, _signal| {
        let state = Arc::clone(&state);
        Box::pin(async move {
            let is_plan = {
                let guard = state.lock().expect("plan-code state lock");
                guard.is_plan_mode()
            };
            if !is_plan {
                return Ok(None);
            }
            let tool_name = context.tool_call.name.as_str();
            match tool_name {
                "edit" => {
                    let path = context
                        .args
                        .get("path")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if path.contains("..") {
                        return Ok(Some(BeforeToolCallResult {
                            block: true,
                            reason: Some(format!(
                                "Plan mode: path traversal (\"..\") is not allowed.\nPath: {path}"
                            )),
                        }));
                    }
                    if is_plan_file_path(path) || is_tmp_path(path) {
                        return Ok(None);
                    }
                    Ok(Some(BeforeToolCallResult {
                        block: true,
                        reason: Some(format!(
                            "Plan mode: only plan files (PLAN*.md, plans/*.md) or files under {} can be edited.\nAttempted path: {path}\nTo edit source files, exit plan mode with /code.",
                            std::env::temp_dir().display()
                        )),
                    }))
                }
                "bash" => {
                    let command = context
                        .args
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    match classify_bash_command(command) {
                        BashDecision::Allow => Ok(None),
                        BashDecision::Block => Ok(Some(BeforeToolCallResult {
                            block: true,
                            reason: Some(format!(
                                "Plan mode: catastrophic command blocked (irreversible system damage).\nCommand: {command}\nThis command cannot run in plan mode under any circumstances."
                            )),
                        })),
                        BashDecision::Confirm => Ok(Some(BeforeToolCallResult {
                            block: true,
                            reason: Some(format!(
                                "Plan mode: command not in the read-only allowlist and no UI to confirm.\nCommand: {command}\nTo allow it, exit plan mode with /code."
                            )),
                        })),
                    }
                }
                "ipython" => {
                    let code = context
                        .args
                        .get("code")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if let Some(violation) = check_dangerous_ipython(code) {
                        return Ok(Some(BeforeToolCallResult {
                            block: true,
                            reason: Some(format!(
                                "Plan mode: {violation}\nTo allow it, exit plan mode with /code."
                            )),
                        }));
                    }
                    Ok(None)
                }
                _ => Ok(None),
            }
        })
    })
}

// ---------------------------------------------------------------------------
// Mode-switch banner (for /code or /dbg following /plan)
// ---------------------------------------------------------------------------

/// The banner prepended to a mode-switch prompt when transitioning from
/// plan to code or debug, so the model stops replaying stale plan-mode
/// restrictions from the transcript.
#[must_use]
pub fn mode_switch_banner(to_mode: PlanCodeMode) -> String {
    let mode_label = to_mode.label();
    format!(
        "The operational mode has changed from plan to {mode_label}.\n\
         The read-only plan-mode restrictions are lifted: all tools are available again.\n\
         Earlier \"Plan mode: ...\" tool result blocks are stale and no longer apply.\n\
         Proceed with the user's request."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_file_path_classification() {
        assert!(is_plan_file_path("PLAN.md"));
        assert!(is_plan_file_path("plans/2025-01-15_fix.md"));
        assert!(is_plan_file_path("PLAN-foo.md"));
        assert!(!is_plan_file_path("src/main.rs"));
        assert!(!is_plan_file_path("../PLAN.md"));
        assert!(!is_plan_file_path("plan.txt"));
    }

    #[test]
    fn tmp_path_classification() {
        assert!(is_tmp_path("/tmp/foo.md"));
        assert!(is_tmp_path("/private/tmp/foo.md"));
        assert!(!is_tmp_path("/Users/k/foo.md"));
    }

    #[test]
    fn bash_classification_readonly() {
        assert_eq!(classify_bash_command("ls -la"), BashDecision::Allow);
        assert_eq!(classify_bash_command("cat file.txt"), BashDecision::Allow);
        assert_eq!(classify_bash_command("git log --oneline"), BashDecision::Allow);
        assert_eq!(classify_bash_command("rg pattern src/"), BashDecision::Allow);
        assert_eq!(classify_bash_command("cargo build"), BashDecision::Allow);
    }

    #[test]
    fn bash_classification_mutating() {
        assert_eq!(classify_bash_command("echo hello > file.txt"), BashDecision::Confirm);
        assert_eq!(classify_bash_command("npm install foo"), BashDecision::Confirm);
    }

    #[test]
    fn bash_classification_catastrophic() {
        assert_eq!(classify_bash_command("rm -rf /"), BashDecision::Block);
        assert_eq!(classify_bash_command("rm -rf ~/"), BashDecision::Block);
        assert_eq!(classify_bash_command("mkfs.ext4 /dev/sda1"), BashDecision::Block);
        assert_eq!(classify_bash_command("sudo rm /etc/passwd"), BashDecision::Block);
    }

    #[test]
    fn bash_classification_plan_redirect() {
        assert_eq!(
            classify_bash_command("echo plan > plans/2025-01-15_test.md"),
            BashDecision::Allow
        );
        assert_eq!(
            classify_bash_command("echo data > /tmp/scratch.txt"),
            BashDecision::Allow
        );
        assert_eq!(
            classify_bash_command("echo data > src/main.rs"),
            BashDecision::Confirm
        );
    }

    #[test]
    fn ipython_dangerous_patterns() {
        assert!(check_dangerous_ipython("os.system('rm -rf /')").is_some());
        assert!(check_dangerous_ipython("eval('1+1')").is_some());
        assert!(check_dangerous_ipython("edit.run(path='foo')").is_some());
        assert!(check_dangerous_ipython("print('hello')").is_none());
        assert!(check_dangerous_ipython("open('file').read()").is_none());
    }

    #[test]
    fn todo_extraction() {
        let message = "Here's the plan:\n\nPlan:\n1. Read the config file\n2. Update the database schema\n3. Run migrations\n";
        let items = extract_todo_items(message);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].step, 1);
        assert!(!items[0].completed);
        assert!(items[0].text.to_lowercase().contains("config"), "text was: {}", items[0].text);
    }

    #[test]
    fn done_step_extraction() {
        let text = "Done with step 1 [DONE:1] and step 3 [DONE:3]";
        let steps = extract_done_steps(text);
        assert_eq!(steps, vec![1, 3]);
    }

    #[test]
    fn mark_completed_updates_state() {
        let mut state = PlanCodeState {
            mode: Some(PlanCodeMode::Code),
            executing: true,
            todos: vec![
                TodoItem { step: 1, text: "A".into(), completed: false },
                TodoItem { step: 2, text: "B".into(), completed: false },
            ],
        };
        let count = state.mark_completed("done [DONE:1]");
        assert_eq!(count, 1);
        assert!(state.todos[0].completed);
        assert!(!state.todos[1].completed);
        assert!(!state.all_complete());
    }

    #[test]
    fn status_label_reflects_mode_and_progress() {
        let mut state = PlanCodeState::default();
        assert_eq!(state.status_label(), "");
        state.enter(PlanCodeMode::Plan);
        assert_eq!(state.status_label(), "plan");
        state.executing = true;
        state.todos = vec![
            TodoItem { step: 1, text: "A".into(), completed: true },
            TodoItem { step: 2, text: "B".into(), completed: false },
        ];
        assert_eq!(state.status_label(), "1/2");
    }

    #[test]
    fn mode_from_flag() {
        assert_eq!(PlanCodeMode::from_flag("plan"), Some(PlanCodeMode::Plan));
        assert_eq!(PlanCodeMode::from_flag("code"), Some(PlanCodeMode::Code));
        assert_eq!(PlanCodeMode::from_flag("debug"), Some(PlanCodeMode::Debug));
        assert_eq!(PlanCodeMode::from_flag("dbg"), Some(PlanCodeMode::Debug));
        assert_eq!(PlanCodeMode::from_flag("invalid"), None);
    }

    #[test]
    fn enter_and_exit_transitions() {
        let mut state = PlanCodeState::default();
        assert!(!state.is_plan_mode());
        state.enter(PlanCodeMode::Plan);
        assert!(state.is_plan_mode());
        assert_eq!(state.mode, Some(PlanCodeMode::Plan));
        state.exit();
        assert!(!state.is_plan_mode());
        assert!(state.todos.is_empty());
    }

    #[test]
    fn clean_step_text_strips_formatting() {
        assert_eq!(clean_step_text("**Bold** step"), "Bold step");
        assert_eq!(clean_step_text("`code` thing"), "Code thing");
        assert_eq!(clean_step_text("Run the tests"), "Tests");
    }
}

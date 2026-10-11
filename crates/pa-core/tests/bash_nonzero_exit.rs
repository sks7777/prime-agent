// Pedantic-gate dispositions as src/lib.rs (large_futures/too_many_lines/casts).
#![allow(
    clippy::large_futures,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]

//! Bash tool nonzero-exit semantics: a nonzero exit of a successfully
//! executed command is data, not a tool error. The tool resolves with
//! the output plus a "Command exited with code N" status line; real
//! execution failures (timeout, abort) keep rejecting with `Err`.

use pa_core::{create_bash_tool_definition, ToolDefinition};
use serde_json::json;

/// Run the bash tool definition with a given command and optional timeout.
async fn run_bash(
    def: &ToolDefinition,
    command: &str,
    timeout: Option<f64>,
) -> anyhow::Result<pa_core::ToolExecutionResult> {
    let params = match timeout {
        Some(t) => json!({ "command": command, "timeout": t }),
        None => json!({ "command": command }),
    };
    let f = def.execute.clone();
    f("test-call", params, None, None).await
}

fn result_text(result: &pa_core::ToolExecutionResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| block.as_text())
        .collect::<Vec<_>>()
        .join("")
}

#[tokio::test]
async fn nonzero_exit_with_output_resolves_as_data() {
    let def = create_bash_tool_definition(std::env::temp_dir().to_str().unwrap());
    let result = run_bash(&def, "sh -c 'echo probe-out; exit 3'", None)
        .await
        .expect("nonzero exit must resolve, not reject");
    let text = result_text(&result);
    assert!(text.contains("probe-out"), "output preserved: {text}");
    assert!(
        text.contains("Command exited with code 3"),
        "status line appended: {text}"
    );
    assert!(!result.is_error, "nonzero exit is data, not an error");
}

#[tokio::test]
async fn nonzero_exit_silent_resolves_as_data() {
    let def = create_bash_tool_definition(std::env::temp_dir().to_str().unwrap());
    let result = run_bash(&def, "false", None)
        .await
        .expect("silent nonzero exit must resolve, not reject");
    let text = result_text(&result);
    assert!(
        text.contains("Command exited with code 1"),
        "status line appended: {text}"
    );
    assert!(!result.is_error, "silent nonzero exit is data, not an error");
}

#[tokio::test]
async fn timeout_still_rejects_as_error() {
    let def = create_bash_tool_definition(std::env::temp_dir().to_str().unwrap());
    let err = run_bash(&def, "sleep 5", Some(1.0))
        .await
        .expect_err("timeout must reject");
    assert!(
        err.to_string().contains("Command timed out after 1 seconds"),
        "timeout error message: {err}"
    );
}

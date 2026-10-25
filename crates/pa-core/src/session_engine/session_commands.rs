//! Session slash-command execution: the daemon-side behavior behind
//! `/compact`, `/refine`, `/goal`, and `/autonomous`. The host runtime owns
//! persistence of what this returns; errors carry the exact TS message and
//! the host renders the `Command failed: ...` result row.

use std::sync::Arc;

use pa_types::session::CustomMessage;

use crate::autonomous::{
    autonomous_status, set_autonomous_enabled, set_autonomous_limits, AutonomousRuntimeState,
};
use crate::goals::{create_goal_context_message, GoalContextKind, GoalStatus};
use crate::slash_command_args::{
    format_autonomous_status, parse_autonomous_command, parse_goal_command, AutonomousCommand,
    GoalCommand,
};

use super::compact_session::CompactOutcome;
use super::engine::SessionEngine;
use super::goal_driver::GoalDriver;
use super::messages::{
    SESSION_SLASH_COMMAND_CUSTOM_TYPE, SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
};
use super::refine::{RefineOptions, RefinementSource};
use super::slash_commands::{parse_refine_command_options, SessionSlashCommand};

pub use crate::autonomous::AUTONOMOUS_STATUS_CUSTOM_TYPE;

/// Inputs the host runtime supplies to one execution.
pub struct SessionCommandParams<'a> {
    pub model: &'a pa_types::ai::Model,
    /// Resolved API key (None falls back to provider resolution).
    pub api_key: Option<String>,
    pub global_harness_dir: std::path::PathBuf,
    pub autonomous: &'a mut AutonomousRuntimeState,
}

/// A completed compaction to persist: the session record plus the
/// client-facing result.
#[derive(Debug, Clone)]
pub struct CompactionExecution {
    pub entry: pa_types::session::CompactionEntry,
    pub result: super::compaction_exec::CompactionResult,
    /// The post-compaction `ipython_state` notice row when a kernel was
    /// running (already durable; hosts broadcast its `message_start` /
    /// `message_end` pair).
    pub ipython_state: Option<CustomMessage>,
}

/// What one execution produced.
#[derive(Debug, Default)]
pub struct SessionCommandExecution {
    /// The command echo, then any result or status rows.
    pub messages: Vec<CustomMessage>,
    /// A compaction that ran (no result row: the TS `/compact` outcome is
    /// the compaction record itself).
    pub compaction: Option<CompactionExecution>,
    /// A compaction skipped: the message the wire `compaction_end`
    /// event carries (the durable transcript records nothing).
    pub compaction_skipped: Option<&'static str>,
    /// An injected custom row the follow-up turn runs on (goal start/resume):
    /// the transcript holds ONE representation of the turn, NOT part of
    /// `messages` — the loop's `message_end` persists it once admitted.
    pub continuation_message: Option<CustomMessage>,
    /// The command failed: the TS error message (the failure result row
    /// is already appended to `messages`).
    pub error: Option<String>,
    /// A refinement run's structured outcome; the result row in
    /// `messages` stays display-only.
    pub refinement: Option<crate::refinement::RefinementResult>,
    /// A refinement run failed: the raw run error (option-parse failures
    /// leave this `None`; they are command failures, not refinement events).
    pub refinement_failed: Option<String>,
}

impl SessionCommandExecution {
    fn push_message(&mut self, message: CustomMessage) {
        self.messages.push(message);
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

/// The durable command echo row. Public for the host transports that
/// emit the echo before execution.
#[must_use]
pub fn session_command_echo_row(command: &SessionSlashCommand) -> CustomMessage {
    CustomMessage {
        custom_type: SESSION_SLASH_COMMAND_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(command.text.clone()),
        display: true,
        details: Some(command_details(command)),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// The command description carried by echo and result rows.
fn command_details(command: &SessionSlashCommand) -> serde_json::Value {
    serde_json::json!({
        "command": {
            "name": command.name,
            "args": command.args,
            "text": command.text,
        }
    })
}

/// Hosts append it so the transcript still records the failed
/// attempt.
#[must_use]
pub fn session_command_failure_row(command: &SessionSlashCommand, error: &str) -> CustomMessage {
    slash_command_result(
        command,
        format!("Command failed: {error}"),
        false,
        "error",
        Some(error),
        true,
    )
}

/// The durable result row (`session_slash_command_result`).
fn slash_command_result(
    command: &SessionSlashCommand,
    content: String,
    success: bool,
    severity: &'static str,
    error: Option<&str>,
    display: bool,
) -> CustomMessage {
    let mut details = command_details(command);
    details["success"] = serde_json::json!(success);
    details["severity"] = serde_json::json!(severity);
    if let Some(error) = error {
        details["error"] = serde_json::json!(error);
    }
    CustomMessage {
        custom_type: SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(content),
        display,
        details: Some(details),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// The goal status line.
fn goal_status_text(state: &crate::goals::GoalState) -> String {
    match &state.objective {
        Some(objective) if state.status != GoalStatus::Idle => {
            format!("Goal {}: {objective}", state.status.slug())
        }
        _ => "No active goal.".to_string(),
    }
}

/// Execute one session command. The echo row is durable whether the command
/// succeeds or fails; a failure appends the failure row and reports `error`.
pub async fn execute_session_command(
    engine: &SessionEngine,
    params: &mut SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    images: &[pa_agent::types::ImageContent],
) -> SessionCommandExecution {
    let mut execution = SessionCommandExecution::default();
    // The echo row is recorded BEFORE the command runs, so the command's
    // own work sees it in the session branch.
    let echo = session_command_echo_row(command);
    execution.push_message(echo.clone());
    if let Err(error) = persist_rows(engine, std::iter::once(&echo)).await {
        execution.error = Some(error);
        return execution;
    }
    let result = match command.name {
        "compact" => execute_compact(engine, params, command, &mut execution).await,
        "refine" => execute_refine(engine, params, command, &mut execution).await,
        "goal" => execute_goal(engine, command, images, &mut execution).await,
        "autonomous" => execute_autonomous(params, command, &mut execution),
        "plan" => execute_plan_code_mode(engine, command, &mut execution).await,
        "code" => execute_plan_code_mode(engine, command, &mut execution).await,
        "dbg" => execute_plan_code_mode(engine, command, &mut execution).await,
        "exit" => execute_plan_code_exit(engine, command, &mut execution).await,
        "todos" => Ok(execute_plan_code_todos(engine, command, &mut execution)),
        other => Err(format!("Unknown session command: {other}")),
    };
    if let Err(message) = result {
        execution.push_message(slash_command_result(
            command,
            format!("Command failed: {message}"),
            false,
            "error",
            Some(&message),
            true,
        ));
        execution.error = Some(message);
    }
    // The echo row is already durable; the rest follow in order.
    if let Err(error) = persist_rows(engine, execution.messages.iter().skip(1)).await {
        execution.error = Some(error);
    }
    sync_live_context(engine).await;
    execution
}

/// The live agent context mirrors the durable rows (so the next admitted
/// turn's request carries them); the rebuild is idempotent — the compaction
/// path rebuilds mid-execution, the refinement path pushes rows mid-execution.
async fn sync_live_context(engine: &SessionEngine) {
    let session = engine.session.session_handle().clone();
    let rebuilt = {
        let session = session.lock().await;
        session.active_context().messages
    };
    // The raw session messages (not the LLM view): custom rows keep their
    // wire identity in the live context, like TS's state push.
    let loop_messages: Vec<pa_agent::types::AgentMessage> = rebuilt
        .iter()
        .filter_map(super::session_message_to_loop)
        .collect();
    engine.session.agent().set_messages(loop_messages).await;
}

/// `/compact`: summarize and cut, or skip silently (TS `CompactionSkippedError`).
async fn execute_compact(
    engine: &SessionEngine,
    params: &SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let instructions = (!command.args.is_empty()).then_some(command.args.as_str());
    let outcome = engine
        .session
        .compact(instructions, params.model, params.api_key.clone(), None)
        .await
        .map_err(|error| format!("{error:#}"))?;
    match outcome {
        CompactOutcome::Skipped(message) => {
            execution.compaction_skipped = Some(message);
        }
        CompactOutcome::Ran(run) => {
            if let Some(telemetry) = &engine.telemetry {
                telemetry.note_compaction(Some(run.duration_ms));
            }
            execution.compaction = Some(CompactionExecution {
                entry: run.entry,
                result: run.result,
                ipython_state: run.ipython_state,
            });
        }
    }
    Ok(())
}

/// `/refine`: run the refinement and record the applied-edit count.
async fn execute_refine(
    engine: &SessionEngine,
    params: &mut SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let options = parse_refine_command_options(&command.args)?;
    let refine_options = RefineOptions {
        global: options.global,
        instructions: options.instructions,
        rollback_id: options.rollback_id,
    };
    let result = match engine
        .session
        .refine(
            &refine_options,
            RefinementSource::User,
            params.model,
            params.api_key.take(),
            params.global_harness_dir.clone(),
        )
        .await
    {
        Ok(result) => result,
        Err(error) => {
            // The refinement run itself failed: a host transport surfaces
            // this as a refinement event, distinct from the command failure.
            execution.refinement_failed = Some(format!("{error:#}"));
            return Err(format!("{error:#}"));
        }
    };
    execution.refinement = Some(result.clone());
    let applied = result
        .applied_edits
        .iter()
        .filter(|edit| edit.applied)
        .count();
    let content = format!(
        "Refined continual harness state: {applied} edit{} applied.",
        if applied == 1 { "" } else { "s" }
    );
    // The refinement outcome message renders the details; the result row is
    // durable but not displayed (TS `displayResult = false`).
    execution.push_message(slash_command_result(
        command, content, true, "info", None, false,
    ));
    Ok(())
}

/// `/goal`: status, clear, pause, resume, and start (which schedules
/// the first continuation turn).
async fn execute_goal(
    engine: &SessionEngine,
    command: &SessionSlashCommand,
    images: &[pa_agent::types::ImageContent],
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let goal = parse_goal_command(&command.args)?;
    // The goal command's fixed choice for the feature-outcome seam
    // (captured before the driver arm moves the command's fields).
    let goal_choice = match goal {
        GoalCommand::Status => "status",
        GoalCommand::Clear => "clear",
        GoalCommand::Pause => "pause",
        GoalCommand::Resume => "resume",
        GoalCommand::Start { .. } => "create",
    };
    let driver: Arc<tokio::sync::Mutex<GoalDriver>> = engine.goal_driver.clone();
    let session = engine.session.session_handle().clone();
    let mut context_message: Option<CustomMessage> = None;
    {
        let mut driver = driver.lock().await;
        let mut session = session.lock().await;
        // The clear's reply reflects the action, not the post-clear state
        // (the operator's 2026-09-25 bug report): a clear that removed a goal
        // record answers "Goal cleared."; nothing-to-clear keeps the plain status.
        let mut cleared_goal = false;
        match goal {
            GoalCommand::Status => {}
            // TS `_clearGoal`/`_pauseGoal`/`_startGoal` route through
            // `_clearQueuedGoalContexts` first: a minted continuation
            // waiting in the queue never runs behind the state change.
            GoalCommand::Clear => {
                engine.purge_queued_goal_contexts();
                cleared_goal =
                    driver.state().objective.is_some() && driver.state().status != GoalStatus::Idle;
                driver
                    .clear(&mut session)
                    .map_err(|error| format!("{error:#}"))?;
            }
            GoalCommand::Pause => {
                engine.purge_queued_goal_contexts();
                driver
                    .pause(&mut session, "Paused by user")
                    .map_err(|error| format!("{error:#}"))?;
            }
            GoalCommand::Resume => {
                context_message = driver
                    .resume(&mut session)
                    .map_err(|error| format!("{error:#}"))?;
            }
            GoalCommand::Start {
                objective,
                token_budget,
            } => {
                engine.purge_queued_goal_contexts();
                let state = driver
                    .start(&mut session, &objective, token_budget)
                    .map_err(|error| format!("{error:#}"))?;
                // TS `_startGoal`: only the objective-start context takes the
                // prompt's attached images; the other goal arms ignore them.
                context_message = Some(
                    create_goal_context_message(&state, GoalContextKind::Continuation, images)
                        .map_err(|error| format!("{error:#}"))?,
                );
            }
        }
        let status_text = if cleared_goal {
            "Goal cleared.".to_string()
        } else {
            goal_status_text(driver.state())
        };
        execution.push_message(slash_command_result(
            command,
            status_text,
            true,
            "info",
            None,
            true,
        ));
    }
    // The goal-context row becomes the turn's primary record (an
    // injected custom row), never an early durable row — the loop
    // admission appends it once.
    execution.continuation_message = context_message;
    // The goal command's observed result at this seam (the driver applied
    // the action), counted as `feature_goal_completed_count`.
    if let Some(telemetry) = engine.telemetry.as_ref() {
        telemetry.note_feature_outcome("goal", "completed", Some(goal_choice));
    }
    Ok(())
}

/// `/autonomous`: status, on (with budget flags), off; emits the
/// durable `autonomous_status` row.
fn execute_autonomous(
    params: &mut SessionCommandParams<'_>,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let parsed = parse_autonomous_command(&command.args)?;
    match parsed {
        AutonomousCommand::Status => {}
        AutonomousCommand::On { config } => {
            set_autonomous_enabled(params.autonomous, true);
            set_autonomous_limits(params.autonomous, &config);
        }
        AutonomousCommand::Off => set_autonomous_enabled(params.autonomous, false),
    }
    let status = autonomous_status(params.autonomous);
    execution.push_message(CustomMessage {
        custom_type: AUTONOMOUS_STATUS_CUSTOM_TYPE.to_string(),
        content: pa_types::ai::UserContent::Text(format_autonomous_status(&status)),
        display: true,
        details: serde_json::to_value(&status).ok(),
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Plan-code mode commands (/plan, /code, /dbg)
// ---------------------------------------------------------------------------

/// Execute `/plan`, `/code`, or `/dbg`: set the mode, adjust tools, and
/// optionally submit trailing args as a follow-up prompt.
async fn execute_plan_code_mode(
    engine: &SessionEngine,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let mode = match command.name {
        "plan" => crate::plan_code::PlanCodeMode::Plan,
        "code" => crate::plan_code::PlanCodeMode::Code,
        "dbg" => crate::plan_code::PlanCodeMode::Debug,
        _ => return Err(format!("Unknown plan-code mode: {}", command.name)),
    };

    let previous_mode = {
        let state = engine.plan_code.lock().expect("plan-code state lock");
        state.mode
    };
    let from_plan = previous_mode == Some(crate::plan_code::PlanCodeMode::Plan);

    // Enter the new mode.
    {
        let mut state = engine.plan_code.lock().expect("plan-code state lock");
        state.enter(mode);
    }

    // Plan tracking: extract the tracked steps from the trailing args' Plan
    // section (`/plan` submits a plan prompt whose numbered list is the
    // execution checklist; `/code`/`/dbg` switch without plan text).
    if mode == crate::plan_code::PlanCodeMode::Plan {
        let todos = crate::plan_code::extract_todo_items(command.args.trim());
        if !todos.is_empty() {
            let mut state = engine.plan_code.lock().expect("plan-code state lock");
            state.set_todos(todos);
        }
    }

    // Adjust tools: in plan mode, disable edit; otherwise restore all tools.
    adjust_tools_for_mode(engine, mode).await;

    // Rebuild the system prompt with the mode-specific layer.
    rebuild_system_prompt(engine, Some(mode)).await;

    let notification = match mode {
        crate::plan_code::PlanCodeMode::Plan => {
            "Plan mode enabled. Read-only commands pass; non-read-only require confirmation; edit is disabled."
        }
        crate::plan_code::PlanCodeMode::Code => "Code mode enabled. Full access restored.",
        crate::plan_code::PlanCodeMode::Debug => "Debug mode enabled. Systematic diagnosis.",
    };
    execution.push_message(slash_command_result(
        command,
        notification.to_string(),
        true,
        "info",
        None,
        true,
    ));

    // Submit trailing args as a follow-up prompt.
    let prompt = command.args.trim();
    if !prompt.is_empty() {
        let content = if from_plan
            && (mode == crate::plan_code::PlanCodeMode::Code
                || mode == crate::plan_code::PlanCodeMode::Debug)
        {
            format!(
                "{}

{}",
                crate::plan_code::mode_switch_banner(mode),
                prompt
            )
        } else {
            prompt.to_string()
        };
        execution.continuation_message = Some(prompt_custom_message("plan_code_prompt", content));
    } else if from_plan
        && (mode == crate::plan_code::PlanCodeMode::Code
            || mode == crate::plan_code::PlanCodeMode::Debug)
    {
        execution.continuation_message = Some(prompt_custom_message(
            "plan_code_prompt",
            crate::plan_code::mode_switch_banner(mode),
        ));
    }

    Ok(())
}

/// Execute `/exit`: leave plan/code/debug mode, restore default tools.
async fn execute_plan_code_exit(
    engine: &SessionEngine,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) -> Result<(), String> {
    let was_in_mode = {
        let state = engine.plan_code.lock().expect("plan-code state lock");
        state.mode.is_some()
    };
    if !was_in_mode {
        execution.push_message(slash_command_result(
            command,
            "Not in plan, code, or debug mode.".to_string(),
            true,
            "info",
            None,
            true,
        ));
        return Ok(());
    }
    let mode_label = {
        let state = engine.plan_code.lock().expect("plan-code state lock");
        state.mode.map_or("unknown", |m| m.label())
    };
    {
        let mut state = engine.plan_code.lock().expect("plan-code state lock");
        state.exit();
    }
    // Restore the system prompt without mode layers.
    rebuild_system_prompt(engine, None).await;
    let notification = format!("Exited {mode_label} mode. Default tools restored.");
    execution.push_message(slash_command_result(
        command,
        notification,
        true,
        "info",
        None,
        true,
    ));
    Ok(())
}

/// Execute `/todos`: show current plan progress.
fn execute_plan_code_todos(
    engine: &SessionEngine,
    command: &SessionSlashCommand,
    execution: &mut SessionCommandExecution,
) {
    let state = engine.plan_code.lock().expect("plan-code state lock");
    if state.todos.is_empty() {
        execution.push_message(slash_command_result(
            command,
            "No todos. Create a plan first with /plan".to_string(),
            true,
            "info",
            None,
            true,
        ));
        return;
    }
    let list = state
        .todos
        .iter()
        .enumerate()
        .map(|(i, item)| {
            format!(
                "{}. {} {}",
                i + 1,
                if item.completed { "[x]" } else { "[ ]" },
                item.text
            )
        })
        .collect::<Vec<_>>()
        .join(
            "
",
        );
    let content = format!(
        "Plan Progress:
{list}"
    );
    execution.push_message(slash_command_result(
        command, content, true, "info", None, true,
    ));
}

/// A minimal custom message for a follow-up prompt (the continuation
/// mechanism the host runtime drives as the turn's primary record).
fn prompt_custom_message(custom_type: &str, content: String) -> CustomMessage {
    CustomMessage {
        custom_type: custom_type.to_string(),
        content: pa_types::ai::UserContent::Text(content),
        display: true,
        details: None,
        timestamp: now_millis(),
        rest: serde_json::Map::default(),
    }
}

/// Adjust the agent's tool set for the active mode.
/// In plan mode: disable edit, keep everything else.
/// In code/debug: restore all tools.
async fn adjust_tools_for_mode(engine: &SessionEngine, mode: crate::plan_code::PlanCodeMode) {
    let agent = engine.session.agent();
    let state = agent.state().await;
    let all_tools = state.tools.clone();
    match mode {
        crate::plan_code::PlanCodeMode::Plan => {
            // Save current tool names for restoration.
            let tool_names: Vec<String> = all_tools.iter().map(|t| t.name().to_string()).collect();
            *engine
                .plan_code_saved_tools
                .lock()
                .expect("plan-code saved tools lock") = tool_names;
            // Disable edit tool, keep everything else.
            let filtered: Vec<Arc<dyn pa_agent::types::AgentTool>> = all_tools
                .into_iter()
                .filter(|t| t.name() != "edit")
                .collect();
            agent.set_tools(filtered).await;
        }
        crate::plan_code::PlanCodeMode::Code | crate::plan_code::PlanCodeMode::Debug => {
            // Restore all tools.
            agent.set_tools(all_tools).await;
        }
    }
}

/// Rebuild the system prompt with the active plan-code mode layer.
async fn rebuild_system_prompt(
    engine: &SessionEngine,
    mode: Option<crate::plan_code::PlanCodeMode>,
) {
    // The system prompt is rebuilt by re-calling build_system_prompt with
    // the plan_code_mode field set. The engine stores the original prompt
    // options implicitly through its fields; we reconstruct the key ones.
    // In practice, the system prompt is set once at creation and the
    // mode layer is injected as a dynamic tail segment. For the Rust port,
    // we append the mode-specific prompt to the existing system prompt.
    let agent = engine.session.agent();
    let current_prompt = agent.state().await.system_prompt;

    // Strip any existing plan-code layer suffix, then append the new one.
    let base_prompt = strip_plan_code_layers(&current_prompt);
    let new_prompt = match mode {
        Some(crate::plan_code::PlanCodeMode::Plan) => {
            format!(
                "{base_prompt}

{}",
                crate::prompts::layers::PLAN_MODE_LAYER.trim()
            )
        }
        Some(crate::plan_code::PlanCodeMode::Code) => {
            format!(
                "{base_prompt}

{}",
                crate::prompts::layers::CODE_MODE_LAYER.trim()
            )
        }
        Some(crate::plan_code::PlanCodeMode::Debug) => {
            format!(
                "{base_prompt}

{}",
                crate::prompts::layers::DEBUG_MODE_LAYER.trim()
            )
        }
        None => base_prompt,
    };
    agent.set_system_prompt(new_prompt).await;
}

/// Remove plan/code/debug mode layer text from a system prompt (to avoid
/// stacking layers on repeated mode switches).
fn strip_plan_code_layers(prompt: &str) -> String {
    let mut result = prompt.to_string();
    for layer in &[
        crate::prompts::layers::PLAN_MODE_LAYER,
        crate::prompts::layers::CODE_MODE_LAYER,
        crate::prompts::layers::DEBUG_MODE_LAYER,
    ] {
        let trimmed = layer.trim();
        if let Some(pos) = result.find(trimmed) {
            // Remove the layer and any preceding \n\n.
            let start = if pos >= 2 && &result[pos - 2..pos] == "\n\n" {
                pos - 2
            } else {
                pos
            };
            result = format!("{}{}", &result[..start], &result[pos + trimmed.len()..]);
        }
    }
    result.trim().to_string()
}

/// The rows are durable in the session's own entry chain: the live context
/// rebuild and a later `/compact` see the same rows the host runtime persists.
async fn persist_rows<'a>(
    engine: &SessionEngine,
    messages: impl Iterator<Item = &'a CustomMessage>,
) -> Result<(), String> {
    let session = engine.session.session_handle().clone();
    let mut session = session.lock().await;
    for message in messages {
        session
            .append_custom_message(
                &message.custom_type,
                message.content.clone(),
                message.display,
                message.details.clone(),
            )
            .map_err(|error| error.to_string())?;
    }
    session.flush_now().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goals::{empty_goal_state, GoalState, GoalStatus};
    use pa_types::ai::UserContent;

    fn command(name: &'static str, args: &str) -> SessionSlashCommand {
        let text = if args.is_empty() {
            format!("/{name}")
        } else {
            format!("/{name} {args}")
        };
        SessionSlashCommand {
            name,
            args: args.to_string(),
            text,
        }
    }

    fn message_text(message: &CustomMessage) -> String {
        message.content.text()
    }

    #[test]
    fn echo_row_shape_matches_ts() {
        let echo = session_command_echo_row(&command("compact", "focus on tests"));
        assert_eq!(echo.custom_type, "session_slash_command");
        assert_eq!(message_text(&echo), "/compact focus on tests");
        assert!(echo.display);
        let details = echo.details.unwrap();
        assert_eq!(
            details["command"],
            serde_json::json!({
                "name": "compact",
                "args": "focus on tests",
                "text": "/compact focus on tests",
            })
        );
    }

    #[test]
    fn result_row_shape_matches_ts() {
        let result = slash_command_result(
            &command("goal", "ship it"),
            "Goal active: ship it".to_string(),
            true,
            "info",
            None,
            true,
        );
        assert_eq!(result.custom_type, "session_slash_command_result");
        assert_eq!(message_text(&result), "Goal active: ship it");
        let details = result.details.unwrap();
        assert_eq!(details["success"], serde_json::json!(true));
        assert_eq!(details["severity"], serde_json::json!("info"));

        let failed = slash_command_result(
            &command("refine", ""),
            "Command failed: boom".to_string(),
            false,
            "error",
            Some("boom"),
            true,
        );
        assert_eq!(failed.details.unwrap()["error"], serde_json::json!("boom"));
    }

    #[test]
    fn goal_status_text_matches_ts() {
        let mut state = empty_goal_state();
        assert_eq!(goal_status_text(&state), "No active goal.");
        state.objective = Some("ship it".to_string());
        state.status = GoalStatus::Active;
        assert_eq!(goal_status_text(&state), "Goal active: ship it");
        state.status = GoalStatus::Paused;
        assert_eq!(goal_status_text(&state), "Goal paused: ship it");
        state.status = GoalStatus::BudgetLimited;
        assert_eq!(goal_status_text(&state), "Goal budget_limited: ship it");
    }

    #[tokio::test]
    async fn autonomous_status_row_emitted() {
        // The autonomous branch touches only the runtime state.
        let mut autonomous = crate::autonomous::create_autonomous_runtime_state(None, None);
        let mut execution = SessionCommandExecution::default();
        execute_autonomous(
            &mut SessionCommandParams {
                model: &scripted_model(),
                api_key: None,
                global_harness_dir: std::path::PathBuf::from("/tmp"),
                autonomous: &mut autonomous,
            },
            &command("autonomous", "on --max-turns 5"),
            &mut execution,
        )
        .unwrap();
        assert!(autonomous.enabled);
        assert_eq!(autonomous.limits.max_turns, 5);
        assert_eq!(execution.messages.len(), 1);
        let status = &execution.messages[0];
        assert_eq!(status.custom_type, "autonomous_status");
        assert!(message_text(status).starts_with("[autonomous-status: on]"));
        assert!(matches!(status.content, UserContent::Text(_)));
    }

    fn scripted_model() -> pa_types::ai::Model {
        serde_json::from_value(serde_json::json!({
            "id": "m", "name": "m", "api": "openai-completions", "provider": "test",
            "baseUrl": "http://localhost", "reasoning": false, "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000, "maxTokens": 100
        }))
        .unwrap()
    }

    #[test]
    fn goal_state_slugs() {
        let state = GoalState {
            status: GoalStatus::Complete,
            ..empty_goal_state()
        };
        assert_eq!(state.status.slug(), "complete");
    }
}

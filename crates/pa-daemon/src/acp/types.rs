//! ACP wire types: the method surface, `session/update` payload shapes,
//! and prompt-block parsing. The served surface is exactly what the TS
//! product serves; ACP-spec methods it does not serve (`session/read`,
//! `session/clone`, cwd adoption) are not invented here. Session modes
//! (ACP v1 `session-config-options`) are served: `session/new` advertises
//! a `mode` config option; `session/set_config_option` switches it.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The `initialize` result payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u64,
    pub agent_capabilities: AgentCapabilities,
    pub agent_info: AgentInfo,
    #[serde(rename = "_meta")]
    pub meta: Value,
}

/// What the agent can do, advertised in `initialize`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub prompt_capabilities: PromptCapabilities,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_capabilities: Option<McpCapabilities>,
    pub session_capabilities: SessionCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptCapabilities {
    pub image: bool,
    pub embedded_context: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpCapabilities {
    pub http: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCapabilities {
    pub close: CloseCapability,
    pub fork: ForkCapability,
}

/// `{}`: present means `session/close` is served.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct CloseCapability {}

/// `{}`: present means `session/fork` is served.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ForkCapability {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

/// The agent-facing classification of a tool call (`kind` field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcpToolKind {
    #[serde(rename = "read")]
    Read,
    #[serde(rename = "edit")]
    Edit,
    #[serde(rename = "delete")]
    Delete,
    #[serde(rename = "move")]
    Move,
    #[serde(rename = "search")]
    Search,
    #[serde(rename = "execute")]
    Execute,
    #[serde(rename = "think")]
    Think,
    #[serde(rename = "fetch")]
    Fetch,
    #[serde(rename = "other")]
    Other,
}

impl AcpToolKind {
    /// The kind map: the model-facing tool is the Python REPL; bash is the
    /// secondary escape hatch.
    pub fn of_tool(tool_name: &str) -> AcpToolKind {
        match tool_name {
            name if pa_types::ai::is_python_tool_name(name) => AcpToolKind::Execute,
            "bash" => AcpToolKind::Execute,
            "read" => AcpToolKind::Read,
            "edit" | "write" => AcpToolKind::Edit,
            _ => AcpToolKind::Other,
        }
    }
}

/// The lifecycle status of a tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpToolStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// The terminal stop reason of a `session/prompt` request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AcpStopReason {
    #[serde(rename = "end_turn")]
    EndTurn,
    #[serde(rename = "max_tokens")]
    MaxTokens,
    #[serde(rename = "max_turn_requests")]
    MaxTurnRequests,
    #[serde(rename = "refusal")]
    Refusal,
    #[serde(rename = "cancelled")]
    Cancelled,
}

/// The `session/prompt` result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AcpStopReasonResponse {
    #[serde(rename = "stopReason")]
    pub stop_reason: AcpStopReason,
}

/// The `session/update` payload body (the `update` object).
///
/// Every variant carries its TS `sessionUpdate` tag; fields are the exact
/// wire names ACP clients read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "sessionUpdate")]
pub enum AcpSessionUpdate {
    /// A streaming chunk of the assistant's visible answer.
    #[serde(rename = "agent_message_chunk")]
    AgentMessageChunk {
        #[serde(rename = "messageId")]
        message_id: String,
        content: TextBlock,
    },
    /// A streaming chunk of the assistant's reasoning.
    #[serde(rename = "agent_thought_chunk")]
    AgentThoughtChunk {
        #[serde(rename = "messageId")]
        message_id: String,
        content: TextBlock,
    },
    /// A tool call started executing.
    #[serde(rename = "tool_call")]
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        title: String,
        kind: AcpToolKind,
        status: AcpToolStatus,
        #[serde(rename = "rawInput")]
        raw_input: Value,
    },
    /// A tool call progressed or finished.
    #[serde(rename = "tool_call_update")]
    ToolCallUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<AcpToolStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Vec<ToolCallContent>>,
        #[serde(rename = "_meta", skip_serializing_if = "Option::is_none")]
        meta: Option<Value>,
        /// Set when a before-tool-call hook blocked the call (e.g. Ask/Plan
        /// mode read-only enforcement). bb distinguishes mode-blocks from
        /// ordinary tool errors so the UI can label them distinctly.
        #[serde(skip_serializing_if = "Option::is_none")]
        blocked: Option<bool>,
    },
    /// Namespaced prime-agent state (compaction, quiescence, ...).
    #[serde(rename = "session_info_update")]
    SessionInfoUpdate {
        #[serde(rename = "_meta")]
        meta: Value,
    },
    /// The session's configuration options changed (TS #2455): the
    /// full set with current values, connection-scoped.
    #[serde(rename = "config_option_update")]
    ConfigOptionUpdate {
        #[serde(rename = "configOptions")]
        config_options: Vec<super::config_options::SessionConfigOption>,
    },
    /// Context window usage for one completed assistant response (TS
    /// `usage_update`): `used` is the request's context size, `size` is
    /// the model's context window. bb maps these to the thread context
    /// window ring and popover.
    #[serde(rename = "usage_update")]
    UsageUpdate { used: u64, size: u64 },
    /// The session's plan entries (TS `plan`): the agent's current
    /// plan with per-entry status. bb renders this as a checklist.
    #[serde(rename = "plan")]
    Plan { entries: Vec<PlanEntry> },
    /// The session's available slash commands (ACP `available_commands_update`):
    /// the builtin commands the agent recognizes. bb populates autocomplete from this.
    #[serde(rename = "available_commands_update")]
    AvailableCommands {
        #[serde(rename = "availableCommands")]
        available_commands: Vec<AvailableCommand>,
    },
}

/// One entry in the available-commands list: a slash command the agent recognizes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AvailableCommand {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputHint", skip_serializing_if = "Option::is_none")]
    pub input_hint: Option<String>,
}

/// A plan entry's lifecycle status (TS `acpPlanEntryStatus`):
/// `pending`, `in_progress`, or `completed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryStatus {
    Pending,
    InProgress,
    Completed,
}

/// The relative importance of a plan entry (ACP v1 `PlanEntryPriority`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanEntryPriority {
    High,
    Medium,
    Low,
}

/// One entry in a plan update (ACP v1 `plan` entries array):
/// `content` is the entry text, `priority` and `status` are required.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub priority: PlanEntryPriority,
    pub status: PlanEntryStatus,
}

impl AcpSessionUpdate {
    /// Serialize to the wire value. `ToolCallUpdate::meta` carries a
    /// namespaced `_meta` payload (see [`meta::prime_agent_meta`]); the
    /// producer merges its correlation fields into that payload afterwards.
    pub fn to_bare_value(&self) -> Value {
        serde_json::to_value(self).expect("session updates serialize")
    }
}

/// `{ "type": "text", "text": ... }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextBlock {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

impl TextBlock {
    pub fn new(text: impl Into<String>) -> Self {
        TextBlock {
            kind: "text".to_string(),
            text: text.into(),
        }
    }
}

/// `{ "type": "content", "content": { ... } }` — the tool-call update shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCallContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub content: TextBlock,
}

impl ToolCallContent {
    pub fn new(text: impl Into<String>) -> Self {
        ToolCallContent {
            kind: "content".to_string(),
            content: TextBlock::new(text),
        }
    }
}

/// A prompt whose blocks could not be admitted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PromptBlockError {
    #[error("image block requires base64 `data` and `mimeType` strings")]
    InvalidImage,
}

/// Split ACP prompt blocks into the text and images the agent accepts.
///
/// Image, embedded-resource, and resource-link blocks are advertised in
/// `initialize`, so they must actually reach the model: dropping them would
/// let a client believe a pasted screenshot was accepted.
pub fn parse_prompt_blocks(
    prompt: &[Value],
) -> Result<(String, Vec<ImageBlock>), PromptBlockError> {
    let mut texts: Vec<String> = Vec::new();
    let mut images: Vec<ImageBlock> = Vec::new();
    for block in prompt {
        let Some(object) = block.as_object() else {
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str);
        match kind {
            Some("text") => {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    texts.push(text.to_string());
                }
            }
            Some("image") => {
                let data = object.get("data").and_then(Value::as_str);
                let mime_type = object.get("mimeType").and_then(Value::as_str);
                match (data, mime_type) {
                    (Some(data), Some(mime_type)) => images.push(ImageBlock {
                        data: data.to_string(),
                        mime_type: mime_type.to_string(),
                    }),
                    _ => return Err(PromptBlockError::InvalidImage),
                }
            }
            Some("resource") => {
                let resource = object.get("resource");
                let text = resource.and_then(|r| r.get("text")).and_then(Value::as_str);
                let uri = resource.and_then(|r| r.get("uri")).and_then(Value::as_str);
                if let Some(text) = text {
                    let uri = uri.map(|uri| format!("{uri}\n")).unwrap_or_default();
                    texts.push(format!("{uri}{text}"));
                }
            }
            Some("resource_link") => {
                if let Some(uri) = object.get("uri").and_then(Value::as_str) {
                    texts.push(uri.to_string());
                }
            }
            _ => {}
        }
    }
    Ok((texts.join("\n"), images))
}

/// The split of ACP prompt blocks into instruction-wrapper text,
/// remaining text blocks, and images.
#[allow(dead_code)]
pub struct AcpPromptSplit {
    /// Leading instruction-wrapper texts, joined. Empty when absent.
    pub instructions_text: String,
    /// Text blocks after the instruction wrapper, in order.
    pub rest_texts: Vec<String>,
    /// Image blocks from the prompt.
    pub images: Vec<ImageBlock>,
}

/// Split ACP prompt blocks into the instruction wrapper and the rest.
///
/// The first text block may be a whole `<system_instructions>` wrapper
/// or a merged wrapper+text block (some clients send them in one block).
/// The marker probe searches `rest_texts[0]` so a leading wrapper cannot
/// hide it.
pub fn split_acp_prompt_blocks(prompt: &[Value]) -> AcpPromptSplit {
    let mut instruction_texts: Vec<String> = Vec::new();
    let mut rest_texts: Vec<String> = Vec::new();
    let mut images: Vec<ImageBlock> = Vec::new();

    for block in prompt {
        let Some(object) = block.as_object() else {
            continue;
        };
        let kind = object.get("type").and_then(Value::as_str);
        match kind {
            Some("text") => {
                let Some(text) = object.get("text").and_then(Value::as_str) else {
                    continue;
                };
                let trimmed = text.trim();
                // A whole wrapper block.
                if rest_texts.is_empty() && regex_safe_match_whole(trimmed) {
                    instruction_texts.push(text.to_string());
                    continue;
                }
                // A merged wrapper+text block: split it. Only attempt the
                // split on the first text block (rest_texts empty); prior
                // instruction blocks do not prevent splitting.
                if rest_texts.is_empty() {
                    if let Some((wrapper, rest)) = split_acp_instruction_prefix(trimmed) {
                        instruction_texts.push(wrapper);
                        rest_texts.push(rest);
                        continue;
                    }
                }
                rest_texts.push(text.to_string());
            }
            Some("image") => {
                let data = object.get("data").and_then(Value::as_str);
                let mime_type = object.get("mimeType").and_then(Value::as_str);
                if let (Some(data), Some(mime_type)) = (data, mime_type) {
                    images.push(ImageBlock {
                        data: data.to_string(),
                        mime_type: mime_type.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    AcpPromptSplit {
        instructions_text: instruction_texts.join(
            "
",
        ),
        rest_texts,
        images,
    }
}

/// Check whether text is a whole `<system_instructions>` wrapper.
fn regex_safe_match_whole(text: &str) -> bool {
    // Manual check instead of regex: starts with <system_instructions>,
    // ends with </system_instructions>, and the closing tag is the last
    // non-whitespace.
    let trimmed = text.trim();
    if !trimmed.starts_with("<system_instructions>") {
        return false;
    }
    if !trimmed.ends_with("</system_instructions>") {
        return false;
    }
    // The content between tags can be anything.
    true
}

/// Split a merged wrapper+text block: `<system_instructions>...</system_instructions>rest`.
fn split_acp_instruction_prefix(text: &str) -> Option<(String, String)> {
    let trimmed = text.trim();
    if !trimmed.starts_with("<system_instructions>") {
        return None;
    }
    // Find the closing tag.
    let close_tag = "</system_instructions>";
    let close_pos = trimmed.find(close_tag)?;
    let after_close = close_pos + close_tag.len();
    let wrapper = trimmed[..after_close].to_string();
    let rest = trimmed[after_close..].trim().to_string();
    if rest.is_empty() {
        return None;
    }
    Some((wrapper, rest))
}

/// An image block admitted into a prompt.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageBlock {
    pub data: String,
    pub mime_type: String,
}

/// The prompt content admitted into a turn.
#[derive(Debug, Clone, PartialEq)]
pub struct AdmittedPrompt {
    pub text: String,
    pub images: Vec<ImageBlock>,
}

impl AdmittedPrompt {
    pub fn parse(prompt: &[Value]) -> Result<AdmittedPrompt, PromptBlockError> {
        let (text, images) = parse_prompt_blocks(prompt)?;
        // Strip a leading `<system_instructions>` wrapper from the
        // admitted text. The wrapper is bb-bridge metadata (thread
        // relocation instructions), not conversation content: storing
        // it in the session file pollutes the LLM context window and
        // breaks prefix caching on session resume.
        let text = strip_leading_instructions_wrapper(&text);
        Ok(AdmittedPrompt { text, images })
    }
}

/// Strip a leading `<system_instructions>` wrapper from joined prompt text.
/// Handles both a whole-wrapper text and a merged wrapper+text prefix.
fn strip_leading_instructions_wrapper(text: &str) -> String {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("<system_instructions>") {
        return text.to_string();
    }
    // Use the existing split function: it returns (wrapper, rest).
    if let Some((_wrapper, rest)) = split_acp_instruction_prefix(trimmed) {
        return rest;
    }
    // The whole text is a wrapper with no trailing content → empty prompt.
    if regex_safe_match_whole(trimmed) {
        return String::new();
    }
    text.to_string()
}

/// The `session/new` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct NewSessionParams {
    pub cwd: Option<String>,
    pub mcp_servers: Vec<Value>,
}

impl NewSessionParams {
    /// Parse `session/new` params. Unknown fields are ignored, matching the
    /// TS SDK's tolerance of forward-compatible params.
    pub fn parse(params: &Value) -> NewSessionParams {
        NewSessionParams {
            cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
            mcp_servers: params
                .get("mcpServers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// The `session/load` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct LoadSessionParams {
    pub session_id: String,
    pub cwd: Option<String>,
    pub mcp_servers: Vec<Value>,
}

impl LoadSessionParams {
    /// Parse `session/load` params. Unknown fields are ignored.
    pub fn parse(params: &Value) -> LoadSessionParams {
        LoadSessionParams {
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
            mcp_servers: params
                .get("mcpServers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// The `session/fork` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct ForkSessionParams {
    pub session_id: String,
    pub cwd: Option<String>,
    pub mcp_servers: Vec<Value>,
    /// Whether the request allows a foreign cwd (the `_meta` opt-in, PRIME-25).
    pub allow_foreign_cwd: bool,
}

impl ForkSessionParams {
    /// Parse `session/fork` params. Unknown fields are ignored.
    pub fn parse(params: &Value) -> ForkSessionParams {
        let allow_foreign_cwd = params
            .get("_meta")
            .and_then(|meta| meta.get(super::meta::PRIME_AGENT_META_NAMESPACE))
            .and_then(|payload| payload.get("allowForeignCwd"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        ForkSessionParams {
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            cwd: params.get("cwd").and_then(Value::as_str).map(String::from),
            mcp_servers: params
                .get("mcpServers")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            allow_foreign_cwd,
        }
    }
}

/// The `session/prompt` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct PromptParams {
    pub session_id: String,
    pub prompt: Vec<Value>,
}

impl PromptParams {
    pub fn parse(params: &Value) -> PromptParams {
        PromptParams {
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            prompt: params
                .get("prompt")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        }
    }
}

/// The `session/set_config_option` request params.
#[derive(Debug, Clone, PartialEq)]
pub struct SetConfigOptionParams {
    pub session_id: String,
    pub config_id: String,
    pub value: Value,
}

impl SetConfigOptionParams {
    /// Parse `session/set_config_option` params. The value stays raw: the
    /// handler treats a non-string value as an invalid option (the TS
    /// handler's `typeof value === "string"` gate).
    pub fn parse(params: &Value) -> SetConfigOptionParams {
        SetConfigOptionParams {
            session_id: params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            config_id: params
                .get("configId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            value: params.get("value").cloned().unwrap_or(Value::Null),
        }
    }
}

/// The initialize result with the served capability set.
pub fn initialize_result(product_version: &str) -> InitializeResult {
    InitializeResult {
        protocol_version: 1,
        agent_capabilities: AgentCapabilities {
            load_session: true,
            prompt_capabilities: PromptCapabilities {
                image: true,
                embedded_context: true,
            },
            mcp_capabilities: Some(McpCapabilities { http: true }),
            session_capabilities: SessionCapabilities {
                close: CloseCapability::default(),
                fork: ForkCapability::default(),
            },
        },
        agent_info: AgentInfo {
            name: "prime-agent".to_string(),
            title: "Prime Agent".to_string(),
            version: product_version.to_string(),
        },
        meta: super::meta::prime_agent_meta(&super::meta::PrimeAgentSessionMeta::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn initialize_result_matches_the_served_surface() {
        let value = serde_json::to_value(initialize_result("9.9.9")).unwrap();
        assert_eq!(
            value,
            json!({
                "protocolVersion": 1,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": { "image": true, "embeddedContext": true },
                    "mcpCapabilities": { "http": true },
                    "sessionCapabilities": { "close": {}, "fork": {} },
                },
                "agentInfo": { "name": "prime-agent", "title": "Prime Agent", "version": "9.9.9" },
                "_meta": { "ai.primeintellect.prime-agent": {} },
            })
        );
    }

    #[test]
    fn tool_kind_map_matches_the_ts_map() {
        assert_eq!(AcpToolKind::of_tool("python_repl"), AcpToolKind::Execute);
        assert_eq!(AcpToolKind::of_tool("bash"), AcpToolKind::Execute);
        assert_eq!(AcpToolKind::of_tool("read"), AcpToolKind::Read);
        assert_eq!(AcpToolKind::of_tool("edit"), AcpToolKind::Edit);
        assert_eq!(AcpToolKind::of_tool("write"), AcpToolKind::Edit);
        assert_eq!(AcpToolKind::of_tool("fetch"), AcpToolKind::Other);
    }

    #[test]
    fn prompt_blocks_split_text_and_images() {
        let prompt = json!([
            { "type": "text", "text": "hello" },
            { "type": "image", "data": "AAAA", "mimeType": "image/png" },
            { "type": "resource", "resource": { "uri": "file:///x", "text": "body" } },
            { "type": "resource_link", "uri": "https://example" },
            { "type": "unknown", "nonsense": true },
        ]);
        let (text, images) = parse_prompt_blocks(prompt.as_array().unwrap()).unwrap();
        assert_eq!(text, "hello\nfile:///x\nbody\nhttps://example");
        assert_eq!(
            images,
            vec![ImageBlock {
                data: "AAAA".into(),
                mime_type: "image/png".into()
            }]
        );
    }

    #[test]
    fn malformed_image_block_is_rejected() {
        let prompt = json!([{ "type": "image", "data": "AAAA" }]);
        let error = parse_prompt_blocks(prompt.as_array().unwrap()).unwrap_err();
        assert_eq!(error, PromptBlockError::InvalidImage);
    }

    #[test]
    fn config_option_update_carries_the_ts_tag_and_payload() {
        let update = AcpSessionUpdate::ConfigOptionUpdate {
            config_options: vec![super::super::config_options::SessionConfigOption {
                id: "model".to_string(),
                name: "Model".to_string(),
                kind: "select",
                category: "model".to_string(),
                current_value: r#"["faux","faux-1"]"#.to_string(),
                options: vec![super::super::config_options::SessionConfigSelectOption {
                    value: r#"["faux","faux-1"]"#.to_string(),
                    name: "Faux Model (faux)".to_string(),
                }],
            }],
        };
        let value = update.to_bare_value();
        assert_eq!(value["sessionUpdate"], "config_option_update");
        assert_eq!(value["configOptions"][0]["id"], "model");
        assert_eq!(value["configOptions"][0]["type"], "select");
        assert_eq!(
            value["configOptions"][0]["currentValue"],
            r#"["faux","faux-1"]"#
        );
        assert_eq!(
            value["configOptions"][0]["options"][0]["value"],
            r#"["faux","faux-1"]"#
        );
    }

    #[test]
    fn update_variants_carry_the_ts_tags() {
        let chunk = AcpSessionUpdate::AgentMessageChunk {
            message_id: "m1".into(),
            content: TextBlock::new("hi"),
        };
        assert_eq!(
            chunk.to_bare_value()["sessionUpdate"],
            "agent_message_chunk"
        );
        let call = AcpSessionUpdate::ToolCall {
            tool_call_id: "t1".into(),
            title: "Python cell".into(),
            kind: AcpToolKind::Execute,
            status: AcpToolStatus::InProgress,
            raw_input: json!({ "code": "1+1" }),
        };
        let value = call.to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call");
        assert_eq!(value["kind"], "execute");
        assert_eq!(value["status"], "in_progress");
        let update = AcpSessionUpdate::ToolCallUpdate {
            tool_call_id: "t1".into(),
            status: Some(AcpToolStatus::Completed),
            content: Some(vec![ToolCallContent::new("42")]),
            meta: None,
            blocked: None,
        };
        let value = update.to_bare_value();
        assert_eq!(value["sessionUpdate"], "tool_call_update");
        assert_eq!(value["status"], "completed");
        assert_eq!(value["content"][0]["type"], "content");
        assert_eq!(value["content"][0]["content"]["text"], "42");
    }

    #[test]
    fn split_acp_prompt_blocks_separates_wrapper_and_rest() {
        let prompt = json!([
            { "type": "text", "text": "<system_instructions>some instructions</system_instructions>" },
            { "type": "text", "text": "[rlm-mirror:abcdef0123456789abcdef0123456789]
[task from parent]

Do work" },
        ]);
        let split = split_acp_prompt_blocks(prompt.as_array().unwrap());
        assert!(split.instructions_text.contains("system_instructions"));
        assert_eq!(split.rest_texts.len(), 1);
        assert!(split.rest_texts[0].starts_with("[rlm-mirror:"));
    }

    #[test]
    fn split_acp_prompt_blocks_handles_merged_wrapper_and_text() {
        let prompt = json!([
            { "type": "text", "text": "<system_instructions>instructions</system_instructions>[rlm-mirror:abcdef0123456789abcdef0123456789]
        body" },
        ]);
        let split = split_acp_prompt_blocks(prompt.as_array().unwrap());
        assert!(split.instructions_text.contains("system_instructions"));
        assert_eq!(split.rest_texts.len(), 1);
        assert!(split.rest_texts[0].starts_with("[rlm-mirror:"));
    }

    #[test]
    fn split_acp_prompt_blocks_no_wrapper() {
        let prompt = json!([
            { "type": "text", "text": "plain text prompt" },
        ]);
        let split = split_acp_prompt_blocks(prompt.as_array().unwrap());
        assert!(split.instructions_text.is_empty());
        assert_eq!(split.rest_texts.len(), 1);
        assert_eq!(split.rest_texts[0], "plain text prompt");
    }
}

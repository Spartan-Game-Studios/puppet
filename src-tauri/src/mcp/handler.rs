//! The MCP surface: tool list (tools.json), server instructions, and tool
//! calls. Almost every tool runs in the webview (the avatar, stage and
//! library live there): a call goes out through a `Bridge` and the webview's
//! reply is turned into an MCP tool result here.

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation, ListToolsResult,
    PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

pub const TOOLS_JSON: &str = include_str!("tools.json");

pub const INSTRUCTIONS: &str = "\
VPuppet is a desktop VTuber app: it drives a VRM avatar from a webcam (MediaPipe face, pose and hand \
tracking) and sends it out over VMC and a virtual camera. This server talks to the running app on this \
computer, so you can see and drive what the user sees.

Typical workflows:
- Orient: app_status, then library_list. Put a model on the stage with library_load (by id) or \
library_import (an absolute .vrm path; load defaults to true).
- Diagnose a model: model_inspect gives bones, expressions, ARKit perfect-sync coverage (VPuppet matches \
the 52 ARKit names ignoring case and punctuation, and counts a model as perfect sync at 40+), presets, \
springs, mesh stats, licence and VPuppet's own model checks. stage_screenshot (framing face/bust/upper/full) \
shows the result.
- Build or fix in Blender (or the user's editor), export the .vrm, then library_import the new file \
(a changed file is a new library entry with a new id) and compare model_inspect before and after.
- Verify perfect sync: expression_sweep set='arkit' drives each of the model's ARKit expressions to 1 with \
the pose frozen and reports which ones change nothing (dead or unbound shapes) and which move the wrong \
side (swapped Left/Right), with a contact sheet. Missing names are in model_inspect's perfect_sync section, \
including shapes that exist under another naming (eyeBlink_L) and only need renaming.
- Pose a look: expression_set holds an expression (exclusive=true to silence tracking), clip_play plays an \
emote; reset with expression_set reset=true and clip_play stop=true.
- Debug tracking: tracking_stats and logs_recent; settings_get/settings_set change tracking mode, \
smoothing, framing, background and physics mode.

Notes: the avatar faces the camera, so the avatar's LEFT is on the image's RIGHT. Tools that need a model \
say so when the stage is empty. A Steam demo whose hours are used up refuses to load models onto the stage.";

/// The webview half of a tool call.
pub trait Bridge: Send + Sync + 'static {
    /// Run `tool` in the webview; resolves to its reply (see `Reply`).
    fn call(&self, tool: &str, args: Value, timeout: Duration) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>>;
    /// Facts only Rust knows, merged into app_status (version, demo clock, server).
    fn app_facts(&self) -> Value;
    /// Err(reason) when `tool` is refused right now (the demo lock).
    fn gate(&self, tool: &str) -> Result<(), String>;
}

/// What the webview sends back for a tool call.
#[derive(Debug, Default, Deserialize)]
pub struct Reply {
    /// Plain text answer (else `data` is sent as JSON text).
    pub text: Option<String>,
    pub data: Option<Value>,
    #[serde(default)]
    pub images: Vec<Image>,
    /// Tool-level failure the agent should read.
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct Image {
    /// Base64, no data: prefix.
    pub data: String,
    #[serde(rename = "mimeType", default = "png")]
    pub mime_type: String,
}
fn png() -> String {
    "image/png".into()
}

pub fn tools() -> &'static [Tool] {
    static TOOLS: OnceLock<Vec<Tool>> = OnceLock::new();
    TOOLS.get_or_init(|| serde_json::from_str(TOOLS_JSON).expect("tools.json is valid"))
}

pub fn has_tool(name: &str) -> bool {
    tools().iter().any(|t| t.name == name)
}

/// How long the webview gets per tool (imports and sweeps render a lot).
pub fn timeout_for(tool: &str) -> Duration {
    Duration::from_secs(match tool {
        "library_import" => 180,
        "expression_sweep" => 120,
        "library_load" => 90,
        "model_inspect" | "stage_screenshot" | "clip_play" => 30,
        _ => 15,
    })
}

/// A webview reply as an MCP tool result.
pub fn to_result(reply: Value) -> CallToolResult {
    let r: Reply = match serde_json::from_value(reply) {
        Ok(r) => r,
        Err(e) => return CallToolResult::error(vec![ContentBlock::text(format!("VPuppet sent a malformed reply: {e}"))]),
    };
    let mut content = Vec::new();
    if let Some(t) = r.text {
        content.push(ContentBlock::text(t));
    }
    if let Some(d) = r.data {
        content.push(ContentBlock::text(d.to_string()));
    }
    for im in r.images {
        content.push(ContentBlock::image(im.data, im.mime_type));
    }
    match r.error {
        Some(e) => {
            content.insert(0, ContentBlock::text(e));
            CallToolResult::error(content)
        }
        None => {
            if content.is_empty() {
                content.push(ContentBlock::text("ok"));
            }
            CallToolResult::success(content)
        }
    }
}

fn error(msg: impl Into<String>) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(msg.into())])
}

#[derive(Clone)]
pub struct VpuppetMcp {
    bridge: Arc<dyn Bridge>,
}

impl VpuppetMcp {
    pub fn new(bridge: Arc<dyn Bridge>) -> Self {
        VpuppetMcp { bridge }
    }

    /// One tool call, start to finish (the ServerHandler entry point minus the context).
    pub async fn run(&self, name: &str, args: Option<Map<String, Value>>) -> CallToolResult {
        if !has_tool(name) {
            return error(format!("unknown tool '{name}'"));
        }
        if let Err(e) = self.bridge.gate(name) {
            return error(e);
        }
        let args = Value::Object(args.unwrap_or_default());
        let reply = self.bridge.call(name, args, timeout_for(name)).await;
        if name == "app_status" {
            // Rust-side facts even when the window does not answer.
            let mut data = match &reply {
                Ok(v) => v.get("data").cloned().unwrap_or_else(|| json!({})),
                Err(e) => json!({ "window": e }),
            };
            if let (Some(d), Value::Object(f)) = (data.as_object_mut(), self.bridge.app_facts()) {
                for (k, v) in f {
                    d.insert(k, v);
                }
            }
            return to_result(json!({ "data": data }));
        }
        match reply {
            Ok(v) => to_result(v),
            Err(e) => error(e),
        }
    }
}

impl ServerHandler for VpuppetMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                Implementation::new("vpuppet", env!("CARGO_PKG_VERSION"))
                    .with_title("VPuppet")
                    .with_description("The running VPuppet VTuber app: avatar inspection, screenshots, expressions, library and tracking."),
            )
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(tools().to_vec()))
    }

    async fn call_tool(&self, request: CallToolRequestParams, _context: RequestContext<RoleServer>) -> Result<CallToolResponse, McpError> {
        Ok(self.run(&request.name, request.arguments).await.into())
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A webview stand-in: answers from a closure, records calls.
    pub struct FakeBridge {
        pub calls: Mutex<Vec<(String, Value)>>,
        pub answer: Box<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>,
        pub locked: bool,
    }

    impl FakeBridge {
        pub fn new(answer: impl Fn(&str, &Value) -> Result<Value, String> + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(FakeBridge { calls: Mutex::new(vec![]), answer: Box::new(answer), locked: false })
        }
    }

    impl Bridge for FakeBridge {
        fn call(&self, tool: &str, args: Value, _timeout: Duration) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>> {
            self.calls.lock().unwrap().push((tool.to_string(), args.clone()));
            let r = (self.answer)(tool, &args);
            Box::pin(async move { r })
        }
        fn app_facts(&self) -> Value {
            json!({ "version": "9.9.9", "demo": { "demo": false } })
        }
        fn gate(&self, tool: &str) -> Result<(), String> {
            if self.locked && tool == "library_load" {
                Err("demo ended".into())
            } else {
                Ok(())
            }
        }
    }

    fn texts(r: &CallToolResult) -> Vec<String> {
        r.content.iter().filter_map(|c| c.as_text().map(|t| t.text.clone())).collect()
    }

    #[test]
    fn tools_json_is_well_formed() {
        let t = tools();
        assert_eq!(t.len(), 14);
        let mut names: Vec<&str> = t.iter().map(|t| t.name.as_ref()).collect();
        for n in &names {
            assert!(n.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{n} is snake_case");
        }
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 14, "names are unique");
        for tool in t {
            assert_eq!(tool.input_schema.get("type").and_then(|v| v.as_str()), Some("object"), "{}", tool.name);
            assert!(tool.description.as_deref().is_some_and(|d| d.len() > 40), "{} has a description", tool.name);
        }
    }

    #[test]
    fn replies_become_tool_results() {
        let r = to_result(json!({ "data": { "a": 1 } }));
        assert_eq!(r.is_error, Some(false));
        assert_eq!(texts(&r), vec![r#"{"a":1}"#]);

        let r = to_result(json!({ "text": "hi", "images": [{ "data": "AAAA", "mimeType": "image/png" }] }));
        assert_eq!(r.content.len(), 2);
        assert!(r.content[1].as_image().is_some());

        let r = to_result(json!({ "error": "NO MODEL ON THE STAGE" }));
        assert_eq!(r.is_error, Some(true));
        assert_eq!(texts(&r), vec!["NO MODEL ON THE STAGE"]);

        let r = to_result(json!({ "images": "nope" }));
        assert_eq!(r.is_error, Some(true));

        assert_eq!(texts(&to_result(json!({}))), vec!["ok"]);
    }

    #[tokio::test]
    async fn calls_go_through_the_bridge() {
        let b = FakeBridge::new(|tool, args| Ok(json!({ "data": { "tool": tool, "args": args } })));
        let s = VpuppetMcp::new(b.clone());
        let mut a = Map::new();
        a.insert("id".into(), json!("abcdef12"));
        let r = s.run("library_load", Some(a)).await;
        assert_eq!(r.is_error, Some(false));
        assert_eq!(b.calls.lock().unwrap()[0], ("library_load".to_string(), json!({ "id": "abcdef12" })));

        let r = s.run("rm_rf", None).await;
        assert_eq!(r.is_error, Some(true));
        assert_eq!(b.calls.lock().unwrap().len(), 1, "unknown tools never reach the webview");
    }

    #[tokio::test]
    async fn app_status_merges_rust_facts_even_without_the_window() {
        let s = VpuppetMcp::new(FakeBridge::new(|_, _| Ok(json!({ "data": { "model": null } }))));
        let r = s.run("app_status", None).await;
        let v: Value = serde_json::from_str(&texts(&r)[0]).unwrap();
        assert_eq!(v["version"], "9.9.9");
        assert!(v.get("model").is_some());

        let s = VpuppetMcp::new(FakeBridge::new(|_, _| Err("VPuppet's window did not answer".into())));
        let r = s.run("app_status", None).await;
        assert_eq!(r.is_error, Some(false));
        let v: Value = serde_json::from_str(&texts(&r)[0]).unwrap();
        assert_eq!(v["version"], "9.9.9");
        assert_eq!(v["window"], "VPuppet's window did not answer");
    }

    #[tokio::test]
    async fn the_demo_lock_refuses_loads() {
        let b = Arc::new(FakeBridge { calls: Mutex::new(vec![]), answer: Box::new(|_, _| Ok(json!({}))), locked: true });
        let s = VpuppetMcp::new(b.clone());
        let r = s.run("library_load", None).await;
        assert_eq!(r.is_error, Some(true));
        assert!(b.calls.lock().unwrap().is_empty());
    }
}

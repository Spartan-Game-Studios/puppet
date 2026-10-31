//! Local MCP server: lets AI agents (Claude Code, Claude Desktop, Cursor and
//! other MCP clients) inspect and drive the running app, for assisted avatar
//! building and debugging.
//!
//! - Transport: MCP Streamable HTTP (the official `rmcp` SDK, stateless, JSON
//!   responses) at `http://127.0.0.1:<port>/mcp`, default port 39540 (next to
//!   VMC's 39539). Loopback only.
//! - Off by default. The frontend turns it on and off (`mcp_configure`, from
//!   the setting in src/app/mcpBridge.ts).
//! - Every request needs `Authorization: Bearer <token>`; the token is random,
//!   created on first enable and kept in the config dir as `mcp-token`
//!   (`mcp.json` beside it holds the port, for the installer scripts).
//!   Browser requests (an `Origin` header) and non-loopback `Host`s are
//!   refused (guard.rs).
//! - Tool calls go to the webview as an `mcp-call` event `{id, tool, args}`;
//!   it answers with `mcp_reply(id, reply)`. No answer in time is a tool
//!   error, never a hang.

pub mod guard;
pub mod handler;

use crate::demo::Demo;
use guard::SharedToken;
use handler::Bridge;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_PORT: u16 = 39540;
pub const TOKEN_FILE: &str = "mcp-token";
pub const INFO_FILE: &str = "mcp.json";
const CALL_EVENT: &str = "mcp-call";

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// Tool calls to the webview and back.
pub struct WebviewBridge {
    app: AppHandle,
    demo: Arc<Demo>,
    pending: Pending,
    next: AtomicU64,
    /// The webview has mounted its half (it called mcp_configure).
    ready: AtomicBool,
    port: AtomicU16,
    calls: AtomicU64,
    last_tool: Mutex<Option<String>>,
}

impl Bridge for WebviewBridge {
    fn call(&self, tool: &str, args: Value, timeout: Duration) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'static>> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        *self.last_tool.lock().unwrap_or_else(|e| e.into_inner()) = Some(tool.to_string());
        if !self.ready.load(Ordering::Acquire) {
            return Box::pin(async { Err("VPuppet's window has not connected to the MCP server yet (still starting?). Try again in a few seconds.".to_string()) });
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
        if let Err(e) = self.app.emit_to("main", CALL_EVENT, json!({ "id": id, "tool": tool, "args": args })) {
            self.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return Box::pin(async move { Err(format!("could not reach VPuppet's window: {e}")) });
        }
        let pending = self.pending.clone();
        let tool = tool.to_string();
        Box::pin(async move {
            match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(v)) => Ok(v),
                Ok(Err(_)) => Err(format!("VPuppet's window dropped the {tool} call (reloaded?)")),
                Err(_) => {
                    pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
                    Err(format!("VPuppet's window did not answer {tool} within {} s (busy loading a model, or minimized on an OS that pauses it?)", timeout.as_secs()))
                }
            }
        })
    }

    fn app_facts(&self) -> Value {
        json!({
            "app": "VPuppet",
            "version": self.app.package_info().version.to_string(),
            "demo": self.demo.status(),
            "mcp": { "port": self.port.load(Ordering::Relaxed) },
        })
    }

    fn gate(&self, tool: &str) -> Result<(), String> {
        if tool == "library_load" {
            self.demo.check().map_err(|e| {
                format!("Refused: the VPuppet demo has ended ({e}), so models can't be loaded onto the stage. The library still works (library_list, library_import with load=false).")
            })?;
        }
        Ok(())
    }
}

/// The axum app: the MCP service at /mcp behind the guard.
pub fn router(bridge: Arc<dyn Bridge>, token: SharedToken, ct: CancellationToken) -> axum::Router {
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_allowed_hosts(["localhost", "127.0.0.1", "::1"])
        .enforce_origin_validation()
        .with_cancellation_token(ct);
    let svc = StreamableHttpService::new(
        move || Ok(handler::VpuppetMcp::new(bridge.clone())),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    axum::Router::new()
        .nest_service("/mcp", svc)
        .layer(axum::middleware::from_fn_with_state(token, guard::middleware))
}

/// Serve until `ct` is cancelled.
pub async fn serve(listener: tokio::net::TcpListener, bridge: Arc<dyn Bridge>, token: SharedToken, ct: CancellationToken) -> std::io::Result<()> {
    let app = router(bridge, token, ct.child_token());
    axum::serve(listener, app).with_graceful_shutdown(async move { ct.cancelled_owned().await }).await
}

#[derive(Debug, Clone, Serialize)]
pub struct McpStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    /// http://127.0.0.1:<port>/mcp while running.
    pub url: Option<String>,
    /// Last start failure (port in use...).
    pub error: Option<String>,
    /// Where mcp-token lives.
    pub config_dir: String,
    pub has_token: bool,
    /// Tool calls served since launch, and the last one.
    pub calls: u64,
    pub last_tool: Option<String>,
}

struct Running {
    port: u16,
    ct: CancellationToken,
}

pub struct McpState {
    bridge: Arc<WebviewBridge>,
    token: SharedToken,
    dir: PathBuf,
    server: tokio::sync::Mutex<Option<Running>>,
    error: Mutex<Option<String>>,
    enabled: AtomicBool,
}

impl McpState {
    pub fn new(app: AppHandle, dir: PathBuf, demo: Arc<Demo>) -> Self {
        let token = read_token(&dir).unwrap_or_default();
        McpState {
            bridge: Arc::new(WebviewBridge {
                app,
                demo,
                pending: Arc::default(),
                next: AtomicU64::new(1),
                ready: AtomicBool::new(false),
                port: AtomicU16::new(DEFAULT_PORT),
                calls: AtomicU64::new(0),
                last_tool: Mutex::new(None),
            }),
            token: Arc::new(RwLock::new(token)),
            dir,
            server: tokio::sync::Mutex::new(None),
            error: Mutex::new(None),
            enabled: AtomicBool::new(false),
        }
    }

    async fn status(&self) -> McpStatus {
        let running = self.server.lock().await.as_ref().map(|r| r.port);
        let port = running.unwrap_or(self.bridge.port.load(Ordering::Relaxed));
        McpStatus {
            enabled: self.enabled.load(Ordering::Relaxed),
            running: running.is_some(),
            port,
            url: running.map(|p| url(p)),
            error: self.error.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            config_dir: self.dir.display().to_string(),
            has_token: !self.token.read().unwrap_or_else(|e| e.into_inner()).is_empty(),
            calls: self.bridge.calls.load(Ordering::Relaxed),
            last_tool: self.bridge.last_tool.lock().unwrap_or_else(|e| e.into_inner()).clone(),
        }
    }

    fn ensure_token(&self) -> Result<(), String> {
        let mut t = self.token.write().unwrap_or_else(|e| e.into_inner());
        if t.is_empty() {
            let fresh = guard::new_token()?;
            write_private(&self.dir.join(TOKEN_FILE), &fresh)?;
            *t = fresh;
        }
        Ok(())
    }

    async fn stop(&self) {
        if let Some(r) = self.server.lock().await.take() {
            r.ct.cancel();
        }
    }

    async fn configure(&self, enabled: bool, port: u16) -> McpStatus {
        self.bridge.ready.store(true, Ordering::Release);
        self.enabled.store(enabled, Ordering::Relaxed);
        let port = if port == 0 { DEFAULT_PORT } else { port };
        self.bridge.port.store(port, Ordering::Relaxed);
        let result = if enabled { self.start(port).await } else { self.stop().await; Ok(()) };
        *self.error.lock().unwrap_or_else(|e| e.into_inner()) = result.err();
        let _ = write_info(&self.dir, port, enabled);
        self.status().await
    }

    async fn start(&self, port: u16) -> Result<(), String> {
        let mut server = self.server.lock().await;
        if server.as_ref().is_some_and(|r| r.port == port) {
            return Ok(());
        }
        if let Some(r) = server.take() {
            r.ct.cancel();
        }
        self.ensure_token()?;
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("port {port}: {e}"))?;
        let ct = CancellationToken::new();
        let bridge: Arc<dyn Bridge> = self.bridge.clone();
        let (token, c) = (self.token.clone(), ct.clone());
        tauri::async_runtime::spawn(async move {
            if let Err(e) = serve(listener, bridge, token, c).await {
                eprintln!("[vpuppet] mcp: server stopped: {e}");
            }
        });
        println!("[vpuppet] mcp: listening on {}", url(port));
        *server = Some(Running { port, ct });
        Ok(())
    }
}

pub fn url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

fn read_token(dir: &Path) -> Option<String> {
    let t = std::fs::read_to_string(dir.join(TOKEN_FILE)).ok()?;
    let t = t.trim();
    (t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit())).then(|| t.to_string())
}

/// Owner-only file, written atomically.
fn write_private(path: &Path, text: &str) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&tmp).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// mcp.json: what the installer scripts need besides the token.
fn write_info(dir: &Path, port: u16, enabled: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let json = serde_json::to_string_pretty(&json!({ "enabled": enabled, "port": port, "url": url(port), "token_file": TOKEN_FILE }))?;
    let p = dir.join(INFO_FILE);
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, p)
}

// ---------------------------------------------------------------- commands

/// Turn the server on or off (the webview calls this at start with the saved setting).
#[tauri::command]
pub async fn mcp_configure(state: State<'_, McpState>, enabled: bool, port: u16) -> Result<McpStatus, String> {
    Ok(state.configure(enabled, port).await)
}

#[tauri::command]
pub async fn mcp_status(state: State<'_, McpState>) -> Result<McpStatus, String> {
    Ok(state.status().await)
}

/// The webview's answer to an `mcp-call` event.
#[tauri::command]
pub fn mcp_reply(state: State<'_, McpState>, id: u64, reply: Value) {
    if let Some(tx) = state.bridge.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send(reply);
    }
}

/// New token: every client must be registered again (the installer does it).
#[tauri::command]
pub async fn mcp_reset_token(state: State<'_, McpState>) -> Result<McpStatus, String> {
    let fresh = guard::new_token()?;
    write_private(&state.dir.join(TOKEN_FILE), &fresh)?;
    *state.token.write().unwrap_or_else(|e| e.into_inner()) = fresh;
    Ok(state.status().await)
}

/// `claude mcp add ...` with the token in it, for the UI's copy button.
#[tauri::command]
pub async fn mcp_connect_command(state: State<'_, McpState>) -> Result<String, String> {
    state.ensure_token()?;
    let port = state.status().await.port;
    let token = state.token.read().unwrap_or_else(|e| e.into_inner()).clone();
    Ok(format!("claude mcp add --transport http --scope user vpuppet {} --header \"Authorization: Bearer {token}\"", url(port)))
}

#[cfg(test)]
mod tests {
    use super::handler::tests::FakeBridge;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    async fn start() -> (u16, CancellationToken, Arc<FakeBridge>) {
        let bridge = FakeBridge::new(|tool, args| match tool {
            "library_list" => Ok(json!({ "data": { "models": [{ "id": "ab12", "name": "Test" }], "args": args } })),
            "stage_screenshot" => Ok(json!({ "images": [{ "data": "iVBORw0KGgo=", "mimeType": "image/png" }] })),
            "model_inspect" => Ok(json!({ "error": "NO MODEL ON THE STAGE: load one with library_load" })),
            _ => Err("not in this test".into()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let ct = CancellationToken::new();
        let b: Arc<dyn Bridge> = bridge.clone();
        tokio::spawn(serve(listener, b, Arc::new(RwLock::new(TOKEN.into())), ct.clone()));
        (port, ct, bridge)
    }

    /// One raw HTTP/1.1 POST. Returns (status, body).
    async fn post(port: u16, body: &str, extra: &[(&str, &str)]) -> (u16, String) {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut req = format!(
            "POST /mcp HTTP/1.1\r\nConnection: close\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n",
            body.len()
        );
        let has = |k: &str| extra.iter().any(|(n, _)| n.eq_ignore_ascii_case(k));
        if !has("host") {
            req += &format!("Host: 127.0.0.1:{port}\r\n");
        }
        if !has("authorization") {
            req += &format!("Authorization: Bearer {TOKEN}\r\n");
        }
        for (k, v) in extra {
            if !v.is_empty() {
                req += &format!("{k}: {v}\r\n");
            }
        }
        req += "\r\n";
        req += body;
        s.write_all(req.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        s.read_to_end(&mut raw).await.unwrap();
        let text = String::from_utf8_lossy(&raw).to_string();
        let (head, rest) = text.split_once("\r\n\r\n").unwrap();
        let status: u16 = head.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = if head.to_ascii_lowercase().contains("transfer-encoding: chunked") { dechunk(rest) } else { rest.to_string() };
        (status, body)
    }

    fn dechunk(mut s: &str) -> String {
        let mut out = String::new();
        while let Some((size, rest)) = s.split_once("\r\n") {
            let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
            if n == 0 {
                break;
            }
            out += &rest[..n];
            s = &rest[n + 2..];
        }
        out
    }

    const V: (&str, &str) = ("MCP-Protocol-Version", "2025-06-18");

    fn rpc(id: u64, method: &str, params: Value) -> String {
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
    }

    #[tokio::test]
    async fn speaks_mcp_over_http() {
        let (port, ct, bridge) = start().await;

        let init = rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }));
        let (st, body) = post(port, &init, &[]).await;
        assert_eq!(st, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["serverInfo"]["name"], "vpuppet");
        assert!(v["result"]["instructions"].as_str().unwrap().contains("expression_sweep"));
        assert!(v["result"]["capabilities"]["tools"].is_object());

        let (st, _) = post(port, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &[V]).await;
        assert_eq!(st, 202);

        let (st, body) = post(port, &rpc(2, "tools/list", json!({})), &[V]).await;
        assert_eq!(st, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        let names: Vec<&str> = v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names.len(), 15);
        assert!(names.contains(&"expression_sweep"));

        let (st, body) = post(port, &rpc(3, "tools/call", json!({ "name": "library_list", "arguments": { "search": "te" } })), &[V]).await;
        assert_eq!(st, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], false);
        let inner: Value = serde_json::from_str(v["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["models"][0]["name"], "Test");
        assert_eq!(bridge.calls.lock().unwrap()[0].1, json!({ "search": "te" }));

        let (_, body) = post(port, &rpc(4, "tools/call", json!({ "name": "stage_screenshot", "arguments": {} })), &[V]).await;
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["content"][0]["type"], "image");
        assert_eq!(v["result"]["content"][0]["mimeType"], "image/png");

        let (_, body) = post(port, &rpc(5, "tools/call", json!({ "name": "model_inspect", "arguments": {} })), &[V]).await;
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], true);
        assert!(v["result"]["content"][0]["text"].as_str().unwrap().starts_with("NO MODEL"));

        // A timeout / unanswered call is a tool error, not a protocol error.
        let (_, body) = post(port, &rpc(6, "tools/call", json!({ "name": "clip_list", "arguments": {} })), &[V]).await;
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["result"]["isError"], true);
        ct.cancel();
    }

    #[tokio::test]
    async fn refuses_strangers() {
        let (port, ct, bridge) = start().await;
        let list = rpc(1, "tools/list", json!({}));
        let (st, _) = post(port, &list, &[V, ("Authorization", "Bearer nope")]).await;
        assert_eq!(st, 401);
        let (st, _) = post(port, &list, &[V, ("Authorization", "")]).await;
        assert_eq!(st, 401);
        let (st, _) = post(port, &list, &[V, ("Origin", "https://evil.example")]).await;
        assert_eq!(st, 403);
        let (st, _) = post(port, &list, &[V, ("Host", "evil.example:39540")]).await;
        assert_eq!(st, 403);
        assert!(bridge.calls.lock().unwrap().is_empty());
        ct.cancel();
    }

    #[test]
    fn token_file_is_private_and_reread() {
        let d = std::env::temp_dir().join(format!("vpuppet-mcp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(read_token(&d), None);
        let t = guard::new_token().unwrap();
        write_private(&d.join(TOKEN_FILE), &t).unwrap();
        assert_eq!(read_token(&d).as_deref(), Some(t.as_str()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(d.join(TOKEN_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::write(d.join(TOKEN_FILE), "short").unwrap();
        assert_eq!(read_token(&d), None, "a damaged token is replaced, not used");
        write_info(&d, 40000, true).unwrap();
        let v: Value = serde_json::from_str(&std::fs::read_to_string(d.join(INFO_FILE)).unwrap()).unwrap();
        assert_eq!(v["port"], 40000);
        let _ = std::fs::remove_dir_all(&d);
    }
}

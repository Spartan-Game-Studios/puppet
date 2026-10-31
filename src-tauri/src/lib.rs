//! VPuppet: Tauri shell. The app itself (rendering, tracking, solving) is the
//! web frontend; Rust provides file access, settings persistence, the VMC
//! sender, the virtual camera output, the model library (library.rs), the
//! imported animation clips (clips.rs), global hotkeys (plugin), camera
//! permission handling, the local MCP server for AI agents (mcp/, off by
//! default) and, in the Steam demo build, the usage clock that locks the
//! outputs after 100 hours (demo.rs).

mod clips;
mod demo;
mod library;
mod mcp;
mod migrate;
mod vcam;
mod vmc;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "macos")]
extern "C" {
    fn pbg_begin_activity();
    fn pbg_keep_webview_running(webview: *mut std::ffi::c_void);
}

/// Keep tracking, rendering and sending while the window is minimized, hidden
/// or covered (see macos/bridge/PuppetBackground.m; the frontend half is
/// src/app/backgroundLoop.ts).
fn keep_running_in_background(app: &tauri::App) {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain FFI call.
        unsafe { pbg_begin_activity() };
        if let Some(w) = app.get_webview_window("main") {
            // with_webview runs the closure on the main thread.
            let _ = w.with_webview(|wv| unsafe { pbg_keep_webview_running(wv.inner()) });
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

struct DemoState(Arc<demo::Demo>);

#[derive(Default)]
struct VmcState(Mutex<vmc::Sender>);

/// Virtual camera: the frame path takes `cam` briefly per frame; status and
/// setup go through `handle` so a slow device probe never stalls frames.
struct VcamState {
    cam: Mutex<vcam::VirtualCam>,
    handle: vcam::VcamHandle,
}

/// Read a file the user picked (model, background image) as raw bytes.
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// settings.json, mcp-token and mcp.json live here.
fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // PUPPET_SETTINGS_DIR: keep test runs away from the user's own settings.
    match std::env::var_os("PUPPET_SETTINGS_DIR") {
        Some(d) => Ok(PathBuf::from(d)),
        None => app.path().app_config_dir().map_err(|e| e.to_string()),
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    let p = settings_path(&app)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Atomic save: write a temp file next to it, then rename over.
#[tauri::command]
fn save_settings(app: AppHandle, json: String) -> Result<(), String> {
    let p = settings_path(&app)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
fn settings_location(app: AppHandle) -> Result<String, String> {
    Ok(settings_path(&app)?.display().to_string())
}

/// Extra URL-style parameters from the PUPPET_QUERY environment variable, so
/// the desktop app can be driven like `?source=file&src=...` in the browser
/// (used for automated testing without a camera).
#[tauri::command]
fn dev_query() -> String {
    std::env::var("PUPPET_QUERY").unwrap_or_default()
}

/// Print a line from the frontend to stdout (enabled with `debuglog=1`).
#[tauri::command]
fn debug_log(line: String) {
    println!("[vpuppet] {line}");
}

#[tauri::command]
fn vmc_configure(state: State<VmcState>, demo: State<DemoState>, enabled: bool, host: String, port: u16) -> Result<(), String> {
    if enabled {
        demo.0.check()?;
    }
    state.0.lock().map_err(|e| e.to_string())?.configure(enabled, &host, port)
}

#[tauri::command]
fn vmc_send(state: State<VmcState>, demo: State<DemoState>, frame: vmc::Frame) -> Result<(), String> {
    demo.0.check()?;
    demo.0.touch();
    state.0.lock().map_err(|e| e.to_string())?.send(&frame)
}

#[tauri::command]
fn vmc_stats(state: State<VmcState>) -> Result<vmc::Stats, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.stats.clone())
}

#[tauri::command(async)]
fn vcam_status(state: State<'_, VcamState>) -> Result<vcam::SinkStatus, String> {
    Ok(state.handle.status())
}

#[tauri::command]
fn vcam_stats(state: State<'_, VcamState>) -> vcam::VcamStats {
    state.handle.stats()
}

/// Install / activate / register the OS camera (may show an OS prompt).
#[tauri::command(async)]
fn vcam_setup(state: State<'_, VcamState>) -> Result<(), String> {
    state.handle.setup()
}

/// The camera driver's install state (macOS camera extension); null elsewhere.
#[tauri::command(async)]
fn vcam_ext_status(state: State<'_, VcamState>) -> Option<vcam::ExtensionStatus> {
    state.handle.extension()
}

/// Install or update the camera extension (macOS asks the user to approve).
#[tauri::command(async)]
fn vcam_ext_install(state: State<'_, VcamState>) -> Result<(), String> {
    state.handle.install_extension()
}

/// Remove the camera extension (the panel confirms first; macOS may ask too).
#[tauri::command(async)]
fn vcam_ext_uninstall(state: State<'_, VcamState>) -> Result<(), String> {
    state.cam.lock().map_err(|e| e.to_string())?.stop();
    state.handle.uninstall_extension()
}

/// Open the System Settings page where the extension is approved.
#[tauri::command(async)]
fn vcam_ext_open_settings(state: State<'_, VcamState>) -> Result<(), String> {
    state.handle.open_settings()
}

#[tauri::command(async)]
fn vcam_select_device(state: State<'_, VcamState>, device: Option<String>) -> Result<(), String> {
    state.handle.select_device(device);
    Ok(())
}

#[tauri::command(async)]
fn vcam_start(state: State<'_, VcamState>, demo: State<'_, DemoState>, width: u32, height: u32, fps: u32) -> Result<(), String> {
    demo.0.check()?;
    state.cam.lock().map_err(|e| e.to_string())?.start(vcam::StreamConfig { width, height, fps })
}

#[tauri::command(async)]
fn vcam_stop(state: State<'_, VcamState>) -> Result<(), String> {
    state.cam.lock().map_err(|e| e.to_string())?.stop();
    Ok(())
}

/// One frame as a raw binary body (no JSON): see `vcam::parse_frame`. Runs off
/// the main thread; returns as soon as the frame is queued (or dropped).
#[tauri::command(async)]
fn vcam_frame(state: State<'_, VcamState>, demo: State<'_, DemoState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("vcam_frame expects a binary body".into());
    };
    if let Err(e) = demo.0.check() {
        // The time ran out while streaming: take the camera down here too.
        state.cam.lock().map_err(|e| e.to_string())?.stop();
        return Err(e);
    }
    demo.0.touch();
    state.cam.lock().map_err(|e| e.to_string())?.push(body)
}

/// The demo's clock (`demo: false` in the full app).
#[tauri::command]
fn demo_status(demo: State<DemoState>) -> demo::Status {
    demo.0.status()
}

/// The stage is in use (model loaded, tracking): counts toward the demo's hours.
#[tauri::command]
fn demo_heartbeat(demo: State<DemoState>) -> demo::Status {
    demo.0.touch();
    demo.0.status()
}

/// The full app's store page: in the Steam client when it's running (the
/// overlay of a running demo can't buy another app), else on the web. The app
/// ID comes from VPUPPET_STEAM_APP_ID at build time.
#[tauri::command(async)]
fn demo_buy() -> Result<(), String> {
    match option_env!("VPUPPET_STEAM_APP_ID") {
        Some(id) if cfg!(feature = "steam") => library::open_url(&format!("steam://store/{id}")),
        Some(id) => library::open_url(&format!("https://store.steampowered.com/app/{id}/")),
        None => library::open_url("https://store.steampowered.com/search/?term=VPuppet"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Emote / expression hotkeys that work while VPuppet is in the background.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(VmcState::default())
        // getUserMedia: grant the camera to our own webview without a second
        // in-webview prompt. The OS still asks (macOS TCC via
        // NSCameraUsageDescription in Info.plist; Windows privacy settings).
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            // Mic lip sync (off by default; only asked for when the user picks a mic).
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            // Before anything reads settings or the library.
            migrate::from_puppet(app.handle());
            let demo_dir = match std::env::var_os("PUPPET_SETTINGS_DIR") {
                Some(d) => Some(PathBuf::from(d)),
                None => app.path().app_data_dir().ok(),
            };
            let demo = Arc::new(demo::Demo::new(demo_dir));
            demo::spawn_ticker(demo.clone());
            // MCP server state; the server itself starts when the webview
            // calls mcp_configure with the setting on.
            if let Ok(dir) = config_dir(app.handle()) {
                app.manage(mcp::McpState::new(app.handle().clone(), dir, demo.clone()));
            }
            app.manage(DemoState(demo));
            keep_running_in_background(app);
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                // WebKitGTK ships with media streams disabled.
                let _ = w.with_webview(|wv| {
                    use webkit2gtk::{SettingsExt, WebViewExt};
                    if let Some(s) = wv.inner().settings() {
                        s.set_enable_media_stream(true);
                    }
                });
            }
            let cam = vcam::VirtualCam::new(vcam::default_sink(app.path().resource_dir().ok()));
            let handle = cam.handle();
            // PUPPET_VCAM_SELFTEST=status|setup: print the sink status (after
            // running setup, i.e. the macOS activation request) for 15 s.
            if let Ok(mode) = std::env::var("PUPPET_VCAM_SELFTEST") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    if mode == "setup" {
                        println!("[vpuppet] vcam selftest: setup -> {:?}", h.setup());
                    }
                    for _ in 0..15 {
                        println!("[vpuppet] vcam selftest: {}", serde_json::to_string(&h.status()).unwrap_or_default());
                        println!("[vpuppet] vcam selftest ext: {}", serde_json::to_string(&h.extension()).unwrap_or_default());
                        std::thread::sleep(std::time::Duration::from_secs(1));
                    }
                });
            }
            app.manage(VcamState { cam: Mutex::new(cam), handle });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            load_settings,
            save_settings,
            settings_location,
            dev_query,
            debug_log,
            demo_status,
            demo_heartbeat,
            demo_buy,
            vmc_configure,
            vmc_send,
            vmc_stats,
            vcam_status,
            vcam_stats,
            vcam_setup,
            vcam_select_device,
            vcam_ext_status,
            vcam_ext_install,
            vcam_ext_uninstall,
            vcam_ext_open_settings,
            vcam_start,
            vcam_stop,
            vcam_frame,
            library::library_location,
            library::library_list,
            library::library_import_path,
            library::library_write,
            library::library_read,
            library::save_vrm_as,
            library::library_delete,
            library::library_index_load,
            library::library_index_save,
            library::library_reveal,
            library::library_open_link,
            clips::clips_location,
            clips::clips_import_path,
            clips::clips_write,
            clips::clips_read,
            clips::clips_delete,
            clips::clips_index_load,
            clips::clips_index_save,
            mcp::mcp_configure,
            mcp::mcp_status,
            mcp::mcp_reply,
            mcp::mcp_reset_token,
            mcp::mcp_connect_command
        ])
        .build(tauri::generate_context!())
        .expect("error while building VPuppet")
        .run(|app, event| {
            // Quitting: close the camera output, which also tells the macOS
            // camera extension to take its device down right away (instead
            // of after the heartbeat times out).
            if let tauri::RunEvent::Exit = event {
                if let Some(d) = app.try_state::<DemoState>() {
                    d.0.flush();
                }
                if let Some(s) = app.try_state::<VcamState>() {
                    if let Ok(mut cam) = s.cam.lock() {
                        cam.stop();
                    }
                }
            }
        });
}

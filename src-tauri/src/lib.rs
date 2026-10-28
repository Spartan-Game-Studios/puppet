//! Puppet: Tauri shell. The app itself (rendering, tracking, solving) is the
//! web frontend; Rust provides file access, settings persistence, the VMC
//! sender and camera permission handling.

mod vmc;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
struct VmcState(Mutex<vmc::Sender>);

/// Read a file the user picked (model, background image) as raw bytes.
#[tauri::command]
fn read_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
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
    println!("[puppet] {line}");
}

#[tauri::command]
fn vmc_configure(state: State<VmcState>, enabled: bool, host: String, port: u16) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.configure(enabled, &host, port)
}

#[tauri::command]
fn vmc_send(state: State<VmcState>, frame: vmc::Frame) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.send(&frame)
}

#[tauri::command]
fn vmc_stats(state: State<VmcState>) -> Result<vmc::Stats, String> {
    Ok(state.0.lock().map_err(|e| e.to_string())?.stats.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(VmcState::default())
        // getUserMedia: grant the camera to our own webview without a second
        // in-webview prompt. The OS still asks (macOS TCC via
        // NSCameraUsageDescription in Info.plist; Windows privacy settings).
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
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
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            load_settings,
            save_settings,
            settings_location,
            dev_query,
            debug_log,
            vmc_configure,
            vmc_send,
            vmc_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running Puppet");
}

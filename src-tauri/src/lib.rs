//! Puppet: Tauri shell. The app itself (rendering, tracking, solving) is the
//! web frontend; Rust provides file access, settings persistence, the VMC
//! sender, the virtual camera output, the model library (library.rs) and
//! camera permission handling.

mod library;
mod vcam;
mod vmc;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State};

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

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    // PUPPET_SETTINGS_DIR: keep test runs away from the user's own settings.
    let dir = match std::env::var_os("PUPPET_SETTINGS_DIR") {
        Some(d) => PathBuf::from(d),
        None => app.path().app_config_dir().map_err(|e| e.to_string())?,
    };
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

#[tauri::command(async)]
fn vcam_select_device(state: State<'_, VcamState>, device: Option<String>) -> Result<(), String> {
    state.handle.select_device(device);
    Ok(())
}

#[tauri::command(async)]
fn vcam_start(state: State<'_, VcamState>, width: u32, height: u32, fps: u32) -> Result<(), String> {
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
fn vcam_frame(state: State<'_, VcamState>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("vcam_frame expects a binary body".into());
    };
    state.cam.lock().map_err(|e| e.to_string())?.push(body)
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
            let cam = vcam::VirtualCam::new(vcam::default_sink(app.path().resource_dir().ok()));
            let handle = cam.handle();
            // PUPPET_VCAM_SELFTEST=status|setup: print the sink status (after
            // running setup, i.e. the macOS activation request) for 15 s.
            if let Ok(mode) = std::env::var("PUPPET_VCAM_SELFTEST") {
                let h = handle.clone();
                std::thread::spawn(move || {
                    if mode == "setup" {
                        println!("[puppet] vcam selftest: setup -> {:?}", h.setup());
                    }
                    for _ in 0..15 {
                        println!("[puppet] vcam selftest: {}", serde_json::to_string(&h.status()).unwrap_or_default());
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
            vmc_configure,
            vmc_send,
            vmc_stats,
            vcam_status,
            vcam_stats,
            vcam_setup,
            vcam_select_device,
            vcam_start,
            vcam_stop,
            vcam_frame,
            library::library_location,
            library::library_list,
            library::library_import_path,
            library::library_write,
            library::library_read,
            library::library_delete,
            library::library_index_load,
            library::library_index_save,
            library::library_reveal,
            library::library_open_link
        ])
        .run(tauri::generate_context!())
        .expect("error while running Puppet");
}

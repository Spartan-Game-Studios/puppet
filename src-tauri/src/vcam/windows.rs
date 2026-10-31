//! Windows sink: softcam (MIT, <https://github.com/tshino/softcam>), a
//! DirectShow virtual camera.
//!
//! `scripts/build-softcam.ps1` builds `softcam.dll` from a pinned commit with
//! VPuppet's own filter name ("VPuppet Virtual Camera"), CLSID and shared-memory
//! names, and the bundle ships it next to `vpuppet.exe`. The DLL is two things
//! at once: the DirectShow filter that camera apps load (it must be registered
//! once, with admin rights, via `regsvr32`), and the sender API we load here
//! at runtime (`scCreateCamera` / `scSendFrame` / `scDeleteCamera`). Frames go
//! through shared memory as 24-bit BGR, top-down.

use super::{convert, BgraFrame, PixelFormat, SinkState, SinkStatus, StreamConfig, VirtualCamSink};
use libloading::{Library, Symbol};
use std::ffi::c_void;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

/// Must match `scripts/build-softcam.ps1`.
pub const CLSID: &str = "{233F85CE-D09F-4E37-B572-149BB9E17F11}";
pub const DLL_NAME: &str = "softcam.dll";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

type CreateFn = unsafe extern "C" fn(i32, i32, f32) -> *mut c_void;
type DeleteFn = unsafe extern "C" fn(*mut c_void);
type SendFn = unsafe extern "C" fn(*mut c_void, *const c_void);

struct Camera {
    lib: Library,
    handle: *mut c_void,
}

// SAFETY: the softcam handle is only used from the writer thread that owns the sink.
unsafe impl Send for Camera {}

pub struct SoftcamSink {
    dll: Option<PathBuf>,
    cam: Option<Camera>,
    buf: Vec<u8>,
    last_error: Option<String>,
}

impl SoftcamSink {
    pub fn new(resource_dir: Option<PathBuf>) -> Self {
        let mut candidates = Vec::new();
        if let Some(d) = resource_dir {
            candidates.push(d.join(DLL_NAME));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(d) = exe.parent() {
                candidates.push(d.join(DLL_NAME));
            }
        }
        // `tauri dev`: the DLL built by scripts/build-softcam.ps1.
        #[cfg(debug_assertions)]
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("vendor/softcam").join(DLL_NAME));
        let dll = candidates.into_iter().find(|p| p.is_file());
        SoftcamSink { dll, cam: None, buf: Vec::new(), last_error: None }
    }

    /// Registered DLL path (InprocServer32 default value), if any.
    fn registered_path() -> Option<String> {
        let out = Command::new("reg")
            .args(["query", &format!("HKCR\\CLSID\\{CLSID}\\InprocServer32"), "/ve"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        text.lines()
            .find(|l| l.contains("REG_SZ"))
            .and_then(|l| l.split("REG_SZ").nth(1))
            .map(|s| s.trim().to_string())
    }
}

impl VirtualCamSink for SoftcamSink {
    fn name(&self) -> &'static str {
        "softcam"
    }

    fn probe(&mut self) -> SinkStatus {
        let mut st = match (&self.dll, Self::registered_path()) {
            (None, _) => SinkStatus::new("softcam", SinkState::Unavailable, "SOFTCAM.DLL NOT IN THIS BUILD")
                .hint("Build it with scripts/build-softcam.ps1, or use the OBS route."),
            (Some(dll), None) => SinkStatus::new("softcam", SinkState::NeedsSetup, "CAMERA NOT REGISTERED")
                .hint("Click REGISTER CAMERA and accept the Windows admin prompt (once). It registers VPuppet's camera DLL with regsvr32.")
                .command(format!("regsvr32 \"{}\"", dll.display()))
                .action("REGISTER CAMERA"),
            (Some(dll), Some(reg)) => {
                let same = PathBuf::from(&reg) == *dll;
                let state = if self.cam.is_some() { SinkState::Running } else { SinkState::Ready };
                let mut s = SinkStatus::new("softcam", state, "VPUPPET VIRTUAL CAMERA (DIRECTSHOW)");
                if !same {
                    s = s
                        .hint(format!("Registered DLL is {reg}; this copy is {}. Click RE-REGISTER if the camera doesn't show up.", dll.display()))
                        .action("RE-REGISTER");
                }
                s
            }
        };
        if let Some(e) = &self.last_error {
            if st.state != SinkState::Running {
                st.detail = format!("{} | {e}", st.detail);
            }
        }
        st.format = Some(PixelFormat::Bgr24);
        st
    }

    /// Register the DLL elevated (UAC prompt). Blocks until regsvr32 exits.
    fn setup(&mut self) -> Result<(), String> {
        let dll = self.dll.clone().ok_or("softcam.dll missing from this build")?;
        let ps = format!(
            "$p = Start-Process -FilePath regsvr32.exe -ArgumentList '/s','\"{}\"' -Verb RunAs -Wait -PassThru; exit $p.ExitCode",
            dll.display().to_string().replace('\'', "''")
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("could not start regsvr32: {e}"))?;
        if status.success() && Self::registered_path().is_some() {
            Ok(())
        } else {
            Err(format!("regsvr32 failed or was cancelled ({status})"))
        }
    }

    fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
        let dll = self.dll.clone().ok_or("softcam.dll missing from this build")?;
        // SAFETY: loading our own bundled DLL; symbols match softcam.h.
        unsafe {
            let lib = Library::new(&dll).map_err(|e| format!("{}: {e}", dll.display()))?;
            let create: Symbol<CreateFn> = lib.get(b"scCreateCamera\0").map_err(|e| e.to_string())?;
            let handle = create(cfg.width as i32, cfg.height as i32, cfg.fps as f32);
            if handle.is_null() {
                let e = "scCreateCamera failed (is another VPuppet already streaming?)".to_string();
                self.last_error = Some(e.clone());
                return Err(e);
            }
            self.cam = Some(Camera { lib, handle });
        }
        self.last_error = None;
        Ok(())
    }

    fn write(&mut self, frame: &BgraFrame) -> Result<(), String> {
        let Some(cam) = &self.cam else { return Err("not open".into()) };
        convert::convert(frame.data, frame.width, frame.height, PixelFormat::Bgr24, &mut self.buf);
        // SAFETY: buffer is width*height*3 bytes as softcam expects; handle is live.
        unsafe {
            let send: Symbol<SendFn> = cam.lib.get(b"scSendFrame\0").map_err(|e| e.to_string())?;
            send(cam.handle, self.buf.as_ptr() as *const c_void);
        }
        Ok(())
    }

    fn close(&mut self) {
        if let Some(cam) = self.cam.take() {
            // SAFETY: handle came from scCreateCamera in the same library.
            unsafe {
                if let Ok(del) = cam.lib.get::<DeleteFn>(b"scDeleteCamera\0") {
                    del(cam.handle);
                }
            }
        }
    }
}

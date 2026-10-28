//! macOS sink: a CoreMediaIO Camera Extension (system extension, macOS 12.3+).
//!
//! The extension (`src-tauri/macos/camera-extension/`, Swift) is embedded at
//! `Puppet.app/Contents/Library/SystemExtensions/` and publishes a device
//! "Puppet Virtual Camera" with a source stream (what Zoom / Meet / Discord
//! read) and a sink stream (what we write into). The app side lives in
//! `src-tauri/macos/bridge/PuppetVCamBridge.m` (activation through
//! OSSystemExtensionRequest, frames through the CMIO sink queue); this module
//! wraps it and turns its state into the panel's plain-language status.
//!
//! Installing a system extension requires a Developer ID-signed app with the
//! `com.apple.developer.system-extension.install` entitlement (from a
//! provisioning profile) and the app in /Applications. See
//! `docs/virtual-camera.md`.

use super::{BgraFrame, PixelFormat, SinkState, SinkStatus, StreamConfig, VirtualCamSink};
use std::ffi::{c_char, CStr};
use std::time::{Duration, Instant};

#[repr(C)]
struct PvcStatus {
    request_state: i32,
    error_code: i64,
    device_present: i32,
    in_applications: i32,
    is_bundle: i32,
    extension_embedded: i32,
    streaming: i32,
    enabled: i32,
    message: [c_char; 512],
}

extern "C" {
    fn pvc_activate();
    fn pvc_deactivate();
    fn pvc_query_properties();
    fn pvc_get_status(out: *mut PvcStatus, probe_device: i32);
    fn pvc_open(w: i32, h: i32, fps: i32, err: *mut c_char, errlen: i32) -> i32;
    fn pvc_send(bgra: *const u8, w: i32, h: i32, err: *mut c_char, errlen: i32) -> i32;
    fn pvc_close();
}

#[cfg(test)]
const REQ_IDLE: i32 = 0;
const REQ_PENDING: i32 = 1;
const REQ_NEEDS_APPROVAL: i32 = 2;
const REQ_ACTIVATED: i32 = 3;
const REQ_NEEDS_REBOOT: i32 = 4;
const REQ_FAILED: i32 = 5;

/// Raw bridge state, decoupled from FFI so the mapping can be unit-tested.
#[derive(Debug, Clone, Default)]
pub struct BridgeState {
    pub request_state: i32,
    pub error_code: i64,
    pub device_present: bool,
    pub in_applications: bool,
    pub is_bundle: bool,
    pub extension_embedded: bool,
    pub streaming: bool,
    pub message: String,
}

fn read_state(probe_device: bool) -> BridgeState {
    let mut s = PvcStatus {
        request_state: 0,
        error_code: 0,
        device_present: 0,
        in_applications: 0,
        is_bundle: 0,
        extension_embedded: 0,
        streaming: 0,
        enabled: -1,
        message: [0; 512],
    };
    // SAFETY: the bridge fills a struct of exactly this layout.
    unsafe { pvc_get_status(&mut s, probe_device as i32) };
    BridgeState {
        request_state: s.request_state,
        error_code: s.error_code,
        device_present: s.device_present != 0,
        in_applications: s.in_applications != 0,
        is_bundle: s.is_bundle != 0,
        extension_embedded: s.extension_embedded != 0,
        streaming: s.streaming != 0,
        // SAFETY: NUL-terminated by strlcpy in the bridge.
        message: unsafe { CStr::from_ptr(s.message.as_ptr()) }.to_string_lossy().into_owned(),
    }
}

const APPROVE_HINT: &str = "Open System Settings > General > Login Items & Extensions > Camera Extensions and switch PUPPET on (macOS 13-14: System Settings > Privacy & Security, click Allow). Then come back here.";
const OBS_HINT: &str = "Until then, use the OBS route: Capture view (H), OBS Window Capture, Start Virtual Camera.";

/// Map the bridge state to what the panel shows.
pub fn describe(b: &BridgeState) -> SinkStatus {
    let s = |st, d: &str| SinkStatus::new("coremediaio", st, d);
    let mut out = if b.device_present {
        let st = if b.streaming { SinkState::Running } else { SinkState::Ready };
        s(st, "PUPPET VIRTUAL CAMERA INSTALLED")
            .hint("Pick \"Puppet Virtual Camera\" as the camera in Zoom, Meet, Discord or FaceTime.")
    } else if !b.is_bundle {
        s(SinkState::Unavailable, "DEV BUILD: CAMERA EXTENSION NEEDS THE INSTALLED APP")
            .hint(format!("Run a signed Puppet.app from /Applications to install the camera. {OBS_HINT}"))
    } else if !b.extension_embedded {
        s(SinkState::Unavailable, "THIS BUILD HAS NO CAMERA EXTENSION").hint(OBS_HINT)
    } else {
        match b.request_state {
            REQ_PENDING => s(SinkState::NeedsSetup, "INSTALLING CAMERA EXTENSION..."),
            REQ_NEEDS_APPROVAL => s(SinkState::NeedsApproval, "APPROVE THE CAMERA IN SYSTEM SETTINGS").hint(APPROVE_HINT),
            REQ_NEEDS_REBOOT => s(SinkState::NeedsSetup, "RESTART YOUR MAC TO FINISH INSTALLING"),
            REQ_ACTIVATED => s(SinkState::NeedsSetup, "ACTIVATED, WAITING FOR THE CAMERA DEVICE")
                .hint("If it does not appear within a few seconds, quit and reopen Puppet.")
                .action("RETRY"),
            REQ_FAILED => failure(b),
            _ if !b.in_applications => s(SinkState::NeedsSetup, "MOVE PUPPET TO /APPLICATIONS")
                .hint(format!("macOS installs camera extensions only from apps in the Applications folder. Drag Puppet.app there, open it from there, then click INSTALL CAMERA. {OBS_HINT}")),
            _ => s(SinkState::NeedsSetup, "CAMERA NOT INSTALLED")
                .hint("Click INSTALL CAMERA. macOS will ask you to approve the Puppet camera extension in System Settings (once).")
                .action("INSTALL CAMERA"),
        }
    };
    if b.request_state == REQ_FAILED && !b.message.is_empty() && out.state != SinkState::Running && out.state != SinkState::Ready {
        out.detail = format!("{} | {}", out.detail, b.message.to_uppercase());
    }
    out.format = Some(PixelFormat::Bgra);
    out
}

fn failure(b: &BridgeState) -> SinkStatus {
    let s = |st, d: &str| SinkStatus::new("coremediaio", st, d);
    match b.error_code {
        // OSSystemExtensionErrorUnsupportedParentBundleLocation
        3 => s(SinkState::NeedsSetup, "MOVE PUPPET TO /APPLICATIONS")
            .hint("macOS installs camera extensions only from apps in the Applications folder. Move Puppet.app there, reopen it, click INSTALL CAMERA.")
            .action("INSTALL CAMERA"),
        // MissingEntitlement, CodeSignatureInvalid, ValidationFailed, ForbiddenBySystemPolicy
        2 | 8 | 9 | 10 => s(SinkState::Unavailable, "THIS BUILD IS NOT SIGNED FOR CAMERA EXTENSIONS")
            .hint(format!("Camera extensions need a Developer ID-signed build (see docs/virtual-camera.md). {OBS_HINT}")),
        // RequestCanceled
        11 => s(SinkState::NeedsSetup, "INSTALL CANCELLED").action("INSTALL CAMERA"),
        // AuthorizationRequired
        13 => s(SinkState::NeedsApproval, "APPROVE THE CAMERA IN SYSTEM SETTINGS").hint(APPROVE_HINT).action("INSTALL CAMERA"),
        _ => s(SinkState::Error, "CAMERA INSTALL FAILED").hint(OBS_HINT).action("RETRY"),
    }
}

pub struct CmioSink {
    open: Option<StreamConfig>,
    queried: bool,
    /// When the sink went missing mid-stream, try to reopen it (extension restarted).
    reopen_after: Option<Instant>,
}

impl CmioSink {
    pub fn new() -> Self {
        CmioSink { open: None, queried: false, reopen_after: None }
    }
}

fn err_buf() -> [c_char; 256] {
    [0; 256]
}
fn err_str(b: &[c_char; 256]) -> String {
    // SAFETY: zero-initialised and NUL-terminated by strlcpy.
    unsafe { CStr::from_ptr(b.as_ptr()) }.to_string_lossy().into_owned()
}

impl VirtualCamSink for CmioSink {
    fn name(&self) -> &'static str {
        "coremediaio"
    }

    fn probe(&mut self) -> SinkStatus {
        let b = read_state(true);
        if !self.queried && b.is_bundle && b.extension_embedded && !b.device_present {
            // Read-only and best effort: learns whether an install is awaiting
            // approval. (With no extension installed, macOS 26 never answers.)
            self.queried = true;
            // SAFETY: plain FFI call.
            unsafe { pvc_query_properties() };
        }
        describe(&b)
    }

    fn setup(&mut self) -> Result<(), String> {
        // SAFETY: plain FFI call; the result arrives asynchronously in the status.
        unsafe { pvc_activate() };
        Ok(())
    }

    fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
        let mut e = err_buf();
        // SAFETY: e is a writable 256-byte buffer.
        let r = unsafe { pvc_open(cfg.width as i32, cfg.height as i32, cfg.fps as i32, e.as_mut_ptr(), e.len() as i32) };
        if r != 0 {
            return Err(err_str(&e));
        }
        self.open = Some(cfg);
        Ok(())
    }

    fn write(&mut self, f: &BgraFrame) -> Result<(), String> {
        let mut e = err_buf();
        // SAFETY: data is width*height*4 bytes (checked by parse_frame).
        let r = unsafe { pvc_send(f.data.as_ptr(), f.width as i32, f.height as i32, e.as_mut_ptr(), e.len() as i32) };
        match r {
            0 | 1 => Ok(()), // 1 = sink queue full, frame skipped
            -1 => {
                // Stream went away (extension updated / restarted): retry the open now and then.
                if let Some(cfg) = self.open {
                    if self.reopen_after.map_or(true, |t| Instant::now() >= t) {
                        self.reopen_after = Some(Instant::now() + Duration::from_secs(2));
                        let _ = self.open(cfg);
                    }
                }
                Err(err_str(&e))
            }
            _ => Err(err_str(&e)),
        }
    }

    fn close(&mut self) {
        // SAFETY: plain FFI call.
        unsafe { pvc_close() };
        self.open = None;
    }
}

/// Remove the extension (not wired to the UI; kept for a future "uninstall").
#[allow(dead_code)]
pub fn deactivate() {
    // SAFETY: plain FFI call.
    unsafe { pvc_deactivate() };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> BridgeState {
        BridgeState { is_bundle: true, extension_embedded: true, in_applications: true, ..Default::default() }
    }

    #[test]
    fn states_map_to_plain_instructions() {
        assert_eq!(describe(&base()).state, SinkState::NeedsSetup);
        assert_eq!(describe(&base()).action.as_deref(), Some("INSTALL CAMERA"));

        let mut b = base();
        b.in_applications = false;
        assert!(describe(&b).detail.contains("/APPLICATIONS"));

        let mut b = base();
        b.request_state = REQ_NEEDS_APPROVAL;
        let s = describe(&b);
        assert_eq!(s.state, SinkState::NeedsApproval);
        assert!(s.hint.unwrap().contains("System Settings"));

        let mut b = base();
        b.request_state = REQ_FAILED;
        b.error_code = 2;
        b.message = "missing entitlement".into();
        let s = describe(&b);
        assert_eq!(s.state, SinkState::Unavailable);
        assert!(s.detail.contains("NOT SIGNED") && s.detail.contains("MISSING ENTITLEMENT"));
        assert!(s.hint.unwrap().contains("OBS"));

        let mut b = base();
        b.request_state = REQ_FAILED;
        b.error_code = 3;
        assert!(describe(&b).detail.contains("/APPLICATIONS"));

        let mut b = base();
        b.device_present = true;
        assert_eq!(describe(&b).state, SinkState::Ready);
        b.streaming = true;
        assert_eq!(describe(&b).state, SinkState::Running);

        let b = BridgeState::default(); // `tauri dev`: not a bundle
        assert_eq!(describe(&b).state, SinkState::Unavailable);
    }

    #[test]
    fn bridge_links_and_reports_dev_build() {
        // Under `cargo test` the process is not a .app. Device enumeration is
        // skipped so the test never touches the camera subsystem.
        let b = read_state(false);
        assert!(!b.is_bundle);
        assert!(!b.extension_embedded);
        assert_eq!(b.request_state, REQ_IDLE);
        assert_eq!(describe(&b).state, SinkState::Unavailable);
        let mut e = err_buf();
        // Sending before open fails cleanly.
        let r = unsafe { pvc_send([0u8; 16].as_ptr(), 2, 2, e.as_mut_ptr(), e.len() as i32) };
        assert_eq!(r, -1);
        assert!(err_str(&e).contains("not open"));
    }
}

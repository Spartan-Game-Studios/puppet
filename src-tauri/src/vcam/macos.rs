//! macOS sink: a CoreMediaIO Camera Extension (system extension, macOS 12.3+).
//!
//! The extension (`src-tauri/macos/camera-extension/`, Swift) is embedded at
//! `VPuppet.app/Contents/Library/SystemExtensions/` and publishes a device
//! "VPuppet Virtual Camera" with a source stream (what Zoom / Meet / Discord
//! read) and a sink stream (what we write into). The app side lives in
//! `src-tauri/macos/bridge/PuppetVCamBridge.m` (activation through
//! OSSystemExtensionRequest, frames through the CMIO sink queue); this module
//! wraps it and turns its state into the panel's plain-language status.
//!
//! The extension publishes its device only while this app sends a presence
//! heartbeat (`pvc_presence`, a Darwin notification; see [`Presence`]): the
//! camera is listed in other apps while VPuppet runs with its output on, and
//! disappears when the output is turned off, VPuppet quits, or it crashes
//! (beats stop; the extension times out after 3.5 s).
//!
//! Installing a system extension requires a Developer ID-signed app with the
//! `com.apple.developer.system-extension.install` entitlement (from a
//! provisioning profile) and the app in /Applications. See
//! `docs/virtual-camera.md`.

use super::{BgraFrame, ExtState, ExtensionStatus, PixelFormat, SinkState, SinkStatus, StreamConfig, VirtualCamSink};
use std::ffi::{c_char, CStr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
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
    props_answered: i32,
    awaiting_approval: i32,
    uninstalling: i32,
    installed_version: [c_char; 64],
    bundled_version: [c_char; 64],
}

extern "C" {
    fn pvc_activate();
    fn pvc_deactivate();
    fn pvc_query_properties();
    fn pvc_get_status(out: *mut PvcStatus, probe_device: i32);
    fn pvc_open(w: i32, h: i32, fps: i32, err: *mut c_char, errlen: i32) -> i32;
    fn pvc_send(bgra: *const u8, w: i32, h: i32, err: *mut c_char, errlen: i32) -> i32;
    fn pvc_close();
    fn pvc_presence(on: i32);
}

#[cfg(test)]
const REQ_IDLE: i32 = 0;
const REQ_PENDING: i32 = 1;
const REQ_NEEDS_APPROVAL: i32 = 2;
const REQ_ACTIVATED: i32 = 3;
const REQ_NEEDS_REBOOT: i32 = 4;
const REQ_FAILED: i32 = 5;
const REQ_DEACTIVATED: i32 = 6;

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
    /// From the properties request: 1 enabled, 0 not, -1 unknown.
    pub enabled: i32,
    pub props_answered: bool,
    pub awaiting_approval: bool,
    pub uninstalling: bool,
    pub installed_version: String,
    pub bundled_version: String,
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
        props_answered: 0,
        awaiting_approval: 0,
        uninstalling: 0,
        installed_version: [0; 64],
        bundled_version: [0; 64],
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
        message: cstr(&s.message),
        enabled: s.enabled,
        props_answered: s.props_answered != 0,
        awaiting_approval: s.awaiting_approval != 0,
        uninstalling: s.uninstalling != 0,
        installed_version: cstr(&s.installed_version),
        bundled_version: cstr(&s.bundled_version),
    }
}

fn cstr(b: &[c_char]) -> String {
    // SAFETY: zero-initialised and NUL-terminated by strlcpy in the bridge.
    unsafe { CStr::from_ptr(b.as_ptr()) }.to_string_lossy().into_owned()
}

impl BridgeState {
    /// The extension is installed and enabled (the device itself only exists while we send).
    fn installed(&self) -> bool {
        self.device_present || self.enabled == 1 || (self.request_state == REQ_ACTIVATED && !self.props_answered)
    }
}

/// Opens System Settings at Login Items & Extensions (macOS 13+). macOS has no
/// in-app approval prompt for system extensions; this is the closest we can get.
const SETTINGS_URL: &str = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";

const APPROVE_HINT: &str = "Open System Settings > General > Login Items & Extensions > Camera Extensions and switch VPUPPET on (macOS 13-14: System Settings > Privacy & Security, click Allow). Then come back here.";
const OBS_HINT: &str = "Until then, use the OBS route: Capture view (H), OBS Window Capture, Start Virtual Camera.";

/// Map the bridge state to what the panel shows.
pub fn describe(b: &BridgeState) -> SinkStatus {
    let s = |st, d: &str| SinkStatus::new("coremediaio", st, d);
    let mut out = if b.installed() && b.request_state != REQ_PENDING {
        let st = if b.streaming { SinkState::Running } else { SinkState::Ready };
        s(st, if b.device_present { "VPUPPET VIRTUAL CAMERA LIVE" } else { "VPUPPET VIRTUAL CAMERA READY" })
            .hint("While the output is ON, pick \"VPuppet Virtual Camera\" in Zoom, Meet, Discord or FaceTime. It is listed only while VPuppet sends.")
    } else if !b.is_bundle {
        s(SinkState::Unavailable, "DEV BUILD: CAMERA EXTENSION NEEDS THE INSTALLED APP")
            .hint(format!("Run a signed VPuppet.app from /Applications to install the camera. {OBS_HINT}"))
    } else if !b.extension_embedded {
        s(SinkState::Unavailable, "THIS BUILD HAS NO CAMERA EXTENSION").hint(OBS_HINT)
    } else {
        match b.request_state {
            REQ_PENDING => s(SinkState::NeedsSetup, "INSTALLING CAMERA EXTENSION..."),
            REQ_NEEDS_APPROVAL => s(SinkState::NeedsApproval, "APPROVE THE CAMERA IN SYSTEM SETTINGS").hint(APPROVE_HINT),
            REQ_NEEDS_REBOOT => s(SinkState::NeedsSetup, "RESTART YOUR MAC TO FINISH INSTALLING"),
            REQ_FAILED => failure(b),
            _ if !b.in_applications => s(SinkState::NeedsSetup, "MOVE VPUPPET TO /APPLICATIONS")
                .hint(format!("macOS installs camera extensions only from apps in the Applications folder. Drag VPuppet.app there, open it from there, then click INSTALL. {OBS_HINT}")),
            _ => s(SinkState::NeedsSetup, "CAMERA NOT INSTALLED")
                .hint("Click INSTALL on the EXTENSION line. macOS will ask you to approve the VPuppet camera extension in System Settings (once)."),
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
        3 => s(SinkState::NeedsSetup, "MOVE VPUPPET TO /APPLICATIONS")
            .hint("macOS installs camera extensions only from apps in the Applications folder. Move VPuppet.app there, reopen it, click INSTALL."),
        // MissingEntitlement, CodeSignatureInvalid, ValidationFailed, ForbiddenBySystemPolicy
        2 | 8 | 9 | 10 => s(SinkState::Unavailable, "THIS BUILD IS NOT SIGNED AND NOTARIZED FOR CAMERA EXTENSIONS")
            .hint(format!("Camera extensions need a Developer ID-signed, notarized build (see docs/virtual-camera.md). {OBS_HINT}")),
        // RequestCanceled
        11 => s(SinkState::NeedsSetup, "INSTALL CANCELLED"),
        // AuthorizationRequired
        13 => s(SinkState::NeedsApproval, "APPROVE THE CAMERA IN SYSTEM SETTINGS").hint(APPROVE_HINT),
        _ => s(SinkState::Error, "CAMERA INSTALL FAILED").hint(OBS_HINT),
    }
}

/// Map the bridge state to the EXTENSION line and its buttons.
pub fn describe_extension(b: &BridgeState) -> ExtensionStatus {
    let ver = |v: &str| if v.is_empty() { None } else { Some(v.to_string()) };
    let mut e = ExtensionStatus {
        state: ExtState::NotInstalled,
        detail: String::new(),
        installed_version: ver(&b.installed_version),
        bundled_version: ver(&b.bundled_version),
        install: None,
        can_uninstall: false,
        open_settings: false,
    };
    let set = |e: &mut ExtensionStatus, st, d: &str| {
        e.state = st;
        e.detail = d.to_string();
    };
    if !b.is_bundle {
        set(&mut e, ExtState::Unavailable, "DEV BUILD: INSTALL FROM THE SIGNED APP");
        return e;
    }
    if !b.extension_embedded {
        set(&mut e, ExtState::Unavailable, "NOT IN THIS BUILD");
        return e;
    }
    let mismatch = !b.installed_version.is_empty() && !b.bundled_version.is_empty() && b.installed_version != b.bundled_version;
    // The device is listed although we aren't sending: only the first release's
    // always-on extension does that (macOS may not report its version).
    let legacy = b.device_present && !b.streaming && b.installed_version.is_empty();
    match b.request_state {
        REQ_PENDING => set(&mut e, ExtState::Working, &format!("{}...", b.message.to_uppercase())),
        REQ_NEEDS_REBOOT => set(&mut e, ExtState::NeedsReboot, "RESTART YOUR MAC TO FINISH"),
        _ if b.uninstalling && !b.installed() => set(&mut e, ExtState::Uninstalling, "REMOVED AFTER A RESTART"),
        _ if b.awaiting_approval || b.request_state == REQ_NEEDS_APPROVAL || (b.request_state == REQ_FAILED && b.error_code == 13) => {
            set(&mut e, ExtState::AwaitingApproval, "WAITING FOR APPROVAL IN SYSTEM SETTINGS");
            e.open_settings = true;
        }
        _ if b.installed() && (mismatch || legacy) => {
            let d = if mismatch {
                format!("NEEDS UPDATE (INSTALLED v{}, THIS APP v{})", b.installed_version, b.bundled_version)
            } else {
                "NEEDS UPDATE (INSTALLED COPY IS OLDER)".to_string()
            };
            set(&mut e, ExtState::NeedsUpdate, &d);
            e.install = Some("UPDATE".into());
            e.can_uninstall = true;
        }
        _ if b.installed() => {
            let v = if b.installed_version.is_empty() { String::new() } else { format!(" v{}", b.installed_version) };
            set(&mut e, ExtState::Active, &format!("ACTIVE{v}"));
            e.can_uninstall = true;
        }
        REQ_FAILED => {
            set(&mut e, ExtState::Failed, &format!("FAILED: {}", b.message.to_uppercase()));
            // Signing / location errors can't be fixed by retrying.
            if !matches!(b.error_code, 2 | 3 | 8 | 9 | 10) {
                e.install = Some("RETRY".into());
            }
        }
        _ if !b.in_applications => set(&mut e, ExtState::NotInstalled, "NOT INSTALLED: MOVE VPUPPET TO /APPLICATIONS FIRST"),
        REQ_DEACTIVATED => {
            set(&mut e, ExtState::NotInstalled, "REMOVED");
            e.install = Some("INSTALL".into());
        }
        _ => {
            set(&mut e, ExtState::NotInstalled, "NOT INSTALLED");
            e.install = Some("INSTALL".into());
        }
    }
    e
}

/// The heartbeat that keeps the extension's device published: one beat a
/// second from a thread while the output is open, "off" when it stops.
struct Presence {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Presence {
    fn start() -> Presence {
        let stop = Arc::new(AtomicBool::new(false));
        let s = stop.clone();
        // SAFETY: plain FFI call (first beat right away, so the device appears now).
        unsafe { pvc_presence(1) };
        let thread = std::thread::Builder::new()
            .name("vcam-presence".into())
            .spawn(move || {
                let mut n = 0u32;
                while !s.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(100));
                    n += 1;
                    if n % 10 == 0 {
                        // SAFETY: plain FFI call.
                        unsafe { pvc_presence(1) };
                    }
                }
            })
            .ok();
        Presence { stop, thread }
    }
}

impl Drop for Presence {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        // SAFETY: plain FFI call.
        unsafe { pvc_presence(0) };
    }
}

/// How long `open` waits for the extension to publish the device after the first beat.
const DEVICE_WAIT: Duration = Duration::from_secs(5);

pub struct CmioSink {
    open: Option<StreamConfig>,
    presence: Option<Presence>,
    /// When the sink went missing mid-stream, try to reopen it (extension restarted).
    reopen_after: Option<Instant>,
}

impl CmioSink {
    pub fn new() -> Self {
        CmioSink { open: None, presence: None, reopen_after: None }
    }
}

fn err_buf() -> [c_char; 256] {
    [0; 256]
}
fn err_str(b: &[c_char; 256]) -> String {
    cstr(b)
}

fn open_settings_page() -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(SETTINGS_URL)
        .status()
        .map_err(|e| format!("could not open System Settings: {e}"))
        .and_then(|st| if st.success() { Ok(()) } else { Err("could not open System Settings".into()) })
}

impl VirtualCamSink for CmioSink {
    fn name(&self) -> &'static str {
        "coremediaio"
    }

    fn probe(&mut self) -> SinkStatus {
        describe(&self.state())
    }

    fn setup(&mut self) -> Result<(), String> {
        // Waiting for approval: the button opens System Settings instead of re-requesting.
        if describe(&read_state(true)).state == SinkState::NeedsApproval {
            return open_settings_page();
        }
        self.install_extension()
    }

    fn extension(&mut self) -> Option<ExtensionStatus> {
        Some(describe_extension(&self.state()))
    }

    fn install_extension(&mut self) -> Result<(), String> {
        // SAFETY: plain FFI call; the result arrives asynchronously in the status.
        unsafe { pvc_activate() };
        Ok(())
    }

    fn uninstall_extension(&mut self) -> Result<(), String> {
        self.close();
        // SAFETY: plain FFI call; the result arrives asynchronously in the status.
        unsafe { pvc_deactivate() };
        Ok(())
    }

    fn open_settings(&mut self) -> Result<(), String> {
        open_settings_page()
    }

    fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
        // Announce ourselves first: the extension publishes the device on the first beat.
        if self.presence.is_none() {
            self.presence = Some(Presence::start());
        }
        let deadline = Instant::now() + DEVICE_WAIT;
        loop {
            let mut e = err_buf();
            // SAFETY: e is a writable 256-byte buffer.
            let r = unsafe { pvc_open(cfg.width as i32, cfg.height as i32, cfg.fps as i32, e.as_mut_ptr(), e.len() as i32) };
            if r == 0 {
                self.open = Some(cfg);
                return Ok(());
            }
            // -1 = device not (yet) published; anything else won't fix itself.
            if r != -1 || Instant::now() >= deadline {
                self.presence = None;
                return Err(err_str(&e));
            }
            std::thread::sleep(Duration::from_millis(150));
        }
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
                        // One quick attempt (the writer thread holds the sink lock).
                        let mut e = err_buf();
                        // SAFETY: e is a writable 256-byte buffer.
                        unsafe { pvc_open(cfg.width as i32, cfg.height as i32, cfg.fps as i32, e.as_mut_ptr(), e.len() as i32) };
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
        // Dropping the heartbeat tells the extension to remove the device.
        self.presence = None;
    }
}

impl CmioSink {
    /// Bridge state, refreshing the installed-extension properties (rate
    /// limited in the bridge; read-only, never installs anything).
    fn state(&mut self) -> BridgeState {
        let b = read_state(true);
        if b.is_bundle && b.extension_embedded {
            // SAFETY: plain FFI call.
            unsafe { pvc_query_properties() };
        }
        b
    }
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
        // Installing is the EXTENSION line's job now.
        assert_eq!(describe(&base()).action, None);
        assert!(describe(&base()).hint.unwrap().contains("INSTALL"));

        let mut b = base();
        b.in_applications = false;
        assert!(describe(&b).detail.contains("/APPLICATIONS"));

        let mut b = base();
        b.request_state = REQ_NEEDS_APPROVAL;
        let s = describe(&b);
        assert_eq!(s.state, SinkState::NeedsApproval);
        assert_eq!(s.action, None, "OPEN SETTINGS lives on the EXTENSION line");
        assert!(s.hint.unwrap().contains("System Settings"));

        let mut b = base();
        b.request_state = REQ_FAILED;
        b.error_code = 13;
        assert_eq!(describe(&b).state, SinkState::NeedsApproval);

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

        // Installed and enabled, device not published (output off): ready, not "not installed".
        let mut b = base();
        b.enabled = 1;
        assert_eq!(describe(&b).state, SinkState::Ready);
        assert!(describe(&b).detail.contains("READY"));
        // Activated in this session, properties not back yet: ready too.
        let mut b = base();
        b.request_state = REQ_ACTIVATED;
        assert_eq!(describe(&b).state, SinkState::Ready);
    }

    fn installed(ver: &str) -> BridgeState {
        BridgeState { enabled: 1, props_answered: true, installed_version: ver.into(), bundled_version: "2".into(), ..base() }
    }

    #[test]
    fn extension_line_states_and_buttons() {
        let dev = describe_extension(&BridgeState::default());
        assert_eq!(dev.state, ExtState::Unavailable);
        assert!(dev.install.is_none() && !dev.can_uninstall);

        let mut b = base();
        b.bundled_version = "2".into();
        let e = describe_extension(&b);
        assert_eq!(e.state, ExtState::NotInstalled);
        assert_eq!(e.install.as_deref(), Some("INSTALL"));
        assert!(!e.can_uninstall);
        assert_eq!(e.bundled_version.as_deref(), Some("2"));

        let mut b = base();
        b.in_applications = false;
        let e = describe_extension(&b);
        assert!(e.detail.contains("/APPLICATIONS") && e.install.is_none());

        let mut b = base();
        b.awaiting_approval = true;
        let e = describe_extension(&b);
        assert_eq!(e.state, ExtState::AwaitingApproval);
        assert!(e.open_settings && e.install.is_none());

        let e = describe_extension(&installed("2"));
        assert_eq!(e.state, ExtState::Active);
        assert!(e.detail.contains("v2") && e.can_uninstall && e.install.is_none());

        // The always-on extension from the first release is 0.1.0.
        let e = describe_extension(&installed("0.1.0"));
        assert_eq!(e.state, ExtState::NeedsUpdate);
        assert_eq!(e.install.as_deref(), Some("UPDATE"));
        assert!(e.can_uninstall && e.detail.contains("0.1.0"));

        // Old always-on extension, version unknown: listed while we don't send.
        let mut b = base();
        b.device_present = true;
        b.bundled_version = "2".into();
        assert_eq!(describe_extension(&b).state, ExtState::NeedsUpdate);
        b.streaming = true; // our own beat published it
        assert_eq!(describe_extension(&b).state, ExtState::Active);

        let mut b = installed("2");
        b.request_state = REQ_PENDING;
        b.message = "Requesting removal".into();
        let e = describe_extension(&b);
        assert_eq!(e.state, ExtState::Working);
        assert!(e.install.is_none() && !e.can_uninstall);

        let mut b = base();
        b.request_state = REQ_DEACTIVATED;
        assert_eq!(describe_extension(&b).install.as_deref(), Some("INSTALL"));

        let mut b = base();
        b.uninstalling = true;
        assert_eq!(describe_extension(&b).state, ExtState::Uninstalling);

        let mut b = base();
        b.request_state = REQ_FAILED;
        b.error_code = 2;
        b.message = "missing entitlement".into();
        let e = describe_extension(&b);
        assert_eq!(e.state, ExtState::Failed);
        assert!(e.install.is_none(), "signing errors can't be retried");
        b.error_code = 1;
        assert_eq!(describe_extension(&b).install.as_deref(), Some("RETRY"));

        let mut b = base();
        b.request_state = REQ_NEEDS_REBOOT;
        assert_eq!(describe_extension(&b).state, ExtState::NeedsReboot);
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

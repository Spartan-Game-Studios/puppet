//! Virtual camera output.
//!
//! The frontend renders the avatar into an offscreen target at the camera
//! resolution, reads it back as BGRA and sends each frame here as a raw binary
//! IPC body (a 16-byte header plus the pixels; no JSON, no base64). The command
//! handler copies the frame into a recycled buffer and hands it to a writer
//! thread over a one-slot channel, so the IPC call returns immediately and a
//! slow sink drops frames instead of building a queue.
//!
//! The writer feeds one [`VirtualCamSink`]: the OS-native camera (CoreMediaIO
//! Camera Extension on macOS, softcam on Windows, v4l2loopback on Linux), or a
//! [`file_sink::FileSink`] / null sink for testing (`PUPPET_VCAM_SINK`).

pub mod convert;
pub mod file_sink;

#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use serde::Serialize;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub use convert::PixelFormat;

/// Header magic of a frame body: "PVCF".
pub const FRAME_MAGIC: [u8; 4] = *b"PVCF";
pub const HEADER_LEN: usize = 16;
/// Largest frame we accept (guards against a bogus header).
pub const MAX_DIM: u32 = 3840;

/// Parsed frame header. Pixels follow the header: BGRA, top-down, stride = width * 4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub width: u32,
    pub height: u32,
    pub seq: u32,
}

/// Split a frame body into header and pixels, validating sizes.
pub fn parse_frame(body: &[u8]) -> Result<(FrameHeader, &[u8]), String> {
    if body.len() < HEADER_LEN || body[..4] != FRAME_MAGIC {
        return Err("not a PVCF frame".into());
    }
    let u = |i: usize| u32::from_le_bytes(body[i..i + 4].try_into().unwrap());
    let h = FrameHeader { width: u(4), height: u(8), seq: u(12) };
    if h.width == 0 || h.height == 0 || h.width > MAX_DIM || h.height > MAX_DIM || h.width % 2 != 0 {
        return Err(format!("bad frame size {}x{}", h.width, h.height));
    }
    let need = PixelFormat::Bgra.frame_bytes(h.width, h.height);
    let px = &body[HEADER_LEN..];
    if px.len() != need {
        return Err(format!("frame {}x{} needs {need} bytes, got {}", h.width, h.height, px.len()));
    }
    Ok((h, px))
}

/// Build a frame body (tests).
#[cfg(test)]
pub fn encode_frame(width: u32, height: u32, seq: u32, bgra: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(HEADER_LEN + bgra.len());
    v.extend_from_slice(&FRAME_MAGIC);
    for x in [width, height, seq] {
        v.extend_from_slice(&x.to_le_bytes());
    }
    v.extend_from_slice(bgra);
    v
}

/// What the stream should look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct StreamConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// One frame handed to a sink: BGRA, top-down, tightly packed.
pub struct BgraFrame<'a> {
    pub width: u32,
    pub height: u32,
    pub seq: u32,
    pub data: &'a [u8],
}

/// Where a sink stands, from the user's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SinkState {
    /// Not possible on this build/OS (the UI points at the OBS route).
    Unavailable,
    /// Something must be installed or created first (see `hint` / `command`).
    NeedsSetup,
    /// Waiting for the user to approve in System Settings (macOS).
    NeedsApproval,
    /// Installed and usable; not streaming.
    Ready,
    /// Streaming frames.
    Running,
    /// Last operation failed (see `detail`).
    Error,
}

/// Status shown in the 05 VIRTUAL CAM panel.
#[derive(Debug, Clone, Serialize)]
pub struct SinkStatus {
    /// Short sink id: "coremediaio", "softcam", "v4l2loopback", "file", "null".
    pub sink: String,
    pub state: SinkState,
    /// One line of status text.
    pub detail: String,
    /// Plain instructions for the user, if any.
    pub hint: Option<String>,
    /// A shell command the user can copy (Linux modprobe).
    pub command: Option<String>,
    /// Label of the setup button, when `setup()` can do something.
    pub action: Option<String>,
    /// Selectable devices (Linux: /dev/videoN loopback nodes).
    pub devices: Vec<String>,
    pub device: Option<String>,
    /// Pixel format the sink writes.
    pub format: Option<PixelFormat>,
}

impl SinkStatus {
    pub fn new(sink: &str, state: SinkState, detail: impl Into<String>) -> Self {
        SinkStatus {
            sink: sink.into(),
            state,
            detail: detail.into(),
            hint: None,
            command: None,
            action: None,
            devices: Vec::new(),
            device: None,
            format: None,
        }
    }
    pub fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
    #[allow(dead_code)] // used by the Linux / Windows sinks
    pub fn command(mut self, c: impl Into<String>) -> Self {
        self.command = Some(c.into());
        self
    }
    #[allow(dead_code)] // used by the macOS / Windows sinks
    pub fn action(mut self, a: impl Into<String>) -> Self {
        self.action = Some(a.into());
        self
    }
}

/// Where an installable camera driver (the macOS camera extension) stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtState {
    /// Can't be installed from this build (dev build, no extension inside).
    Unavailable,
    NotInstalled,
    /// An install or removal request is in flight.
    Working,
    AwaitingApproval,
    Active,
    /// Installed, but a different version than the one inside this app.
    NeedsUpdate,
    NeedsReboot,
    /// Removal finishes after a restart.
    Uninstalling,
    Failed,
}

/// Status of the camera extension, for the 06 VIRTUAL CAM panel's EXT line
/// and its INSTALL / UPDATE / UNINSTALL / OPEN SETTINGS buttons.
#[derive(Debug, Clone, Serialize)]
pub struct ExtensionStatus {
    pub state: ExtState,
    pub detail: String,
    pub installed_version: Option<String>,
    pub bundled_version: Option<String>,
    /// Label of the install button ("INSTALL" / "UPDATE" / "RETRY"), when it applies.
    pub install: Option<String>,
    pub can_uninstall: bool,
    pub open_settings: bool,
}

/// A virtual camera backend. One implementation per OS, plus file/null sinks
/// for testing. All methods are called from one thread at a time.
pub trait VirtualCamSink: Send {
    /// Short id, e.g. "v4l2loopback".
    fn name(&self) -> &'static str;
    /// Detect availability without side effects.
    fn probe(&mut self) -> SinkStatus;
    /// User-initiated install / activation / registration (may prompt the
    /// user). Default: nothing to do.
    fn setup(&mut self) -> Result<(), String> {
        Err(format!("{}: nothing to set up", self.name()))
    }
    /// Status of an installable camera driver (macOS camera extension). None:
    /// this sink has nothing to install or remove.
    fn extension(&mut self) -> Option<ExtensionStatus> {
        None
    }
    /// Request install / update of the driver (may prompt the user).
    fn install_extension(&mut self) -> Result<(), String> {
        Err(format!("{}: nothing to install", self.name()))
    }
    /// Request removal of the driver (may prompt the user).
    fn uninstall_extension(&mut self) -> Result<(), String> {
        Err(format!("{}: nothing to uninstall", self.name()))
    }
    /// Open the OS page where the driver is approved.
    fn open_settings(&mut self) -> Result<(), String> {
        Err(format!("{}: no settings page", self.name()))
    }
    /// Choose a device (Linux). Default: ignored.
    fn select_device(&mut self, _device: Option<String>) {}
    /// Start streaming at this size.
    fn open(&mut self, cfg: StreamConfig) -> Result<(), String>;
    /// Deliver one frame (sized as opened).
    fn write(&mut self, frame: &BgraFrame) -> Result<(), String>;
    /// Stop streaming.
    fn close(&mut self);
}

/// Discards frames (counts them). `PUPPET_VCAM_SINK=null`, for measuring IPC alone.
pub struct NullSink {
    open: Option<StreamConfig>,
}

impl VirtualCamSink for NullSink {
    fn name(&self) -> &'static str {
        "null"
    }
    fn probe(&mut self) -> SinkStatus {
        let st = if self.open.is_some() { SinkState::Running } else { SinkState::Ready };
        SinkStatus::new("null", st, "NULL SINK (TEST): FRAMES ARE DISCARDED")
    }
    fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
        self.open = Some(cfg);
        Ok(())
    }
    fn write(&mut self, _frame: &BgraFrame) -> Result<(), String> {
        Ok(())
    }
    fn close(&mut self) {
        self.open = None;
    }
}

/// Fallback when there is no native sink for this OS.
#[allow(dead_code)]
pub struct UnsupportedSink;

impl VirtualCamSink for UnsupportedSink {
    fn name(&self) -> &'static str {
        "none"
    }
    fn probe(&mut self) -> SinkStatus {
        SinkStatus::new("none", SinkState::Unavailable, "NO NATIVE VIRTUAL CAMERA ON THIS OS")
            .hint("Use the OBS route: Capture view, OBS Window Capture, Start Virtual Camera.")
    }
    fn open(&mut self, _cfg: StreamConfig) -> Result<(), String> {
        Err("no native virtual camera on this OS".into())
    }
    fn write(&mut self, _frame: &BgraFrame) -> Result<(), String> {
        Ok(())
    }
    fn close(&mut self) {}
}

/// Pick the sink: `PUPPET_VCAM_SINK=file:<path>` or `null` for testing,
/// otherwise the OS-native one.
pub fn default_sink(resource_dir: Option<std::path::PathBuf>) -> Box<dyn VirtualCamSink> {
    match std::env::var("PUPPET_VCAM_SINK").ok().as_deref() {
        Some("null") => return Box::new(NullSink { open: None }),
        Some(s) if s.starts_with("file:") => return Box::new(file_sink::FileSink::from_spec(&s[5..])),
        _ => {}
    }
    let _ = &resource_dir;
    #[cfg(target_os = "macos")]
    return Box::new(macos::CmioSink::new());
    #[cfg(target_os = "windows")]
    return Box::new(windows::SoftcamSink::new(resource_dir));
    #[cfg(target_os = "linux")]
    return Box::new(linux::V4l2Sink::new());
    #[allow(unreachable_code)]
    Box::new(UnsupportedSink)
}

/// Running statistics, polled by the UI and printed with `debuglog=1`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct VcamStats {
    pub running: bool,
    pub width: u32,
    pub height: u32,
    pub format: Option<PixelFormat>,
    /// Frames received over IPC.
    pub received: u64,
    /// Frames delivered to the sink.
    pub written: u64,
    /// Frames dropped because the writer was still busy.
    pub dropped: u64,
    /// Frames rejected (bad header / size mismatch).
    pub rejected: u64,
    pub write_errors: u64,
    pub last_error: Option<String>,
    pub bytes: u64,
    /// Receive rate over the last second.
    pub fps_in: f32,
    /// Write rate over the last second.
    pub fps_out: f32,
    /// Mean time to copy a frame out of the IPC body (ms, EMA).
    pub copy_ms: f32,
    /// Mean time inside sink.write, including pixel conversion (ms, EMA).
    pub write_ms: f32,
    /// Max interval between written frames in the last second (ms).
    pub max_gap_ms: f32,
}

struct Shared {
    sink: Mutex<Box<dyn VirtualCamSink>>,
    stats: Mutex<VcamStats>,
    running: std::sync::atomic::AtomicBool,
}

struct Job {
    header: FrameHeader,
    buf: Vec<u8>,
}

/// Cheap, cloneable access to status / setup / stats that never waits on the
/// frame path (the IPC handler holds the `VirtualCam` lock only briefly, and
/// status probes can be slow: device scans, `reg query`, CMIO enumeration).
#[derive(Clone)]
pub struct VcamHandle {
    shared: Arc<Shared>,
}

impl VcamHandle {
    pub fn status(&self) -> SinkStatus {
        let mut st = self.shared.sink.lock().unwrap().probe();
        if self.shared.running.load(std::sync::atomic::Ordering::Relaxed) && st.state == SinkState::Ready {
            st.state = SinkState::Running;
        }
        st
    }

    pub fn setup(&self) -> Result<(), String> {
        self.shared.sink.lock().unwrap().setup()
    }

    pub fn extension(&self) -> Option<ExtensionStatus> {
        self.shared.sink.lock().unwrap().extension()
    }

    pub fn install_extension(&self) -> Result<(), String> {
        self.shared.sink.lock().unwrap().install_extension()
    }

    pub fn uninstall_extension(&self) -> Result<(), String> {
        self.shared.sink.lock().unwrap().uninstall_extension()
    }

    pub fn open_settings(&self) -> Result<(), String> {
        self.shared.sink.lock().unwrap().open_settings()
    }

    pub fn select_device(&self, device: Option<String>) {
        self.shared.sink.lock().unwrap().select_device(device);
    }

    pub fn stats(&self) -> VcamStats {
        self.shared.stats.lock().unwrap().clone()
    }
}

/// Owns the sink and the writer thread.
pub struct VirtualCam {
    shared: Arc<Shared>,
    tx: Option<SyncSender<Job>>,
    /// Recycled frame buffers (returned by the writer).
    pool: Arc<Mutex<Vec<Vec<u8>>>>,
    worker: Option<JoinHandle<()>>,
    config: Option<StreamConfig>,
    rate_in: RateMeter,
}

impl VirtualCam {
    pub fn new(sink: Box<dyn VirtualCamSink>) -> Self {
        VirtualCam {
            shared: Arc::new(Shared {
                sink: Mutex::new(sink),
                stats: Mutex::new(VcamStats::default()),
                running: Default::default(),
            }),
            tx: None,
            pool: Arc::new(Mutex::new(Vec::new())),
            worker: None,
            config: None,
            rate_in: RateMeter::default(),
        }
    }

    pub fn handle(&self) -> VcamHandle {
        VcamHandle { shared: self.shared.clone() }
    }

    #[cfg(test)]
    pub fn status(&self) -> SinkStatus {
        self.handle().status()
    }

    #[cfg(test)]
    pub fn stats(&self) -> VcamStats {
        self.handle().stats()
    }

    /// Open the sink and start the writer thread. Restarts if the size changed.
    pub fn start(&mut self, cfg: StreamConfig) -> Result<(), String> {
        if self.config == Some(cfg) {
            return Ok(());
        }
        self.stop();
        let format = {
            let mut sink = self.shared.sink.lock().unwrap();
            sink.open(cfg)?;
            sink.probe().format
        };
        *self.shared.stats.lock().unwrap() =
            VcamStats { running: true, width: cfg.width, height: cfg.height, format, ..Default::default() };
        let (tx, rx) = sync_channel::<Job>(1);
        let shared = self.shared.clone();
        let pool = self.pool.clone();
        self.worker = Some(
            std::thread::Builder::new()
                .name("vcam-writer".into())
                .spawn(move || writer_loop(rx, shared, pool))
                .map_err(|e| e.to_string())?,
        );
        self.tx = Some(tx);
        self.config = Some(cfg);
        self.rate_in = RateMeter::default();
        self.shared.running.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub fn stop(&mut self) {
        self.tx = None; // closes the channel; the writer drains and exits
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
        if self.config.take().is_some() {
            self.shared.sink.lock().unwrap().close();
        }
        self.shared.running.store(false, std::sync::atomic::Ordering::Relaxed);
        self.shared.stats.lock().unwrap().running = false;
    }

    /// Accept one frame body from IPC. Never blocks on the sink.
    pub fn push(&mut self, body: &[u8]) -> Result<(), String> {
        let Some(tx) = &self.tx else { return Ok(()) };
        let cfg = self.config.unwrap();
        let parsed = parse_frame(body).and_then(|(h, px)| {
            if h.width != cfg.width || h.height != cfg.height {
                Err(format!("frame {}x{} but stream is {}x{}", h.width, h.height, cfg.width, cfg.height))
            } else {
                Ok((h, px))
            }
        });
        let (header, px) = match parsed {
            Ok(v) => v,
            Err(e) => {
                let mut s = self.shared.stats.lock().unwrap();
                s.rejected += 1;
                s.last_error = Some(e.clone());
                return Err(e);
            }
        };
        let t = Instant::now();
        let mut buf = self.pool.lock().unwrap().pop().unwrap_or_default();
        buf.clear();
        buf.extend_from_slice(px);
        let copy_ms = t.elapsed().as_secs_f32() * 1000.0;
        let fps_in = self.rate_in.tick(t);
        let res = tx.try_send(Job { header, buf });
        let mut s = self.shared.stats.lock().unwrap();
        s.received += 1;
        s.bytes += body.len() as u64;
        s.fps_in = fps_in;
        s.copy_ms = ema(s.copy_ms, copy_ms, s.received);
        match res {
            Ok(()) => {}
            Err(TrySendError::Full(job)) => {
                s.dropped += 1;
                self.pool.lock().unwrap().push(job.buf);
            }
            Err(TrySendError::Disconnected(_)) => return Err("virtual camera writer stopped".into()),
        }
        Ok(())
    }
}

impl Drop for VirtualCam {
    fn drop(&mut self) {
        self.stop();
    }
}

fn ema(prev: f32, x: f32, n: u64) -> f32 {
    if n <= 1 {
        x
    } else {
        prev + 0.1 * (x - prev)
    }
}

fn writer_loop(rx: Receiver<Job>, shared: Arc<Shared>, pool: Arc<Mutex<Vec<Vec<u8>>>>) {
    let mut rate = RateMeter::default();
    while let Ok(job) = rx.recv() {
        let t = Instant::now();
        let frame = BgraFrame { width: job.header.width, height: job.header.height, seq: job.header.seq, data: &job.buf };
        let res = shared.sink.lock().unwrap().write(&frame);
        let ms = t.elapsed().as_secs_f32() * 1000.0;
        let fps = rate.tick(Instant::now());
        {
            let mut s = shared.stats.lock().unwrap();
            match res {
                Ok(()) => {
                    s.written += 1;
                    s.write_ms = ema(s.write_ms, ms, s.written);
                }
                Err(e) => {
                    s.write_errors += 1;
                    s.last_error = Some(e);
                }
            }
            s.fps_out = fps;
            s.max_gap_ms = rate.max_gap_ms();
        }
        let mut p = pool.lock().unwrap();
        if p.len() < 3 {
            p.push(job.buf);
        }
    }
}

/// Events per second over a sliding one-second window.
#[derive(Default)]
struct RateMeter {
    times: std::collections::VecDeque<Instant>,
}

impl RateMeter {
    fn tick(&mut self, now: Instant) -> f32 {
        self.times.push_back(now);
        while let Some(&f) = self.times.front() {
            if now.duration_since(f) > Duration::from_secs(1) {
                self.times.pop_front();
            } else {
                break;
            }
        }
        self.times.len() as f32
    }
    fn max_gap_ms(&self) -> f32 {
        self.times
            .iter()
            .zip(self.times.iter().skip(1))
            .map(|(a, b)| b.duration_since(*a).as_secs_f32() * 1000.0)
            .fold(0.0, f32::max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Records what it receives; can be made slow to exercise frame dropping.
    struct MockSink {
        log: Arc<Mutex<Vec<(u32, u32, u32, usize, u8)>>>,
        opened: Arc<Mutex<Option<StreamConfig>>>,
        closes: Arc<AtomicU64>,
        delay: Duration,
    }

    impl VirtualCamSink for MockSink {
        fn name(&self) -> &'static str {
            "mock"
        }
        fn probe(&mut self) -> SinkStatus {
            SinkStatus::new("mock", SinkState::Ready, "MOCK")
        }
        fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
            *self.opened.lock().unwrap() = Some(cfg);
            Ok(())
        }
        fn write(&mut self, f: &BgraFrame) -> Result<(), String> {
            std::thread::sleep(self.delay);
            self.log.lock().unwrap().push((f.width, f.height, f.seq, f.data.len(), f.data[0]));
            Ok(())
        }
        fn close(&mut self) {
            self.closes.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn mock(delay_ms: u64) -> (VirtualCam, Arc<Mutex<Vec<(u32, u32, u32, usize, u8)>>>, Arc<Mutex<Option<StreamConfig>>>, Arc<AtomicU64>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let opened = Arc::new(Mutex::new(None));
        let closes = Arc::new(AtomicU64::new(0));
        let sink = MockSink { log: log.clone(), opened: opened.clone(), closes: closes.clone(), delay: Duration::from_millis(delay_ms) };
        (VirtualCam::new(Box::new(sink)), log, opened, closes)
    }

    fn frame(w: u32, h: u32, seq: u32) -> Vec<u8> {
        encode_frame(w, h, seq, &vec![seq as u8; (w * h * 4) as usize])
    }

    #[test]
    fn header_roundtrip_and_validation() {
        let body = frame(64, 36, 7);
        let (h, px) = parse_frame(&body).unwrap();
        assert_eq!(h, FrameHeader { width: 64, height: 36, seq: 7 });
        assert_eq!(px.len(), 64 * 36 * 4);
        assert!(parse_frame(&body[..body.len() - 1]).is_err(), "short body");
        assert!(parse_frame(&encode_frame(0, 36, 0, &[])).is_err(), "zero width");
        assert!(parse_frame(&encode_frame(63, 1, 0, &[0; 63 * 4])).is_err(), "odd width");
        let mut bad = body.clone();
        bad[0] = b'X';
        assert!(parse_frame(&bad).is_err(), "magic");
    }

    #[test]
    fn frames_reach_the_sink_in_order_with_size_and_format() {
        let (mut vc, log, opened, closes) = mock(0);
        let cfg = StreamConfig { width: 64, height: 36, fps: 30 };
        vc.start(cfg).unwrap();
        assert_eq!(*opened.lock().unwrap(), Some(cfg));
        for seq in 0..20 {
            vc.push(&frame(64, 36, seq)).unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        vc.stop();
        assert_eq!(closes.load(Ordering::SeqCst), 1);
        let log = log.lock().unwrap();
        let s = vc.stats();
        assert_eq!(s.received, 20);
        assert_eq!(s.written + s.dropped, 20);
        assert!(s.written >= 10, "most frames should get through a fast sink: {s:?}");
        let mut last = None;
        for &(w, h, seq, len, first) in log.iter() {
            assert_eq!((w, h, len), (64, 36, 64 * 36 * 4));
            assert_eq!(first, seq as u8, "pixels belong to their frame");
            assert!(last.map_or(true, |l| seq > l), "in order");
            last = Some(seq);
        }
    }

    #[test]
    fn slow_sink_drops_instead_of_queueing() {
        let (mut vc, log, _, _) = mock(30);
        vc.start(StreamConfig { width: 16, height: 8, fps: 30 }).unwrap();
        for seq in 0..30 {
            vc.push(&frame(16, 8, seq)).unwrap(); // never blocks
        }
        vc.stop();
        let s = vc.stats();
        assert_eq!(s.received, 30);
        assert!(s.dropped >= 25, "a 30 ms sink fed instantly should drop: {s:?}");
        assert_eq!(log.lock().unwrap().len() as u64, s.written);
    }

    #[test]
    fn wrong_size_is_rejected_and_restart_changes_size() {
        let (mut vc, log, opened, closes) = mock(0);
        vc.start(StreamConfig { width: 16, height: 8, fps: 30 }).unwrap();
        assert!(vc.push(&frame(32, 8, 0)).is_err());
        assert_eq!(vc.stats().rejected, 1);
        vc.start(StreamConfig { width: 32, height: 8, fps: 30 }).unwrap();
        assert_eq!(closes.load(Ordering::SeqCst), 1, "size change reopens");
        assert_eq!(opened.lock().unwrap().unwrap().width, 32);
        vc.push(&frame(32, 8, 1)).unwrap();
        vc.stop();
        assert_eq!(log.lock().unwrap()[0].0, 32);
    }

    #[test]
    fn push_when_stopped_is_a_no_op() {
        let (mut vc, log, _, _) = mock(0);
        vc.push(&frame(16, 8, 0)).unwrap();
        assert_eq!(vc.stats().received, 0);
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn status_reports_running_while_streaming() {
        let (mut vc, _, _, _) = mock(0);
        assert_eq!(vc.status().state, SinkState::Ready);
        vc.start(StreamConfig { width: 16, height: 8, fps: 30 }).unwrap();
        assert_eq!(vc.status().state, SinkState::Running);
        vc.stop();
        assert_eq!(vc.status().state, SinkState::Ready);
    }
}

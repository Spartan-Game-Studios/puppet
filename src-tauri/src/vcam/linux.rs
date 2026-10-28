//! Linux sink: v4l2loopback.
//!
//! The user creates a loopback device once (Puppet never loads kernel
//! modules):
//!
//! ```sh
//! sudo modprobe v4l2loopback devices=1 video_nr=10 card_label="Puppet" exclusive_caps=1
//! ```
//!
//! We find `/dev/video*` nodes whose driver is "v4l2 loopback", set the output
//! format to YUYV at the stream size with `VIDIOC_S_FMT`, and `write()` one
//! YUYV frame per call. `exclusive_caps=1` makes the node look like a normal
//! capture device to browsers (Chrome/WebRTC) once a writer is attached.

use super::{convert, BgraFrame, PixelFormat, SinkState, SinkStatus, StreamConfig, VirtualCamSink};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;

pub const MODPROBE: &str = "sudo modprobe v4l2loopback devices=1 video_nr=10 card_label=\"Puppet\" exclusive_caps=1";

// ---- minimal V4L2 ABI (linux/videodev2.h) ----

const V4L2_BUF_TYPE_VIDEO_OUTPUT: u32 = 2;
const V4L2_FIELD_NONE: u32 = 1;
const V4L2_COLORSPACE_SRGB: u32 = 8;
const V4L2_PIX_FMT_YUYV: u32 = fourcc(b"YUYV");

const fn fourcc(c: &[u8; 4]) -> u32 {
    (c[0] as u32) | (c[1] as u32) << 8 | (c[2] as u32) << 16 | (c[3] as u32) << 24
}

#[repr(C)]
#[derive(Default)]
struct V4l2Capability {
    driver: [u8; 16],
    card: [u8; 32],
    bus_info: [u8; 32],
    version: u32,
    capabilities: u32,
    device_caps: u32,
    reserved: [u32; 3],
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct V4l2PixFormat {
    width: u32,
    height: u32,
    pixelformat: u32,
    field: u32,
    bytesperline: u32,
    sizeimage: u32,
    colorspace: u32,
    priv_: u32,
    flags: u32,
    ycbcr_enc: u32,
    quantization: u32,
    xfer_func: u32,
}

/// The kernel union is 200 bytes and pointer-aligned (it contains
/// `struct v4l2_window`, which has pointers).
#[repr(C)]
union V4l2FormatUnion {
    pix: V4l2PixFormat,
    raw: [u8; 200],
    _align: [usize; 0],
}

#[repr(C)]
struct V4l2Format {
    type_: u32,
    fmt: V4l2FormatUnion,
}

const IOC_WRITE: u32 = 1;
const IOC_READ: u32 = 2;
const fn ioc(dir: u32, nr: u32, size: usize) -> u32 {
    (dir << 30) | ((size as u32) << 16) | ((b'V' as u32) << 8) | nr
}
const VIDIOC_QUERYCAP: u32 = ioc(IOC_READ, 0, std::mem::size_of::<V4l2Capability>());
const VIDIOC_S_FMT: u32 = ioc(IOC_READ | IOC_WRITE, 5, std::mem::size_of::<V4l2Format>());

fn cstr(b: &[u8]) -> String {
    String::from_utf8_lossy(b.split(|&c| c == 0).next().unwrap_or(&[])).into_owned()
}

/// Driver and card name of a V4L2 node, or None if it isn't one.
fn query(path: &str) -> Option<(String, String)> {
    let f = OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path).ok()?;
    let mut cap = V4l2Capability::default();
    // SAFETY: VIDIOC_QUERYCAP fills a v4l2_capability; the struct matches the kernel ABI.
    let r = unsafe { libc::ioctl(f.as_raw_fd(), VIDIOC_QUERYCAP as _, &mut cap as *mut V4l2Capability) };
    (r == 0).then(|| (cstr(&cap.driver), cstr(&cap.card)))
}

/// v4l2loopback nodes, as (path, card label), sorted by path.
pub fn loopback_devices() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir("/dev") else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with("video") {
            continue;
        }
        let path = format!("/dev/{name}");
        if let Some((driver, card)) = query(&path) {
            if driver.contains("loopback") {
                out.push((path, card));
            }
        }
    }
    out.sort_by_key(|(p, _)| p.trim_start_matches("/dev/video").parse::<u32>().unwrap_or(u32::MAX));
    out
}

pub struct V4l2Sink {
    device: Option<String>,
    file: Option<File>,
    buf: Vec<u8>,
}

impl V4l2Sink {
    pub fn new() -> Self {
        V4l2Sink { device: None, file: None, buf: Vec::new() }
    }

    fn pick(&self, devices: &[(String, String)]) -> Option<String> {
        match &self.device {
            Some(d) if devices.iter().any(|(p, _)| p == d) => Some(d.clone()),
            _ => devices.first().map(|(p, _)| p.clone()),
        }
    }
}

impl VirtualCamSink for V4l2Sink {
    fn name(&self) -> &'static str {
        "v4l2loopback"
    }

    fn probe(&mut self) -> SinkStatus {
        let devs = loopback_devices();
        let mut st = if devs.is_empty() {
            SinkStatus::new("v4l2loopback", SinkState::NeedsSetup, "NO V4L2LOOPBACK DEVICE FOUND")
                .hint("Install v4l2loopback (e.g. the v4l2loopback-dkms package), then create a device with this command and press REFRESH. Puppet does not load kernel modules itself.")
                .command(MODPROBE)
        } else {
            let state = if self.file.is_some() { SinkState::Running } else { SinkState::Ready };
            let dev = self.pick(&devs).unwrap_or_default();
            let card = devs.iter().find(|(p, _)| *p == dev).map(|(_, c)| c.clone()).unwrap_or_default();
            let mut s = SinkStatus::new("v4l2loopback", state, format!("{dev} ({card})"));
            s.device = Some(dev);
            s
        };
        st.devices = devs.into_iter().map(|(p, _)| p).collect();
        st.format = Some(PixelFormat::Yuyv);
        st
    }

    fn select_device(&mut self, device: Option<String>) {
        self.device = device;
    }

    fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
        let dev = self.pick(&loopback_devices()).ok_or_else(|| format!("no v4l2loopback device; run: {MODPROBE}"))?;
        let f = OpenOptions::new().read(true).write(true).open(&dev).map_err(|e| format!("{dev}: {e}"))?;
        let mut fmt = V4l2Format { type_: V4L2_BUF_TYPE_VIDEO_OUTPUT, fmt: V4l2FormatUnion { raw: [0; 200] } };
        fmt.fmt.pix = V4l2PixFormat {
            width: cfg.width,
            height: cfg.height,
            pixelformat: V4L2_PIX_FMT_YUYV,
            field: V4L2_FIELD_NONE,
            bytesperline: cfg.width * 2,
            sizeimage: cfg.width * cfg.height * 2,
            colorspace: V4L2_COLORSPACE_SRGB,
            ..Default::default()
        };
        // SAFETY: VIDIOC_S_FMT reads/writes a v4l2_format; layout matches the kernel ABI.
        let r = unsafe { libc::ioctl(f.as_raw_fd(), VIDIOC_S_FMT as _, &mut fmt as *mut V4l2Format) };
        if r != 0 {
            return Err(format!("{dev}: VIDIOC_S_FMT failed: {} (is another app writing to it?)", std::io::Error::last_os_error()));
        }
        // SAFETY: plain read of the union the kernel just filled.
        let got = unsafe { fmt.fmt.pix };
        if got.width != cfg.width || got.height != cfg.height || got.pixelformat != V4L2_PIX_FMT_YUYV {
            return Err(format!(
                "{dev} accepted {}x{} {:#x} instead of {}x{} YUYV (reload v4l2loopback or pick another device)",
                got.width, got.height, got.pixelformat, cfg.width, cfg.height
            ));
        }
        self.device = Some(dev);
        self.file = Some(f);
        Ok(())
    }

    fn write(&mut self, frame: &BgraFrame) -> Result<(), String> {
        let Some(f) = &mut self.file else { return Err("not open".into()) };
        convert::convert(frame.data, frame.width, frame.height, PixelFormat::Yuyv, &mut self.buf);
        f.write_all(&self.buf).map_err(|e| e.to_string())
    }

    fn close(&mut self) {
        self.file = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abi_sizes_match_videodev2() {
        assert_eq!(std::mem::size_of::<V4l2Capability>(), 104);
        assert_eq!(std::mem::size_of::<V4l2PixFormat>(), 48);
        #[cfg(target_pointer_width = "64")]
        {
            assert_eq!(std::mem::size_of::<V4l2Format>(), 208);
            assert_eq!(VIDIOC_S_FMT, 0xC0D0_5605);
        }
        assert_eq!(VIDIOC_QUERYCAP, 0x8068_5600);
        assert_eq!(V4L2_PIX_FMT_YUYV, 0x5659_5559);
    }

    #[test]
    fn probe_without_devices_explains_modprobe() {
        // CI runners have no loopback device; on a machine that has one this
        // just checks the status is coherent.
        let mut s = V4l2Sink::new();
        let st = s.probe();
        if st.devices.is_empty() {
            assert_eq!(st.state, SinkState::NeedsSetup);
            assert!(st.command.as_deref().unwrap().contains("modprobe v4l2loopback"));
        } else {
            assert_eq!(st.state, SinkState::Ready);
        }
    }
}

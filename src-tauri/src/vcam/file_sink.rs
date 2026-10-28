//! Test sink: writes frames to a raw video file plus a JSON summary, so the
//! whole path (render -> readback -> IPC -> writer -> conversion) can be
//! checked without any virtual camera installed.
//!
//! `PUPPET_VCAM_SINK=file:/abs/out.yuyv` (format from the extension: `.yuyv`,
//! `.bgr` / `.bgr24`, anything else BGRA). Append `?max=N` to cap the number
//! of frames stored (default 150; later frames are counted, not stored).
//! The summary goes to `<path>.json` and is refreshed every second.
//!
//! View the result with ffmpeg, e.g.
//! `ffmpeg -f rawvideo -pix_fmt yuyv422 -s 1280x720 -i out.yuyv -frames:v 1 f.png`.

use super::{convert, BgraFrame, PixelFormat, SinkState, SinkStatus, StreamConfig, VirtualCamSink};
use serde::Serialize;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug, Default, Clone, Serialize)]
pub struct FileSummary {
    pub path: String,
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub bytes_per_frame: usize,
    /// Frames delivered to the sink.
    pub frames: u64,
    /// Frames stored in the file (<= max).
    pub stored: u64,
    pub first_seq: Option<u32>,
    pub last_seq: Option<u32>,
    /// Sequence gaps seen (frames dropped upstream of the sink).
    pub seq_gaps: u64,
    pub elapsed_s: f64,
    pub fps: f64,
    pub min_interval_ms: f64,
    pub max_interval_ms: f64,
    /// Mean time of the pixel conversion only (ms).
    pub convert_ms: f64,
}

pub struct FileSink {
    path: PathBuf,
    format: PixelFormat,
    max: u64,
    out: Option<BufWriter<File>>,
    buf: Vec<u8>,
    sum: FileSummary,
    start: Option<Instant>,
    last: Option<Instant>,
    last_json: Option<Instant>,
    convert_total: f64,
}

impl FileSink {
    pub fn new(path: PathBuf, format: PixelFormat, max: u64) -> Self {
        FileSink {
            path,
            format,
            max,
            out: None,
            buf: Vec::new(),
            sum: FileSummary::default(),
            start: None,
            last: None,
            last_json: None,
            convert_total: 0.0,
        }
    }

    /// Parse `path[?max=N]`.
    pub fn from_spec(spec: &str) -> Self {
        let (path, query) = spec.split_once('?').unwrap_or((spec, ""));
        let max = query
            .split('&')
            .find_map(|kv| kv.strip_prefix("max=").and_then(|v| v.parse().ok()))
            .unwrap_or(150);
        let lower = path.to_ascii_lowercase();
        let format = if lower.ends_with(".yuyv") {
            PixelFormat::Yuyv
        } else if lower.ends_with(".bgr") || lower.ends_with(".bgr24") {
            PixelFormat::Bgr24
        } else {
            PixelFormat::Bgra
        };
        FileSink::new(PathBuf::from(path), format, max)
    }

    fn json_path(&self) -> PathBuf {
        let mut p = self.path.clone().into_os_string();
        p.push(".json");
        p.into()
    }

    fn write_summary(&mut self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.sum) {
            let _ = std::fs::write(self.json_path(), s);
        }
        self.last_json = Some(Instant::now());
    }
}

impl VirtualCamSink for FileSink {
    fn name(&self) -> &'static str {
        "file"
    }

    fn probe(&mut self) -> SinkStatus {
        let st = if self.out.is_some() { SinkState::Running } else { SinkState::Ready };
        let mut s = SinkStatus::new("file", st, format!("FILE SINK (TEST): {}", self.path.display()));
        s.format = Some(self.format);
        s
    }

    fn open(&mut self, cfg: StreamConfig) -> Result<(), String> {
        let f = File::create(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        self.out = Some(BufWriter::with_capacity(1 << 20, f));
        self.sum = FileSummary {
            path: self.path.display().to_string(),
            format: self.format.name().into(),
            width: cfg.width,
            height: cfg.height,
            bytes_per_frame: self.format.frame_bytes(cfg.width, cfg.height),
            min_interval_ms: f64::MAX,
            ..Default::default()
        };
        self.start = None;
        self.last = None;
        self.convert_total = 0.0;
        Ok(())
    }

    fn write(&mut self, frame: &BgraFrame) -> Result<(), String> {
        let now = Instant::now();
        let t = Instant::now();
        convert::convert(frame.data, frame.width, frame.height, self.format, &mut self.buf);
        self.convert_total += t.elapsed().as_secs_f64() * 1000.0;
        let s = &mut self.sum;
        if let Some(prev) = s.last_seq {
            if frame.seq > prev + 1 {
                s.seq_gaps += (frame.seq - prev - 1) as u64;
            }
        } else {
            s.first_seq = Some(frame.seq);
        }
        s.last_seq = Some(frame.seq);
        s.frames += 1;
        if s.stored < self.max {
            if let Some(out) = &mut self.out {
                out.write_all(&self.buf).map_err(|e| e.to_string())?;
                s.stored += 1;
            }
        }
        let start = *self.start.get_or_insert(now);
        if let Some(last) = self.last {
            let ms = now.duration_since(last).as_secs_f64() * 1000.0;
            s.min_interval_ms = s.min_interval_ms.min(ms);
            s.max_interval_ms = s.max_interval_ms.max(ms);
        }
        self.last = Some(now);
        s.elapsed_s = now.duration_since(start).as_secs_f64();
        s.fps = if s.elapsed_s > 0.0 { (s.frames - 1) as f64 / s.elapsed_s } else { 0.0 };
        s.convert_ms = self.convert_total / s.frames as f64;
        if self.last_json.map_or(true, |t| t.elapsed().as_secs_f64() >= 1.0) {
            self.write_summary();
        }
        Ok(())
    }

    fn close(&mut self) {
        if let Some(mut out) = self.out.take() {
            let _ = out.flush();
        }
        if self.sum.min_interval_ms == f64::MAX {
            self.sum.min_interval_ms = 0.0;
        }
        self.write_summary();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcam::{encode_frame, VirtualCam};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("puppet-vcam-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join(name)
    }

    #[test]
    fn spec_parsing() {
        let s = FileSink::from_spec("/x/out.yuyv?max=5");
        assert_eq!((s.format, s.max), (PixelFormat::Yuyv, 5));
        assert_eq!(s.path, PathBuf::from("/x/out.yuyv"));
        assert_eq!(FileSink::from_spec("/x/o.bgr").format, PixelFormat::Bgr24);
        assert_eq!(FileSink::from_spec("/x/o.raw").format, PixelFormat::Bgra);
    }

    #[test]
    fn writes_frames_of_the_right_size_and_format_through_the_controller() {
        let path = tmp("frames.yuyv");
        let mut vc = VirtualCam::new(Box::new(FileSink::from_spec(&format!("{}?max=4", path.display()))));
        let (w, h) = (64u32, 32u32);
        vc.start(StreamConfig { width: w, height: h, fps: 30 }).unwrap();
        // Chroma green frames, paced so none are dropped.
        let green: Vec<u8> = [0u8, 255, 0, 255].iter().copied().cycle().take((w * h * 4) as usize).collect();
        for seq in 0..6 {
            vc.push(&encode_frame(w, h, seq, &green)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        vc.stop();
        let st = vc.stats();
        assert_eq!(st.format, Some(PixelFormat::Yuyv));
        assert_eq!(st.written + st.dropped, 6);

        let data = std::fs::read(&path).unwrap();
        let stored = st.written.min(4) as usize;
        assert_eq!(data.len(), stored * (w * h * 2) as usize, "max caps stored frames");
        // YUYV of chroma green: Y ~144, U ~54, V ~34.
        assert!((data[0] as i32 - 144).abs() <= 1 && (data[1] as i32 - 54).abs() <= 1 && (data[3] as i32 - 34).abs() <= 1, "{:?}", &data[..4]);

        let json: serde_json::Value = serde_json::from_slice(&std::fs::read(path.with_extension("yuyv.json")).unwrap()).unwrap();
        assert_eq!(json["width"], 64);
        assert_eq!(json["height"], 32);
        assert_eq!(json["format"], "YUYV");
        assert_eq!(json["bytes_per_frame"], 64 * 32 * 2);
        assert_eq!(json["frames"].as_u64().unwrap(), st.written);
        assert!(json["fps"].as_f64().unwrap() > 20.0, "paced at ~15 ms: {json}");
    }
}

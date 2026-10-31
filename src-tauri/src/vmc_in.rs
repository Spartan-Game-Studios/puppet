//! VMC protocol input (https://protocol.vmc.info/): VPuppet as a VMC
//! *receiver*. Body trackers (SlimeVR, mocopi), iPhone face apps and other VMC
//! senders stream OSC over UDP; a thread here decodes it into the latest pose
//! and the webview polls it once per render tick (`vmc_in_poll`), then blends
//! it per body region over its own tracking (src/vmc/vmcInput.ts).
//!
//! Messages used: /VMC/Ext/Bone/Pos (humanoid bone, local position + rotation,
//! Unity space), /VMC/Ext/Root/Pos, /VMC/Ext/Blend/Val + /VMC/Ext/Blend/Apply
//! (blend shapes become visible on Apply), /VMC/Ext/OK and /VMC/Ext/T.
//! Anything else is counted and ignored.

use rosc::{decoder, OscPacket, OscType};
use serde::Serialize;
use std::collections::HashMap;
use std::net::UdpSocket;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// [px, py, pz, qx, qy, qz, qw], Unity coordinates.
pub type Transform7 = [f32; 7];

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
pub struct InFrame {
    /// Increases whenever anything new arrived.
    pub seq: u64,
    /// Unity HumanBodyBones name -> local transform.
    pub bones: HashMap<String, Transform7>,
    pub root: Option<Transform7>,
    /// Blend shape name -> value, as of the last /VMC/Ext/Blend/Apply.
    pub blends: HashMap<String, f32>,
    /// Sender's /VMC/Ext/T.
    pub t: Option<f32>,
    /// /VMC/Ext/OK: model loaded (1) and tracking status (1 = tracking), when the sender says.
    pub loaded: Option<i32>,
    pub tracking: Option<i32>,
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct InStatus {
    pub enabled: bool,
    pub listening: Option<String>,
    pub error: Option<String>,
    pub packets: u64,
    pub messages: u64,
    pub ignored: u64,
    pub bad: u64,
    /// Where the last packet came from.
    pub sender: Option<String>,
    /// Milliseconds since the last packet (None: nothing yet).
    pub age_ms: Option<u64>,
    /// Packets per second over the last second or so.
    pub rate: f32,
}

#[derive(Default)]
struct Shared {
    frame: InFrame,
    pending_blends: HashMap<String, f32>,
    status: InStatus,
    last_packet: Option<Instant>,
    rate_window: (Option<Instant>, u64),
}

impl Shared {
    fn packet(&mut self, buf: &[u8], from: String) {
        let now = Instant::now();
        self.status.packets += 1;
        self.status.sender = Some(from);
        self.last_packet = Some(now);
        let (start, n) = &mut self.rate_window;
        match start {
            Some(s) if now.duration_since(*s) < Duration::from_secs(1) => *n += 1,
            _ => {
                if let Some(s) = start {
                    self.status.rate = *n as f32 / now.duration_since(*s).as_secs_f32().max(0.001);
                }
                *start = Some(now);
                *n = 1;
            }
        }
        match decoder::decode_udp(buf) {
            Ok((_, p)) => {
                self.walk(p);
                self.frame.seq += 1;
            }
            Err(_) => self.status.bad += 1,
        }
    }

    fn walk(&mut self, p: OscPacket) {
        match p {
            OscPacket::Bundle(b) => b.content.into_iter().for_each(|c| self.walk(c)),
            OscPacket::Message(m) => {
                self.status.messages += 1;
                let a = &m.args;
                match m.addr.as_str() {
                    "/VMC/Ext/Bone/Pos" => match (name(a), transform(a)) {
                        (Some(n), Some(t)) => {
                            self.frame.bones.insert(n, t);
                        }
                        _ => self.status.bad += 1,
                    },
                    "/VMC/Ext/Root/Pos" => match transform(a) {
                        Some(t) => self.frame.root = Some(t),
                        None => self.status.bad += 1,
                    },
                    "/VMC/Ext/Blend/Val" => match (name(a), a.get(1).and_then(float)) {
                        (Some(n), Some(v)) => {
                            self.pending_blends.insert(n, v);
                        }
                        _ => self.status.bad += 1,
                    },
                    "/VMC/Ext/Blend/Apply" => {
                        self.frame.blends.extend(self.pending_blends.drain());
                    }
                    "/VMC/Ext/OK" => {
                        self.frame.loaded = a.first().and_then(int);
                        self.frame.tracking = a.get(3).and_then(int);
                    }
                    "/VMC/Ext/T" => self.frame.t = a.first().and_then(float),
                    _ => self.status.ignored += 1,
                }
            }
        }
    }
}

fn name(a: &[OscType]) -> Option<String> {
    match a.first()? {
        OscType::String(s) => Some(s.clone()),
        _ => None,
    }
}

fn float(v: &OscType) -> Option<f32> {
    match v {
        OscType::Float(f) => Some(*f),
        OscType::Double(d) => Some(*d as f32),
        OscType::Int(i) => Some(*i as f32),
        _ => None,
    }
}

fn int(v: &OscType) -> Option<i32> {
    match v {
        OscType::Int(i) => Some(*i),
        _ => None,
    }
}

/// name, px, py, pz, qx, qy, qz, qw (Bone/Pos and Root/Pos; Root may carry extra scale/offset args).
fn transform(a: &[OscType]) -> Option<Transform7> {
    if a.len() < 8 {
        return None;
    }
    let mut t = [0f32; 7];
    for (i, v) in a[1..8].iter().enumerate() {
        t[i] = float(v)?;
        if !t[i].is_finite() {
            return None;
        }
    }
    Some(t)
}

/// The receiver: one listening thread at a time.
#[derive(Default)]
pub struct Receiver {
    shared: Arc<Mutex<Shared>>,
    stop: Option<Arc<AtomicBool>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Receiver {
    /// Start (or restart) listening; `lan` also accepts other devices on the
    /// network (an iPhone app), otherwise only this computer.
    pub fn configure(&mut self, enabled: bool, port: u16, lan: bool) -> Result<InStatus, String> {
        // The old listener must let go of its port before a new one binds it.
        self.stop();
        {
            let mut sh = self.shared.lock().map_err(|e| e.to_string())?;
            *sh = Shared::default();
            sh.status.enabled = enabled;
        }
        if !enabled {
            return self.status();
        }
        let addr = if lan { format!("0.0.0.0:{port}") } else { format!("127.0.0.1:{port}") };
        let socket = match UdpSocket::bind(&addr) {
            Ok(s) => s,
            Err(e) => {
                let msg = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("port {port} is in use (another VMC receiver such as VSeeFace, or VPuppet's own VMC output aimed at this port?)")
                } else {
                    format!("cannot listen on {addr}: {e}")
                };
                self.shared.lock().map_err(|e| e.to_string())?.status.error = Some(msg.clone());
                return Err(msg);
            }
        };
        // Wake up regularly so a stop request is seen without traffic.
        socket.set_read_timeout(Some(Duration::from_millis(200))).map_err(|e| e.to_string())?;
        self.shared.lock().map_err(|e| e.to_string())?.status.listening = Some(addr);
        let stop = Arc::new(AtomicBool::new(false));
        self.stop = Some(stop.clone());
        let shared = self.shared.clone();
        self.thread = Some(std::thread::spawn(move || {
            let mut buf = vec![0u8; 65_536];
            while !stop.load(Ordering::Relaxed) {
                match socket.recv_from(&mut buf) {
                    Ok((n, from)) => {
                        if let Ok(mut sh) = shared.lock() {
                            sh.packet(&buf[..n], from.to_string());
                        }
                    }
                    Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                    Err(e) => {
                        if let Ok(mut sh) = shared.lock() {
                            sh.status.error = Some(e.to_string());
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        }));
        self.status()
    }

    pub fn status(&self) -> Result<InStatus, String> {
        let sh = self.shared.lock().map_err(|e| e.to_string())?;
        let mut s = sh.status.clone();
        s.age_ms = sh.last_packet.map(|t| t.elapsed().as_millis() as u64);
        if s.age_ms.is_some_and(|a| a > 1500) {
            s.rate = 0.0;
        }
        Ok(s)
    }

    /// The latest frame if anything arrived after `since` (its seq).
    pub fn poll(&self, since: u64) -> Result<Option<InFrame>, String> {
        let sh = self.shared.lock().map_err(|e| e.to_string())?;
        Ok((sh.frame.seq > since).then(|| sh.frame.clone()))
    }

    /// Stop listening and wait for the thread (it wakes every 200 ms) so the port is free.
    pub fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            s.store(true, Ordering::Relaxed);
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }

    /// Feed a datagram as if it arrived (tests, and replaying captures).
    pub fn inject(&self, buf: &[u8]) -> Result<(), String> {
        self.shared.lock().map_err(|e| e.to_string())?.packet(buf, "inject".into());
        Ok(())
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vmc::{encode_frame, Frame};

    fn frame() -> Frame {
        Frame {
            t: 1.5,
            root: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            bones: (0..60)
                .map(|i| (format!("Bone{i}"), 0.0, i as f32, 0.0, 0.0, 0.0, 0.0, 1.0))
                .chain(std::iter::once(("LeftUpperLeg".to_string(), 0.1, -0.05, 0.0, 0.5, 0.0, 0.0, 0.866)))
                .collect(),
            blends: vec![("eyeBlinkLeft".into(), 0.75), ("A".into(), 0.25)],
        }
    }

    #[test]
    fn decodes_what_the_sender_encodes_across_datagrams() {
        let r = Receiver::default();
        let datagrams = encode_frame(&frame()).unwrap();
        assert!(datagrams.len() > 1, "the frame spans several datagrams");
        for d in &datagrams {
            r.inject(d).unwrap();
        }
        let f = r.poll(0).unwrap().unwrap();
        assert_eq!(f.bones.len(), 61);
        assert_eq!(f.bones["LeftUpperLeg"], [0.1, -0.05, 0.0, 0.5, 0.0, 0.0, 0.866]);
        assert_eq!(f.root, Some([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]));
        assert_eq!(f.blends["eyeBlinkLeft"], 0.75);
        assert_eq!(f.t, Some(1.5));
        assert_eq!((f.loaded, f.tracking), (Some(1), Some(1)));
        assert_eq!(f.seq, datagrams.len() as u64);
        // Nothing new since then.
        assert!(r.poll(f.seq).unwrap().is_none());
    }

    #[test]
    fn blends_wait_for_apply_and_garbage_is_counted() {
        let r = Receiver::default();
        let val = rosc::encoder::encode(&OscPacket::Message(rosc::OscMessage {
            addr: "/VMC/Ext/Blend/Val".into(),
            args: vec![OscType::String("jawOpen".into()), OscType::Float(0.5)],
        }))
        .unwrap();
        r.inject(&val).unwrap();
        assert!(r.poll(0).unwrap().unwrap().blends.is_empty());
        let apply = rosc::encoder::encode(&OscPacket::Message(rosc::OscMessage { addr: "/VMC/Ext/Blend/Apply".into(), args: vec![] })).unwrap();
        r.inject(&apply).unwrap();
        assert_eq!(r.poll(0).unwrap().unwrap().blends["jawOpen"], 0.5);
        r.inject(b"not osc at all").unwrap();
        let s = r.status().unwrap();
        assert_eq!((s.packets, s.bad), (3, 1));
    }

    #[test]
    fn listens_on_localhost_and_reports_a_busy_port() {
        let mut r = Receiver::default();
        // Port 0 = any free port; read it back to send to it.
        let s = r.configure(true, 0, false).unwrap();
        assert!(s.listening.as_deref().unwrap().starts_with("127.0.0.1:"));
        let taken = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let mut other = Receiver::default();
        let err = other.configure(true, port, false).unwrap_err();
        assert!(err.contains("in use"), "{err}");
        r.configure(false, 0, false).unwrap();
        assert!(!r.status().unwrap().enabled);
    }

    #[test]
    fn reconfiguring_the_same_port_reuses_it() {
        let probe = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let mut r = Receiver::default();
        for _ in 0..3 {
            r.configure(true, port, false).expect("the previous listener released the port");
        }
        r.stop();
    }

    #[test]
    fn receives_over_real_udp() {
        let probe = UdpSocket::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let mut r = Receiver::default();
        r.configure(true, port, false).unwrap();
        let tx = UdpSocket::bind("127.0.0.1:0").unwrap();
        for d in encode_frame(&frame()).unwrap() {
            tx.send_to(&d, ("127.0.0.1", port)).unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        while r.poll(0).unwrap().map(|f| f.bones.len()) != Some(61) {
            assert!(Instant::now() < deadline, "frame never arrived");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(r.status().unwrap().sender.unwrap().starts_with("127.0.0.1:"));
        r.stop();
    }
}

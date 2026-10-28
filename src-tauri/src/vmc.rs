//! VMC protocol output (https://protocol.vmc.info/): OSC over UDP.
//!
//! The frontend sends one `Frame` per render tick; this module encodes it as
//! OSC bundles and sends them. Frames are split across several datagrams so
//! each stays under a safe UDP payload size even on a real network.

use rosc::{encoder, OscBundle, OscMessage, OscPacket, OscTime, OscType};
use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};

/// Max bytes per datagram we aim for (below a 1500-byte Ethernet MTU).
pub const MAX_DATAGRAM: usize = 1200;

/// One VMC frame. Positions/rotations are already in Unity coordinates.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct Frame {
    /// Seconds since start (/VMC/Ext/T).
    pub t: f32,
    /// Root transform: px, py, pz, qx, qy, qz, qw.
    pub root: [f32; 7],
    /// (Unity HumanBodyBones name, px, py, pz, qx, qy, qz, qw).
    pub bones: Vec<(String, f32, f32, f32, f32, f32, f32, f32)>,
    /// (blend shape name, value 0..1).
    pub blends: Vec<(String, f32)>,
}

fn msg(addr: &str, args: Vec<OscType>) -> OscPacket {
    OscPacket::Message(OscMessage { addr: addr.to_string(), args })
}

fn bundle(content: Vec<OscPacket>) -> OscPacket {
    OscPacket::Bundle(OscBundle { timetag: OscTime { seconds: 0, fractional: 1 }, content })
}

fn floats(v: &[f32]) -> Vec<OscType> {
    v.iter().map(|f| OscType::Float(*f)).collect()
}

/// Encode a frame into one or more OSC bundle datagrams, in send order:
/// status + time + root, then bones, then blend values, with
/// `/VMC/Ext/Blend/Apply` as the last message of the last datagram.
pub fn encode_frame(frame: &Frame) -> Result<Vec<Vec<u8>>, String> {
    let mut msgs: Vec<OscPacket> = Vec::with_capacity(frame.bones.len() + frame.blends.len() + 4);
    // /VMC/Ext/OK <loaded=1> <calibration state=3 (done)> <calibration mode=0> <tracking status=1>
    msgs.push(msg("/VMC/Ext/OK", vec![OscType::Int(1), OscType::Int(3), OscType::Int(0), OscType::Int(1)]));
    msgs.push(msg("/VMC/Ext/T", vec![OscType::Float(frame.t)]));
    let mut root = vec![OscType::String("root".into())];
    root.extend(floats(&frame.root));
    msgs.push(msg("/VMC/Ext/Root/Pos", root));
    for (name, px, py, pz, qx, qy, qz, qw) in &frame.bones {
        let mut a = vec![OscType::String(name.clone())];
        a.extend(floats(&[*px, *py, *pz, *qx, *qy, *qz, *qw]));
        msgs.push(msg("/VMC/Ext/Bone/Pos", a));
    }
    for (name, v) in &frame.blends {
        msgs.push(msg("/VMC/Ext/Blend/Val", vec![OscType::String(name.clone()), OscType::Float(*v)]));
    }
    msgs.push(msg("/VMC/Ext/Blend/Apply", vec![]));

    // Pack messages greedily into bundles under MAX_DATAGRAM.
    let mut out = Vec::new();
    let mut cur: Vec<OscPacket> = Vec::new();
    let mut cur_len = 16usize; // "#bundle\0" + timetag
    for m in msgs {
        let len = encoder::encode(&m).map_err(|e| e.to_string())?.len() + 4;
        if !cur.is_empty() && cur_len + len > MAX_DATAGRAM {
            out.push(encoder::encode(&bundle(std::mem::take(&mut cur))).map_err(|e| e.to_string())?);
            cur_len = 16;
        }
        cur_len += len;
        cur.push(m);
    }
    if !cur.is_empty() {
        out.push(encoder::encode(&bundle(cur)).map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct Stats {
    pub enabled: bool,
    pub target: String,
    pub frames: u64,
    pub datagrams: u64,
    pub bytes: u64,
    pub errors: u64,
    pub last_error: Option<String>,
}

#[derive(Default)]
pub struct Sender {
    socket: Option<UdpSocket>,
    target: Option<SocketAddr>,
    pub stats: Stats,
}

impl Sender {
    pub fn configure(&mut self, enabled: bool, host: &str, port: u16) -> Result<(), String> {
        self.stats.enabled = false;
        self.socket = None;
        self.target = None;
        self.stats.target = format!("{host}:{port}");
        if !enabled {
            return Ok(());
        }
        let target = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("bad VMC target {host}:{port}: {e}"))?
            .next()
            .ok_or_else(|| format!("no address for {host}"))?;
        let bind = if target.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" };
        let socket = UdpSocket::bind(bind).map_err(|e| e.to_string())?;
        socket.set_nonblocking(true).map_err(|e| e.to_string())?;
        self.socket = Some(socket);
        self.target = Some(target);
        self.stats.enabled = true;
        Ok(())
    }

    pub fn send(&mut self, frame: &Frame) -> Result<(), String> {
        let (Some(sock), Some(target)) = (&self.socket, self.target) else {
            return Ok(());
        };
        let datagrams = encode_frame(frame)?;
        self.stats.frames += 1;
        for d in &datagrams {
            match sock.send_to(d, target) {
                Ok(n) => {
                    self.stats.datagrams += 1;
                    self.stats.bytes += n as u64;
                }
                Err(e) => {
                    // Nothing listening is normal (ICMP unreachable on some OSes); count, don't fail.
                    self.stats.errors += 1;
                    self.stats.last_error = Some(e.to_string());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::decoder;

    fn sample() -> Frame {
        Frame {
            t: 1.5,
            root: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            bones: (0..55)
                .map(|i| (format!("Bone{i}"), 0.1, 0.2, 0.3, 0.0, 0.0, 0.0, 1.0))
                .collect(),
            blends: (0..60).map(|i| (format!("blend{i}"), i as f32 / 60.0)).collect(),
        }
    }

    fn decode_all(datagrams: &[Vec<u8>]) -> Vec<OscMessage> {
        let mut out = Vec::new();
        for d in datagrams {
            let (_, p) = decoder::decode_udp(d).expect("decodes");
            match p {
                OscPacket::Bundle(b) => {
                    for c in b.content {
                        if let OscPacket::Message(m) = c {
                            out.push(m)
                        }
                    }
                }
                OscPacket::Message(m) => out.push(m),
            }
        }
        out
    }

    #[test]
    fn datagrams_fit_and_decode_in_order() {
        let f = sample();
        let dg = encode_frame(&f).unwrap();
        assert!(dg.len() > 1, "a full frame should be split");
        for d in &dg {
            assert!(d.len() <= MAX_DATAGRAM, "datagram {} bytes", d.len());
        }
        let msgs = decode_all(&dg);
        assert_eq!(msgs.len(), 3 + 55 + 60 + 1);
        assert_eq!(msgs[0].addr, "/VMC/Ext/OK");
        assert_eq!(msgs[1].addr, "/VMC/Ext/T");
        assert_eq!(msgs[2].addr, "/VMC/Ext/Root/Pos");
        assert_eq!(msgs.last().unwrap().addr, "/VMC/Ext/Blend/Apply");
        // Every blend value precedes Apply.
        let apply = msgs.iter().position(|m| m.addr == "/VMC/Ext/Blend/Apply").unwrap();
        assert!(msgs.iter().rposition(|m| m.addr == "/VMC/Ext/Blend/Val").unwrap() < apply);
    }

    #[test]
    fn bone_message_layout() {
        let f = Frame {
            t: 0.0,
            root: [1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0],
            bones: vec![("Head".into(), 0.0, 0.1, 0.0, 0.1, -0.2, 0.3, 0.9)],
            blends: vec![("jawOpen".into(), 0.75)],
        };
        let msgs = decode_all(&encode_frame(&f).unwrap());
        let bone = msgs.iter().find(|m| m.addr == "/VMC/Ext/Bone/Pos").unwrap();
        assert_eq!(bone.args.len(), 8);
        assert_eq!(bone.args[0], OscType::String("Head".into()));
        assert_eq!(bone.args[5], OscType::Float(-0.2));
        let root = msgs.iter().find(|m| m.addr == "/VMC/Ext/Root/Pos").unwrap();
        assert_eq!(root.args[0], OscType::String("root".into()));
        assert_eq!(root.args[1], OscType::Float(1.0));
        let blend = msgs.iter().find(|m| m.addr == "/VMC/Ext/Blend/Val").unwrap();
        assert_eq!(blend.args, vec![OscType::String("jawOpen".into()), OscType::Float(0.75)]);
        let ok = msgs.iter().find(|m| m.addr == "/VMC/Ext/OK").unwrap();
        assert_eq!(ok.args[0], OscType::Int(1));
    }

    #[test]
    fn frame_deserializes_from_frontend_json() {
        let json = r#"{"t":0.5,"root":[0,0,0,0,0,0,1],"bones":[["Hips",0,1,0,0,0,0,1]],"blends":[["Blink",1]]}"#;
        let f: Frame = serde_json::from_str(json).unwrap();
        assert_eq!(f.bones[0].0, "Hips");
        assert_eq!(f.bones[0].2, 1.0);
        assert_eq!(f.blends[0], ("Blink".to_string(), 1.0));
    }

    #[test]
    fn sends_over_udp_loopback() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let port = rx.local_addr().unwrap().port();
        let mut s = Sender::default();
        s.configure(true, "127.0.0.1", port).unwrap();
        s.send(&sample()).unwrap();
        let mut buf = [0u8; 2048];
        let mut got = Vec::new();
        while let Ok((n, _)) = rx.recv_from(&mut buf) {
            got.push(buf[..n].to_vec());
            if got.len() as u64 == s.stats.datagrams {
                break;
            }
        }
        let msgs = decode_all(&got);
        assert_eq!(msgs.len(), 3 + 55 + 60 + 1);
        assert_eq!(s.stats.errors, 0);
    }
}

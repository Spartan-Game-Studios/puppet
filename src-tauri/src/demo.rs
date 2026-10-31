//! The free Steam demo (cargo feature `demo`): fully featured for 100 hours of
//! use, then the outputs lock, but only when the app starts: hours running out
//! mid-stream never cuts the stream (players hate that), the session carries on
//! and the next launch is locked. Tracking on the stage, the virtual camera and
//! VMC stop; the model library (HOME) stays open, so nothing the user imported
//! is lost, and buying the full app (same identifier, same data folder) picks
//! it all up.
//!
//! "Use" is time on the stage with a model loaded or an output running: the
//! frontend sends `demo_heartbeat` from the stage, and every VMC send and
//! virtual camera frame counts on their own. The clock advances in TICK_S
//! steps while the last sign of use is under ACTIVE_S old.
//!
//! The total is kept in `demo.json` next to the library, signed with an HMAC
//! so a hand edit reads as spent rather than as zero, and (feature `steam`)
//! mirrored to the Steamworks stat `demo_seconds`; the higher of the two
//! wins. The source is MIT, so none of this stops someone rebuilding without
//! the feature; it keeps the honest path honest.
//!
//! Without the feature every check passes and `demo_status` reports
//! `demo: false`.

use hmac::{Hmac, Mac};
use serde::Serialize;
use sha2::Sha256;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const ENABLED: bool = cfg!(feature = "demo");
/// 100 hours.
pub const LIMIT_S: u64 = 100 * 3600;
/// The error every locked command returns; the frontend matches the prefix.
pub const EXPIRED: &str = "DEMO_EXPIRED";

const TICK_S: u64 = 5;
const ACTIVE_S: u64 = 15;
const SAVE_EVERY_S: u64 = 60;
/// Steam's copy of the clock can arrive a few seconds after launch; it may still
/// lock the app this early, before the user has started anything.
const STARTUP_GRACE_S: u64 = 30;
const KEY: &[u8] = b"vpuppet/demo/v1/7c2f0e9a4b1d";

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub demo: bool,
    pub used_s: u64,
    pub limit_s: u64,
    pub locked: bool,
    /// The hours are used up; if not `locked` yet, the app locks at its next start.
    pub expired: bool,
    /// The Steam stat has been read (feature `steam`, Steam running).
    pub steam: bool,
}

struct Clock {
    used_s: u64,
    limit_s: u64,
    last_active: Option<Instant>,
    saved_s: u64,
    steam_read: bool,
    /// Decided at launch (and by Steam's stat within STARTUP_GRACE_S), never later.
    locked: bool,
    started: Instant,
}

pub struct Demo {
    clock: Mutex<Clock>,
    path: Option<PathBuf>,
    #[cfg(feature = "steam")]
    steam: Option<steam::Stat>,
}

impl Demo {
    /// `dir`: where demo.json lives (None: memory only, as in the browser harness).
    pub fn new(dir: Option<PathBuf>) -> Self {
        // Debug builds only: shorten the limit to test the lock.
        #[cfg(debug_assertions)]
        let limit_s = std::env::var("PUPPET_DEMO_LIMIT_S").ok().and_then(|v| v.parse().ok()).unwrap_or(LIMIT_S);
        #[cfg(not(debug_assertions))]
        let limit_s = LIMIT_S;
        Self::with_limit(dir, limit_s)
    }

    fn with_limit(dir: Option<PathBuf>, limit_s: u64) -> Self {
        let path = dir.map(|d| d.join("demo.json"));
        let used_s = path.as_deref().map(load).unwrap_or(0);
        Demo {
            clock: Mutex::new(Clock {
                used_s,
                limit_s,
                last_active: None,
                saved_s: used_s,
                steam_read: false,
                locked: used_s >= limit_s,
                started: Instant::now(),
            }),
            path,
            #[cfg(feature = "steam")]
            steam: if ENABLED { steam::Stat::init() } else { None },
        }
    }

    /// Something the user is doing counts as use (stage heartbeat, output frame).
    pub fn touch(&self) {
        if let Ok(mut c) = self.clock.lock() {
            c.last_active = Some(Instant::now());
        }
    }

    /// Ok while the demo has time left (always, in the full app).
    pub fn check(&self) -> Result<(), String> {
        if ENABLED && self.status().locked {
            return Err(format!("{EXPIRED}: the 100 free hours are used up"));
        }
        Ok(())
    }

    pub fn status(&self) -> Status {
        let c = self.clock.lock().unwrap_or_else(|e| e.into_inner());
        Status {
            demo: ENABLED,
            used_s: c.used_s.min(c.limit_s),
            limit_s: c.limit_s,
            locked: ENABLED && c.locked,
            expired: ENABLED && c.used_s >= c.limit_s,
            steam: c.steam_read,
        }
    }

    /// Advance the clock by `dt` if there was use in the last ACTIVE_S, and
    /// save when due. Called by the ticker thread every TICK_S.
    fn tick(&self, now: Instant, dt: Duration) {
        let mut c = self.clock.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(feature = "steam")]
        if let Some(s) = &self.steam {
            s.pump();
            if !c.steam_read {
                if let Some(v) = s.read() {
                    c.used_s = c.used_s.max(v);
                    c.steam_read = true;
                    // Steam remembers hours a reinstall or another machine forgot.
                    if c.used_s >= c.limit_s && now.duration_since(c.started) < Duration::from_secs(STARTUP_GRACE_S) {
                        c.locked = true;
                    }
                }
            }
        }
        let active = c.last_active.is_some_and(|t| now.duration_since(t) < Duration::from_secs(ACTIVE_S));
        if active && c.used_s < c.limit_s {
            c.used_s = (c.used_s + dt.as_secs()).min(c.limit_s);
        }
        if c.used_s >= c.saved_s + SAVE_EVERY_S || (c.used_s >= c.limit_s && c.saved_s < c.limit_s) {
            self.save_locked(&mut c);
        }
    }

    /// Save now (on quit).
    pub fn flush(&self) {
        let mut c = self.clock.lock().unwrap_or_else(|e| e.into_inner());
        if c.used_s != c.saved_s {
            self.save_locked(&mut c);
        }
    }

    fn save_locked(&self, c: &mut Clock) {
        if let Some(p) = &self.path {
            if let Err(e) = save(p, c.used_s) {
                eprintln!("[vpuppet] demo: save failed: {e}");
                return;
            }
        }
        #[cfg(feature = "steam")]
        if let Some(s) = &self.steam {
            s.write(c.used_s);
        }
        c.saved_s = c.used_s;
    }
}

/// Run the clock on its own thread for the life of the app.
pub fn spawn_ticker(demo: std::sync::Arc<Demo>) {
    if !ENABLED {
        return;
    }
    std::thread::spawn(move || {
        let mut last = Instant::now();
        loop {
            std::thread::sleep(Duration::from_secs(TICK_S));
            let now = Instant::now();
            // A sleep across a system suspend is not use: cap the step.
            let dt = now.duration_since(last).min(Duration::from_secs(TICK_S));
            last = now;
            demo.tick(now, dt);
        }
    });
}

fn sign(used_s: u64) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(KEY).expect("any key length");
    m.update(format!("vpuppet-demo/1/{used_s}").as_bytes());
    m.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(serde::Deserialize)]
struct Record {
    used_s: u64,
    sig: String,
}

/// Missing: a fresh demo. Unreadable or wrongly signed: spent.
fn load(path: &Path) -> u64 {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return 0,
        Err(_) => return LIMIT_S,
    };
    match serde_json::from_str::<Record>(&text) {
        Ok(r) if r.sig == sign(r.used_s) => r.used_s,
        _ => LIMIT_S,
    }
}

/// Atomic: temp file, then rename over.
fn save(path: &Path, used_s: u64) -> std::io::Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    let json = serde_json::json!({ "v": 1, "used_s": used_s, "sig": sign(used_s) }).to_string();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

#[cfg(feature = "steam")]
mod steam {
    //! The Steamworks stat `demo_seconds` (INT, set by the client; configure
    //! it as "increment only" in Steamworks so it can never go down).
    const STAT: &str = "demo_seconds";

    pub struct Stat(steamworks::Client);

    impl Stat {
        /// None when Steam isn't running or the app ID isn't known (outside
        /// Steam, put `steam_appid.txt` with the demo's ID in the working dir).
        pub fn init() -> Option<Self> {
            match steamworks::Client::init() {
                Ok(c) => Some(Stat(c)),
                Err(e) => {
                    eprintln!("[vpuppet] demo: Steam not available ({e}); counting locally only");
                    None
                }
            }
        }

        pub fn pump(&self) {
            self.0.run_callbacks();
        }

        /// None until Steam has delivered the user's stats.
        pub fn read(&self) -> Option<u64> {
            self.0.user_stats().get_stat_i32(STAT).ok().map(|v| v.max(0) as u64)
        }

        pub fn write(&self, used_s: u64) {
            let us = self.0.user_stats();
            let _ = us.set_stat_i32(STAT, used_s.min(i32::MAX as u64) as i32);
            let _ = us.store_stats();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vpuppet-demo-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn record_round_trips_and_rejects_edits() {
        let d = tmp("sig");
        let p = d.join("demo.json");
        assert_eq!(load(&p), 0, "missing file is a fresh demo");
        save(&p, 1234).unwrap();
        assert_eq!(load(&p), 1234);
        let edited = std::fs::read_to_string(&p).unwrap().replace("1234", "1");
        std::fs::write(&p, edited).unwrap();
        assert_eq!(load(&p), LIMIT_S, "an edited record reads as spent");
        std::fs::write(&p, "garbage").unwrap();
        assert_eq!(load(&p), LIMIT_S);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clock_counts_only_while_active_and_locks_at_the_next_start() {
        let d = tmp("clock");
        let demo = Demo::with_limit(Some(d.clone()), 20);
        let t0 = Instant::now();
        let step = Duration::from_secs(TICK_S);
        demo.tick(t0, step);
        assert_eq!(demo.status().used_s, 0, "idle time is not use");
        demo.touch();
        demo.tick(Instant::now(), step);
        assert_eq!(demo.status().used_s, 5);
        for _ in 0..10 {
            demo.touch();
            demo.tick(Instant::now(), step);
        }
        let s = demo.status();
        assert_eq!(s.used_s, 20);
        // Used up mid-session: the session carries on, the next start is locked.
        assert_eq!(s.expired, ENABLED);
        assert!(!s.locked);
        assert!(demo.check().is_ok());
        // Hitting the limit saves right away.
        assert_eq!(load(&d.join("demo.json")), 20);
        let next = Demo::with_limit(Some(d.clone()), 20);
        assert_eq!(next.status().locked, ENABLED);
        assert_eq!(next.check().is_err(), ENABLED);
        // Use long ago doesn't count.
        let demo2 = Demo::new(None);
        demo2.clock.lock().unwrap().last_active = Some(t0);
        demo2.tick(t0 + Duration::from_secs(ACTIVE_S + 1), step);
        assert_eq!(demo2.status().used_s, 0);
        let _ = std::fs::remove_dir_all(&d);
    }
}

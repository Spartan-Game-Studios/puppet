# Testing VMC input against SlimeVR (virtual tracker rig)

This rig lets you test VPuppet's VMC receiver against a real SlimeVR-Server without owning any
SlimeVR trackers. It has three parts:

1. **SlimeVR-Server, headless.** It is built from source at a pinned commit and runs with no GUI.
   Its config comes from a generated `vrconfig.yml`.
2. **Fake IMU trackers** (`scripts/slimevr-fake-trackers.mjs`). They speak the same UDP protocol
   as SlimeVR firmware on port 6969 and stream scripted, deterministic motions at 100 Hz.
3. **SlimeVR's VMC output.** It is turned on and sent to `127.0.0.1:39539`, the usual VMC receiver
   port, or any port you choose.

```
fake trackers ──UDP 6969──▶ SlimeVR-Server ──VMC/OSC UDP 39539──▶ VPuppet (or slimevr-capture.mjs)
```

## Prerequisites

- Node 22 or newer. The scripts use no npm dependencies.
- `git` and `tar`. You don't need Java installed, because `setup` downloads a portable JDK.
- Network access the first time, for the JDK (about 190 MB), the SlimeVR source and the Gradle
  dependencies (about 400 MB).
- Free ports: UDP 6969 (trackers), TCP 21110 (SlimeVR's WebSocket/SolarXR API), UDP 39540 (the
  SlimeVR VMC *input*, which the server always binds when VMC is on; change it with `--vmc-in`),
  and the VMC output port on the receiving side. Quit any real SlimeVR install first.

Everything is downloaded into a **rig directory**. That is `$SLIMEVR_RIG_DIR` if set, otherwise
`--dir <path>`, otherwise `~/.cache/vpuppet-slimevr`. Nothing goes into the repo:

| Path | What |
|---|---|
| `jdk/` | Eclipse Temurin **JDK 17** (`server/desktop/build.gradle.kts` uses `jvmToolchain(17)`). The latest 17 GA build comes from the Adoptium API and its sha256 is checked. |
| `jdk-download/` | The JDK tarball |
| `SlimeVR-Server/` | Source at commit `83941fd38e91` (v21.1.0-9-g83941fd, 2026-09-18), plus the `solarxr-protocol` submodule |
| `gradle-home/` | Gradle cache (`GRADLE_USER_HOME`) |
| `run/` | Server working directory. It holds `config/` (marker), `vrconfig.yml`, `server.log`, `trackers.log`, and `Library/Logs/...`, because `HOME` is pointed here so SlimeVR's own log folder stays in the rig. |
| `rig.json` | PIDs of a detached rig |

## Commands

```sh
export SLIMEVR_RIG_DIR=~/.cache/vpuppet-slimevr   # optional

node scripts/slimevr-rig.mjs setup               # JDK + clone + gradle :server:desktop:shadowJar (~2 min)
node scripts/slimevr-rig.mjs setup --release     # or: JDK + the released v21.1.0 slimevr.jar, no build

node scripts/slimevr-rig.mjs up                  # foreground; Ctrl-C stops server and trackers
#   type idle | sit | walk | lean | squat (+Enter) to switch motion live, "reset" for a full reset
node scripts/slimevr-rig.mjs up --detach --motion walk:5,sit:5 --vmc-port 39539
node scripts/slimevr-rig.mjs status
node scripts/slimevr-rig.mjs down                # stops a detached rig (SIGTERM, then SIGKILL after 5 s)

node scripts/slimevr-rig.mjs fixtures            # re-record scripts/fixtures/slimevr-<motion>.jsonl
node scripts/slimevr-capture.mjs --port 39539 --seconds 5 [--out x.jsonl]  # capture + summary
node scripts/vmc-listen.mjs 39539 5              # quick message counts (existing tool)
```

Options for `up` and `fixtures`:

| Option | Default | Meaning |
|---|---|---|
| `--vmc-port` / `--vmc-host` | 39539 / 127.0.0.1 | Where SlimeVR sends VMC |
| `--vmc-in` | 39540 | SlimeVR's own VMC receiver port, which it binds |
| `--motion` | idle | `m[:secs],m[:secs]...`. A sequence loops with a 1 s blend between motions. |
| `--trackers` | 6 | 6 = chest, hip, both upper legs, both lower legs ("ankle" trackers sit on the shin in SlimeVR). 8 adds feet. 10 also adds upper arms. |
| `--mounted` | off | Sends the IMU rotation tilted the way a strapped-on tracker would be. This only comes out right after the full reset, which exercises SlimeVR's reset path. |
| `--vrm` / `--no-vrm` | `test-assets/cc0/devil.vrm` | The model whose proportions SlimeVR uses for its VMC output (see below) |
| `--filter` | prediction | SlimeVR rotation filter: `prediction`, `smoothing` or `none` (SlimeVR's default is prediction, amount 0.2) |
| `--anchor-head` | off | VMC "anchor at head" instead of SlimeVR's default, "anchor at hip". Not useful without an HMD (see below). |
| `fixtures --seconds/--keep-hz/--motions/--suffix/--out` | 5 / 30 / all / "" / `scripts/fixtures` | Capture length, decimation, which motions, file suffix, output folder |

The fake trackers can also run on their own: `node scripts/slimevr-fake-trackers.mjs --help`
(see the file header). `--print <secs>` prints the exact poses as JSON lines without opening a
network connection, so tests can use it.

## Pointing the rig at VPuppet

1. Start VPuppet and enable its VMC input on port 39539, the conventional VMC port.
2. `node scripts/slimevr-rig.mjs up` (or `--vmc-port <n>` to match VPuppet).
3. SlimeVR streams continuously, about 240 bundles/s, with `/VMC/Ext/OK 1` in every bundle. The
   avatar holds the standing pose first. The motion begins about 2 s after the trackers connect:
   1.5 s standing, then the full reset, then 0.7 s more.

`fixtures` binds the VMC port itself to capture. Close VPuppet, or use another port, while
recording.

## What SlimeVR sends over VMC (measured at commit 83941fd)

Source: `server/core/src/main/java/dev/slimevr/osc/VMCHandler.kt`.

- **One OSC bundle per server tick, about 240 bundles/s.** The code gates at more than 3 ms
  (the comment says "200hz to not crash VSF"), but in practice it runs at about 240 Hz. This does
  not depend on the 100 Hz tracker rate. Every bundle contains, in this order:
  1. `/VMC/Ext/T  ,f  [secondsSinceServerStart]`
  2. `/VMC/Ext/OK ,i  [1]`. There is only one argument, not the 3- or 5-argument form, and it is
     always 1 once the skeleton exists.
  3. `/VMC/Ext/Root/Pos ,sfffffff ["root", 0,0,0, 0,0,0,-1]`. This is always the origin, with the
     identity rotation written as **w = -1**.
  4. 20 × `/VMC/Ext/Bone/Pos ,sfffffff [name, px,py,pz, qx,qy,qz,qw]`, always in this order:
     `Hips, LeftUpperLeg, RightUpperLeg, LeftLowerLeg, RightLowerLeg, LeftFoot, RightFoot, Spine,
     Chest, UpperChest, Neck, Head, LeftShoulder, RightShoulder, LeftUpperArm, RightUpperArm,
     LeftLowerArm, RightLowerArm, LeftHand, RightHand`. Finger bones are sent only when finger
     trackers exist. Arm bones are skipped when an arm is tracked from a controller. There are no
     eyes, jaw or toes.
  5. "Computed tracker" messages for SlimeVR's virtual trackers:
     `/VMC/Ext/Hmd/Pos ["human://HEAD", …]`,
     8 × `/VMC/Ext/Tra/Pos` (`human://CHEST, WAIST, LEFT_KNEE, RIGHT_KNEE, LEFT_FOOT, RIGHT_FOOT,
     LEFT_ELBOW, RIGHT_ELBOW`) and 2 × `/VMC/Ext/Con/Pos` (`human://LEFT_HAND, RIGHT_HAND`).
     These carry **global** positions and rotations in SlimeVR's skeleton space. With no HMD, that
     space is rooted at the head (head = 0,0,0, feet at about y = -1.48), not at the floor. A
     receiver that only does avatar bones can ignore them.
- There are **no blend shapes**: no `/VMC/Ext/Blend/*`, no `/VMC/Ext/Blend/Apply`. There is also
  no `/VMC/Ext/Rvc`, `/VMC/Ext/Remote` or `/VMC/Ext/Cam`.
- **Bone rotations are local** to the parent bone in the Unity humanoid hierarchy.
  `Hips` is the root, so its rotation is global. Positions are **local translations taken from
  the VRM's node offsets**. `Hips` gets the VRM hip height (0.767 m for `devil.vrm`) plus the
  average upper-leg offset. These translations are fixed per model.
- **Coordinates are Unity's**: left-handed, +Y up, the avatar faces +Z, and its left is -X.
  SlimeVR converts from its right-handed frame by negating z and w: `(x, y, -z, -w)`. As a
  result, **almost every quaternion has a negative w**. That is the same rotation, but a receiver
  that compares or interpolates quaternions must handle the double cover (`q ≡ -q`).
- **The rest pose is the VRM/Unity T-pose.** Identity means the normalised T-pose. SlimeVR's
  own rest pose is standing with arms down, so at rest `LeftUpperArm` is about 90° about +Z
  (`[0,0,-0.707,-0.707]`) and `RightUpperArm` is about -90°.
- **Sign conventions** (Unity frame, measured from the fixtures):
  - Leaning the upper body forward is a positive X rotation on Hips and Spine.
  - Lifting the thigh forward is a negative X rotation on UpperLeg.
  - Bending the knee is a negative X rotation on LowerLeg.
  - Leaning to the avatar's left is a positive Z rotation.
- **There is no positional tracking without an HMD or other positional trackers.** In the
  default "anchor at hip" mode, `Hips` stays at the VRM hip height and moves only a few mm.
  A squat bends the legs but **the hips don't drop**. With `--anchor-head` the hip position is
  computed below a head fixed at the origin, so it floats at about y = -0.43 and *rises* during
  a squat. Both are artefacts of having no HMD, not bugs in the rig.
- **A VRM is needed for useful positions.** With `--no-vrm` (no `vmc.vrmJson`), every bone
  translation, Hips included, is `0,0,0`. Only the rotations are meaningful then. In the real
  app the user picks a VRM in the SlimeVR GUI, and the GUI sends the JSON chunk of the glTF.
  The rig writes that JSON chunk into `vmc.vrmJson` itself. The server's `VRMReader` handles both
  VRM 0.x (`extensions.VRM`) and 1.0 (`VRMC_vrm`). `devil.vrm` is 0.x, and only 0.x was tested.
- **Feet** are identity relative to the lower leg unless foot trackers exist (`--trackers 8`).
  The Neck, Head, shoulders and arms barely move with 6 trackers. SlimeVR derives the
  spine/chest split from the chest and hip trackers.
- With no receiver listening, the server logs `PortUnreachableException` warnings. These are
  harmless, and it keeps sending.

## Fixture format (`scripts/fixtures/slimevr-<motion>.jsonl`)

There is one file per motion: `idle`, `sit`, `walk`, `lean` and `squat`. Each holds 5 s,
starting at the moment the motion begins, which is right after the full reset. Each motion eases
in from standing over its first second. The format is JSON Lines:

```jsonc
// line 1: metadata
{"meta": {"format": "vpuppet-vmc-capture/1", "port": 39539, "seconds": 5, "startedAt": "…",
          "datagrams": 1195, "datagramsPerSecond": 239, "keptDatagrams": 144, "keepHz": 30,
          "source": "…", "slimevrVersion": "83941fd3", "slimevrCommit": "83941fd3…",
          "motion": "walk", "motionStartsAt": 0, "trackers": ["body:chest", …], "mounted": false,
          "vrm": "test-assets/cc0/devil.vrm", "filter": "prediction", "anchorHip": true}}
// then one line per OSC message, in arrival order
{"t": 0.034, "d": 8, "address": "/VMC/Ext/Bone/Pos", "types": ",sfffffff",
 "args": ["Hips", 0, 0.766402, -0.003501, -0.036919, 0.002584, -0.06979, -0.996875]}
```

- `t`: seconds since the capture started. It is the receive time of the datagram, with ms
  resolution. All messages in one datagram share it.
- `d`: datagram index in the original stream. Messages with the same `d` came in one OSC bundle,
  so together they are one complete SlimeVR frame. To keep the files small (about 650 KB each),
  fixtures keep **whole bundles at about 30 Hz** (`keepHz`), so `d` has gaps. The live stream is
  about 240 bundles/s (`datagramsPerSecond`). Re-record with `--keep-hz 0` for every bundle,
  which is about 3 MB per 3 s.
- `types`: the OSC type-tag string, so a replay can send ints (`/VMC/Ext/OK ,i`) as ints.
- `args`: the OSC arguments. Floats are rounded to 6 decimals.

Replaying a fixture means grouping lines by `d` and sending each group as one bundle at its `t`.

What each motion should do to the bones (all rotations local, Unity frame):

| Motion | What happens | Peak per-bone change in the fixture |
|---|---|---|
| idle | Breathing and a slight sway | about 2–3° |
| sit | Seated at a desk: thighs horizontal, shins vertical, leaning forward 12°, one foot tapping | UpperLeg about 80°, LowerLeg about 88°, Spine about 16°, Hips 8° |
| walk | Marching in place at 1 step/s, alternating legs, hip and chest counter-twist | UpperLeg about 46°, LowerLeg about 76°, Hips about 5° |
| lean | Side to side ±20° (0.2 Hz) plus forward and back ±15° (0.1 Hz) | Hips about 9°, Spine about 10° |
| squat | Down and up every 4 s, bottom at t = 2 s | UpperLeg about 115°, LowerLeg about 120°, Hips 30° |

## How the tracker emulation works

The server side is in `server/core/.../tracking/trackers/udp/` (`TrackersUDPServer.kt`,
`UDPProtocolParser.kt`, `UDPPacket.kt`). The firmware side is in SlimeVR-Tracker-ESP
`src/network/connection.cpp`. The protocol is the extended owoTrack protocol. All values are
big-endian. Every packet from a tracker to the server starts with `i32 type, i64 packetNumber`,
and the packet number must strictly increase per device.

1. **Handshake (type 3).** It carries the board, IMU and MCU type, three legacy ints, the protocol
   version (we send 22), the firmware string and a 6-byte MAC. The server answers with a raw
   `0x03 "Hey OVR =D 5"`. **It only accepts MACs listed in `vrconfig.yml` `knownDevices`.** Other
   MACs get an "unknown device" prompt in the GUI and no reply, so the rig lists the fake MACs
   `5A:1E:00:00:00:01…`. Each tracker is its own device on its own UDP socket, like a real
   single-IMU tracker.
2. **Sensor info (type 15).** It gives the sensor id, status, IMU type, sensor config, the
   rest-calibration flag, the **tracker position** and the data type. The server acks with
   `i32 15, u8 id, u8 status`. Protocol 9 and later wait for this packet before creating the
   tracker.
3. **Rotation (type 17).** `u8 sensorId, u8 dataType=1, f32 x,y,z,w, u8 accuracy` is sent at
   100 Hz. Battery (type 12) goes out every 5 s. Pings (type 10) are echoed. The server times a
   device out after 1 s of silence. The fake trackers handshake again if the server goes quiet.
4. **Body positions.** These come from `vrconfig.yml` `trackers["udp://<MAC>/0"].designation`
   (for example `body:left_upper_leg`) and are also sent in the sensor info packet. Mounting
   orientation is set to identity. SlimeVR's default for new trackers is a 180° "back" mounting,
   which would mirror front and back.
5. **Axes.** The server multiplies every IMU quaternion by `AXES_OFFSET` (-90° about X), so the
   fake trackers send `AXES_OFFSET⁻¹ · q`. Inside the server the tracker then reads exactly `q`,
   the body part's global rotation relative to standing, in SlimeVR's frame: +Y up, facing -Z.
6. **Full reset.** After 1.5 s of standing still, tracker 0 sends a *user action* packet
   (type 21, value 2 = full reset). This is what the button on a real tracker does.
   `resetsConfig.fullResetDelay` is 0, so it happens immediately. SlimeVR takes the current pose
   as "standing straight". With `--mounted` this is what cancels the strap tilt.

No GUI or WebSocket calls are needed. The server is configured entirely by the generated
`vrconfig.yml` before launch. YAML is a superset of JSON, so the rig writes JSON. The `config/`
folder in the working directory makes SlimeVR use `./vrconfig.yml` instead of
`~/Library/Application Support/dev.slimevr.SlimeVR/`. The desktop jar's `run` command has no
window of its own (the GUI is a separate app), and the rig also passes `-Djava.awt.headless=true`.

## Emulated vs real

The fake trackers are *ideal* IMUs. Real ones differ in these ways:

- **No yaw drift, noise or magnetometer.** Real 6-axis IMUs drift in yaw over minutes. The user
  then has to yaw-reset, or turn on drift compensation or "Stay Aligned". Here, drift
  compensation is off and the rotations are noise-free floats.
- **Mounting is perfect.** The default identity mounting is exact. `--mounted` adds a
  pitch/roll-only strap angle, which a full reset removes exactly. Real trackers also have a yaw
  mounting error, so users have to run a *mounting reset* (squat-style calibration). The rig
  never does one.
- **The same latency for every tracker.** All trackers share one 100 Hz clock over loopback. Real
  ones run at 100–200+ Hz each over WiFi, with jitter, packet loss and occasional reconnects.
- **No acceleration.** Rotation-only packets (17) are sent, not type 23 with acceleration. Leg
  tweaks and the skeleton still work, but anything that depends on acceleration, such as tap
  detection or some floor-clip heuristics, sees zeros.
- **No HMD**, which is normal for a VTuber setup. So there is no positional data (see above).
- **Motions are kinematically simple**: sine waves on hand-picked joint angles. They are a test
  signal, not motion capture.

## When real trackers arrive

1. Install the SlimeVR app (server and GUI) normally and pair the trackers. Pick body positions in
   the GUI and do the full reset and mounting calibration there.
2. In SlimeVR: *Settings → OSC → VMC*. Enable it, set the address to 127.0.0.1 (or VPuppet's PC)
   and the port to VPuppet's VMC port (39539). Pick the same VRM you use in VPuppet under
   "VRM model" so the bone offsets match. Leave "Anchor at hips" on unless you have an HMD.
3. Check the stream with `node scripts/slimevr-capture.mjs --port 39539`. The bone list and order
   should match the fixtures. Expect yaw drift over time, and jitter that the fixtures don't have.
4. Record a real capture with `node scripts/slimevr-capture.mjs --seconds 5 --keep-hz 30 --out
   scripts/fixtures/slimevr-real-<motion>.jsonl`. Add `--meta '{"motion":"sit"}'` to note what
   you did. The format is identical, so tests can use real and synthetic fixtures side by side.
5. Stop the rig (or never start it): it uses the same ports (6969, 21110) as a real SlimeVR install.

// Puppet Virtual Camera: CoreMediaIO Camera Extension (macOS 12.3+).
//
// One device, "Puppet Virtual Camera", with two streams:
//   - a SINK stream the Puppet app writes BGRA frames into (through the CMIO
//     C API, see src-tauri/macos/bridge/PuppetVCamBridge.m), and
//   - a SOURCE stream that Zoom, Meet, Discord, FaceTime etc. read.
// Every frame consumed from the sink is forwarded to the source (scaled with
// vImage if the client picked the other resolution).
//
// The device exists only while Puppet is running with its camera output on.
// The app announces itself with a Darwin notification heartbeat (see
// PRESENCE_NOTIFY and pvc_presence in PuppetVCamBridge.m): the provider adds
// the device on the first beat and removes it when the app says "off" (camera
// toggled off, app quit) or when beats stop for PRESENCE_TIMEOUT (app crashed
// or was killed). Between the device appearing and the first frame, or if
// frames stall, clients see a "PUPPET / WAITING FOR FRAMES" card.
//
// Written from Apple's CoreMediaIO headers; no third-party code.

import Accelerate
import CoreGraphics
import CoreMediaIO
import CoreText
import CoreVideo
import Foundation
import IOKit.audio
import notify
import os.log

// Must match PVC_DEVICE_UUID / PVC_DEVICE_NAME in PuppetVCamBridge.m.
let DEVICE_UUID = UUID(uuidString: "6A3B1E0C-4F7D-4E8A-9C21-5B0D7E2F9A41")!
let DEVICE_NAME = "Puppet Virtual Camera"
let SOURCE_STREAM_UUID = UUID(uuidString: "0C9E5B7A-2D41-4C3F-8E6A-1F2B3C4D5E60")!
let SINK_STREAM_UUID = UUID(uuidString: "7D1F2A3B-5C6E-4F80-9A1B-2C3D4E5F6071")!
// Must match PVC_PRESENCE_NOTIFY in PuppetVCamBridge.m. The notification's
// state is a beat counter while Puppet's camera output is on, 0 when it is off.
let PRESENCE_NOTIFY = "com.spartangamestudios.puppet.camera.presence"
/// No beat (or frame) for this long: Puppet is gone, remove the device.
let PRESENCE_TIMEOUT_NS: UInt64 = 3_500_000_000
let FPS: Int32 = 30
let SIZES: [(Int32, Int32)] = [(1280, 720), (1920, 1080)]

let log = Logger(subsystem: "com.spartangamestudios.puppet.camera", category: "extension")

func makeFormats() -> [CMIOExtensionStreamFormat] {
    SIZES.map { (w, h) in
        var desc: CMFormatDescription?
        CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault, codecType: kCVPixelFormatType_32BGRA,
                                       width: w, height: h, extensions: nil, formatDescriptionOut: &desc)
        let d = CMTime(value: 1, timescale: FPS)
        return CMIOExtensionStreamFormat(formatDescription: desc!, maxFrameDuration: d, minFrameDuration: d, validFrameDurations: nil)
    }
}

func hostTimeNanos() -> UInt64 {
    let t = CMClockGetTime(CMClockGetHostTimeClock())
    return UInt64(max(0, CMTimeGetSeconds(t)) * Double(NSEC_PER_SEC))
}

// MARK: - Device

final class DeviceSource: NSObject, CMIOExtensionDeviceSource {
    private(set) var device: CMIOExtensionDevice!
    private var sourceStream: StreamSource!
    private var sinkStream: SinkSource!
    private let queue = DispatchQueue(label: "puppet.camera.device", qos: .userInteractive)

    private var timer: DispatchSourceTimer?
    private var sourceRunning = 0
    private var lastFrameAt: UInt64 = 0
    private var pools: [Int: CVPixelBufferPool] = [:]
    private var placeholders: [Int: CVPixelBuffer] = [:]

    override init() {
        super.init()
        device = CMIOExtensionDevice(localizedName: DEVICE_NAME, deviceID: DEVICE_UUID, legacyDeviceID: nil, source: self)
        let formats = makeFormats()
        sourceStream = StreamSource(name: "Puppet Video", id: SOURCE_STREAM_UUID, formats: formats, device: self)
        sinkStream = SinkSource(name: "Puppet Input", id: SINK_STREAM_UUID, formats: formats, device: self)
        do {
            try device.addStream(sourceStream.stream)
            try device.addStream(sinkStream.stream)
        } catch {
            log.error("addStream failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.deviceTransportType, .deviceModel]
    }

    func deviceProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionDeviceProperties {
        let p = CMIOExtensionDeviceProperties(dictionary: [:])
        if properties.contains(.deviceTransportType) { p.transportType = kIOAudioDeviceTransportTypeVirtual }
        if properties.contains(.deviceModel) { p.model = "Puppet" }
        return p
    }

    func setDeviceProperties(_ deviceProperties: CMIOExtensionDeviceProperties) throws {}

    // MARK: source side (clients)

    func sourceStarted() {
        queue.async {
            self.sourceRunning += 1
            if self.timer != nil { return }
            let t = DispatchSource.makeTimerSource(queue: self.queue)
            t.schedule(deadline: .now(), repeating: .nanoseconds(Int(1_000_000_000 / Int(FPS))), leeway: .milliseconds(2))
            t.setEventHandler { [weak self] in self?.placeholderTick() }
            t.resume()
            self.timer = t
        }
    }

    /// The device was taken off the provider: stop feeding clients.
    func deviceRemoved() {
        queue.async {
            self.sourceRunning = 0
            self.timer?.cancel()
            self.timer = nil
        }
    }

    /// Host time of the last frame from the app (0 = none yet).
    var lastFrameHostNanos: UInt64 { queue.sync { lastFrameAt } }

    func sourceStopped() {
        queue.async {
            self.sourceRunning = max(0, self.sourceRunning - 1)
            if self.sourceRunning == 0 {
                self.timer?.cancel()
                self.timer = nil
            }
        }
    }

    /// Keep clients fed while frames are not arriving (a "waiting" card).
    private func placeholderTick() {
        let now = hostTimeNanos()
        if now - lastFrameAt < 250_000_000 { return }
        let (w, h) = sourceStream.activeSize
        guard let pb = placeholder(w, h) else { return }
        send(pb, at: now)
    }

    // MARK: sink side (the Puppet app)

    /// A frame from the app: forward it to the source stream.
    func deliver(_ sbuf: CMSampleBuffer) {
        queue.async {
            guard self.sourceRunning > 0, let src = CMSampleBufferGetImageBuffer(sbuf) else { return }
            let (w, h) = self.sourceStream.activeSize
            let out: CVPixelBuffer
            if CVPixelBufferGetWidth(src) == w && CVPixelBufferGetHeight(src) == h
                && CVPixelBufferGetPixelFormatType(src) == kCVPixelFormatType_32BGRA {
                out = src
            } else if let scaled = self.scale(src, w, h) {
                out = scaled
            } else {
                return
            }
            let now = hostTimeNanos()
            self.lastFrameAt = now
            self.send(out, at: now)
        }
    }

    private func send(_ pb: CVPixelBuffer, at hostNanos: UInt64) {
        var fmt: CMFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescriptionOut: &fmt) == noErr,
              let fmt else { return }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: FPS),
            presentationTimeStamp: CMTime(value: CMTimeValue(hostNanos), timescale: CMTimeScale(NSEC_PER_SEC)),
            decodeTimeStamp: .invalid)
        var sb: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: pb, formatDescription: fmt,
                                                       sampleTiming: &timing, sampleBufferOut: &sb) == noErr,
              let sb else { return }
        sourceStream.stream.send(sb, discontinuity: [], hostTimeInNanoseconds: hostNanos)
    }

    private func pool(_ w: Int, _ h: Int) -> CVPixelBufferPool? {
        let key = w << 16 | h
        if let p = pools[key] { return p }
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: w,
            kCVPixelBufferHeightKey as String: h,
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ]
        var p: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &p)
        pools[key] = p
        return p
    }

    private func newBuffer(_ w: Int, _ h: Int) -> CVPixelBuffer? {
        guard let p = pool(w, h) else { return nil }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, p, &pb)
        return pb
    }

    private func placeholder(_ w: Int, _ h: Int) -> CVPixelBuffer? {
        let key = w << 16 | h
        if let pb = placeholders[key] { return pb }
        guard let pb = newBuffer(w, h) else { return nil }
        CVPixelBufferLockBaseAddress(pb, [])
        if let base = CVPixelBufferGetBaseAddress(pb) {
            // Near-black (#101010) with a label, so a stalled feed reads as Puppet's, not a broken camera.
            memset(base, 0x10, CVPixelBufferGetBytesPerRow(pb) * h)
            drawCard(base, w, h, CVPixelBufferGetBytesPerRow(pb))
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        placeholders[key] = pb
        return pb
    }

    /// "PUPPET" over "WAITING FOR FRAMES", centred, in the app's monospace style.
    private func drawCard(_ base: UnsafeMutableRawPointer, _ w: Int, _ h: Int, _ rowBytes: Int) {
        let info = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        guard let ctx = CGContext(data: base, width: w, height: h, bitsPerComponent: 8, bytesPerRow: rowBytes,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: info) else { return }
        let unit = CGFloat(h) / 720
        func line(_ text: String, size: CGFloat, alpha: CGFloat, y: CGFloat) {
            let font = CTFontCreateWithName("Menlo-Bold" as CFString, size * unit, nil)
            let attrs: [NSAttributedString.Key: Any] = [
                NSAttributedString.Key(kCTFontAttributeName as String): font,
                NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0.92, alpha: alpha),
            ]
            let l = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
            let width = CTLineGetTypographicBounds(l, nil, nil, nil)
            ctx.textPosition = CGPoint(x: (CGFloat(w) - CGFloat(width)) / 2, y: y * unit)
            CTLineDraw(l, ctx)
        }
        // Bitmap contexts map memory row 0 to the top, so y counts up from the bottom edge as usual.
        line("PUPPET", size: 72, alpha: 1, y: 380)
        line("WAITING FOR FRAMES", size: 24, alpha: 0.6, y: 320)
    }

    private func scale(_ src: CVPixelBuffer, _ w: Int, _ h: Int) -> CVPixelBuffer? {
        guard CVPixelBufferGetPixelFormatType(src) == kCVPixelFormatType_32BGRA, let dst = newBuffer(w, h) else { return nil }
        CVPixelBufferLockBaseAddress(src, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
        }
        var s = vImage_Buffer(data: CVPixelBufferGetBaseAddress(src), height: vImagePixelCount(CVPixelBufferGetHeight(src)),
                              width: vImagePixelCount(CVPixelBufferGetWidth(src)), rowBytes: CVPixelBufferGetBytesPerRow(src))
        var d = vImage_Buffer(data: CVPixelBufferGetBaseAddress(dst), height: vImagePixelCount(h),
                              width: vImagePixelCount(w), rowBytes: CVPixelBufferGetBytesPerRow(dst))
        return vImageScale_ARGB8888(&s, &d, nil, vImage_Flags(kvImageNoFlags)) == kvImageNoError ? dst : nil
    }
}

// MARK: - Source stream (what video apps read)

final class StreamSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    let formats: [CMIOExtensionStreamFormat]
    private weak var device: DeviceSource?
    private var activeIndex = 0

    init(name: String, id: UUID, formats: [CMIOExtensionStreamFormat], device: DeviceSource) {
        self.formats = formats
        self.device = device
        super.init()
        stream = CMIOExtensionStream(localizedName: name, streamID: id, direction: .source, clockType: .hostTime, source: self)
    }

    var activeSize: (Int, Int) {
        let (w, h) = SIZES[activeIndex]
        return (Int(w), Int(h))
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration]
    }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let p = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { p.activeFormatIndex = activeIndex }
        if properties.contains(.streamFrameDuration) { p.frameDuration = CMTime(value: 1, timescale: FPS) }
        return p
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let i = streamProperties.activeFormatIndex, i >= 0, i < formats.count { activeIndex = i }
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool { true }

    func startStream() throws { device?.sourceStarted() }

    func stopStream() throws { device?.sourceStopped() }
}

// MARK: - Sink stream (what the Puppet app writes)

final class SinkSource: NSObject, CMIOExtensionStreamSource {
    private(set) var stream: CMIOExtensionStream!
    let formats: [CMIOExtensionStreamFormat]
    private weak var device: DeviceSource?
    private var activeIndex = 0
    private var client: CMIOExtensionClient?
    private var running = false
    private let queue = DispatchQueue(label: "puppet.camera.sink", qos: .userInteractive)

    init(name: String, id: UUID, formats: [CMIOExtensionStreamFormat], device: DeviceSource) {
        self.formats = formats
        self.device = device
        super.init()
        stream = CMIOExtensionStream(localizedName: name, streamID: id, direction: .sink, clockType: .hostTime, source: self)
    }

    var availableProperties: Set<CMIOExtensionProperty> {
        [.streamActiveFormatIndex, .streamFrameDuration, .streamSinkBufferQueueSize,
         .streamSinkBuffersRequiredForStartup, .streamSinkBufferUnderrunCount, .streamSinkEndOfData]
    }

    func streamProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionStreamProperties {
        let p = CMIOExtensionStreamProperties(dictionary: [:])
        if properties.contains(.streamActiveFormatIndex) { p.activeFormatIndex = activeIndex }
        if properties.contains(.streamFrameDuration) { p.frameDuration = CMTime(value: 1, timescale: FPS) }
        if properties.contains(.streamSinkBufferQueueSize) { p.sinkBufferQueueSize = 2 }
        if properties.contains(.streamSinkBuffersRequiredForStartup) { p.sinkBuffersRequiredForStartup = 1 }
        if properties.contains(.streamSinkBufferUnderrunCount) { p.sinkBufferUnderrunCount = 0 }
        if properties.contains(.streamSinkEndOfData) { p.sinkEndOfData = 0 }
        return p
    }

    func setStreamProperties(_ streamProperties: CMIOExtensionStreamProperties) throws {
        if let i = streamProperties.activeFormatIndex, i >= 0, i < formats.count { activeIndex = i }
    }

    func authorizedToStartStream(for client: CMIOExtensionClient) -> Bool {
        // Only one writer at a time.
        queue.sync { self.client = client }
        return true
    }

    func startStream() throws {
        queue.async {
            self.running = true
            self.consume()
        }
    }

    func stopStream() throws {
        queue.async {
            self.running = false
            self.client = nil
        }
    }

    private func consume() {
        guard running, let client else { return }
        stream.consumeSampleBuffer(from: client) { [weak self] sbuf, seq, _, hasMore, _ in
            guard let self else { return }
            if let sbuf {
                self.device?.deliver(sbuf)
                let out = CMIOExtensionScheduledOutput(sequenceNumber: seq, hostTimeInNanoseconds: hostTimeNanos())
                self.stream.notifyScheduledOutputChanged(out)
            }
            // Poll again right away if more is queued, else after ~a quarter frame.
            let delay: DispatchTimeInterval = hasMore ? .nanoseconds(0) : .milliseconds(8)
            self.queue.asyncAfter(deadline: .now() + delay) { self.consume() }
        }
    }
}

// MARK: - Provider

/// Adds the device while Puppet is alive (heartbeat), removes it otherwise.
final class ProviderSource: NSObject, CMIOExtensionProviderSource {
    private(set) var provider: CMIOExtensionProvider!
    private var deviceSource: DeviceSource!
    private let presenceQueue = DispatchQueue(label: "puppet.camera.presence", qos: .userInitiated)
    private var token: Int32 = NOTIFY_TOKEN_INVALID
    private var poll: DispatchSourceTimer?
    private var lastState: UInt64 = 0
    private var lastBeat: UInt64 = 0
    private var present = false

    init(clientQueue: DispatchQueue?) {
        super.init()
        provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
        deviceSource = DeviceSource()
        presenceQueue.async { self.startPresence() }
    }

    private func startPresence() {
        let st = notify_register_dispatch(PRESENCE_NOTIFY, &token, presenceQueue) { [weak self] _ in
            self?.check(posted: true)
        }
        if st != NOTIFY_STATUS_OK {
            // Without the heartbeat channel, fall back to an always-present device.
            log.error("notify_register_dispatch failed (\(st)); device stays present")
            setPresent(true)
            return
        }
        // A stale non-zero state from a crashed app must not bring the device
        // back: only a change (or a post) after start counts as a beat.
        var s: UInt64 = 0
        notify_get_state(token, &s)
        lastState = s
        let t = DispatchSource.makeTimerSource(queue: presenceQueue)
        t.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500), leeway: .milliseconds(50))
        t.setEventHandler { [weak self] in self?.check(posted: false) }
        t.resume()
        poll = t
    }

    /// On a post, or every 500 ms: read the beat counter and decide.
    private func check(posted: Bool) {
        var s: UInt64 = 0
        notify_get_state(token, &s)
        let now = hostTimeNanos()
        if s == 0 {
            if posted || lastState != 0 { setPresent(false) }
        } else if posted || s != lastState {
            lastBeat = now
            setPresent(true)
        }
        lastState = s
        if present {
            // Frames count as beats too (a busy app may post late).
            let beat = max(lastBeat, deviceSource.lastFrameHostNanos)
            if now > beat && now - beat > PRESENCE_TIMEOUT_NS { setPresent(false) }
        }
    }

    private func setPresent(_ on: Bool) {
        guard on != present else { return }
        do {
            if on {
                try provider.addDevice(deviceSource.device)
            } else {
                try provider.removeDevice(deviceSource.device)
                deviceSource.deviceRemoved()
            }
            present = on
            log.info("device \(on ? "added" : "removed", privacy: .public)")
        } catch {
            log.error("\(on ? "addDevice" : "removeDevice", privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func connect(to client: CMIOExtensionClient) throws {}

    func disconnect(from client: CMIOExtensionClient) {}

    var availableProperties: Set<CMIOExtensionProperty> {
        [.providerManufacturer]
    }

    func providerProperties(forProperties properties: Set<CMIOExtensionProperty>) throws -> CMIOExtensionProviderProperties {
        let p = CMIOExtensionProviderProperties(dictionary: [:])
        if properties.contains(.providerManufacturer) { p.manufacturer = "Spartan Game Studios" }
        return p
    }

    func setProviderProperties(_ providerProperties: CMIOExtensionProviderProperties) throws {}
}

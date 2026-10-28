// Puppet Virtual Camera: CoreMediaIO Camera Extension (macOS 12.3+).
//
// One device, "Puppet Virtual Camera", with two streams:
//   - a SINK stream the Puppet app writes BGRA frames into (through the CMIO
//     C API, see src-tauri/macos/bridge/PuppetVCamBridge.m), and
//   - a SOURCE stream that Zoom, Meet, Discord, FaceTime etc. read.
// Every frame consumed from the sink is forwarded to the source (scaled with
// vImage if the client picked the other resolution). When Puppet is not
// sending, the source shows a plain dark frame.
//
// Written from Apple's CoreMediaIO headers; no third-party code.

import Accelerate
import CoreMediaIO
import CoreVideo
import Foundation
import IOKit.audio
import os.log

// Must match PVC_DEVICE_UUID / PVC_DEVICE_NAME in PuppetVCamBridge.m.
let DEVICE_UUID = UUID(uuidString: "6A3B1E0C-4F7D-4E8A-9C21-5B0D7E2F9A41")!
let DEVICE_NAME = "Puppet Virtual Camera"
let SOURCE_STREAM_UUID = UUID(uuidString: "0C9E5B7A-2D41-4C3F-8E6A-1F2B3C4D5E60")!
let SINK_STREAM_UUID = UUID(uuidString: "7D1F2A3B-5C6E-4F80-9A1B-2C3D4E5F6071")!
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

    func sourceStopped() {
        queue.async {
            self.sourceRunning = max(0, self.sourceRunning - 1)
            if self.sourceRunning == 0 {
                self.timer?.cancel()
                self.timer = nil
            }
        }
    }

    /// Keep clients fed while Puppet is not sending (dark frame).
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
            // Near-black (#101010): "Puppet is not sending".
            memset(base, 0x10, CVPixelBufferGetBytesPerRow(pb) * h)
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        placeholders[key] = pb
        return pb
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

final class ProviderSource: NSObject, CMIOExtensionProviderSource {
    private(set) var provider: CMIOExtensionProvider!
    private var deviceSource: DeviceSource!

    init(clientQueue: DispatchQueue?) {
        super.init()
        provider = CMIOExtensionProvider(source: self, clientQueue: clientQueue)
        deviceSource = DeviceSource()
        do {
            try provider.addDevice(deviceSource.device)
        } catch {
            log.error("addDevice failed: \(error.localizedDescription, privacy: .public)")
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

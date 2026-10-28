// Puppet virtual camera: app-side bridge (macOS).
//
// Two jobs, exposed to Rust as plain C functions (src-tauri/src/vcam/macos.rs):
//
// 1. Install the CoreMediaIO Camera Extension embedded in the app bundle
//    (Contents/Library/SystemExtensions/) with OSSystemExtensionRequest, and
//    report where that stands: needs approval in System Settings, needs the
//    app in /Applications, activated, failed (with the OSSystemExtension
//    error code).
// 2. Feed frames to the extension: find the "Puppet Virtual Camera" CMIO
//    device, take its sink stream (direction = output), and enqueue BGRA
//    CMSampleBuffers into the sink's CMSimpleQueue. The extension forwards
//    them to its source stream, which is what Zoom / Meet / Discord read.
//
// Built by build.rs with the `cc` crate (ARC on). Written from Apple's
// CoreMediaIO and SystemExtensions headers; no third-party code.

#import <Foundation/Foundation.h>
#import <SystemExtensions/SystemExtensions.h>
#import <CoreMediaIO/CMIOHardware.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include <stdint.h>
#include <string.h>

#define PVC_EXTENSION_ID @"com.spartangamestudios.puppet.camera"
// Must match DEVICE_UUID / DEVICE_NAME in camera-extension/Provider.swift.
#define PVC_DEVICE_UUID @"6A3B1E0C-4F7D-4E8A-9C21-5B0D7E2F9A41"
#define PVC_DEVICE_NAME @"Puppet Virtual Camera"

enum {
    PVC_REQ_IDLE = 0,
    PVC_REQ_PENDING = 1,
    PVC_REQ_NEEDS_APPROVAL = 2,
    PVC_REQ_ACTIVATED = 3,
    PVC_REQ_NEEDS_REBOOT = 4,
    PVC_REQ_FAILED = 5,
    PVC_REQ_DEACTIVATED = 6,
};

typedef struct {
    int32_t request_state;   // PVC_REQ_*
    int64_t error_code;      // OSSystemExtensionErrorCode (or NSError code) when FAILED
    int32_t device_present;  // the CMIO device exists (extension installed and running)
    int32_t in_applications; // app bundle lives under /Applications
    int32_t is_bundle;       // running from a .app (not `tauri dev`)
    int32_t extension_embedded; // Contents/Library/SystemExtensions/<id>.systemextension exists
    int32_t streaming;       // sink stream started
    int32_t enabled;         // from a properties request: extension enabled (-1 unknown)
    char message[512];
} pvc_status;

// ---------------------------------------------------------------- activation

@interface PVCRequestDelegate : NSObject <OSSystemExtensionRequestDelegate>
@end

static dispatch_queue_t pvc_queue(void) {
    static dispatch_queue_t q;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ q = dispatch_queue_create("puppet.vcam", DISPATCH_QUEUE_SERIAL); });
    return q;
}

static NSObject *g_lock;
static int32_t g_req = PVC_REQ_IDLE;
static int64_t g_err = 0;
static int32_t g_enabled = -1;
static NSString *g_msg = @"";
static PVCRequestDelegate *g_delegate;
static OSSystemExtensionRequest *g_props_request;
static BOOL g_deactivating = NO;

static void set_state(int32_t s, int64_t code, NSString *msg) {
    @synchronized(g_lock) {
        g_req = s;
        g_err = code;
        g_msg = msg ?: @"";
    }
}

@implementation PVCRequestDelegate

- (OSSystemExtensionReplacementAction)request:(OSSystemExtensionRequest *)request
                  actionForReplacingExtension:(OSSystemExtensionProperties *)existing
                                withExtension:(OSSystemExtensionProperties *)ext {
    // Always take the copy shipped with this app (upgrades and downgrades).
    return OSSystemExtensionReplacementActionReplace;
}

- (void)requestNeedsUserApproval:(OSSystemExtensionRequest *)request {
    set_state(PVC_REQ_NEEDS_APPROVAL, 0, @"Waiting for approval in System Settings");
}

- (void)request:(OSSystemExtensionRequest *)request didFinishWithResult:(OSSystemExtensionRequestResult)result {
    if (request == g_props_request) return;
    BOOL deact = g_deactivating;
    if (result == OSSystemExtensionRequestWillCompleteAfterReboot)
        set_state(PVC_REQ_NEEDS_REBOOT, 0, @"Restart the Mac to finish");
    else
        set_state(deact ? PVC_REQ_DEACTIVATED : PVC_REQ_ACTIVATED, 0, deact ? @"Removed" : @"Activated");
}

- (void)request:(OSSystemExtensionRequest *)request didFailWithError:(NSError *)error {
    if (request == g_props_request) {
        // A signing problem (missing entitlement, bad signature) shows up here
        // already, so the panel can say "not signed" before the user tries to
        // install. Other errors only go to the status line.
        @synchronized(g_lock) {
            if (g_req == PVC_REQ_IDLE) {
                long c = (long)error.code;
                if (c == 2 || c == 8 || c == 9 || c == 10) {
                    g_req = PVC_REQ_FAILED;
                    g_err = c;
                }
                g_msg = [NSString stringWithFormat:@"%@ (%@ %ld)", error.localizedDescription, error.domain, c];
            }
        }
        return;
    }
    NSString *m = [NSString stringWithFormat:@"%@ (%@ %ld)", error.localizedDescription, error.domain, (long)error.code];
    set_state(PVC_REQ_FAILED, error.code, m);
}

- (void)request:(OSSystemExtensionRequest *)request foundProperties:(NSArray<OSSystemExtensionProperties *> *)properties API_AVAILABLE(macos(12.0)) {
    int32_t en = 0;
    BOOL awaiting = NO;
    for (OSSystemExtensionProperties *p in properties) {
        if (p.isEnabled) en = 1;
        if (p.isAwaitingUserApproval) awaiting = YES;
    }
    @synchronized(g_lock) {
        g_enabled = en;
        if (awaiting && g_req == PVC_REQ_IDLE) {
            g_req = PVC_REQ_NEEDS_APPROVAL;
            g_msg = @"Waiting for approval in System Settings";
        }
    }
}

@end

static void ensure_init(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_lock = [NSObject new];
        g_delegate = [PVCRequestDelegate new];
    });
}

void pvc_activate(void) {
    ensure_init();
    g_deactivating = NO;
    set_state(PVC_REQ_PENDING, 0, @"Requesting activation");
    OSSystemExtensionRequest *r = [OSSystemExtensionRequest activationRequestForExtension:PVC_EXTENSION_ID queue:pvc_queue()];
    r.delegate = g_delegate;
    [[OSSystemExtensionManager sharedManager] submitRequest:r];
}

void pvc_deactivate(void) {
    ensure_init();
    g_deactivating = YES;
    set_state(PVC_REQ_PENDING, 0, @"Requesting removal");
    OSSystemExtensionRequest *r = [OSSystemExtensionRequest deactivationRequestForExtension:PVC_EXTENSION_ID queue:pvc_queue()];
    r.delegate = g_delegate;
    [[OSSystemExtensionManager sharedManager] submitRequest:r];
}

/// Ask (without installing anything) whether the extension is enabled or awaiting approval.
void pvc_query_properties(void) {
    ensure_init();
    if (@available(macOS 12.0, *)) {
        OSSystemExtensionRequest *r = [OSSystemExtensionRequest propertiesRequestForExtension:PVC_EXTENSION_ID queue:pvc_queue()];
        r.delegate = g_delegate;
        g_props_request = r;
        [[OSSystemExtensionManager sharedManager] submitRequest:r];
    }
}

// ---------------------------------------------------------------- CMIO helpers

static CMIOObjectPropertyAddress addr(CMIOObjectPropertySelector sel) {
    CMIOObjectPropertyAddress a = {sel, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
    return a;
}

static NSArray<NSNumber *> *object_list(CMIOObjectID obj, CMIOObjectPropertySelector sel) {
    CMIOObjectPropertyAddress a = addr(sel);
    UInt32 size = 0, used = 0;
    if (CMIOObjectGetPropertyDataSize(obj, &a, 0, NULL, &size) != kCMIOHardwareNoError || size == 0) return @[];
    UInt32 n = size / sizeof(CMIOObjectID);
    CMIOObjectID *ids = calloc(n, sizeof(CMIOObjectID));
    NSMutableArray *out = [NSMutableArray array];
    if (CMIOObjectGetPropertyData(obj, &a, 0, NULL, size, &used, ids) == kCMIOHardwareNoError) {
        for (UInt32 i = 0; i < used / sizeof(CMIOObjectID); i++) [out addObject:@(ids[i])];
    }
    free(ids);
    return out;
}

static NSString *string_prop(CMIOObjectID obj, CMIOObjectPropertySelector sel) {
    CMIOObjectPropertyAddress a = addr(sel);
    CFStringRef s = NULL;
    UInt32 used = 0;
    if (CMIOObjectGetPropertyData(obj, &a, 0, NULL, sizeof(s), &used, &s) != kCMIOHardwareNoError || !s) return nil;
    return (__bridge_transfer NSString *)s;
}

static CMIODeviceID find_device(void) {
    for (NSNumber *d in object_list(kCMIOObjectSystemObject, kCMIOHardwarePropertyDevices)) {
        CMIODeviceID dev = d.unsignedIntValue;
        NSString *uid = string_prop(dev, kCMIODevicePropertyDeviceUID);
        NSString *name = string_prop(dev, kCMIOObjectPropertyName);
        if ([uid caseInsensitiveCompare:PVC_DEVICE_UUID] == NSOrderedSame || [name isEqualToString:PVC_DEVICE_NAME]) return dev;
    }
    return kCMIOObjectUnknown;
}

// ---------------------------------------------------------------- sink stream

static CMIODeviceID g_dev = kCMIOObjectUnknown;
static CMIOStreamID g_sink = kCMIOObjectUnknown;
static CMSimpleQueueRef g_queue = NULL;
static CVPixelBufferPoolRef g_pool = NULL;
static CMVideoFormatDescriptionRef g_fmt = NULL;
static int32_t g_w = 0, g_h = 0, g_fps = 30;

static void queue_altered(CMIOStreamID s, void *token, void *refcon) {
    (void)s; (void)token; (void)refcon;
    // Nothing to do: we check the queue's fullness before each enqueue.
}

static void copy_err(char *err, int32_t len, NSString *m) {
    if (err && len > 0) strlcpy(err, m.UTF8String ?: "error", (size_t)len);
}

void pvc_close(void) {
    ensure_init();
    @synchronized(g_lock) {
        if (g_dev != kCMIOObjectUnknown && g_sink != kCMIOObjectUnknown) CMIODeviceStopStream(g_dev, g_sink);
        if (g_queue) CFRelease(g_queue);
        if (g_pool) CVPixelBufferPoolRelease(g_pool);
        if (g_fmt) CFRelease(g_fmt);
        g_queue = NULL;
        g_pool = NULL;
        g_fmt = NULL;
        g_dev = g_sink = kCMIOObjectUnknown;
    }
}

int32_t pvc_open(int32_t w, int32_t h, int32_t fps, char *err, int32_t errlen) {
    ensure_init();
    pvc_close();
    @synchronized(g_lock) {
        CMIODeviceID dev = find_device();
        if (dev == kCMIOObjectUnknown) {
            copy_err(err, errlen, @"Puppet Virtual Camera device not found (extension not installed or not approved)");
            return -1;
        }
        CMIOStreamID sink = kCMIOObjectUnknown;
        NSArray<NSNumber *> *streams = object_list(dev, kCMIODevicePropertyStreams);
        for (NSNumber *s in streams) {
            CMIOObjectPropertyAddress a = addr(kCMIOStreamPropertyDirection);
            UInt32 dir = 1, used = 0;
            // 0 = output (a sink we write into), 1 = input (a source apps read).
            if (CMIOObjectGetPropertyData(s.unsignedIntValue, &a, 0, NULL, sizeof(dir), &used, &dir) == kCMIOHardwareNoError && dir == 0) {
                sink = s.unsignedIntValue;
                break;
            }
        }
        if (sink == kCMIOObjectUnknown && streams.count > 1) sink = streams[1].unsignedIntValue;
        if (sink == kCMIOObjectUnknown) {
            copy_err(err, errlen, [NSString stringWithFormat:@"no sink stream on the device (%lu streams)", (unsigned long)streams.count]);
            return -2;
        }
        CMSimpleQueueRef q = NULL;
        OSStatus st = CMIOStreamCopyBufferQueue(sink, queue_altered, NULL, &q);
        if (st != noErr || !q) {
            copy_err(err, errlen, [NSString stringWithFormat:@"CMIOStreamCopyBufferQueue failed (%d)", (int)st]);
            return -3;
        }
        st = CMIODeviceStartStream(dev, sink);
        if (st != noErr) {
            CFRelease(q);
            copy_err(err, errlen, [NSString stringWithFormat:@"CMIODeviceStartStream failed (%d)", (int)st]);
            return -4;
        }
        NSDictionary *attrs = @{
            (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
            (id)kCVPixelBufferWidthKey : @(w),
            (id)kCVPixelBufferHeightKey : @(h),
            (id)kCVPixelBufferIOSurfacePropertiesKey : @{},
        };
        CVPixelBufferPoolRef pool = NULL;
        CVPixelBufferPoolCreate(kCFAllocatorDefault, NULL, (__bridge CFDictionaryRef)attrs, &pool);
        CMVideoFormatDescriptionRef fmt = NULL;
        CMVideoFormatDescriptionCreate(kCFAllocatorDefault, kCVPixelFormatType_32BGRA, w, h, NULL, &fmt);
        if (!pool || !fmt) {
            CMIODeviceStopStream(dev, sink);
            CFRelease(q);
            if (pool) CVPixelBufferPoolRelease(pool);
            if (fmt) CFRelease(fmt);
            copy_err(err, errlen, @"could not create pixel buffer pool");
            return -5;
        }
        g_dev = dev;
        g_sink = sink;
        g_queue = q;
        g_pool = pool;
        g_fmt = fmt;
        g_w = w;
        g_h = h;
        g_fps = fps > 0 ? fps : 30;
    }
    return 0;
}

/// Enqueue one BGRA frame (top-down, stride w*4). 0 = sent, 1 = dropped (queue full), <0 = error.
int32_t pvc_send(const uint8_t *bgra, int32_t w, int32_t h, char *err, int32_t errlen) {
    @synchronized(g_lock) {
        if (!g_queue) {
            copy_err(err, errlen, @"sink stream not open");
            return -1;
        }
        if (w != g_w || h != g_h) {
            copy_err(err, errlen, @"frame size does not match the open stream");
            return -2;
        }
        if (CMSimpleQueueGetCount(g_queue) >= CMSimpleQueueGetCapacity(g_queue)) return 1;
        CVPixelBufferRef pb = NULL;
        if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, g_pool, &pb) != kCVReturnSuccess || !pb) {
            copy_err(err, errlen, @"pixel buffer pool exhausted");
            return -3;
        }
        CVPixelBufferLockBaseAddress(pb, 0);
        uint8_t *dst = CVPixelBufferGetBaseAddress(pb);
        size_t dstride = CVPixelBufferGetBytesPerRow(pb);
        size_t sstride = (size_t)w * 4;
        if (dstride == sstride) {
            memcpy(dst, bgra, sstride * (size_t)h);
        } else {
            for (int32_t y = 0; y < h; y++) memcpy(dst + dstride * y, bgra + sstride * y, sstride);
        }
        CVPixelBufferUnlockBaseAddress(pb, 0);

        CMSampleTimingInfo timing;
        timing.duration = CMTimeMake(1, g_fps);
        timing.presentationTimeStamp = CMClockGetTime(CMClockGetHostTimeClock());
        timing.decodeTimeStamp = kCMTimeInvalid;
        CMSampleBufferRef sb = NULL;
        OSStatus st = CMSampleBufferCreateReadyWithImageBuffer(kCFAllocatorDefault, pb, g_fmt, &timing, &sb);
        CVPixelBufferRelease(pb);
        if (st != noErr || !sb) {
            copy_err(err, errlen, [NSString stringWithFormat:@"CMSampleBufferCreate failed (%d)", (int)st]);
            return -4;
        }
        // The queue takes ownership of the retained sample buffer on success.
        st = CMSimpleQueueEnqueue(g_queue, sb);
        if (st != noErr) {
            CFRelease(sb);
            return 1;
        }
    }
    return 0;
}

// ---------------------------------------------------------------- status

/// probe_device = 0 skips CMIO device enumeration (unit tests: no camera prompt).
void pvc_get_status(pvc_status *out, int32_t probe_device) {
    ensure_init();
    memset(out, 0, sizeof(*out));
    NSString *bundlePath = NSBundle.mainBundle.bundlePath;
    out->is_bundle = [bundlePath hasSuffix:@".app"];
    out->in_applications = [bundlePath hasPrefix:@"/Applications/"];
    NSString *ext = [bundlePath stringByAppendingPathComponent:
                                    [NSString stringWithFormat:@"Contents/Library/SystemExtensions/%@.systemextension", PVC_EXTENSION_ID]];
    out->extension_embedded = [[NSFileManager defaultManager] fileExistsAtPath:ext];
    out->device_present = probe_device && find_device() != kCMIOObjectUnknown;
    @synchronized(g_lock) {
        out->request_state = g_req;
        out->error_code = g_err;
        out->streaming = g_queue != NULL;
        out->enabled = g_enabled;
        strlcpy(out->message, g_msg.UTF8String ?: "", sizeof(out->message));
    }
}

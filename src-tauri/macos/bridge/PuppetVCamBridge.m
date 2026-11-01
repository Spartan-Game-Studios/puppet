// VPuppet virtual camera: app-side bridge (macOS).
//
// Two jobs, exposed to Rust as plain C functions (src-tauri/src/vcam/macos.rs):
//
// 1. Install the CoreMediaIO Camera Extension through VPuppet Camera.app, the
//    helper embedded at Contents/Helpers/ (copied to /Applications and run;
//    see "activation" below), and report where that stands: needs approval
//    in System Settings, activated, failed (with the OSSystemExtension error
//    code).
// 2. Announce that VPuppet is alive (pvc_presence): a Darwin notification
//    heartbeat the extension watches. It adds the camera device while beats
//    arrive and removes it on "off" or when they stop (quit, crash).
// 3. Feed frames to the extension: find the "VPuppet Virtual Camera" CMIO
//    device, take its sink stream (direction = output), and enqueue BGRA
//    CMSampleBuffers into the sink's CMSimpleQueue. The extension forwards
//    them to its source stream, which is what Zoom / Meet / Discord read.
//
// Built by build.rs with the `cc` crate (ARC on). Written from Apple's
// CoreMediaIO headers; no third-party code.

#import <Foundation/Foundation.h>
#import <CoreMediaIO/CMIOHardware.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#include <notify.h>
#include <stdint.h>
#include <string.h>

#define PVC_EXTENSION_ID @"com.spartangamestudios.vpuppet.camera"
// Must match DEVICE_UUID / DEVICE_NAME in camera-extension/Provider.swift.
#define PVC_DEVICE_UUID @"6A3B1E0C-4F7D-4E8A-9C21-5B0D7E2F9A41"
#define PVC_DEVICE_NAME @"VPuppet Virtual Camera"
// Must match PRESENCE_NOTIFY in camera-extension/Provider.swift.
#define PVC_PRESENCE_NOTIFY "com.spartangamestudios.vpuppet.camera.presence"

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
    int32_t helper_installed; // /Applications/VPuppet Camera.app exists
    int32_t is_bundle;       // running from a .app (not `tauri dev`)
    int32_t extension_embedded; // Contents/Helpers/VPuppet Camera.app carries the extension
    int32_t streaming;       // sink stream started
    int32_t enabled;         // from a properties request: extension enabled (-1 unknown)
    char message[512];
    int32_t props_answered;  // a properties request has answered at least once
    int32_t awaiting_approval; // from properties: installed, waiting for the user
    int32_t uninstalling;    // from properties: removal pending (reboot)
    char installed_version[64]; // CFBundleVersion of the enabled (else newest) installed copy
    char bundled_version[64];   // CFBundleVersion of the copy inside this app's helper
} pvc_status;

// ---------------------------------------------------------------- activation
//
// macOS activates system extensions only from an app in /Applications, and
// VPuppet may live anywhere (Steam: ~/Library/Application Support/Steam). So
// VPuppet carries a helper, Contents/Helpers/VPuppet Camera.app, with the
// extension inside it. Install, update and removal copy the helper to
// /Applications when the copy there differs, then run it (activate /
// deactivate / properties) and read its one-line answers
// (camera-helper/main.swift has the protocol).

#define PVC_HELPER_NAME @"VPuppet Camera.app"
#define PVC_HELPER_INSTALLED @"/Applications/VPuppet Camera.app"
#define PVC_HELPER_EXE @"Contents/MacOS/VPuppet Camera"
// Our own error code (not an OSSystemExtensionErrorCode): the helper could not
// be copied to /Applications.
#define PVC_ERR_COPY -100

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
static int32_t g_props_answered = 0;
static int32_t g_awaiting = 0;
static int32_t g_uninstalling = 0;
static NSString *g_installed_version = @"";
static double g_props_sent_at = 0;
static int32_t g_props_pending = 0;
static int32_t g_busy = 0; // an activate / deactivate run is in flight

static void set_state(int32_t s, int64_t code, NSString *msg) {
    @synchronized(g_lock) {
        g_req = s;
        g_err = code;
        g_msg = msg ?: @"";
    }
}

static void ensure_init(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{ g_lock = [NSObject new]; });
}

static NSString *bundled_helper(void) {
    return [NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:[@"Contents/Helpers" stringByAppendingPathComponent:PVC_HELPER_NAME]];
}

static NSString *extension_in(NSString *helper) {
    return [helper stringByAppendingPathComponent:
                       [NSString stringWithFormat:@"Contents/Library/SystemExtensions/%@.systemextension", PVC_EXTENSION_ID]];
}

static NSString *plist_version(NSString *bundle) {
    // Read the file each time: NSBundle caches, and the copy can change under us.
    NSDictionary *d = [NSDictionary dictionaryWithContentsOfFile:[bundle stringByAppendingPathComponent:@"Contents/Info.plist"]];
    id v = d[@"CFBundleVersion"];
    return [v isKindOfClass:NSString.class] ? v : @"";
}

/// The copy in /Applications is the one this VPuppet carries (same helper and
/// extension executables and Info.plists).
static BOOL helper_current(void) {
    NSString *src = bundled_helper(), *dst = PVC_HELPER_INSTALLED;
    NSString *ext = [NSString stringWithFormat:@"Contents/Library/SystemExtensions/%@.systemextension/Contents/", PVC_EXTENSION_ID];
    NSArray *files = @[ PVC_HELPER_EXE, @"Contents/Info.plist", @"Contents/_CodeSignature/CodeResources",
                        [ext stringByAppendingFormat:@"MacOS/%@", PVC_EXTENSION_ID], [ext stringByAppendingString:@"Info.plist"] ];
    for (NSString *f in files) {
        NSData *a = [NSData dataWithContentsOfFile:[src stringByAppendingPathComponent:f]];
        NSData *b = [NSData dataWithContentsOfFile:[dst stringByAppendingPathComponent:f]];
        if (!a || ![a isEqualToData:b]) return NO;
    }
    return YES;
}

static NSString *shell_quote(NSString *s) {
    return [NSString stringWithFormat:@"'%@'", [s stringByReplacingOccurrencesOfString:@"'" withString:@"'\\''"]];
}

/// Run a shell command as an administrator: macOS shows its own password dialog.
static BOOL run_as_admin(NSString *cmd, NSString **err) {
    NSString *as = [[cmd stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"] stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""];
    NSTask *t = [NSTask new];
    t.launchPath = @"/usr/bin/osascript";
    t.arguments = @[ @"-e", [NSString stringWithFormat:@"do shell script \"%@\" with prompt \"VPuppet needs to put its camera installer, VPuppet Camera, in the Applications folder.\" with administrator privileges", as] ];
    NSPipe *errPipe = [NSPipe pipe];
    t.standardError = errPipe;
    t.standardOutput = [NSFileHandle fileHandleWithNullDevice];
    @try {
        [t launch];
    } @catch (NSException *e) {
        if (err) *err = e.reason;
        return NO;
    }
    NSData *d = [errPipe.fileHandleForReading readDataToEndOfFile];
    [t waitUntilExit];
    if (t.terminationStatus == 0) return YES;
    if (err) *err = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding] ?: @"cancelled";
    return NO;
}

/// Put this VPuppet's helper in /Applications (replacing a different copy).
static BOOL install_helper(NSString **err) {
    if (helper_current()) return YES;
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *src = bundled_helper(), *dst = PVC_HELPER_INSTALLED;
    NSString *tmp = [NSString stringWithFormat:@"/Applications/.VPuppet Camera.%d.app", getpid()];
    NSError *e = nil;
    [fm removeItemAtPath:tmp error:nil];
    if ([fm copyItemAtPath:src toPath:tmp error:&e]) {
        [fm removeItemAtPath:dst error:nil];
        if ([fm moveItemAtPath:tmp toPath:dst error:&e]) return YES;
        [fm removeItemAtPath:tmp error:nil];
    }
    // /Applications not writable for this user (a standard account): ask for an administrator.
    NSString *cmd = [NSString stringWithFormat:@"/bin/rm -rf %@ && /usr/bin/ditto %@ %@", shell_quote(dst), shell_quote(src), shell_quote(dst)];
    NSString *adminErr = nil;
    if (run_as_admin(cmd, &adminErr) && helper_current()) return YES;
    if (err) *err = adminErr ?: e.localizedDescription ?: @"copy failed";
    return NO;
}

/// Run the installed helper with one command; `line` gets each answer line.
static int run_helper(NSString *command, void (^line)(NSString *)) {
    NSTask *t = [NSTask new];
    t.launchPath = [PVC_HELPER_INSTALLED stringByAppendingPathComponent:PVC_HELPER_EXE];
    t.arguments = @[ command ];
    NSPipe *out = [NSPipe pipe];
    t.standardOutput = out;
    t.standardError = [NSFileHandle fileHandleWithNullDevice];
    @try {
        [t launch];
    } @catch (NSException *e) {
        line([NSString stringWithFormat:@"failed %d could not run VPuppet Camera: %@", PVC_ERR_COPY, e.reason]);
        return -1;
    }
    NSMutableData *buf = [NSMutableData data];
    NSFileHandle *h = out.fileHandleForReading;
    for (;;) {
        NSData *d = [h availableData]; // blocks; empty at EOF
        if (d.length == 0) break;
        [buf appendData:d];
        for (;;) {
            NSRange nl = [buf rangeOfData:[NSData dataWithBytes:"\n" length:1] options:0 range:NSMakeRange(0, buf.length)];
            if (nl.location == NSNotFound) break;
            NSString *l = [[NSString alloc] initWithData:[buf subdataWithRange:NSMakeRange(0, nl.location)] encoding:NSUTF8StringEncoding];
            [buf replaceBytesInRange:NSMakeRange(0, nl.location + 1) withBytes:NULL length:0];
            if (l.length) line(l);
        }
    }
    [t waitUntilExit];
    return t.terminationStatus;
}

static void reset_props(BOOL nothing_installed) {
    @synchronized(g_lock) {
        g_props_sent_at = 0; // re-read versions on the next poll
        g_props_pending = 0;
        if (nothing_installed) {
            // macOS may never answer a properties request once nothing is installed.
            g_props_answered = 0;
            g_enabled = -1;
            g_awaiting = 0;
            g_installed_version = @"";
        }
    }
}

/// One answer line from an activate / deactivate run. Returns YES when final.
static BOOL handle_result(NSString *l, BOOL removing) {
    if ([l isEqualToString:@"approval"]) {
        set_state(PVC_REQ_NEEDS_APPROVAL, 0, @"Waiting for approval in System Settings");
        return NO;
    }
    if ([l isEqualToString:@"activated"] || [l isEqualToString:@"deactivated"] || [l isEqualToString:@"reboot"]) {
        reset_props(removing);
        if ([l isEqualToString:@"reboot"])
            set_state(PVC_REQ_NEEDS_REBOOT, 0, @"Restart the Mac to finish");
        else
            set_state(removing ? PVC_REQ_DEACTIVATED : PVC_REQ_ACTIVATED, 0, removing ? @"Removed" : @"Activated");
        return YES;
    }
    if ([l hasPrefix:@"failed "]) {
        NSArray *p = [l componentsSeparatedByString:@" "];
        long code = p.count > 1 ? [p[1] integerValue] : 1;
        NSString *msg = p.count > 2 ? [[p subarrayWithRange:NSMakeRange(2, p.count - 2)] componentsJoinedByString:@" "] : @"failed";
        set_state(PVC_REQ_FAILED, code, msg);
        @synchronized(g_lock) { g_props_sent_at = 0; }
        return YES;
    }
    if ([l isEqualToString:@"timeout"]) {
        set_state(PVC_REQ_FAILED, 1, removing ? @"Removal timed out" : @"Approval timed out");
        return YES;
    }
    return NO;
}

static void run_request(BOOL removing) {
    ensure_init();
    @synchronized(g_lock) {
        if (g_busy) return;
        g_busy = 1;
    }
    set_state(PVC_REQ_PENDING, 0, @"Copying VPuppet Camera to Applications");
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        NSString *err = nil;
        if (!install_helper(&err)) {
            set_state(PVC_REQ_FAILED, PVC_ERR_COPY, [NSString stringWithFormat:@"Could not copy VPuppet Camera to Applications: %@", err]);
        } else {
            set_state(PVC_REQ_PENDING, 0, removing ? @"Requesting removal" : @"Requesting activation");
            __block BOOL done = NO;
            int status = run_helper(removing ? @"deactivate" : @"activate", ^(NSString *l) {
                if (!done) done = handle_result(l, removing);
            });
            if (!done) set_state(PVC_REQ_FAILED, 1, [NSString stringWithFormat:@"VPuppet Camera exited (%d)", status]);
            // Removed: the helper has no job left (dragging it to the Trash would
            // also remove the extension, so it is the user's uninstaller too).
            BOOL removed;
            @synchronized(g_lock) { removed = removing && (g_req == PVC_REQ_DEACTIVATED || g_req == PVC_REQ_NEEDS_REBOOT); }
            if (removed) [NSFileManager.defaultManager removeItemAtPath:PVC_HELPER_INSTALLED error:nil];
        }
        @synchronized(g_lock) { g_busy = 0; }
    });
}

void pvc_activate(void) { run_request(NO); }

void pvc_deactivate(void) { run_request(YES); }

/// Ask (without installing anything) whether the extension is enabled or awaiting approval.
void pvc_query_properties(void) {
    ensure_init();
    @synchronized(g_lock) {
        // At most one request every 4 s (the panel polls every 3 s), none while
        // an install or removal runs.
        double now = CFAbsoluteTimeGetCurrent();
        if (g_busy || g_props_pending || now - g_props_sent_at < 4) return;
        g_props_sent_at = now;
        g_props_pending = 1;
    }
    dispatch_async(pvc_queue(), ^{
        if (![NSFileManager.defaultManager isExecutableFileAtPath:[PVC_HELPER_INSTALLED stringByAppendingPathComponent:PVC_HELPER_EXE]]) {
            // No helper in /Applications: nothing of ours is installed.
            @synchronized(g_lock) {
                g_props_pending = 0;
                g_props_answered = 1;
                g_enabled = 0;
                g_awaiting = 0;
                g_uninstalling = 0;
                g_installed_version = @"";
            }
            return;
        }
        run_helper(@"properties", ^(NSString *l) {
            NSArray *p = [l componentsSeparatedByString:@" "];
            @synchronized(g_lock) {
                if ([p[0] isEqualToString:@"props"] && p.count >= 5) {
                    g_enabled = [p[1] intValue];
                    g_awaiting = [p[2] intValue];
                    g_uninstalling = [p[3] intValue];
                    g_installed_version = [p[4] isEqualToString:@"-"] ? @"" : p[4];
                    g_props_answered = 1;
                    if (g_awaiting && g_req == PVC_REQ_IDLE) {
                        g_req = PVC_REQ_NEEDS_APPROVAL;
                        g_msg = @"Waiting for approval in System Settings";
                    }
                } else if ([p[0] isEqualToString:@"failed"] && p.count >= 2 && g_req == PVC_REQ_IDLE) {
                    // A signing problem (missing entitlement, bad signature) shows up here
                    // already, so the panel can say "not signed" before the user tries to
                    // install. Other errors only go to the status line.
                    long c = [p[1] integerValue];
                    if (c == 2 || c == 8 || c == 9 || c == 10) {
                        g_req = PVC_REQ_FAILED;
                        g_err = c;
                    }
                    g_msg = p.count > 2 ? [[p subarrayWithRange:NSMakeRange(2, p.count - 2)] componentsJoinedByString:@" "] : @"";
                }
            }
        });
        @synchronized(g_lock) { g_props_pending = 0; }
    });
}

// ---------------------------------------------------------------- presence

/// on = 1: one heartbeat (call about once a second while the camera output is
/// on). on = 0: tell the extension to remove the device now.
void pvc_presence(int32_t on) {
    ensure_init();
    static int token = NOTIFY_TOKEN_INVALID;
    static uint64_t beat = 0;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ notify_register_check(PVC_PRESENCE_NOTIFY, &token); });
    @synchronized(g_lock) {
        if (token != NOTIFY_TOKEN_INVALID) notify_set_state(token, on ? ++beat : 0);
        notify_post(PVC_PRESENCE_NOTIFY);
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
            copy_err(err, errlen, @"VPuppet Virtual Camera device not found (extension not installed or not approved)");
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
    out->helper_installed = [[NSFileManager defaultManager] fileExistsAtPath:PVC_HELPER_INSTALLED];
    NSString *ext = extension_in(bundled_helper());
    out->extension_embedded = [[NSFileManager defaultManager] fileExistsAtPath:ext];
    out->device_present = probe_device && find_device() != kCMIOObjectUnknown;
    @synchronized(g_lock) {
        out->request_state = g_req;
        out->error_code = g_err;
        out->streaming = g_queue != NULL;
        out->enabled = g_enabled;
        strlcpy(out->message, g_msg.UTF8String ?: "", sizeof(out->message));
        out->props_answered = g_props_answered;
        out->awaiting_approval = g_awaiting;
        out->uninstalling = g_uninstalling;
        strlcpy(out->installed_version, g_installed_version.UTF8String ?: "", sizeof(out->installed_version));
    }
    if (out->extension_embedded) strlcpy(out->bundled_version, plist_version(ext).UTF8String ?: "", sizeof(out->bundled_version));
}

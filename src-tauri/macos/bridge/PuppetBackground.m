// VPuppet: keep running in the background (macOS).
//
// VPuppet is a live video source: while it is minimized, hidden or covered it
// must keep tracking, rendering and sending (virtual camera, VMC). Three
// things stand in the way on macOS, and this file turns each off:
//
// 1. App Nap. A hidden or fully covered app gets its timers coalesced and its
//    priority lowered. An NSProcessInfo activity (user-initiated, latency
//    critical) opts the whole process out, without blocking idle system sleep.
// 2. WKWebView's window occlusion detection: a covered or off-screen window
//    makes WebKit treat the page as hidden (rAF stops, the WebContent process
//    is suppressed). `_setWindowOcclusionDetectionEnabled:NO` (WebKit SPI;
//    Tauri already builds with macOSPrivateApi) keeps a covered window
//    "visible". Minimized / Cmd-H hidden windows are still hidden pages; the
//    frontend's background loop (src/app/backgroundLoop.ts) covers those.
// 3. Hidden-page throttling in WebKit's preferences: DOM timer throttling and
//    visibility-based process suppression (WKPreferences SPI). The public
//    inactiveSchedulingPolicy = none is already set by Tauri
//    (backgroundThrottling: "disabled").
//
// Every SPI call is guarded with respondsToSelector:, so a WebKit without one
// of them just skips it.

#import <Foundation/Foundation.h>
#import <objc/message.h>

static id g_activity;

static void set_bool(id obj, NSString *sel, BOOL v) {
    SEL s = NSSelectorFromString(sel);
    if (obj && [obj respondsToSelector:s]) ((void (*)(id, SEL, BOOL))objc_msgSend)(obj, s, v);
}

/// Opt the process out of App Nap for its lifetime.
void pbg_begin_activity(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        g_activity = [[NSProcessInfo processInfo]
            beginActivityWithOptions:NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
                              reason:@"VPuppet sends live video (virtual camera, VMC) while in the background"];
    });
}

/// `webview` is the WKWebView (Tauri: `PlatformWebview::inner()`). Main thread only.
void pbg_keep_webview_running(void *webview) {
    id wv = (__bridge id)webview;
    if (!wv) return;
    set_bool(wv, @"_setWindowOcclusionDetectionEnabled:", NO);
    id cfg = [wv respondsToSelector:@selector(configuration)] ? [wv performSelector:@selector(configuration)] : nil;
    id prefs = [cfg respondsToSelector:@selector(preferences)] ? [cfg performSelector:@selector(preferences)] : nil;
    set_bool(prefs, @"_setHiddenPageDOMTimerThrottlingEnabled:", NO);
    set_bool(prefs, @"_setPageVisibilityBasedProcessSuppressionEnabled:", NO);
}

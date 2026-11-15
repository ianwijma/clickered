/*
 * clickered-helper (macOS) — input capture / replay helper for clickered.
 *
 * Spec: docs/PROTOCOL.md (protocol version 2; no keyboard replication). This is a port
 * of native/helper.c (X11) speaking exactly the same line protocol:
 *   stdout: one JSON object per line (flushed)
 *   stdin : one command per line
 *   stderr: diagnostics
 *
 * Threads:
 *   main  — stdin, command execution (seq / pick / list), window enumeration
 *           (CoreGraphics + Accessibility), event injection, the pick overlay window,
 *           all stdout writes. Driven by the main CFRunLoop; sleeps inside a `seq` run
 *           nested CFRunLoop slices so stdin (`abort`), timers and output keep flowing.
 *   tap   — owns the CGEventTap and its own CFRunLoop. An active event tap stalls the
 *           whole system's input stream while its callback runs, so this thread never
 *           does Accessibility IPC or blocking writes: it decides pass/drop, keeps the
 *           gesture state and queues JSON lines for the main thread to write.
 *
 * Memory management: ARC for Objective-C objects (-fobjc-arc); CoreFoundation objects
 * are released by hand (CFRelease), bridged with __bridge / CFBridgingRelease.
 *
 * See native/mac/README.md for the platform mapping and its limits.
 */

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PROTOCOL_VERSION 2
#define MOTION_INTERVAL_MS 8
#define POST_SEQ_SUPPRESS_MS 30
#define WINDOWS_DEBOUNCE_MS 100
#define WINDOWS_POLL_MS 400
#define TICK_S 0.05
#define ACTIVATE_WAIT_MS 200
#define POINTER_SETTLE_MS 100
#define PICK_RELEASE_TIMEOUT_MS 3000
#define PICK_HOVER_INTERVAL_MS 30
/* Bounds for seq coordinates: fractions may leave the window (drags), but not absurdly. */
#define FRAC_LIMIT 100.0
#define COORD_LIMIT 32767L
/* Accessibility IPC timeout: a hung app must not stall the helper for the 6 s default. */
#define AX_TIMEOUT_S 0.25f
/* Smallest window treated as a client window (filters 1x1 helper windows etc.). */
#define MIN_CLIENT_SIZE 8.0
/* Value stored in kCGEventSourceUserData of every event we post ("clkr"). */
#define INJECT_TAG 0x636c6b72LL
/* kVK_Escape from Carbon's HIToolbox/Events.h (not imported to stay off Carbon). */
#define KEYCODE_ESCAPE 53
/* Cap on stdout bytes queued while the host is not reading. */
#define OUTQ_LIMIT (8u << 20)
/* macOS-specific: also activate the target in `m` when it is under the pointer but not
 * the key window of the frontmost app. A click into an inactive window is, for most
 * apps, consumed as a "focus click" and never delivered; X11 has no such behaviour.
 * See README ("Deviations"). */
#define ACTIVATE_INACTIVE_TARGET 1

/* ------------------------------------------------------------------------ */
/* Globals                                                                   */

static pid_t self_pid;
static CFRunLoopRef main_rl;
static CFRunLoopSourceRef wake_src; /* signalled by the tap thread; drains output */

static atomic_int exit_requested;
static atomic_int seq_running;
static atomic_int abort_flag;
static _Atomic long long suppress_until;
static int stdin_eof; /* main thread only */

/* Shared between threads, protected by g_mu (lock order: g_mu before out_mu). */
static pthread_mutex_t g_mu = PTHREAD_MUTEX_INITIALIZER;
static pid_t *g_regular; /* pids of regular (Dock) apps, published by the main thread */
static size_t g_nregular, g_capregular;
/* pick: 0 idle, 1 waiting for click, 2 replied, waiting for release. Written under g_mu. */
static atomic_int pick_state;
static int pick_rearm;
static int pick_cgbutton;
static long long pick_deadline;
/* desired overlay state, applied by the main thread */
static int ov_dirty, ov_visible;
static CGRect ov_rect;

/* tap */
static CFMachPortRef g_tap;
static CFRunLoopTimerRef tap_timer;

/* main: windows */
static long long windows_due;   /* debounced windows message; 0 = none pending */
static long long next_poll_ms;  /* next cheap change check */
static char *last_sig;          /* signature of the last emitted windows message */

/* AXUIElement -> CGWindowID. Private but stable (every window manager uses it);
 * resolved at runtime so a missing symbol degrades to frame matching. */
typedef AXError (*AXGetWindowFn)(AXUIElementRef, CGWindowID *);
static AXGetWindowFn ax_get_window;
static AXUIElementRef ax_system;

/* ------------------------------------------------------------------------ */
/* Utilities                                                                 */

static long long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void die_oom(void)
{
    fputs("clickered-helper: out of memory\n", stderr);
    _exit(3);
}

static void *xrealloc(void *p, size_t n)
{
    void *q = realloc(p, n ? n : 1);
    if (!q) die_oom();
    return q;
}

typedef struct {
    char *p;
    size_t n, cap;
} Buf;

static void b_reserve(Buf *b, size_t extra)
{
    if (b->n + extra + 1 > b->cap) {
        size_t c = b->cap ? b->cap : 256;
        while (c < b->n + extra + 1) c *= 2;
        b->p = xrealloc(b->p, c);
        b->cap = c;
    }
}

static void b_putc(Buf *b, char c)
{
    b_reserve(b, 1);
    b->p[b->n++] = c;
    b->p[b->n] = 0;
}

static void b_putn(Buf *b, const char *s, size_t l)
{
    b_reserve(b, l);
    memcpy(b->p + b->n, s, l);
    b->n += l;
    b->p[b->n] = 0;
}

static void b_puts(Buf *b, const char *s)
{
    b_putn(b, s, strlen(s));
}

static void b_printf(Buf *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void b_printf(Buf *b, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    int l = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (l < 0) return;
    b_reserve(b, (size_t)l);
    va_start(ap, fmt);
    vsnprintf(b->p + b->n, (size_t)l + 1, fmt, ap);
    va_end(ap);
    b->n += (size_t)l;
}

/* Length of a valid UTF-8 sequence at s (max n bytes), 0 if invalid. */
static int utf8_len(const unsigned char *s, size_t n)
{
    unsigned char c = s[0];
    if (c < 0x80) return 1;
    if (c >= 0xC2 && c <= 0xDF) {
        return (n >= 2 && (s[1] & 0xC0) == 0x80) ? 2 : 0;
    }
    if (c >= 0xE0 && c <= 0xEF) {
        if (n < 3 || (s[1] & 0xC0) != 0x80 || (s[2] & 0xC0) != 0x80) return 0;
        if (c == 0xE0 && s[1] < 0xA0) return 0; /* overlong */
        if (c == 0xED && s[1] > 0x9F) return 0; /* surrogates */
        return 3;
    }
    if (c >= 0xF0 && c <= 0xF4) {
        if (n < 4 || (s[1] & 0xC0) != 0x80 || (s[2] & 0xC0) != 0x80 ||
            (s[3] & 0xC0) != 0x80)
            return 0;
        if (c == 0xF0 && s[1] < 0x90) return 0;
        if (c == 0xF4 && s[1] > 0x8F) return 0;
        return 4;
    }
    return 0;
}

/* Append a JSON string literal; invalid UTF-8 bytes become U+FFFD. */
static void b_jstr(Buf *b, const char *str, size_t len)
{
    const unsigned char *s = (const unsigned char *)str;
    b_putc(b, '"');
    size_t i = 0;
    while (i < len) {
        unsigned char c = s[i];
        if (c < 0x80) {
            switch (c) {
            case '"': b_puts(b, "\\\""); break;
            case '\\': b_puts(b, "\\\\"); break;
            case '\n': b_puts(b, "\\n"); break;
            case '\r': b_puts(b, "\\r"); break;
            case '\t': b_puts(b, "\\t"); break;
            default:
                if (c < 0x20 || c == 0x7f) b_printf(b, "\\u%04x", c);
                else b_putc(b, (char)c);
            }
            i++;
            continue;
        }
        int l = utf8_len(s + i, len - i);
        if (l == 0) {
            b_puts(b, "\xEF\xBF\xBD");
            i++;
        } else {
            b_putn(b, (const char *)s + i, (size_t)l);
            i += (size_t)l;
        }
    }
    b_putc(b, '"');
}

/* Append a CFString as a JSON string literal ("" for NULL / non-strings). Unpaired
 * surrogates are replaced (lossByte), so the output is always valid UTF-8. */
static void b_jcfstr(Buf *b, CFStringRef s)
{
    if (!s || CFGetTypeID(s) != CFStringGetTypeID()) {
        b_puts(b, "\"\"");
        return;
    }
    CFIndex len = CFStringGetLength(s);
    CFIndex max = CFStringGetMaximumSizeForEncoding(len, kCFStringEncodingUTF8);
    if (max < 0) max = 0;
    UInt8 *tmp = xrealloc(NULL, (size_t)max + 1);
    CFIndex used = 0;
    CFStringGetBytes(s, CFRangeMake(0, len), kCFStringEncodingUTF8, '?', false, tmp, max,
                     &used);
    b_jstr(b, (const char *)tmp, (size_t)used);
    free(tmp);
}

static int cfstr_nonempty(CFStringRef s)
{
    return s && CFGetTypeID(s) == CFStringGetTypeID() && CFStringGetLength(s) > 0;
}

static void b_num(Buf *b, double v)
{
    if (!isfinite(v)) v = 0;
    b_printf(b, "%.6f", v);
}

/* ------------------------------------------------------------------------ */
/* Output. Every thread appends finished lines to one queue; only the main    */
/* thread writes stdout, so a host that stops reading can never block the tap. */

static pthread_mutex_t out_mu = PTHREAD_MUTEX_INITIALIZER;
static Buf outq;
static unsigned long out_dropped;

static void flush_out(void)
{
    pthread_mutex_lock(&out_mu);
    Buf local = outq;
    outq = (Buf){0};
    unsigned long dropped = out_dropped;
    out_dropped = 0;
    pthread_mutex_unlock(&out_mu);
    if (dropped) fprintf(stderr, "clickered-helper: dropped %lu output lines\n", dropped);
    if (local.n) {
        if (fwrite(local.p, 1, local.n, stdout) != local.n || fflush(stdout) != 0)
            exit_requested = 1; /* host gone */
    }
    free(local.p);
}

static void wake_main(void)
{
    if (wake_src) {
        CFRunLoopSourceSignal(wake_src);
        CFRunLoopWakeUp(main_rl);
    }
}

/* Queue one finished JSON object (b is reset). Written immediately on the main thread. */
static void emit_buf(Buf *b)
{
    b_putc(b, '\n');
    pthread_mutex_lock(&out_mu);
    if (outq.n + b->n <= OUTQ_LIMIT) b_putn(&outq, b->p, b->n);
    else out_dropped++;
    pthread_mutex_unlock(&out_mu);
    b->n = 0;
    if (b->p) b->p[0] = 0;
    if (pthread_main_np()) flush_out();
    else wake_main();
}

static void emit_error(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
static void emit_error(const char *fmt, ...)
{
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    Buf b = {0};
    b_puts(&b, "{\"t\":\"error\",\"msg\":");
    b_jstr(&b, msg, strlen(msg));
    b_putc(&b, '}');
    emit_buf(&b);
    free(b.p);
    fprintf(stderr, "clickered-helper: %s\n", msg);
}

/* ------------------------------------------------------------------------ */
/* CoreGraphics window list helpers (thread-safe; used by both threads)      */

static long long dict_ll(CFDictionaryRef d, CFStringRef key, long long def)
{
    CFTypeRef v = CFDictionaryGetValue(d, key);
    long long out = def;
    if (v && CFGetTypeID(v) == CFNumberGetTypeID()) {
        SInt64 x;
        if (CFNumberGetValue((CFNumberRef)v, kCFNumberSInt64Type, &x)) out = (long long)x;
    }
    return out;
}

static double dict_double(CFDictionaryRef d, CFStringRef key, double def)
{
    CFTypeRef v = CFDictionaryGetValue(d, key);
    double out = def;
    if (v && CFGetTypeID(v) == CFNumberGetTypeID()) {
        double x;
        if (CFNumberGetValue((CFNumberRef)v, kCFNumberDoubleType, &x)) out = x;
    }
    return out;
}

static int dict_bool(CFDictionaryRef d, CFStringRef key)
{
    CFTypeRef v = CFDictionaryGetValue(d, key);
    if (!v) return 0;
    if (CFGetTypeID(v) == CFBooleanGetTypeID()) return CFBooleanGetValue((CFBooleanRef)v);
    if (CFGetTypeID(v) == CFNumberGetTypeID()) return dict_ll(d, key, 0) != 0;
    return 0;
}

static int dict_rect(CFDictionaryRef d, CGRect *r)
{
    CFTypeRef v = CFDictionaryGetValue(d, kCGWindowBounds);
    if (!v || CFGetTypeID(v) != CFDictionaryGetTypeID()) return 0;
    return CGRectMakeWithDictionaryRepresentation((CFDictionaryRef)v, r) ? 1 : 0;
}

static CFStringRef dict_str(CFDictionaryRef d, CFStringRef key)
{
    CFTypeRef v = CFDictionaryGetValue(d, key);
    return (v && CFGetTypeID(v) == CFStringGetTypeID()) ? (CFStringRef)v : NULL;
}

static int is_regular_pid(pid_t pid)
{
    int found = 0;
    pthread_mutex_lock(&g_mu);
    for (size_t i = 0; i < g_nregular; i++)
        if (g_regular[i] == pid) {
            found = 1;
            break;
        }
    pthread_mutex_unlock(&g_mu);
    return found;
}

static int is_window_server(CFDictionaryRef d)
{
    CFStringRef owner = dict_str(d, kCGWindowOwnerName);
    return owner && CFStringCompare(owner, CFSTR("Window Server"), 0) == kCFCompareEqualTo;
}

/* Client window predicate on a CG window description (without the onscreen part). */
static int looks_like_client(CFDictionaryRef d, pid_t pid, const CGRect *r)
{
    if (pid <= 0 || pid == self_pid) return 0;
    if (dict_ll(d, kCGWindowLayer, -1) != 0) return 0;
    if (dict_double(d, kCGWindowAlpha, 1.0) <= 0.01) return 0;
    if (r->size.width < MIN_CLIENT_SIZE || r->size.height < MIN_CLIENT_SIZE) return 0;
    return is_regular_pid(pid);
}

typedef struct {
    CGRect r;
    pid_t pid;
    int onscreen;
} WinInfo;

/* Fresh bounds / owner / onscreen state of one window. 0 if it does not exist. */
static int win_info(CGWindowID id, WinInfo *wi)
{
    if (!id) return 0;
    CFArrayRef a = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, id);
    if (!a) return 0;
    int ok = 0;
    for (CFIndex i = 0; i < CFArrayGetCount(a) && !ok; i++) {
        CFDictionaryRef d = CFArrayGetValueAtIndex(a, i);
        if ((CGWindowID)dict_ll(d, kCGWindowNumber, 0) != id) continue;
        if (!dict_rect(d, &wi->r)) continue;
        wi->pid = (pid_t)dict_ll(d, kCGWindowOwnerPID, 0);
        wi->onscreen = dict_bool(d, kCGWindowIsOnscreen);
        ok = 1;
    }
    CFRelease(a);
    return ok;
}

/* Window exists and is on screen (on the current Space, not minimized / hidden). */
static int window_ok(CGWindowID w)
{
    WinInfo wi;
    return win_info(w, &wi) && wi.onscreen;
}

/*
 * Client window at global point p (0 if none): the topmost visible on-screen window
 * containing p, if that is a client window. Our own windows (the pick overlay) are
 * ignored. rect_out (optional) receives its bounds.
 */
static CGWindowID client_at(CGPoint p, CGRect *rect_out)
{
    CFArrayRef a = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!a) return 0;
    CGWindowID found = 0;
    for (CFIndex i = 0; i < CFArrayGetCount(a); i++) {
        CFDictionaryRef d = CFArrayGetValueAtIndex(a, i);
        pid_t pid = (pid_t)dict_ll(d, kCGWindowOwnerPID, 0);
        if (pid == self_pid) continue;
        if (dict_double(d, kCGWindowAlpha, 1.0) <= 0.01) continue;
        if (is_window_server(d)) continue;
        CGRect r;
        if (!dict_rect(d, &r) || !CGRectContainsPoint(r, p)) continue;
        /* front-to-back order: this is the window under the point */
        if (looks_like_client(d, pid, &r)) {
            found = (CGWindowID)dict_ll(d, kCGWindowNumber, 0);
            if (rect_out) *rect_out = r;
        }
        break;
    }
    CFRelease(a);
    return found;
}

static CGPoint pointer_pos(void)
{
    CGPoint p = CGPointZero;
    CGEventRef e = CGEventCreate(NULL);
    if (e) {
        p = CGEventGetLocation(e);
        CFRelease(e);
    }
    return p;
}

static void frac(CGWindowID w, CGPoint p, double *fx, double *fy)
{
    WinInfo wi;
    *fx = *fy = 0;
    if (!w || !win_info(w, &wi) || wi.r.size.width <= 0 || wi.r.size.height <= 0) return;
    *fx = (p.x - wi.r.origin.x) / wi.r.size.width;
    *fy = (p.y - wi.r.origin.y) / wi.r.size.height;
}

/* ------------------------------------------------------------------------ */
/* Accessibility helpers (main thread only)                                  */

static CFTypeRef ax_copy(AXUIElementRef e, CFStringRef attr)
{
    CFTypeRef v = NULL;
    if (!e) return NULL;
    if (AXUIElementCopyAttributeValue(e, attr, &v) != kAXErrorSuccess) {
        if (v) CFRelease(v);
        return NULL;
    }
    return v;
}

static int ax_rect(AXUIElementRef w, CGRect *r)
{
    CFTypeRef p = ax_copy(w, kAXPositionAttribute);
    CFTypeRef s = ax_copy(w, kAXSizeAttribute);
    int ok = 0;
    CGPoint pt;
    CGSize sz;
    if (p && s && CFGetTypeID(p) == AXValueGetTypeID() && CFGetTypeID(s) == AXValueGetTypeID() &&
        AXValueGetValue((AXValueRef)p, kAXValueTypeCGPoint, &pt) &&
        AXValueGetValue((AXValueRef)s, kAXValueTypeCGSize, &sz)) {
        *r = CGRectMake(pt.x, pt.y, sz.width, sz.height);
        ok = 1;
    }
    if (p) CFRelease(p);
    if (s) CFRelease(s);
    return ok;
}

static int rect_close(CGRect a, CGRect b)
{
    return fabs(a.origin.x - b.origin.x) <= 1 && fabs(a.origin.y - b.origin.y) <= 1 &&
           fabs(a.size.width - b.size.width) <= 1 && fabs(a.size.height - b.size.height) <= 1;
}

/* Fallback when _AXUIElementGetWindow is unavailable: the frontmost layer-0 window of
 * pid with (almost) the same frame. Ambiguous for identically placed windows. */
static CGWindowID cg_match_frame(pid_t pid, CGRect axr)
{
    CFArrayRef a = CGWindowListCopyWindowInfo(kCGWindowListOptionAll |
                                                  kCGWindowListExcludeDesktopElements,
                                              kCGNullWindowID);
    if (!a) return 0;
    CGWindowID found = 0;
    for (CFIndex i = 0; i < CFArrayGetCount(a) && !found; i++) {
        CFDictionaryRef d = CFArrayGetValueAtIndex(a, i);
        if ((pid_t)dict_ll(d, kCGWindowOwnerPID, 0) != pid) continue;
        if (dict_ll(d, kCGWindowLayer, -1) != 0) continue;
        CGRect r;
        if (dict_rect(d, &r) && rect_close(r, axr)) found = (CGWindowID)dict_ll(d, kCGWindowNumber, 0);
    }
    CFRelease(a);
    return found;
}

static CGWindowID ax_window_id(AXUIElementRef w, pid_t pid)
{
    if (!w) return 0;
    if (ax_get_window) {
        CGWindowID id = 0;
        if (ax_get_window(w, &id) == kAXErrorSuccess && id) return id;
    }
    CGRect r;
    if (!ax_rect(w, &r)) return 0;
    return cg_match_frame(pid, r);
}

/* AX windows of an app (retained CFArray or NULL). */
static CFArrayRef ax_windows(AXUIElementRef app)
{
    CFTypeRef v = ax_copy(app, kAXWindowsAttribute);
    if (v && CFGetTypeID(v) != CFArrayGetTypeID()) {
        CFRelease(v);
        v = NULL;
    }
    return (CFArrayRef)v;
}

/* The AX element of window id (retained) or NULL. */
static AXUIElementRef ax_find_window(AXUIElementRef app, CGWindowID id, pid_t pid, CGRect cgr)
{
    CFArrayRef wins = ax_windows(app);
    if (!wins) return NULL;
    AXUIElementRef found = NULL, by_frame = NULL;
    for (CFIndex i = 0; i < CFArrayGetCount(wins) && !found; i++) {
        AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(wins, i);
        if (ax_get_window) {
            CGWindowID wid = 0;
            if (ax_get_window(w, &wid) == kAXErrorSuccess && wid) {
                if (wid == id) found = w;
                continue;
            }
        }
        CGRect r;
        if (!by_frame && ax_rect(w, &r) && rect_close(r, cgr)) by_frame = w;
    }
    (void)pid;
    if (!found) found = by_frame;
    if (found) CFRetain(found);
    CFRelease(wins);
    return found;
}

/* Focused window of the frontmost application (0 if unknown). */
static CGWindowID active_window(void)
{
    CGWindowID id = 0;
    pid_t pid = 0;
    CFTypeRef app = ax_copy(ax_system, kAXFocusedApplicationAttribute);
    if (app && CFGetTypeID(app) == AXUIElementGetTypeID()) {
        AXUIElementGetPid((AXUIElementRef)app, &pid);
        CFTypeRef w = ax_copy((AXUIElementRef)app, kAXFocusedWindowAttribute);
        if (w && CFGetTypeID(w) == AXUIElementGetTypeID()) id = ax_window_id((AXUIElementRef)w, pid);
        if (w) CFRelease(w);
    }
    if (app) CFRelease(app);
    if (id) return id;

    /* Fallback: the frontmost on-screen layer-0 window of the frontmost app. */
    if (!pid) pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
    if (pid <= 0) return 0;
    CFArrayRef a = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
    if (!a) return 0;
    for (CFIndex i = 0; i < CFArrayGetCount(a) && !id; i++) {
        CFDictionaryRef d = CFArrayGetValueAtIndex(a, i);
        if ((pid_t)dict_ll(d, kCGWindowOwnerPID, 0) != pid) continue;
        if (dict_ll(d, kCGWindowLayer, -1) != 0) continue;
        id = (CGWindowID)dict_ll(d, kCGWindowNumber, 0);
    }
    CFRelease(a);
    return id;
}

/* ------------------------------------------------------------------------ */
/* Client list (main thread)                                                 */

typedef struct {
    CGWindowID id;
    pid_t pid;
    CGRect r;
    int onscreen;
    CFStringRef owner; /* retained or NULL */
    CFStringRef name;  /* kCGWindowName (needs Screen Recording), retained or NULL */
} Client;

/* pid -> @YES/@NO regular app; pid -> cls string */
static NSMutableDictionary<NSNumber *, NSNumber *> *pid_regular;
static NSMutableDictionary<NSNumber *, NSString *> *pid_cls;
/* window id -> @YES client / @NO not a client (off-screen windows validated via AX once) */
static NSMutableDictionary<NSNumber *, NSNumber *> *known;

static void free_clients(Client *c, size_t n)
{
    for (size_t i = 0; i < n; i++) {
        if (c[i].owner) CFRelease(c[i].owner);
        if (c[i].name) CFRelease(c[i].name);
    }
    free(c);
}

static void note_pid(pid_t pid, CFStringRef owner)
{
    NSNumber *k = @(pid);
    if (pid_regular[k]) return;
    NSRunningApplication *ra = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    BOOL regular = ra && ra.activationPolicy == NSApplicationActivationPolicyRegular;
    pid_regular[k] = @(regular);
    NSString *cls = ra.bundleIdentifier;
    if (cls.length == 0) cls = ra.localizedName;
    if (cls.length == 0 && owner) cls = (__bridge NSString *)owner;
    pid_cls[k] = cls ? [cls copy] : @"";
}

/* Publish the regular-app pid set for the tap thread. */
static void publish_regular(void)
{
    pthread_mutex_lock(&g_mu);
    g_nregular = 0;
    for (NSNumber *k in pid_regular) {
        if (!pid_regular[k].boolValue) continue;
        if (g_nregular == g_capregular) {
            g_capregular = g_capregular ? g_capregular * 2 : 128;
            g_regular = xrealloc(g_regular, g_capregular * sizeof *g_regular);
        }
        g_regular[g_nregular++] = (pid_t)k.intValue;
    }
    pthread_mutex_unlock(&g_mu);
}

/* Window ids (and optionally titles) of an app's AX windows. */
static void ax_scan_app(pid_t pid, NSMutableSet<NSNumber *> *ids,
                        NSMutableDictionary<NSNumber *, NSString *> *titles)
{
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    if (!app) return;
    CFArrayRef wins = ax_windows(app);
    if (wins) {
        for (CFIndex i = 0; i < CFArrayGetCount(wins); i++) {
            AXUIElementRef w = (AXUIElementRef)CFArrayGetValueAtIndex(wins, i);
            CGWindowID id = ax_window_id(w, pid);
            if (!id) continue;
            [ids addObject:@(id)];
            if (titles) {
                CFTypeRef t = ax_copy(w, kAXTitleAttribute);
                if (t && CFGetTypeID(t) == CFStringGetTypeID() && CFStringGetLength(t) > 0)
                    titles[@(id)] = (NSString *)CFBridgingRelease(t);
                else if (t)
                    CFRelease(t);
            }
        }
        CFRelease(wins);
    }
    CFRelease(app);
}

/*
 * Current client windows in front-to-back order. A client window is a layer-0, visible,
 * not-tiny window owned by a regular app that is on screen, or that was a client when we
 * last saw it on screen, or (first seen off screen, e.g. minimized at startup) that the
 * app reports through Accessibility. Off-screen junk windows (offscreen buffers etc.)
 * are filtered out that way.
 */
static size_t collect_clients(Client **out)
{
    *out = NULL;
    CFArrayRef a = CGWindowListCopyWindowInfo(kCGWindowListOptionAll |
                                                  kCGWindowListExcludeDesktopElements,
                                              kCGNullWindowID);
    if (!a) return 0;
    CFIndex na = CFArrayGetCount(a);

    NSMutableSet<NSNumber *> *seen_pids = [NSMutableSet set];
    for (CFIndex i = 0; i < na; i++) {
        CFDictionaryRef d = CFArrayGetValueAtIndex(a, i);
        if (dict_ll(d, kCGWindowLayer, -1) != 0) continue;
        pid_t pid = (pid_t)dict_ll(d, kCGWindowOwnerPID, 0);
        if (pid <= 0 || pid == self_pid) continue;
        [seen_pids addObject:@(pid)];
        note_pid(pid, dict_str(d, kCGWindowOwnerName));
    }
    for (NSNumber *k in [pid_regular allKeys])
        if (![seen_pids containsObject:k]) {
            [pid_regular removeObjectForKey:k];
            [pid_cls removeObjectForKey:k];
        }
    publish_regular();

    Client *c = xrealloc(NULL, (size_t)(na ? na : 1) * sizeof *c);
    size_t n = 0;
    NSMutableDictionary<NSNumber *, NSNumber *> *nknown = [NSMutableDictionary dictionary];
    NSMutableDictionary<NSNumber *, NSMutableSet<NSNumber *> *> *ax_ids = [NSMutableDictionary dictionary];
    for (CFIndex i = 0; i < na; i++) {
        CFDictionaryRef d = CFArrayGetValueAtIndex(a, i);
        pid_t pid = (pid_t)dict_ll(d, kCGWindowOwnerPID, 0);
        CGRect r;
        if (!dict_rect(d, &r)) continue;
        if (!looks_like_client(d, pid, &r)) continue;
        CGWindowID id = (CGWindowID)dict_ll(d, kCGWindowNumber, 0);
        if (!id) continue;
        int on = dict_bool(d, kCGWindowIsOnscreen);
        NSNumber *k = @(id);
        BOOL is_client;
        if (on) {
            is_client = YES;
        } else if (known[k]) {
            is_client = known[k].boolValue;
        } else {
            NSMutableSet<NSNumber *> *ids = ax_ids[@(pid)];
            if (!ids) {
                ids = [NSMutableSet set];
                ax_scan_app(pid, ids, nil);
                ax_ids[@(pid)] = ids;
            }
            is_client = [ids containsObject:k];
        }
        nknown[k] = @(is_client);
        if (!is_client) continue;
        Client *e = &c[n++];
        e->id = id;
        e->pid = pid;
        e->r = r;
        e->onscreen = on;
        e->owner = dict_str(d, kCGWindowOwnerName);
        if (e->owner) CFRetain(e->owner);
        e->name = dict_str(d, kCGWindowName);
        if (e->name) CFRetain(e->name);
    }
    known = nknown;
    CFRelease(a);
    *out = c;
    return n;
}

static int cmp_u32(const void *a, const void *b)
{
    uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

/* Signature of what a windows message reports structurally (ids, mapped, active). */
static char *signature(const Client *c, size_t n, CGWindowID active)
{
    uint32_t *v = xrealloc(NULL, (n ? n : 1) * sizeof *v);
    for (size_t i = 0; i < n; i++) v[i] = (uint32_t)c[i].id << 1 | (c[i].onscreen ? 1u : 0u);
    qsort(v, n, sizeof *v, cmp_u32);
    Buf b = {0};
    b_printf(&b, "%u;", (unsigned)active);
    for (size_t i = 0; i < n; i++) b_printf(&b, "%u,", (unsigned)v[i]);
    free(v);
    if (!b.p) b_puts(&b, "");
    return b.p;
}

static void emit_windows(void)
{
    windows_due = 0;
    Client *c;
    size_t n = collect_clients(&c);
    CGWindowID act = active_window();

    NSMutableDictionary<NSNumber *, NSString *> *titles = [NSMutableDictionary dictionary];
    NSMutableSet<NSNumber *> *pids = [NSMutableSet set];
    for (size_t i = 0; i < n; i++) [pids addObject:@(c[i].pid)];
    for (NSNumber *p in pids) ax_scan_app((pid_t)p.intValue, [NSMutableSet set], titles);

    Buf b = {0};
    b_printf(&b, "{\"t\":\"windows\",\"active\":%u,\"list\":[", (unsigned)act);
    for (size_t i = 0; i < n; i++) {
        if (i) b_putc(&b, ',');
        b_printf(&b, "{\"id\":%u,\"title\":", (unsigned)c[i].id);
        NSString *t = titles[@(c[i].id)];
        if (t.length) b_jcfstr(&b, (__bridge CFStringRef)t);
        else if (cfstr_nonempty(c[i].name)) b_jcfstr(&b, c[i].name);
        else b_jcfstr(&b, c[i].owner);
        b_puts(&b, ",\"cls\":");
        NSString *cls = pid_cls[@(c[i].pid)];
        if (cls.length) b_jcfstr(&b, (__bridge CFStringRef)cls);
        else b_jcfstr(&b, c[i].owner);
        b_printf(&b, ",\"pid\":%d,\"x\":%ld,\"y\":%ld,\"w\":%ld,\"h\":%ld,\"mapped\":%s}",
                 (int)c[i].pid, lround(c[i].r.origin.x), lround(c[i].r.origin.y),
                 lround(c[i].r.size.width), lround(c[i].r.size.height),
                 c[i].onscreen ? "true" : "false");
    }
    b_puts(&b, "]}");
    emit_buf(&b);
    free(b.p);

    free(last_sig);
    last_sig = signature(c, n, act);
    free_clients(c, n);
}

/* Cheap periodic change check; schedules a debounced windows message on change. */
static void poll_windows(void)
{
    Client *c;
    size_t n = collect_clients(&c);
    char *sig = signature(c, n, active_window());
    free_clients(c, n);
    if (!last_sig || strcmp(sig, last_sig) != 0) {
        if (!windows_due) windows_due = now_ms() + WINDOWS_DEBOUNCE_MS;
    }
    free(sig);
}

/* ------------------------------------------------------------------------ */
/* Pick overlay (main thread). The helper is a background process, so it      */
/* cannot reliably change the cursor; instead it highlights the window that a */
/* click would pick with a click-through, borderless overlay at a high level. */

@interface CKHighlightView : NSView
@end

@implementation CKHighlightView
- (void)drawRect:(NSRect)dirty
{
    (void)dirty;
    NSRect b = self.bounds;
    [[NSColor colorWithCalibratedRed:0.20 green:0.55 blue:1.0 alpha:0.20] setFill];
    NSRectFill(b);
    NSBezierPath *border = [NSBezierPath bezierPathWithRect:NSInsetRect(b, 2, 2)];
    border.lineWidth = 4;
    [[NSColor colorWithCalibratedRed:0.20 green:0.55 blue:1.0 alpha:0.95] setStroke];
    [border stroke];
    /* crosshair through the centre */
    NSBezierPath *cross = [NSBezierPath bezierPath];
    CGFloat cx = NSMidX(b), cy = NSMidY(b), arm = 18;
    [cross moveToPoint:NSMakePoint(cx - arm, cy)];
    [cross lineToPoint:NSMakePoint(cx + arm, cy)];
    [cross moveToPoint:NSMakePoint(cx, cy - arm)];
    [cross lineToPoint:NSMakePoint(cx, cy + arm)];
    cross.lineWidth = 2;
    [cross stroke];
}
@end

static NSWindow *ov_window;

/* CG global rect (top-left origin, y down) -> Cocoa screen rect (bottom-left, y up). */
static NSRect cocoa_rect(CGRect r)
{
    CGFloat h = CGDisplayBounds(CGMainDisplayID()).size.height;
    return NSMakeRect(r.origin.x, h - r.origin.y - r.size.height, r.size.width, r.size.height);
}

static void apply_overlay(void)
{
    pthread_mutex_lock(&g_mu);
    int dirty = ov_dirty, vis = ov_visible;
    CGRect r = ov_rect;
    ov_dirty = 0;
    pthread_mutex_unlock(&g_mu);
    if (!dirty) return;
    if (!vis || CGRectIsEmpty(r)) {
        if (ov_window) [ov_window orderOut:nil];
        return;
    }
    if (!ov_window) {
        NSWindow *w = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 100, 100)
                                                  styleMask:NSWindowStyleMaskBorderless
                                                    backing:NSBackingStoreBuffered
                                                      defer:NO];
        w.releasedWhenClosed = NO;
        w.opaque = NO;
        w.backgroundColor = NSColor.clearColor;
        w.hasShadow = NO;
        w.ignoresMouseEvents = YES;
        w.level = NSScreenSaverWindowLevel;
        w.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
                               NSWindowCollectionBehaviorStationary |
                               NSWindowCollectionBehaviorIgnoresCycle |
                               NSWindowCollectionBehaviorFullScreenAuxiliary;
        w.contentView = [[CKHighlightView alloc] initWithFrame:NSMakeRect(0, 0, 100, 100)];
        ov_window = w;
    }
    [ov_window setFrame:cocoa_rect(r) display:YES];
    [ov_window.contentView setNeedsDisplay:YES];
    [ov_window orderFrontRegardless];
}

/* Any thread: request the overlay over rect (empty / !visible = hidden). */
static void overlay_want(int visible, CGRect r)
{
    pthread_mutex_lock(&g_mu);
    ov_visible = visible;
    ov_rect = r;
    ov_dirty = 1;
    pthread_mutex_unlock(&g_mu);
    if (pthread_main_np()) apply_overlay();
    else wake_main();
}

/* ------------------------------------------------------------------------ */
/* Capture (tap thread)                                                      */

/* tap-thread-only state */
static unsigned held_mask;      /* X buttons whose press was reported */
static CGWindowID gesture_win;
static long long last_motion_ms = -1000;
static int motion_pending;
static CGPoint last_motion_pt;
static uint32_t swallowed_mask; /* CG buttons whose physical press we dropped */
static long long last_hover_ms;

static int input_suppressed(void)
{
    return seq_running || now_ms() < suppress_until;
}

/* CG button number -> X11 button number (1 left, 2 middle, 3 right, 8/9 back/forward). */
static int x_button_from_cg(int cg)
{
    switch (cg) {
    case 0: return 1;
    case 1: return 3;
    case 2: return 2;
    default: return cg + 5;
    }
}

static void emit_picked(CGWindowID w)
{
    Buf b = {0};
    b_printf(&b, "{\"t\":\"picked\",\"win\":%u}", (unsigned)w);
    emit_buf(&b);
    free(b.p);
}

static void tap_arm_timer(void)
{
    if (!tap_timer) return;
    long long t = now_ms(), due = -1;
    if (motion_pending) due = last_motion_ms + MOTION_INTERVAL_MS;
    pthread_mutex_lock(&g_mu);
    if (pick_state == 2 && (due < 0 || pick_deadline < due)) due = pick_deadline;
    pthread_mutex_unlock(&g_mu);
    CFAbsoluteTime when = due < 0 ? CFAbsoluteTimeGetCurrent() + 1.0e7
                                  : CFAbsoluteTimeGetCurrent() + (double)(due > t ? due - t : 0) / 1000.0;
    CFRunLoopTimerSetNextFireDate(tap_timer, when);
}

static void emit_motion(CGPoint p)
{
    double fx, fy;
    frac(gesture_win, p, &fx, &fy);
    Buf b = {0};
    b_printf(&b, "{\"t\":\"motion\",\"win\":%u,\"fx\":", (unsigned)gesture_win);
    b_num(&b, fx);
    b_puts(&b, ",\"fy\":");
    b_num(&b, fy);
    b_printf(&b, ",\"x\":%d,\"y\":%d,\"time\":%lld}", (int)floor(p.x), (int)floor(p.y), now_ms());
    emit_buf(&b);
    free(b.p);
    last_motion_ms = now_ms();
    motion_pending = 0;
}

static void report_button(int xb, int down, CGPoint p)
{
    if (xb < 1 || xb > 31) return;
    unsigned bit = 1u << xb;
    if (down) {
        if (input_suppressed() || pick_state) return;
        if (held_mask & bit) return;
        if (held_mask == 0) {
            gesture_win = client_at(p, NULL);
            motion_pending = 0;
        }
        held_mask |= bit;
    } else {
        if (!(held_mask & bit)) return;
        held_mask &= ~bit;
        if (held_mask == 0) motion_pending = 0;
        if (input_suppressed() || pick_state) return;
    }
    double fx, fy;
    frac(gesture_win, p, &fx, &fy);
    Buf b = {0};
    b_printf(&b, "{\"t\":\"btn\",\"down\":%s,\"button\":%d,\"win\":%u,\"fx\":",
             down ? "true" : "false", xb, (unsigned)gesture_win);
    b_num(&b, fx);
    b_puts(&b, ",\"fy\":");
    b_num(&b, fy);
    b_printf(&b, ",\"x\":%d,\"y\":%d,\"time\":%lld}", (int)floor(p.x), (int)floor(p.y), now_ms());
    emit_buf(&b);
    free(b.p);
}

/* The picked click's button came up (or timed out): end the pick, or go again.
 * Caller holds g_mu. Returns 1 if the overlay must be hidden. */
static int pick_release_locked(void)
{
    if (pick_rearm) {
        pick_rearm = 0;
        pick_state = 1;
        return 0;
    }
    pick_state = 0;
    return 1;
}

static void pick_hover(CGPoint p, int force)
{
    long long t = now_ms();
    if (!force && t - last_hover_ms < PICK_HOVER_INTERVAL_MS) return;
    last_hover_ms = t;
    CGRect r = CGRectNull;
    if (!client_at(p, &r)) r = CGRectNull;
    overlay_want(1, r);
}

/* A physical press while a pick is active (always swallowed by the caller). */
static void pick_on_down(int cgb, CGPoint p)
{
    CGWindowID w = cgb == 0 ? client_at(p, NULL) : 0;
    pthread_mutex_lock(&g_mu);
    if (pick_state == 1 && (cgb == 0 || cgb == 1)) {
        emit_picked(w); /* right click: 0 = cancelled */
        pick_state = 2;
        pick_cgbutton = cgb;
        pick_deadline = now_ms() + PICK_RELEASE_TIMEOUT_MS;
    }
    pthread_mutex_unlock(&g_mu);
    tap_arm_timer();
}

static void pick_on_up(int cgb)
{
    int hide = 0;
    pthread_mutex_lock(&g_mu);
    if (pick_state == 2 && cgb == pick_cgbutton) hide = pick_release_locked();
    pthread_mutex_unlock(&g_mu);
    if (hide) overlay_want(0, CGRectNull);
    tap_arm_timer();
}

static void tap_timer_cb(CFRunLoopTimerRef timer, void *info)
{
    (void)timer;
    (void)info;
    long long t = now_ms();
    if (motion_pending && t - last_motion_ms >= MOTION_INTERVAL_MS) {
        if (held_mask && !input_suppressed() && !pick_state) emit_motion(last_motion_pt);
        else motion_pending = 0;
    }
    int hide = 0;
    pthread_mutex_lock(&g_mu);
    if (pick_state == 2 && t >= pick_deadline) hide = pick_release_locked();
    pthread_mutex_unlock(&g_mu);
    if (hide) overlay_want(0, CGRectNull);
    tap_arm_timer();
}

static int is_own_event(CGEventRef ev)
{
    return CGEventGetIntegerValueField(ev, kCGEventSourceUserData) == INJECT_TAG ||
           CGEventGetIntegerValueField(ev, kCGEventSourceUnixProcessID) == (int64_t)self_pid;
}

static CGEventRef on_mouse_button(CGEventRef ev, CGEventType type)
{
    int down, cgb;
    switch (type) {
    case kCGEventLeftMouseDown: down = 1; cgb = 0; break;
    case kCGEventLeftMouseUp: down = 0; cgb = 0; break;
    case kCGEventRightMouseDown: down = 1; cgb = 1; break;
    case kCGEventRightMouseUp: down = 0; cgb = 1; break;
    case kCGEventOtherMouseDown:
        down = 1;
        cgb = (int)CGEventGetIntegerValueField(ev, kCGMouseEventButtonNumber);
        break;
    default:
        down = 0;
        cgb = (int)CGEventGetIntegerValueField(ev, kCGMouseEventButtonNumber);
        break;
    }
    if (cgb < 0 || cgb > 31) return ev;
    uint32_t bit = 1u << cgb;
    CGPoint p = CGEventGetLocation(ev);
    int xb = x_button_from_cg(cgb);
    if (!down) {
        if (swallowed_mask & bit) {
            /* its press never reached an app: swallow the release too */
            swallowed_mask &= ~bit;
            pick_on_up(cgb);
            report_button(xb, 0, p); /* clears held state if any; never reported */
            return NULL;
        }
        report_button(xb, 0, p);
        return ev;
    }
    if (pick_state) {
        pick_on_down(cgb, p);
        swallowed_mask |= bit;
        return NULL;
    }
    if (seq_running) {
        /* mouse lock: physical presses must not disturb the replay */
        swallowed_mask |= bit;
        return NULL;
    }
    report_button(xb, 1, p);
    return ev;
}

static CGEventRef on_drag(CGEventRef ev)
{
    if (seq_running || swallowed_mask) return NULL;
    CGPoint p = CGEventGetLocation(ev);
    if (held_mask && !input_suppressed() && !pick_state) {
        last_motion_pt = p;
        if (now_ms() - last_motion_ms >= MOTION_INTERVAL_MS) {
            emit_motion(p);
        } else if (!motion_pending) {
            motion_pending = 1;
            tap_arm_timer();
        }
    }
    return ev;
}

static CGEventRef on_scroll(CGEventRef ev)
{
    if (seq_running || pick_state) return NULL; /* lock / swallowed by pick */
    /* Momentum (inertia) events are synthesized after the fingers lift; X11 never
     * reports those as wheel buttons, so neither do we. */
    if (CGEventGetIntegerValueField(ev, kCGScrollWheelEventMomentumPhase) != 0) return ev;
    int64_t d1 = CGEventGetIntegerValueField(ev, kCGScrollWheelEventDeltaAxis1);
    int64_t d2 = CGEventGetIntegerValueField(ev, kCGScrollWheelEventDeltaAxis2);
    CGPoint p = CGEventGetLocation(ev);
    int b = 0;
    if (d1 > 0) b = 4;
    else if (d1 < 0) b = 5;
    if (b) {
        report_button(b, 1, p);
        report_button(b, 0, p);
    }
    b = 0;
    if (d2 > 0) b = 6;
    else if (d2 < 0) b = 7;
    if (b) {
        report_button(b, 1, p);
        report_button(b, 0, p);
    }
    return ev;
}

static void on_key_down(CGEventRef ev)
{
    if (CGEventGetIntegerValueField(ev, kCGKeyboardEventKeycode) != KEYCODE_ESCAPE) return;
    if (CGEventGetIntegerValueField(ev, kCGKeyboardEventAutorepeat) != 0) return;
    /* Panic key: abort the running seq and always report it. Never swallowed. */
    if (seq_running) abort_flag = 1;
    Buf b = {0};
    b_printf(&b, "{\"t\":\"esc\",\"time\":%lld}", now_ms());
    emit_buf(&b);
    free(b.p);
}

static CGEventRef tap_cb(CGEventTapProxy proxy, CGEventType type, CGEventRef ev, void *info)
{
    (void)proxy;
    (void)info;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
        if (g_tap) CGEventTapEnable(g_tap, true);
        return ev;
    }
    if (!ev || is_own_event(ev)) return ev;
    switch (type) {
    case kCGEventKeyDown:
        on_key_down(ev);
        return ev;
    case kCGEventLeftMouseDown:
    case kCGEventLeftMouseUp:
    case kCGEventRightMouseDown:
    case kCGEventRightMouseUp:
    case kCGEventOtherMouseDown:
    case kCGEventOtherMouseUp:
        return on_mouse_button(ev, type);
    case kCGEventLeftMouseDragged:
    case kCGEventRightMouseDragged:
    case kCGEventOtherMouseDragged:
        return on_drag(ev);
    case kCGEventMouseMoved:
        if (seq_running) return NULL;
        if (pick_state) pick_hover(CGEventGetLocation(ev), 0);
        return ev;
    case kCGEventScrollWheel:
        return on_scroll(ev);
    default:
        return ev;
    }
}

static void *tap_thread_main(void *arg)
{
    (void)arg;
    @autoreleasepool {
        pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0);
        CFRunLoopRef rl = CFRunLoopGetCurrent();
        CFRunLoopSourceRef s = CFMachPortCreateRunLoopSource(NULL, g_tap, 0);
        CFRunLoopAddSource(rl, s, kCFRunLoopCommonModes);
        CFRelease(s);
        tap_timer = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + 1.0e7, 1.0e7, 0, 0,
                                         tap_timer_cb, NULL);
        CFRunLoopAddTimer(rl, tap_timer, kCFRunLoopCommonModes);
        CGEventTapEnable(g_tap, true);
    }
    CFRunLoopRun();
    return NULL;
}

static int create_tap(void)
{
    CGEventMask mask = CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
                       CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp) |
                       CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
                       CGEventMaskBit(kCGEventLeftMouseDragged) |
                       CGEventMaskBit(kCGEventRightMouseDragged) |
                       CGEventMaskBit(kCGEventOtherMouseDragged) |
                       CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventScrollWheel) |
                       CGEventMaskBit(kCGEventKeyDown);
    g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault,
                             mask, tap_cb, NULL);
    return g_tap != NULL;
}

/* ------------------------------------------------------------------------ */
/* Pick (main thread side)                                                   */

static void pick_start(void)
{
    pthread_mutex_lock(&g_mu);
    if (pick_state == 2) {
        /* Picking several windows in a row: keep swallowing, wait for the next click. */
        pick_rearm = 1;
        pthread_mutex_unlock(&g_mu);
        return;
    }
    if (pick_state) {
        pthread_mutex_unlock(&g_mu);
        emit_error("pick already active");
        return;
    }
    pick_rearm = 0;
    pick_state = 1;
    pthread_mutex_unlock(&g_mu);
    CGRect r = CGRectNull;
    if (!client_at(pointer_pos(), &r)) r = CGRectNull;
    overlay_want(1, r);
}

static void pick_cancel(void)
{
    int hide = 0, reply = 0;
    pthread_mutex_lock(&g_mu);
    if (pick_state == 1) {
        pick_state = 0;
        pick_rearm = 0;
        hide = reply = 1;
    } else if (pick_state == 2 && pick_rearm) {
        pick_rearm = 0; /* the pick ends with the pending release */
        reply = 1;
    }
    pthread_mutex_unlock(&g_mu);
    if (hide) overlay_want(0, CGRectNull);
    if (reply) emit_picked(0);
}

/* ------------------------------------------------------------------------ */
/* stdin                                                                     */

typedef struct Line {
    struct Line *next;
    char s[];
} Line;

static Line *q_head, *q_tail;
static char *inbuf;
static size_t inlen, incap;

static char *trim(char *s)
{
    while (*s == ' ' || *s == '\t' || *s == '\r') s++;
    size_t l = strlen(s);
    while (l && (s[l - 1] == ' ' || s[l - 1] == '\t' || s[l - 1] == '\r')) s[--l] = 0;
    return s;
}

static void push_line(const char *s, size_t n)
{
    Line *l = xrealloc(NULL, sizeof(Line) + n + 1);
    memcpy(l->s, s, n);
    l->s[n] = 0;
    l->next = NULL;
    if (seq_running && strcmp(trim(l->s), "abort") == 0) {
        abort_flag = 1;
        free(l);
        return;
    }
    if (q_tail) q_tail->next = l;
    else q_head = l;
    q_tail = l;
}

static Line *pop_line(void)
{
    Line *l = q_head;
    if (l) {
        q_head = l->next;
        if (!q_head) q_tail = NULL;
    }
    return l;
}

static void read_stdin(void)
{
    if (stdin_eof) return;
    for (;;) {
        if (incap - inlen < 4096) {
            incap = incap ? incap * 2 : 65536;
            inbuf = xrealloc(inbuf, incap);
        }
        ssize_t r = read(STDIN_FILENO, inbuf + inlen, incap - inlen);
        if (r > 0) {
            inlen += (size_t)r;
            continue;
        }
        if (r == 0) {
            stdin_eof = 1;
            break;
        }
        if (errno == EINTR) {
            if (exit_requested) break;
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        stdin_eof = 1; /* treat other errors like EOF */
        break;
    }
    size_t start = 0;
    for (size_t i = 0; i < inlen; i++) {
        if (inbuf[i] == '\n') {
            push_line(inbuf + start, i - start);
            start = i + 1;
        }
    }
    if (start) {
        memmove(inbuf, inbuf + start, inlen - start);
        inlen -= start;
    }
    if (stdin_eof && inlen) inlen = 0; /* unterminated partial line is dropped */
}

static void stdin_cb(CFFileDescriptorRef f, CFOptionFlags flags, void *info)
{
    (void)flags;
    (void)info;
    read_stdin();
    if (!stdin_eof) CFFileDescriptorEnableCallBacks(f, kCFFileDescriptorReadCallBack);
}

/* ------------------------------------------------------------------------ */
/* Main run loop servicing                                                   */

static void wake_perform(void *info)
{
    (void)info;
    flush_out();
    apply_overlay();
}

/* Dispatch pending AppKit events (our only window is click-through, but the
 * window server still talks to us). Never blocks. */
static void pump_appkit(void)
{
    for (int i = 0; i < 64; i++) {
        NSEvent *e = [NSApp nextEventMatchingMask:NSEventMaskAny
                                        untilDate:[NSDate distantPast]
                                           inMode:NSDefaultRunLoopMode
                                          dequeue:YES];
        if (!e) break;
        [NSApp sendEvent:e];
    }
}

/* Run the main run loop for at most `seconds`, returning early when a source fired. */
static void run_slice(double seconds)
{
    @autoreleasepool {
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds > 0 ? seconds : 0, true);
        pump_appkit();
        flush_out();
    }
}

static void tick_cb(CFRunLoopTimerRef timer, void *info)
{
    (void)timer;
    (void)info;
    if (seq_running) return; /* keep replay timing tight; caught up right after */
    @autoreleasepool {
        long long t = now_ms();
        if (t >= next_poll_ms) {
            next_poll_ms = t + WINDOWS_POLL_MS;
            poll_windows();
        }
        if (windows_due && now_ms() >= windows_due) emit_windows();
    }
}

/* ------------------------------------------------------------------------ */
/* Waiting (non-blocking sleep)                                              */

static int seq_interrupted(void)
{
    return abort_flag || stdin_eof || exit_requested;
}

/*
 * Wait up to ms milliseconds while servicing stdin, the tap's output and timers. If
 * wait_active is set, return early as soon as it is the active window. Returns 0 if the
 * seq was interrupted (abort / EOF / signal / Escape), 1 otherwise.
 */
static int seq_wait(long long ms, CGWindowID wait_active)
{
    long long deadline = now_ms() + ms;
    for (;;) {
        run_slice(0);
        if (seq_interrupted()) return 0;
        if (wait_active && active_window() == wait_active) return 1;
        long long left = deadline - now_ms();
        if (left <= 0) return !seq_interrupted();
        long long slice = wait_active ? 10 : 5;
        if (slice > left) slice = left;
        run_slice((double)slice / 1000.0);
    }
}

/* ------------------------------------------------------------------------ */
/* Injection (main thread)                                                   */

static CGEventSourceRef inj_src;
static CGPoint cur;                 /* where our injected pointer is */
static unsigned char held_btn[256]; /* X buttons pressed by the seq */
static int held_click_state[32];    /* per CG button: click state of its press */
static long long last_down_ms = -100000;
static int last_down_cg = -1;
static CGPoint last_down_pt;
static int last_click_state;
static long long dbl_click_ms = 500;

static void post(CGEventRef e)
{
    if (!e) return;
    CGEventSetIntegerValueField(e, kCGEventSourceUserData, INJECT_TAG);
    /* behave like XTest: the physical modifier state applies to injected input */
    CGEventSetFlags(e, CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState));
    CGEventPost(kCGHIDEventTap, e);
    CFRelease(e);
}

/* X button -> CG button (-1: none / wheel). */
static int cg_button_from_x(int xb)
{
    switch (xb) {
    case 1: return 0;
    case 2: return 2;
    case 3: return 1;
    default: return xb >= 8 && xb - 5 <= 31 ? xb - 5 : -1;
    }
}

/* Lowest CG button the seq holds, preferring left, then right (-1: none). */
static int held_cg_button(void)
{
    if (held_btn[1]) return 0;
    if (held_btn[3]) return 1;
    if (held_btn[2]) return 2;
    for (int xb = 8; xb < 256; xb++)
        if (held_btn[xb]) return cg_button_from_x(xb);
    return -1;
}

static int any_btn_held(void)
{
    return held_cg_button() >= 0;
}

static void warp(CGPoint p)
{
    int hb = held_cg_button();
    CGEventType t;
    CGMouseButton mb = kCGMouseButtonLeft;
    if (hb < 0) {
        t = kCGEventMouseMoved;
    } else if (hb == 0) {
        t = kCGEventLeftMouseDragged;
    } else if (hb == 1) {
        t = kCGEventRightMouseDragged;
        mb = kCGMouseButtonRight;
    } else {
        t = kCGEventOtherMouseDragged;
        mb = (CGMouseButton)hb;
    }
    CGEventRef e = CGEventCreateMouseEvent(inj_src, t, p, mb);
    if (!e) return;
    CGEventSetIntegerValueField(e, kCGMouseEventDeltaX, (int64_t)lround(p.x - cur.x));
    CGEventSetIntegerValueField(e, kCGMouseEventDeltaY, (int64_t)lround(p.y - cur.y));
    cur = p;
    post(e);
}

static void scroll_tick(int xb)
{
    int32_t w1 = xb == 4 ? 1 : xb == 5 ? -1 : 0;
    int32_t w2 = xb == 6 ? 1 : xb == 7 ? -1 : 0;
    CGEventRef e = CGEventCreateScrollWheelEvent2(inj_src, kCGScrollEventUnitLine, 2, w1, w2, 0);
    if (!e) return;
    CGEventSetLocation(e, cur);
    post(e);
}

static void button(int xb, int down)
{
    if (xb >= 4 && xb <= 7) {
        if (down) scroll_tick(xb); /* a wheel "press" is one tick; its release is a no-op */
        return;
    }
    int cg = cg_button_from_x(xb);
    if (cg < 0) return;
    CGEventType t;
    if (cg == 0) t = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
    else if (cg == 1) t = down ? kCGEventRightMouseDown : kCGEventRightMouseUp;
    else t = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp;
    int cs;
    if (down) {
        /* macOS apps detect double clicks from the click state, not from timing */
        long long t_ms = now_ms();
        if (cg == last_down_cg && t_ms - last_down_ms <= dbl_click_ms &&
            fabs(cur.x - last_down_pt.x) <= 4 && fabs(cur.y - last_down_pt.y) <= 4)
            cs = last_click_state + 1;
        else
            cs = 1;
        last_down_cg = cg;
        last_down_ms = t_ms;
        last_down_pt = cur;
        last_click_state = cs;
        held_click_state[cg] = cs;
    } else {
        cs = held_click_state[cg] > 0 ? held_click_state[cg] : 1;
    }
    CGEventRef e = CGEventCreateMouseEvent(inj_src, t, cur, (CGMouseButton)cg);
    if (!e) return;
    CGEventSetIntegerValueField(e, kCGMouseEventClickState, cs);
    held_btn[xb] = down ? 1 : 0;
    post(e);
}

static void release_all(void)
{
    for (int i = 1; i < 256; i++)
        if (held_btn[i]) button(i, 0);
}

/*
 * Activate + raise; wait (bounded) until it is the active window. Returns 1 only if w is
 * the active window afterwards; 0 if the app refused or was too slow, or on interrupt.
 */
static int activate(CGWindowID w)
{
    WinInfo wi;
    if (!win_info(w, &wi)) return 0;
    AXUIElementRef app = AXUIElementCreateApplication(wi.pid);
    if (app) {
        AXUIElementRef axw = ax_find_window(app, w, wi.pid, wi.r);
        if (axw) {
            AXUIElementSetAttributeValue(axw, kAXMainAttribute, kCFBooleanTrue);
            AXUIElementPerformAction(axw, kAXRaiseAction);
            CFRelease(axw);
        }
        AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);
        CFRelease(app);
    }
    NSRunningApplication *ra = [NSRunningApplication runningApplicationWithProcessIdentifier:wi.pid];
    if (ra && !ra.active) [ra activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    if (active_window() == w) return 1;
    if (!seq_wait(ACTIVATE_WAIT_MS, w)) return 0;
    return active_window() == w;
}

/* Wait (bounded) until the client under the pointer is w, e.g. while windows restack. */
static int pointer_on(CGWindowID w)
{
    long long deadline = now_ms() + POINTER_SETTLE_MS;
    for (;;) {
        if (client_at(cur, NULL) == w) return 1;
        if (now_ms() >= deadline) return 0;
        if (!seq_wait(10, 0)) return 0;
    }
}

static double frac_to_pt(double f, double origin, double size)
{
    double v = floor(f * size);
    if (f >= 0 && f <= 1) {
        if (v > size - 1) v = size - 1;
        if (v < 0) v = 0;
    }
    return origin + v;
}

static CGPoint frac_point(const CGRect *r, double fx, double fy)
{
    return CGPointMake(frac_to_pt(fx, r->origin.x, r->size.width),
                       frac_to_pt(fy, r->origin.y, r->size.height));
}

/* ------------------------------------------------------------------------ */
/* seq                                                                       */

typedef struct {
    char op; /* f m d u s w */
    unsigned long win;
    double fx, fy;
    long a, b;
} Op;

static int parse_ops(char *s, Op **out_ops, size_t *out_n, char *err, size_t errlen)
{
    Op *ops = NULL;
    size_t n = 0, cap = 0;
    char *save = NULL;
    for (char *seg = strtok_r(s, ";", &save); seg; seg = strtok_r(NULL, ";", &save)) {
        char *t = trim(seg);
        if (!*t) continue;
        char *tok[4];
        int nt = 0;
        char *s2 = NULL;
        for (char *w = strtok_r(t, " \t", &s2); w; w = strtok_r(NULL, " \t", &s2)) {
            if (nt == 4) {
                nt = 5;
                break;
            }
            tok[nt++] = w;
        }
        Op o;
        memset(&o, 0, sizeof o);
        char *end;
        int ok = 1;
#define NUMUL(i, dst)                                    \
    do {                                                 \
        errno = 0;                                       \
        (dst) = strtoul(tok[i], &end, 0);                \
        if (errno || *end || end == tok[i]) ok = 0;      \
    } while (0)
#define NUML(i, dst)                                     \
    do {                                                 \
        errno = 0;                                       \
        (dst) = strtol(tok[i], &end, 10);                \
        if (errno || *end || end == tok[i]) ok = 0;      \
    } while (0)
#define NUMD(i, dst)                                     \
    do {                                                 \
        errno = 0;                                       \
        (dst) = strtod(tok[i], &end);                    \
        if (errno || *end || end == tok[i] || !isfinite(dst) || fabs(dst) > FRAC_LIMIT) ok = 0; \
    } while (0)
        if (nt == 2 && strcmp(tok[0], "f") == 0) {
            o.op = 'f';
            NUMUL(1, o.win);
        } else if (nt == 4 && strcmp(tok[0], "m") == 0) {
            o.op = 'm';
            NUMUL(1, o.win);
            NUMD(2, o.fx);
            NUMD(3, o.fy);
        } else if (nt == 2 && (strcmp(tok[0], "d") == 0 || strcmp(tok[0], "u") == 0)) {
            o.op = tok[0][0];
            NUML(1, o.a);
            if (o.a < 1 || o.a > 255) ok = 0;
        } else if (nt == 2 && strcmp(tok[0], "s") == 0) {
            o.op = 's';
            NUML(1, o.a);
            if (o.a < 0) ok = 0;
            if (o.a > 600000) o.a = 600000;
        } else if (nt == 3 && strcmp(tok[0], "w") == 0) {
            o.op = 'w';
            NUML(1, o.a);
            NUML(2, o.b);
            if (labs(o.a) > COORD_LIMIT || labs(o.b) > COORD_LIMIT) ok = 0;
        } else {
            ok = 0; /* includes the removed kd / ku */
        }
#undef NUMUL
#undef NUML
#undef NUMD
        if (!ok || ((o.op == 'f' || o.op == 'm') && (o.win == 0 || o.win > UINT32_MAX))) {
            snprintf(err, errlen, "bad seq op #%zu", n + 1);
            free(ops);
            return 0;
        }
        if (n == cap) {
            cap = cap ? cap * 2 : 64;
            ops = xrealloc(ops, cap * sizeof *ops);
        }
        ops[n++] = o;
    }
    *out_ops = ops;
    *out_n = n;
    return 1;
}

static void emit_done(unsigned long long id, int ok)
{
    Buf b = {0};
    b_printf(&b, "{\"t\":\"done\",\"id\":%llu,\"ok\":%s}", id, ok ? "true" : "false");
    emit_buf(&b);
    free(b.p);
}

/* Consume `abort` lines queued after this seq and before the next seq. */
static void scan_queued_abort(void)
{
    Line *prev = NULL, *l = q_head;
    while (l) {
        char *t = trim(l->s);
        if (strncmp(t, "seq", 3) == 0 && (t[3] == ' ' || t[3] == '\t' || t[3] == 0)) break;
        if (strcmp(t, "abort") == 0) {
            abort_flag = 1;
            Line *nx = l->next;
            if (prev) prev->next = nx;
            else q_head = nx;
            if (q_tail == l) q_tail = prev;
            free(l);
            l = nx;
            continue;
        }
        prev = l;
        l = l->next;
    }
}

static void run_seq(char *args)
{
    char *end;
    errno = 0;
    unsigned long long id = strtoull(args, &end, 10);
    if (errno || end == args || (*end != ' ' && *end != '\t' && *end != 0)) {
        emit_error("bad seq id");
        return;
    }
    Op *ops = NULL;
    size_t n = 0;
    char err[96];
    if (!parse_ops(end, &ops, &n, err, sizeof err)) {
        emit_error("%s", err);
        emit_done(id, 0);
        return;
    }

    /* Mouse lock: while seq_running the tap drops every physical mouse event. */
    seq_running = 1;
    abort_flag = 0;
    scan_queued_abort();
    cur = pointer_pos();
    int skip = 0;
    CGWindowID skipwin = 0;
    int any_target = 0, any_ok = 0;

    for (size_t i = 0; i < n; i++) {
        /* service stdin / the tap between ops so `abort` and Escape are noticed promptly */
        if (!seq_wait(0, 0)) break;
        Op *o = &ops[i];
        switch (o->op) {
        case 'f':
        case 'm': {
            any_target = 1;
            CGWindowID w = (CGWindowID)o->win;
            if (skip && w == skipwin) break;
            if (!window_ok(w)) {
                release_all();
                skip = 1;
                skipwin = w;
                break;
            }
            skip = 0;
            if (o->op == 'f') {
                if (!activate(w)) {
                    release_all();
                    skip = 1;
                    skipwin = w;
                    break;
                }
                any_ok = 1;
                break;
            }
            WinInfo wi;
            if (!win_info(w, &wi)) {
                release_all();
                skip = 1;
                skipwin = w;
                break;
            }
            warp(frac_point(&wi.r, o->fx, o->fy));
            if (!any_btn_held()) {
                int need = client_at(cur, NULL) != w;
#if ACTIVATE_INACTIVE_TARGET
                if (!need) need = active_window() != w;
#endif
                if (need) {
                    /* Something covers w (or it is inactive): raise + activate it, and
                     * never click into whatever is on top. */
                    int ok = activate(w) && win_info(w, &wi);
                    if (ok) {
                        warp(frac_point(&wi.r, o->fx, o->fy));
                        ok = pointer_on(w);
                    }
                    if (!ok) {
                        release_all();
                        skip = 1;
                        skipwin = w;
                        break;
                    }
                }
            }
            any_ok = 1;
            break;
        }
        case 'd':
        case 'u':
            if (skip) break;
            button((int)o->a, o->op == 'd');
            break;
        case 's':
            if (skip) break;
            seq_wait(o->a, 0);
            break;
        case 'w':
            skip = 0;
            warp(CGPointMake((double)o->a, (double)o->b));
            break;
        }
        if (seq_interrupted()) break;
    }
    int interrupted = seq_interrupted();
    release_all();
    free(ops);
    suppress_until = now_ms() + POST_SEQ_SUPPRESS_MS;
    seq_running = 0; /* unlocks the mouse */
    abort_flag = 0;
    emit_done(id, !interrupted && (!any_target || any_ok));
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */

static void exec_line(char *line)
{
    char *t = trim(line);
    if (!*t) return;
    if (strcmp(t, "list") == 0) {
        emit_windows();
    } else if (strcmp(t, "pick") == 0) {
        pick_start();
    } else if (strcmp(t, "pickcancel") == 0) {
        pick_cancel();
    } else if (strncmp(t, "seq", 3) == 0 && (t[3] == ' ' || t[3] == '\t')) {
        run_seq(trim(t + 4));
    } else if (strcmp(t, "abort") == 0) {
        /* no seq running: nothing to do */
    } else {
        char shown[64];
        snprintf(shown, sizeof shown, "%.60s", t);
        emit_error("unknown command: %s", shown);
    }
}

/* ------------------------------------------------------------------------ */
/* main                                                                      */

static void shutdown_and_exit(int code)
{
    seq_running = 0;
    release_all();
    pthread_mutex_lock(&g_mu);
    pick_state = 0;
    pick_rearm = 0;
    pthread_mutex_unlock(&g_mu);
    if (ov_window) [ov_window orderOut:nil];
    flush_out();
    exit(code);
}

/* Idle until `seconds` passed, servicing stdin and signals; exits on EOF / signal. */
static void wait_startup(double seconds)
{
    long long deadline = now_ms() + (long long)(seconds * 1000);
    while (now_ms() < deadline) {
        run_slice((double)(deadline - now_ms()) / 1000.0);
        if (stdin_eof || exit_requested) shutdown_and_exit(0);
    }
}

static void wait_for_permissions(void)
{
    if (!AXIsProcessTrusted()) {
        NSDictionary *opts = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
        AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
        emit_error("clickered needs the Accessibility permission to see and click windows. "
                   "Open System Settings > Privacy & Security > Accessibility and turn on "
                   "clickered (the app that started this helper); it continues automatically.");
        while (!AXIsProcessTrusted()) wait_startup(1.0);
    }
    int warned = 0;
    while (!create_tap()) {
        if (!warned) {
            warned = 1;
            CGRequestListenEventAccess();
            emit_error("clickered could not start listening to mouse input. Open System "
                       "Settings > Privacy & Security > Input Monitoring (and Accessibility) and "
                       "turn on clickered; it continues automatically.");
        }
        wait_startup(1.0);
    }
}

static void install_signals(void)
{
    static dispatch_source_t srcs[3];
    const int sigs[3] = {SIGTERM, SIGINT, SIGHUP};
    for (int i = 0; i < 3; i++) {
        signal(sigs[i], SIG_IGN); /* delivered through the dispatch source instead */
        dispatch_source_t s = dispatch_source_create(DISPATCH_SOURCE_TYPE_SIGNAL,
                                                     (uintptr_t)sigs[i], 0,
                                                     dispatch_get_main_queue());
        dispatch_source_set_event_handler(s, ^{
            exit_requested = 1;
            CFRunLoopStop(CFRunLoopGetMain());
        });
        dispatch_resume(s);
        srcs[i] = s;
    }
    signal(SIGPIPE, SIG_IGN);
}

static void install_workspace_observers(void)
{
    static NSMutableArray *tokens;
    tokens = [NSMutableArray array];
    NSNotificationCenter *nc = NSWorkspace.sharedWorkspace.notificationCenter;
    NSArray<NSNotificationName> *names = @[
        NSWorkspaceDidActivateApplicationNotification,
        NSWorkspaceDidLaunchApplicationNotification,
        NSWorkspaceDidTerminateApplicationNotification,
        NSWorkspaceDidHideApplicationNotification,
        NSWorkspaceDidUnhideApplicationNotification,
        NSWorkspaceActiveSpaceDidChangeNotification,
    ];
    for (NSNotificationName name in names) {
        id tok = [nc addObserverForName:name
                                 object:nil
                                  queue:nil
                             usingBlock:^(NSNotification *note) {
                                 (void)note;
                                 next_poll_ms = 0; /* check on the next tick */
                             }];
        [tokens addObject:tok];
    }
}

int main(void)
{
    @autoreleasepool {
        self_pid = getpid();
        main_rl = CFRunLoopGetMain();
        install_signals();

        CFRunLoopSourceContext ctx;
        memset(&ctx, 0, sizeof ctx);
        ctx.perform = wake_perform;
        wake_src = CFRunLoopSourceCreate(NULL, 0, &ctx);
        CFRunLoopAddSource(main_rl, wake_src, kCFRunLoopCommonModes);

        int fl = fcntl(STDIN_FILENO, F_GETFL);
        if (fl >= 0) fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK);
        CFFileDescriptorRef in_fd = CFFileDescriptorCreate(NULL, STDIN_FILENO, false, stdin_cb, NULL);
        if (!in_fd) {
            fputs("clickered-helper: cannot watch stdin\n", stderr);
            return 1;
        }
        CFFileDescriptorEnableCallBacks(in_fd, kCFFileDescriptorReadCallBack);
        CFRunLoopSourceRef in_src = CFFileDescriptorCreateRunLoopSource(NULL, in_fd, 0);
        CFRunLoopAddSource(main_rl, in_src, kCFRunLoopCommonModes);
        CFRelease(in_src);

        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];

        pid_regular = [NSMutableDictionary dictionary];
        pid_cls = [NSMutableDictionary dictionary];
        known = [NSMutableDictionary dictionary];
        ax_get_window = (AXGetWindowFn)dlsym(RTLD_DEFAULT, "_AXUIElementGetWindow");
        if (!ax_get_window)
            fputs("clickered-helper: _AXUIElementGetWindow unavailable, matching windows by frame\n",
                  stderr);
        ax_system = AXUIElementCreateSystemWide();
        /* on the system-wide element this sets the global AX messaging timeout */
        AXUIElementSetMessagingTimeout(ax_system, AX_TIMEOUT_S);
        dbl_click_ms = (long long)(NSEvent.doubleClickInterval * 1000.0);
        if (dbl_click_ms <= 0) dbl_click_ms = 500;

        wait_for_permissions(); /* returns with g_tap created */

        inj_src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        if (inj_src) {
            CGEventSourceSetUserData(inj_src, INJECT_TAG);
            /* do not freeze the user's real mouse after each injected event */
            CGEventSourceSetLocalEventsSuppressionInterval(inj_src, 0.0);
        }

        /* first client scan publishes the regular-app pids before the tap needs them */
        Client *c0;
        size_t n0 = collect_clients(&c0);
        free_clients(c0, n0);

        pthread_t th;
        if (pthread_create(&th, NULL, tap_thread_main, NULL) != 0) {
            fputs("clickered-helper: cannot start the event tap thread\n", stderr);
            return 1;
        }
        pthread_detach(th);

        install_workspace_observers();
        CFRunLoopTimerRef tick = CFRunLoopTimerCreate(NULL, CFAbsoluteTimeGetCurrent() + TICK_S,
                                                      TICK_S, 0, 0, tick_cb, NULL);
        CFRunLoopAddTimer(main_rl, tick, kCFRunLoopCommonModes);

        Buf b = {0};
        b_printf(&b, "{\"t\":\"ready\",\"version\":%d}", PROTOCOL_VERSION);
        emit_buf(&b);
        free(b.p);
        emit_windows();
        next_poll_ms = now_ms() + WINDOWS_POLL_MS;
    }

    for (;;) {
        @autoreleasepool {
            if (exit_requested) shutdown_and_exit(0);
            Line *l;
            while (!exit_requested && !stdin_eof && (l = pop_line())) {
                exec_line(l->s);
                free(l);
                run_slice(0);
            }
            if (stdin_eof || exit_requested) shutdown_and_exit(0);
            if (q_head) continue;
            run_slice(1.0);
        }
    }
}

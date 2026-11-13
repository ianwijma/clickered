/*
 * clickered-helper — X11 input capture / replay helper for clickered.
 *
 * Spec: docs/PROTOCOL.md (protocol version 1).
 *   stdout: one JSON object per line (flushed)
 *   stdin : one command per line
 *   stderr: diagnostics
 *
 * Single-threaded, one Display connection. Everything is driven by poll() on
 * stdin, the X connection fd and a signal self-pipe; sleeps inside a `seq` keep
 * servicing them.
 */
#define _POSIX_C_SOURCE 200809L

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/Xatom.h>
#include <X11/Xproto.h>
#include <X11/cursorfont.h>
#include <X11/extensions/XInput2.h>
#include <X11/extensions/XTest.h>

#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define PROTOCOL_VERSION 1
#define MOTION_INTERVAL_MS 8
#define POST_SEQ_SUPPRESS_MS 30
#define WINDOWS_DEBOUNCE_MS 100
#define ACTIVATE_WAIT_MS 200
#define POINTER_SETTLE_MS 100
/* Bounds for seq coordinates: fractions may leave the window (drags), but not absurdly. */
#define FRAC_LIMIT 100.0
#define COORD_LIMIT 32767L
#define PICK_RELEASE_TIMEOUT_MS 3000

/* ------------------------------------------------------------------------ */
/* Globals                                                                   */

static Display *dpy;
static Window root;
static int scr;
static int xi_opcode;

static Atom A_CLIENT_LIST, A_ACTIVE, A_NET_WM_NAME, A_UTF8, A_PID;

static volatile sig_atomic_t exit_requested;
/* Self-pipe: the signal handler writes a byte so a blocking poll() wakes up. */
static int sig_pipe[2] = {-1, -1};
static int stdin_eof;

/* XTEST slave device ids (filtered out of capture). */
static int xtest_ids[16];
static int n_xtest;

/* capture state */
static int keys_on;
static unsigned held_mask;      /* physical buttons whose press was reported */
static Window gesture_win;
static long long last_motion_ms = -1000;
static int motion_pending;

/* seq state */
static int seq_running;
static int abort_flag;
static long long suppress_until;
static int active_changed;

/* pick state: 0 idle, 1 waiting for click, 2 replied, waiting for release */
static int pick_state;
static int pick_rearm; /* a new `pick` arrived while waiting for the previous click's release */
static unsigned pick_button;
static long long pick_deadline;
static Cursor cross_cursor;

/* debounced windows message; 0 = none pending */
static long long windows_due;

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
    exit(3);
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

static void b_puts(Buf *b, const char *s)
{
    size_t l = strlen(s);
    b_reserve(b, l);
    memcpy(b->p + b->n, s, l);
    b->n += l;
    b->p[b->n] = 0;
}

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
            b_reserve(b, (size_t)l);
            memcpy(b->p + b->n, s + i, (size_t)l);
            b->n += (size_t)l;
            b->p[b->n] = 0;
            i += (size_t)l;
        }
    }
    b_putc(b, '"');
}

static void b_num(Buf *b, double v)
{
    if (!isfinite(v)) v = 0;
    b_printf(b, "%.6f", v);
}

/* Write one finished JSON line to stdout. */
static void emit_buf(Buf *b)
{
    b_putc(b, '\n');
    if (fwrite(b->p, 1, b->n, stdout) != b->n || fflush(stdout) != 0) {
        /* host gone */
        exit_requested = 1;
    }
    b->n = 0;
    if (b->p) b->p[0] = 0;
}

static Buf out;

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
/* X error handling                                                          */

static int on_xerror(Display *d, XErrorEvent *e)
{
    if (e->error_code == BadWindow || e->error_code == BadMatch ||
        e->error_code == BadDrawable)
        return 0; /* windows vanish at any time */
    char txt[160];
    XGetErrorText(d, e->error_code, txt, sizeof txt);
    emit_error("X error: %s (request %d.%d)", txt, e->request_code, e->minor_code);
    return 0;
}

static int on_xioerror(Display *d)
{
    (void)d;
    fputs("clickered-helper: lost connection to X server\n", stderr);
    _exit(2);
    return 0;
}

/* ------------------------------------------------------------------------ */
/* Window helpers                                                            */

static unsigned char *get_prop(Window w, Atom prop, Atom req_type, Atom *type_out,
                               int *fmt_out, unsigned long *n_out)
{
    Atom type = None;
    int fmt = 0;
    unsigned long n = 0, after = 0;
    unsigned char *data = NULL;
    if (XGetWindowProperty(dpy, w, prop, 0, 1 << 20, False, req_type, &type, &fmt,
                           &n, &after, &data) != Success) {
        return NULL;
    }
    if (type == None) {
        if (data) XFree(data);
        return NULL;
    }
    if (type_out) *type_out = type;
    if (fmt_out) *fmt_out = fmt;
    if (n_out) *n_out = n;
    return data;
}

/* Caller frees with XFree. Returns count. */
static unsigned long get_client_list(Window **out)
{
    int fmt;
    unsigned long n = 0;
    unsigned char *d = get_prop(root, A_CLIENT_LIST, XA_WINDOW, NULL, &fmt, &n);
    if (!d || fmt != 32) {
        if (d) XFree(d);
        *out = NULL;
        return 0;
    }
    *out = (Window *)d; /* format 32 → array of long */
    return n;
}

static Window get_active(void)
{
    int fmt;
    unsigned long n = 0;
    unsigned char *d = get_prop(root, A_ACTIVE, XA_WINDOW, NULL, &fmt, &n);
    Window w = 0;
    if (d && fmt == 32 && n >= 1) w = ((Window *)d)[0];
    if (d) XFree(d);
    return w;
}

/* The direct child of root that contains w (w itself if a child of root). */
static Window toplevel_of(Window w)
{
    for (int depth = 0; depth < 64; depth++) {
        Window r, parent, *kids = NULL;
        unsigned int nk = 0;
        if (!XQueryTree(dpy, w, &r, &parent, &kids, &nk)) return 0;
        if (kids) XFree(kids);
        if (parent == root || parent == None) return w;
        w = parent;
    }
    return 0;
}

/* Client window under the pointer (0 if none). Root coords in *px,*py. */
static Window client_under_pointer(int *px, int *py)
{
    Window r = 0, child = 0;
    int rx = 0, ry = 0, wx, wy;
    unsigned int mask;
    if (!XQueryPointer(dpy, root, &r, &child, &rx, &ry, &wx, &wy, &mask)) {
        rx = ry = 0;
        child = 0;
    }
    if (px) *px = rx;
    if (py) *py = ry;
    if (!child) return 0;
    Window *list;
    unsigned long n = get_client_list(&list);
    Window found = 0;
    for (unsigned long i = 0; i < n && !found; i++)
        if (list[i] == child) found = child;
    for (unsigned long i = 0; i < n && !found; i++)
        if (toplevel_of(list[i]) == child) found = list[i];
    if (list) XFree(list);
    return found;
}

static void pointer_pos(int *px, int *py)
{
    Window r, c;
    int wx, wy;
    unsigned int mask;
    if (!XQueryPointer(dpy, root, &r, &c, px, py, &wx, &wy, &mask)) *px = *py = 0;
}

typedef struct {
    int x, y, w, h;
    int viewable;
} Rect;

/* Content rect per PROTOCOL.md. Returns 0 if the window does not exist. */
static int content_rect(Window w, Rect *r)
{
    XWindowAttributes a;
    if (!XGetWindowAttributes(dpy, w, &a)) return 0;
    Window ch;
    int x, y;
    if (!XTranslateCoordinates(dpy, w, root, 0, 0, &x, &y, &ch)) return 0;
    r->x = x;
    r->y = y;
    r->w = a.width;
    r->h = a.height;
    r->viewable = a.map_state == IsViewable;

    Window rr, parent, *kids = NULL;
    unsigned int nk = 0;
    if (!XQueryTree(dpy, w, &rr, &parent, &kids, &nk)) return 1;
    int count = 0;
    XWindowAttributes one;
    for (unsigned int i = 0; i < nk && count < 2; i++) {
        XWindowAttributes ca;
        if (!XGetWindowAttributes(dpy, kids[i], &ca)) continue;
        if (ca.map_state == IsUnmapped || ca.class != InputOutput) continue;
        if (count == 0) one = ca;
        count++;
    }
    if (kids) XFree(kids);
    if (count == 1) {
        long W = a.width, H = a.height;
        long cw = one.width, chh = one.height;
        if ((cw < W || chh < H) && cw <= W && chh <= H && cw * chh * 5 >= W * H * 4) {
            r->x = x + one.x + one.border_width;
            r->y = y + one.y + one.border_width;
            r->w = one.width;
            r->h = one.height;
        }
    }
    return 1;
}

/* Window exists and is viewable. */
static int window_ok(Window w)
{
    if (!w) return 0;
    XWindowAttributes a;
    if (!XGetWindowAttributes(dpy, w, &a)) return 0;
    return a.map_state == IsViewable;
}

/* Append latin-1 bytes as UTF-8 into a malloc'd string. */
static char *latin1_to_utf8(const unsigned char *s, size_t n, size_t *outlen)
{
    char *o = xrealloc(NULL, n * 2 + 1);
    size_t j = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < 0x80) o[j++] = (char)s[i];
        else {
            o[j++] = (char)(0xC0 | (s[i] >> 6));
            o[j++] = (char)(0x80 | (s[i] & 0x3F));
        }
    }
    o[j] = 0;
    *outlen = j;
    return o;
}

static void b_title(Buf *b, Window w)
{
    Atom type;
    int fmt;
    unsigned long n = 0;
    unsigned char *d = get_prop(w, A_NET_WM_NAME, A_UTF8, &type, &fmt, &n);
    if (d && fmt == 8 && n > 0) {
        b_jstr(b, (char *)d, n);
        XFree(d);
        return;
    }
    if (d) XFree(d);
    d = get_prop(w, XA_WM_NAME, AnyPropertyType, &type, &fmt, &n);
    if (d && fmt == 8) {
        if (type == XA_STRING) {
            size_t l;
            char *u = latin1_to_utf8(d, n, &l);
            b_jstr(b, u, l);
            free(u);
        } else {
            b_jstr(b, (char *)d, n); /* UTF8_STRING / COMPOUND_TEXT: sanitized */
        }
        XFree(d);
        return;
    }
    if (d) XFree(d);
    b_puts(b, "\"\"");
}

static void emit_windows(void)
{
    windows_due = 0;
    Window *list;
    unsigned long n = get_client_list(&list);
    Buf *b = &out;
    b_printf(b, "{\"t\":\"windows\",\"active\":%lu,\"list\":[", (unsigned long)get_active());
    int first = 1;
    for (unsigned long i = 0; i < n; i++) {
        Window w = list[i];
        Rect r;
        if (!content_rect(w, &r)) continue; /* vanished */
        if (!first) b_putc(b, ',');
        first = 0;
        b_printf(b, "{\"id\":%lu,\"title\":", (unsigned long)w);
        b_title(b, w);
        b_puts(b, ",\"cls\":");
        XClassHint ch = {0};
        if (XGetClassHint(dpy, w, &ch)) {
            const char *c = ch.res_class ? ch.res_class : "";
            b_jstr(b, c, strlen(c));
            if (ch.res_name) XFree(ch.res_name);
            if (ch.res_class) XFree(ch.res_class);
        } else {
            b_puts(b, "\"\"");
        }
        long pid = 0;
        int fmt;
        unsigned long pn = 0;
        unsigned char *pd = get_prop(w, A_PID, XA_CARDINAL, NULL, &fmt, &pn);
        if (pd && fmt == 32 && pn >= 1) pid = (long)((unsigned long *)pd)[0];
        if (pd) XFree(pd);
        b_printf(b, ",\"pid\":%ld,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"mapped\":%s}", pid,
                 r.x, r.y, r.w, r.h, r.viewable ? "true" : "false");
    }
    if (list) XFree(list);
    b_puts(b, "]}");
    emit_buf(b);
}

/* ------------------------------------------------------------------------ */
/* XInput2                                                                   */

static void refresh_xtest_devices(void)
{
    int nd = 0;
    XIDeviceInfo *info = XIQueryDevice(dpy, XIAllDevices, &nd);
    n_xtest = 0;
    for (int i = 0; i < nd; i++) {
        if ((info[i].use == XISlavePointer || info[i].use == XISlaveKeyboard ||
             info[i].use == XIFloatingSlave) &&
            info[i].name && strstr(info[i].name, "XTEST") &&
            n_xtest < (int)(sizeof xtest_ids / sizeof xtest_ids[0])) {
            xtest_ids[n_xtest++] = info[i].deviceid;
        }
    }
    if (info) XIFreeDeviceInfo(info);
}

/* Lock the physical mice for the duration of a seq, so that moving the mouse cannot
 * drag the pointer away mid-replay. Each physical slave pointer is grabbed with
 * XIGrabDevice: a grabbed slave is detached from the master pointer until ungrabbed,
 * and the X server drops the grab by itself if this process dies, so the mouse can
 * never stay locked. XTEST (our injection path) and keyboards are left alone. */
static int locked_ids[32];
static int n_locked;

static void lock_pointers(void)
{
    int nd = 0;
    XIDeviceInfo *info = XIQueryDevice(dpy, XIAllDevices, &nd);
    if (!info) return;
    unsigned char bits[XIMaskLen(XI_LASTEVENT)];
    memset(bits, 0, sizeof bits);
    XIEventMask mask = {0, (int)sizeof bits, bits};
    n_locked = 0;
    for (int i = 0; i < nd; i++) {
        if (info[i].use != XISlavePointer || !info[i].enabled) continue;
        if (info[i].name && strstr(info[i].name, "XTEST")) continue;
        if (n_locked >= (int)(sizeof locked_ids / sizeof locked_ids[0])) break;
        mask.deviceid = info[i].deviceid;
        if (XIGrabDevice(dpy, info[i].deviceid, root, CurrentTime, None, GrabModeAsync,
                         GrabModeAsync, False, &mask) == GrabSuccess)
            locked_ids[n_locked++] = info[i].deviceid;
    }
    XIFreeDeviceInfo(info);
    XFlush(dpy);
}

static void unlock_pointers(void)
{
    for (int i = 0; i < n_locked; i++) XIUngrabDevice(dpy, locked_ids[i], CurrentTime);
    n_locked = 0;
    XFlush(dpy);
}

static int is_xtest(int id)
{
    for (int i = 0; i < n_xtest; i++)
        if (xtest_ids[i] == id) return 1;
    return 0;
}

static int input_suppressed(void)
{
    return seq_running || now_ms() < suppress_until;
}

static void frac(Window w, int x, int y, double *fx, double *fy)
{
    Rect r;
    *fx = *fy = 0;
    if (!w || !content_rect(w, &r) || r.w <= 0 || r.h <= 0) return;
    *fx = (double)(x - r.x) / r.w;
    *fy = (double)(y - r.y) / r.h;
}

static void emit_motion(void)
{
    int x, y;
    double fx, fy;
    pointer_pos(&x, &y);
    frac(gesture_win, x, y, &fx, &fy);
    b_printf(&out, "{\"t\":\"motion\",\"win\":%lu,\"fx\":", (unsigned long)gesture_win);
    b_num(&out, fx);
    b_puts(&out, ",\"fy\":");
    b_num(&out, fy);
    b_printf(&out, ",\"x\":%d,\"y\":%d,\"time\":%lld}", x, y, now_ms());
    emit_buf(&out);
    last_motion_ms = now_ms();
    motion_pending = 0;
}

static void on_raw_button(XIRawEvent *ev, int down)
{
    int b = ev->detail;
    if (b < 1 || b > 31) return;
    unsigned bit = 1u << b;
    if (is_xtest(ev->sourceid)) return;
    int x, y;
    if (down) {
        if (input_suppressed() || pick_state) return;
        if (held_mask & bit) return;
        if (held_mask == 0) {
            gesture_win = client_under_pointer(&x, &y);
            motion_pending = 0;
        } else {
            pointer_pos(&x, &y);
        }
        held_mask |= bit;
    } else {
        if (!(held_mask & bit)) return;
        held_mask &= ~bit;
        if (held_mask == 0) motion_pending = 0;
        if (input_suppressed() || pick_state) return;
        pointer_pos(&x, &y);
    }
    double fx, fy;
    frac(gesture_win, x, y, &fx, &fy);
    b_printf(&out, "{\"t\":\"btn\",\"down\":%s,\"button\":%d,\"win\":%lu,\"fx\":",
             down ? "true" : "false", b, (unsigned long)gesture_win);
    b_num(&out, fx);
    b_puts(&out, ",\"fy\":");
    b_num(&out, fy);
    b_printf(&out, ",\"x\":%d,\"y\":%d,\"time\":%lld}", x, y, now_ms());
    emit_buf(&out);
}

static void on_raw_motion(XIRawEvent *ev)
{
    if (!held_mask || is_xtest(ev->sourceid)) return;
    if (input_suppressed() || pick_state) return;
    if (now_ms() - last_motion_ms >= MOTION_INTERVAL_MS) emit_motion();
    else motion_pending = 1;
}

static void on_raw_key(XIRawEvent *ev, int down)
{
    if (is_xtest(ev->sourceid)) return;
    if (ev->flags & XIKeyRepeat) return;
    /* Panic key: a physical Escape aborts the running seq and is always reported
     * (even with `keys 0` and during a seq) so the host can drop its queue too. */
    if (down && ev->detail == (int)XKeysymToKeycode(dpy, XK_Escape)) {
        if (seq_running) abort_flag = 1;
        b_printf(&out, "{\"t\":\"esc\",\"time\":%lld}", now_ms());
        emit_buf(&out);
    }
    if (!keys_on) return;
    if (input_suppressed()) return;
    b_printf(&out, "{\"t\":\"key\",\"down\":%s,\"keycode\":%d,\"win\":%lu,\"time\":%lld}",
             down ? "true" : "false", ev->detail, (unsigned long)get_active(), now_ms());
    emit_buf(&out);
}

/* ------------------------------------------------------------------------ */
/* Pick                                                                      */

static void emit_picked(Window w)
{
    b_printf(&out, "{\"t\":\"picked\",\"win\":%lu}", (unsigned long)w);
    emit_buf(&out);
}

static void pick_end(void)
{
    XUngrabPointer(dpy, CurrentTime);
    XFlush(dpy);
    pick_state = 0;
    pick_rearm = 0;
}

static void pick_start(void)
{
    if (pick_state == 2) {
        /* Picking several windows in a row: keep the grab, wait for the next click. */
        pick_rearm = 1;
        return;
    }
    if (pick_state) {
        emit_error("pick already active");
        return;
    }
    if (!cross_cursor) cross_cursor = XCreateFontCursor(dpy, XC_crosshair);
    int rc = GrabNotViewable + 1;
    for (int i = 0; i < 5; i++) {
        rc = XGrabPointer(dpy, root, False, ButtonPressMask | ButtonReleaseMask,
                          GrabModeAsync, GrabModeAsync, None, cross_cursor, CurrentTime);
        if (rc == GrabSuccess) break;
        struct timespec ts = {0, 20 * 1000000};
        nanosleep(&ts, NULL);
    }
    if (rc != GrabSuccess) {
        emit_error("pick: pointer grab failed (%d)", rc);
        emit_picked(0);
        return;
    }
    pick_state = 1;
}

/* The picked click's button came up (or timed out): end the pick, or go again. */
static void pick_release(void)
{
    if (pick_rearm) {
        pick_rearm = 0;
        pick_state = 1;
    } else {
        pick_end();
    }
}

static void pick_cancel(void)
{
    if (pick_state == 1) {
        pick_end();
        emit_picked(0);
    } else if (pick_state == 2 && pick_rearm) {
        pick_rearm = 0; /* grab ends with the pending release */
        emit_picked(0);
    }
}

static void on_core_button(XButtonEvent *e, int down)
{
    if (!pick_state) return;
    if (down) {
        if (pick_state != 1) return;
        if (input_suppressed()) return; /* our own XTEST clicks */
        if (e->button == 1) {
            Window w = client_under_pointer(NULL, NULL);
            emit_picked(w);
        } else if (e->button == 3) {
            emit_picked(0);
        } else {
            return; /* swallowed, still waiting */
        }
        pick_state = 2;
        pick_button = e->button;
        pick_deadline = now_ms() + PICK_RELEASE_TIMEOUT_MS;
    } else if (pick_state == 2 && e->button == pick_button) {
        pick_release();
    }
}

/* ------------------------------------------------------------------------ */
/* X event pump                                                              */

static void handle_xevent(XEvent *ev)
{
    if (ev->type == GenericEvent && ev->xcookie.extension == xi_opcode) {
        if (!XGetEventData(dpy, &ev->xcookie)) return;
        switch (ev->xcookie.evtype) {
        case XI_RawButtonPress: on_raw_button(ev->xcookie.data, 1); break;
        case XI_RawButtonRelease: on_raw_button(ev->xcookie.data, 0); break;
        case XI_RawMotion: on_raw_motion(ev->xcookie.data); break;
        case XI_RawKeyPress: on_raw_key(ev->xcookie.data, 1); break;
        case XI_RawKeyRelease: on_raw_key(ev->xcookie.data, 0); break;
        case XI_HierarchyChanged: refresh_xtest_devices(); break;
        default: break;
        }
        XFreeEventData(dpy, &ev->xcookie);
        return;
    }
    switch (ev->type) {
    case PropertyNotify:
        if (ev->xproperty.window == root &&
            (ev->xproperty.atom == A_CLIENT_LIST || ev->xproperty.atom == A_ACTIVE)) {
            if (ev->xproperty.atom == A_ACTIVE) active_changed = 1;
            if (!windows_due) windows_due = now_ms() + WINDOWS_DEBOUNCE_MS;
        }
        break;
    case ButtonPress: on_core_button(&ev->xbutton, 1); break;
    case ButtonRelease: on_core_button(&ev->xbutton, 0); break;
    default: break;
    }
}

static void pump_x(void)
{
    while (XPending(dpy)) {
        XEvent ev;
        XNextEvent(dpy, &ev);
        handle_xevent(&ev);
    }
}

/* Fire timers that are due. */
static void service_timers(void)
{
    long long t = now_ms();
    if (windows_due && t >= windows_due) emit_windows();
    if (motion_pending && t - last_motion_ms >= MOTION_INTERVAL_MS) {
        if (held_mask && !input_suppressed() && !pick_state) emit_motion();
        else motion_pending = 0;
    }
    if (pick_state == 2 && t >= pick_deadline) pick_release();
}

/* Milliseconds until the next timer, capped by cap; -1 = wait forever. */
static int next_timeout(long long cap)
{
    long long t = now_ms(), best = 0;
    int have = 0;
#define CONSIDER(expr)                          \
    do {                                        \
        long long d_ = (expr);                  \
        if (d_ < 0) d_ = 0;                     \
        if (!have || d_ < best) best = d_;      \
        have = 1;                               \
    } while (0)
    if (cap >= 0) CONSIDER(cap);
    if (windows_due) CONSIDER(windows_due - t);
    if (motion_pending) CONSIDER(last_motion_ms + MOTION_INTERVAL_MS - t);
    if (pick_state == 2) CONSIDER(pick_deadline - t);
#undef CONSIDER
    if (!have) return -1;
    if (best > 1000000) best = 1000000;
    return (int)best;
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

/* ------------------------------------------------------------------------ */
/* Waiting (non-blocking sleep)                                              */

/*
 * poll() stdin, the X connection and the signal pipe. Returns -1/0 like poll(), else a
 * positive value with bit 0 set when stdin is readable (or hung up). Drains the pipe.
 */
static int wait_io(int timeout_ms)
{
    struct pollfd p[3] = {
        {STDIN_FILENO, POLLIN, 0},
        {ConnectionNumber(dpy), POLLIN, 0},
        {sig_pipe[0], POLLIN, 0},
    };
    int r = poll(p, sig_pipe[0] >= 0 ? 3 : 2, timeout_ms);
    if (r <= 0) return r;
    if (sig_pipe[0] >= 0 && (p[2].revents & POLLIN)) {
        char junk[16];
        while (read(sig_pipe[0], junk, sizeof junk) > 0) {
        }
    }
    return 2 | ((p[0].revents & (POLLIN | POLLHUP | POLLERR)) ? 1 : 0);
}

static int seq_interrupted(void)
{
    return abort_flag || stdin_eof || exit_requested;
}

/*
 * Wait up to ms milliseconds while servicing stdin and X. If wait_active is set,
 * return early as soon as _NET_ACTIVE_WINDOW equals it. Returns 0 if the seq
 * was interrupted (abort / EOF / signal), 1 otherwise.
 */
static int seq_wait(long long ms, Window wait_active)
{
    long long deadline = now_ms() + ms;
    for (;;) {
        service_timers();
        pump_x();
        if (seq_interrupted()) return 0;
        if (wait_active && active_changed) {
            active_changed = 0;
            if (get_active() == wait_active) return 1;
            continue; /* re-pump: get_active may have queued events */
        }
        long long left = deadline - now_ms();
        int r = wait_io(left > 0 ? next_timeout(left) : 0);
        if (r > 0 && (r & 1)) read_stdin();
        if (left <= 0) {
            pump_x();
            return !seq_interrupted();
        }
    }
}

/* ------------------------------------------------------------------------ */
/* seq                                                                       */

typedef struct {
    char op; /* f m d u K(kd) k(ku) s w */
    unsigned long win;
    double fx, fy;
    long a, b;
} Op;

static unsigned char held_btn[256];
static unsigned char held_key[256];

static void inject_flush(void)
{
    XSync(dpy, False);
}

static void warp(int x, int y)
{
    XTestFakeMotionEvent(dpy, scr, x, y, CurrentTime);
    inject_flush();
}

static int any_btn_held(void)
{
    for (int i = 0; i < 256; i++)
        if (held_btn[i]) return 1;
    return 0;
}

static void release_all(void)
{
    int any = 0;
    for (int i = 0; i < 256; i++) {
        if (held_btn[i]) {
            XTestFakeButtonEvent(dpy, (unsigned)i, False, CurrentTime);
            held_btn[i] = 0;
            any = 1;
        }
        if (held_key[i]) {
            XTestFakeKeyEvent(dpy, (unsigned)i, False, CurrentTime);
            held_key[i] = 0;
            any = 1;
        }
    }
    if (any) inject_flush();
}

/*
 * Activate + raise; wait (bounded) until it is the active window. Returns 1 only if w is
 * the active window afterwards; 0 if the WM refused or was too slow, or on interrupt.
 */
static int activate(Window w)
{
    XEvent e;
    memset(&e, 0, sizeof e);
    e.xclient.type = ClientMessage;
    e.xclient.window = w;
    e.xclient.message_type = A_ACTIVE;
    e.xclient.format = 32;
    e.xclient.data.l[0] = 2; /* source indication: pager */
    e.xclient.data.l[1] = CurrentTime;
    e.xclient.data.l[2] = 0;
    active_changed = 0;
    XSendEvent(dpy, root, False, SubstructureRedirectMask | SubstructureNotifyMask, &e);
    XRaiseWindow(dpy, w);
    XSync(dpy, False);
    if (get_active() == w) return 1;
    if (!seq_wait(ACTIVATE_WAIT_MS, w)) return 0;
    return get_active() == w;
}

/* Wait (bounded) until the client under the pointer is w, e.g. while the WM restacks. */
static int pointer_on(Window w)
{
    long long deadline = now_ms() + POINTER_SETTLE_MS;
    for (;;) {
        if (client_under_pointer(NULL, NULL) == w) return 1;
        if (now_ms() >= deadline) return 0;
        if (!seq_wait(10, 0)) return 0;
    }
}

static int frac_to_px(double f, int origin, int size)
{
    double v = f * size;
    int p = (int)floor(v);
    if (f >= 0 && f <= 1) {
        if (p > size - 1) p = size - 1;
        if (p < 0) p = 0;
    }
    return origin + p;
}

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
        char *dup = t;
        for (char *w = strtok_r(dup, " \t", &s2); w; w = strtok_r(NULL, " \t", &s2)) {
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
        if (nt >= 1 && strcmp(tok[0], "f") == 0 && nt == 2) {
            o.op = 'f';
            NUMUL(1, o.win);
        } else if (nt >= 1 && strcmp(tok[0], "m") == 0 && nt == 4) {
            o.op = 'm';
            NUMUL(1, o.win);
            NUMD(2, o.fx);
            NUMD(3, o.fy);
        } else if (nt == 2 && (strcmp(tok[0], "d") == 0 || strcmp(tok[0], "u") == 0)) {
            o.op = tok[0][0];
            NUML(1, o.a);
            if (o.a < 1 || o.a > 255) ok = 0;
        } else if (nt == 2 && (strcmp(tok[0], "kd") == 0 || strcmp(tok[0], "ku") == 0)) {
            o.op = tok[0][1] == 'd' ? 'K' : 'k';
            NUML(1, o.a);
            if (o.a < 8 || o.a > 255) ok = 0;
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
            ok = 0;
        }
#undef NUMUL
#undef NUML
#undef NUMD
        if (!ok || ((o.op == 'f' || o.op == 'm') && o.win == 0)) {
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
    b_printf(&out, "{\"t\":\"done\",\"id\":%llu,\"ok\":%s}", id, ok ? "true" : "false");
    emit_buf(&out);
}

/* Consume `abort` lines queued after this seq and before the next seq. */
static void scan_queued_abort(void)
{
    Line *prev = NULL, *l = q_head;
    while (l) {
        char *t = trim(l->s);
        if (strncmp(t, "seq", 3) == 0 && (t[3] == ' ' || t[3] == 0)) break;
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

    seq_running = 1;
    abort_flag = 0;
    scan_queued_abort();
    lock_pointers();
    int skip = 0;
    Window skipwin = 0;
    int any_target = 0, any_ok = 0;

    for (size_t i = 0; i < n; i++) {
        /* service stdin/X between ops so `abort` is noticed promptly */
        if (!seq_wait(0, 0)) break;
        Op *o = &ops[i];
        switch (o->op) {
        case 'f':
        case 'm': {
            any_target = 1;
            Window w = (Window)o->win;
            if (skip && w == skipwin) break;
            if (!window_ok(w)) {
                release_all();
                skip = 1;
                skipwin = w;
                break;
            }
            skip = 0;
            if (o->op == 'f') {
                /* Never type into a window that did not actually get focus. */
                if (!activate(w)) {
                    release_all();
                    skip = 1;
                    skipwin = w;
                    break;
                }
                any_ok = 1;
                break;
            }
            Rect r;
            if (!content_rect(w, &r)) {
                release_all();
                skip = 1;
                skipwin = w;
                break;
            }
            warp(frac_to_px(o->fx, r.x, r.w), frac_to_px(o->fy, r.y, r.h));
            if (!any_btn_held() && client_under_pointer(NULL, NULL) != w) {
                /* Something covers w: raise it, and never click into whatever is on top. */
                int ok = activate(w) && content_rect(w, &r);
                if (ok) {
                    warp(frac_to_px(o->fx, r.x, r.w), frac_to_px(o->fy, r.y, r.h));
                    ok = pointer_on(w);
                }
                if (!ok) {
                    release_all();
                    skip = 1;
                    skipwin = w;
                    break;
                }
            }
            any_ok = 1;
            break;
        }
        case 'd':
        case 'u':
            if (skip) break;
            XTestFakeButtonEvent(dpy, (unsigned)o->a, o->op == 'd', CurrentTime);
            held_btn[o->a] = o->op == 'd';
            inject_flush();
            break;
        case 'K':
        case 'k':
            if (skip) break;
            XTestFakeKeyEvent(dpy, (unsigned)o->a, o->op == 'K', CurrentTime);
            held_key[o->a] = o->op == 'K';
            inject_flush();
            break;
        case 's':
            if (skip) break;
            seq_wait(o->a, 0);
            break;
        case 'w':
            skip = 0;
            warp((int)o->a, (int)o->b);
            break;
        }
        if (seq_interrupted()) break;
    }
    int interrupted = seq_interrupted();
    release_all();
    unlock_pointers();
    free(ops);
    seq_running = 0;
    suppress_until = now_ms() + POST_SEQ_SUPPRESS_MS;
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
    } else if (strncmp(t, "keys", 4) == 0 && (t[4] == ' ' || t[4] == '\t')) {
        char *v = trim(t + 5);
        if (strcmp(v, "0") == 0) keys_on = 0;
        else if (strcmp(v, "1") == 0) keys_on = 1;
        else emit_error("bad keys argument");
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

static void on_signal(int sig)
{
    (void)sig;
    int saved = errno;
    exit_requested = 1;
    if (sig_pipe[1] >= 0) {
        ssize_t ignored = write(sig_pipe[1], "x", 1);
        (void)ignored;
    }
    errno = saved;
}

static void shutdown_and_exit(int code)
{
    release_all();
    if (pick_state) pick_end();
    XSync(dpy, False);
    XCloseDisplay(dpy);
    exit(code);
}

int main(void)
{
    if (pipe(sig_pipe) == 0) {
        for (int i = 0; i < 2; i++) {
            int f = fcntl(sig_pipe[i], F_GETFL);
            if (f >= 0) fcntl(sig_pipe[i], F_SETFL, f | O_NONBLOCK);
            fcntl(sig_pipe[i], F_SETFD, FD_CLOEXEC);
        }
    } else {
        sig_pipe[0] = sig_pipe[1] = -1;
    }
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_signal;
    sigemptyset(&sa.sa_mask);
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);
    signal(SIGPIPE, SIG_IGN);

    dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fputs("clickered-helper: cannot open display\n", stderr);
        return 1;
    }
    XSetErrorHandler(on_xerror);
    XSetIOErrorHandler(on_xioerror);
    scr = DefaultScreen(dpy);
    root = RootWindow(dpy, scr);

    int ev, er, maj, min;
    if (!XQueryExtension(dpy, "XInputExtension", &xi_opcode, &ev, &er)) {
        fputs("clickered-helper: XInput extension missing\n", stderr);
        return 1;
    }
    maj = 2;
    min = 2;
    if (XIQueryVersion(dpy, &maj, &min) != Success || maj < 2 || (maj == 2 && min < 1)) {
        fprintf(stderr, "clickered-helper: XInput 2.1+ required (server has %d.%d)\n", maj, min);
        return 1;
    }
    if (!XTestQueryExtension(dpy, &ev, &er, &maj, &min)) {
        fputs("clickered-helper: XTEST extension missing\n", stderr);
        return 1;
    }

    A_CLIENT_LIST = XInternAtom(dpy, "_NET_CLIENT_LIST", False);
    A_ACTIVE = XInternAtom(dpy, "_NET_ACTIVE_WINDOW", False);
    A_NET_WM_NAME = XInternAtom(dpy, "_NET_WM_NAME", False);
    A_UTF8 = XInternAtom(dpy, "UTF8_STRING", False);
    A_PID = XInternAtom(dpy, "_NET_WM_PID", False);

    refresh_xtest_devices();

    unsigned char m1[XIMaskLen(XI_LASTEVENT)] = {0};
    unsigned char m2[XIMaskLen(XI_LASTEVENT)] = {0};
    XISetMask(m1, XI_RawButtonPress);
    XISetMask(m1, XI_RawButtonRelease);
    XISetMask(m1, XI_RawMotion);
    XISetMask(m1, XI_RawKeyPress);
    XISetMask(m1, XI_RawKeyRelease);
    XISetMask(m2, XI_HierarchyChanged);
    XIEventMask masks[2] = {
        {XIAllMasterDevices, sizeof m1, m1},
        {XIAllDevices, sizeof m2, m2},
    };
    XISelectEvents(dpy, root, masks, 2);
    XSelectInput(dpy, root, PropertyChangeMask);
    XSync(dpy, False);

    int fl = fcntl(STDIN_FILENO, F_GETFL);
    if (fl >= 0) fcntl(STDIN_FILENO, F_SETFL, fl | O_NONBLOCK);

    b_printf(&out, "{\"t\":\"ready\",\"version\":%d}", PROTOCOL_VERSION);
    emit_buf(&out);
    emit_windows();

    for (;;) {
        if (exit_requested) shutdown_and_exit(0);
        Line *l;
        while (!exit_requested && !stdin_eof && (l = pop_line())) {
            exec_line(l->s);
            free(l);
            pump_x();
            service_timers();
        }
        if (stdin_eof || exit_requested) shutdown_and_exit(0);
        service_timers();
        pump_x();
        if (q_head) continue;
        int r = wait_io(next_timeout(-1));
        if (r > 0 && (r & 1)) read_stdin();
    }
}

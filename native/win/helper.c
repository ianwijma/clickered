/*
 * clickered-helper.exe — Windows input capture / replay helper for clickered.
 *
 * Windows port of native/helper.c. Same wire protocol (docs/PROTOCOL.md, protocol
 * version 3: no keyboard replication, Escape panic key only; optional background mode
 * that posts window messages instead of injecting input):
 *   stdout: one JSON object per line (each line written whole)
 *   stdin : one command per line
 *   stderr: diagnostics
 *
 * Plain C11 + Win32 (user32, gdi32, dwmapi, ole32, winmm). Platform mapping and
 * limits: native/win/README.md.
 *
 * Threads
 *   main  : executes commands and seqs, owns every byte written to stdout.
 *   hook  : WH_MOUSE_LL + WH_KEYBOARD_LL + WinEvent hooks + the pick overlay window.
 *           Only classifies input, decides whether to swallow it (pick, mouse lock) and
 *           queues events for main. Never blocks, so the low-level hooks stay fast.
 *   stdin : blocking ReadFile, splits lines and queues them for main. `abort` while a
 *           seq runs is applied directly.
 * All state shared between threads is guarded by `cs` (or is a volatile LONG changed
 * with Interlocked*). Every wait on the main thread is MsgWaitForMultipleObjects on
 * `wake_ev`, which the other two threads signal.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER 0x0A00
#endif

#include <windows.h>
#include <dwmapi.h>
#include <mmsystem.h>
#include <objbase.h>
#include <tlhelp32.h>

#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _MSC_VER
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "dwmapi.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "winmm.lib")
#endif

#define PROTOCOL_VERSION 3
#define MOTION_INTERVAL_MS 8
#define POST_SEQ_SUPPRESS_MS 30
#define WINDOWS_DEBOUNCE_MS 100
#define ACTIVATE_WAIT_MS 200
#define POINTER_SETTLE_MS 100
#define FRAC_LIMIT 100.0
#define COORD_LIMIT 32767L
#define PICK_RELEASE_TIMEOUT_MS 3000
/* Mouse lock is only honoured while the main thread shows signs of life (it refreshes
 * the heartbeat at least every 100 ms during a seq), so a wedged helper can never keep
 * the user's mouse frozen. */
#define LOCK_STALE_MS 1000
/* Time allowed for an injected absolute move to show up in GetCursorPos. */
#define WARP_SETTLE_MS 50
/* Background mode: WM_NCHITTEST timeout per candidate window, and minimum spacing of
 * posted drag moves. */
#define BG_HITTEST_TIMEOUT_MS 50
#define BG_MOVE_INTERVAL_MS 8
/* Tag on every event we inject (MOUSEINPUT.dwExtraInfo). */
#define INJECT_MAGIC ((ULONG_PTR)0x434C4B52u) /* "CLKR" */

/* Hook thread messages (PostThreadMessage; the hook thread owns the overlay window,
 * so nothing ever sends to it synchronously from another thread). */
#define WM_APP_SYNC_OVERLAY (WM_APP + 1)   /* show/hide overlay to match pick_state */
#define WM_APP_PICK_CLICK (WM_APP + 2)     /* overlay click-through, then EV_PICK_LEFT */
#define WM_APP_OVERLAY_SOLID (WM_APP + 3)  /* pick resolved: overlay hit-testable again */

#ifndef EVENT_OBJECT_CLOAKED
#define EVENT_OBJECT_CLOAKED 0x8017
#define EVENT_OBJECT_UNCLOAKED 0x8018
#endif
#ifndef DWMWA_CLOAKED
#define DWMWA_CLOAKED 14
#endif
#ifndef DWM_CLOAKED_SHELL
#define DWM_CLOAKED_SHELL 0x2
#endif
#ifndef LLMHF_LOWER_IL_INJECTED
#define LLMHF_LOWER_IL_INJECTED 0x2
#endif
#ifndef LLKHF_LOWER_IL_INJECTED
#define LLKHF_LOWER_IL_INJECTED 0x2
#endif
#ifndef WM_MOUSEHWHEEL
#define WM_MOUSEHWHEEL 0x020E
#endif

/* ------------------------------------------------------------------------ */
/* Shared state                                                              */

static CRITICAL_SECTION cs;
static HANDLE wake_ev; /* auto-reset; signalled by the hook and stdin threads */
static HANDLE out_h, err_h;
static DWORD hook_tid;
static HWND overlay_hwnd; /* written once by the hook thread before it signals ready */
static DWORD host_pid;    /* parent process (the Electron main process) */

static volatile LONG abort_flag;
static volatile LONG exit_requested;
static volatile LONG stdin_eof;
static volatile LONG windows_dirty;

/* [cs] seq / pick state read by the hooks */
static int seq_running;
static int seq_bg; /* the running seq is a background seq: the mouse is not locked */
static long long suppress_until;
static long long heartbeat;
/* pick: 0 idle, 1 waiting for click, 2 replied, waiting for that button's release */
static int pick_state;
static int pick_rearm;
static int pick_button;
static long long pick_deadline;

/* [cs] input events from the hook thread */
enum { EV_BTN = 1, EV_MOTION, EV_ESC, EV_PICK_LEFT, EV_PICK_RIGHT };
typedef struct {
    unsigned char type, button, down, suppressed;
    POINT pt;
} InEv;
#define EVQ_SIZE 4096
static InEv evq[EVQ_SIZE];
static unsigned evq_head, evq_len;
static unsigned evq_dropped;

/* [cs] stdin lines */
typedef struct Line {
    struct Line *next;
    char s[];
} Line;
static Line *q_head, *q_tail;

/* main thread only */
static unsigned held_mask; /* physical buttons whose press was reported */
static HWND gesture_win;
static long long last_motion_ms = -1000;
static int motion_pending;
static long long windows_due;
static unsigned char held_btn[256]; /* buttons pressed by the running seq */

/* ------------------------------------------------------------------------ */
/* Utilities                                                                 */

static LARGE_INTEGER qpf;

static long long now_ms(void)
{
    LARGE_INTEGER c;
    QueryPerformanceCounter(&c);
    return (c.QuadPart / qpf.QuadPart) * 1000 + (c.QuadPart % qpf.QuadPart) * 1000 / qpf.QuadPart;
}

static void write_all(HANDLE h, const char *p, size_t n, int is_stdout)
{
    while (n) {
        DWORD chunk = n > 0x10000000u ? 0x10000000u : (DWORD)n, put = 0;
        if (!h || h == INVALID_HANDLE_VALUE || !WriteFile(h, p, chunk, &put, NULL) || put == 0) {
            if (is_stdout) { /* host gone */
                InterlockedExchange(&exit_requested, 1);
                SetEvent(wake_ev);
            }
            return;
        }
        p += put;
        n -= put;
    }
}

static void diag(const char *fmt, ...)
{
    char msg[600];
    int l = snprintf(msg, sizeof msg, "clickered-helper: ");
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg + l, sizeof msg - (size_t)l - 2, fmt, ap);
    va_end(ap);
    strcat(msg, "\n");
    write_all(err_h, msg, strlen(msg), 0);
}

static void die_oom(void)
{
    diag("out of memory");
    ExitProcess(3);
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
    if (c >= 0xC2 && c <= 0xDF) return (n >= 2 && (s[1] & 0xC0) == 0x80) ? 2 : 0;
    if (c >= 0xE0 && c <= 0xEF) {
        if (n < 3 || (s[1] & 0xC0) != 0x80 || (s[2] & 0xC0) != 0x80) return 0;
        if (c == 0xE0 && s[1] < 0xA0) return 0; /* overlong */
        if (c == 0xED && s[1] > 0x9F) return 0; /* surrogates */
        return 3;
    }
    if (c >= 0xF0 && c <= 0xF4) {
        if (n < 4 || (s[1] & 0xC0) != 0x80 || (s[2] & 0xC0) != 0x80 || (s[3] & 0xC0) != 0x80)
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

/* Append a UTF-16 string as a JSON string literal. */
static void b_jwstr(Buf *b, const WCHAR *w, int wlen)
{
    if (wlen <= 0) {
        b_puts(b, "\"\"");
        return;
    }
    /* Unpaired surrogates are converted to U+FFFD (no WC_ERR_INVALID_CHARS). */
    int n = WideCharToMultiByte(CP_UTF8, 0, w, wlen, NULL, 0, NULL, NULL);
    if (n <= 0) {
        b_puts(b, "\"\"");
        return;
    }
    char *u = xrealloc(NULL, (size_t)n);
    WideCharToMultiByte(CP_UTF8, 0, w, wlen, u, n, NULL, NULL);
    b_jstr(b, u, (size_t)n);
    free(u);
}

static void b_num(Buf *b, double v)
{
    if (!isfinite(v)) v = 0;
    b_printf(b, "%.6f", v);
}

/* Window ids on the wire: the HWND's 32 significant bits (handles are sign-extended
 * 32-bit values even in 64-bit processes). */
static unsigned long hwnd_id(HWND h)
{
    return (unsigned long)(uint32_t)(uintptr_t)h;
}

static HWND id_hwnd(unsigned long id)
{
    return (HWND)(intptr_t)(int32_t)(uint32_t)id;
}

static Buf out;

/* Write one finished JSON line to stdout. Main thread only. */
static void emit_buf(Buf *b)
{
    b_putc(b, '\n');
    write_all(out_h, b->p, b->n, 1);
    b->n = 0;
    if (b->p) b->p[0] = 0;
}

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
    diag("%s", msg);
}

/* ------------------------------------------------------------------------ */
/* Virtual desktops (IVirtualDesktopManager, declared here to avoid depending on
 * a particular SDK / mingw header version)                                  */

typedef struct VDM VDM;
typedef struct {
    HRESULT(STDMETHODCALLTYPE *QueryInterface)(VDM *, REFIID, void **);
    ULONG(STDMETHODCALLTYPE *AddRef)(VDM *);
    ULONG(STDMETHODCALLTYPE *Release)(VDM *);
    HRESULT(STDMETHODCALLTYPE *IsWindowOnCurrentVirtualDesktop)(VDM *, HWND, BOOL *);
    HRESULT(STDMETHODCALLTYPE *GetWindowDesktopId)(VDM *, HWND, GUID *);
    HRESULT(STDMETHODCALLTYPE *MoveWindowToDesktop)(VDM *, HWND, REFGUID);
} VDMVtbl;
struct VDM {
    const VDMVtbl *lpVtbl;
};
static const GUID CLSID_VDM_ = {0xaa509086, 0x5ca9, 0x4c25, {0x8f, 0x95, 0x58, 0x9d, 0x3c, 0x07, 0xb4, 0x8a}};
static const GUID IID_VDM_ = {0xa5cd92ff, 0x29be, 0x454c, {0x8d, 0x04, 0xd8, 0x28, 0x79, 0xfb, 0x3f, 0x1b}};
static VDM *vdm;
static int vdm_tried;

/* A window cloaked by the shell because it lives on another virtual desktop. Such
 * windows stay in the list (mapped:false), like X windows on another workspace. */
static int on_other_desktop(HWND h, DWORD cloaked)
{
    if (cloaked & ~(DWORD)DWM_CLOAKED_SHELL) return 0; /* app-cloaked / inherited */
    if (!vdm_tried) {
        vdm_tried = 1;
        if (FAILED(CoCreateInstance(&CLSID_VDM_, NULL, CLSCTX_ALL, &IID_VDM_, (void **)&vdm)))
            vdm = NULL;
    }
    if (!vdm) return 0;
    GUID id;
    static const GUID zero;
    if (FAILED(vdm->lpVtbl->GetWindowDesktopId(vdm, h, &id)) || memcmp(&id, &zero, sizeof id) == 0)
        return 0;
    BOOL on = TRUE;
    if (FAILED(vdm->lpVtbl->IsWindowOnCurrentVirtualDesktop(vdm, h, &on))) return 0;
    return !on;
}

/* ------------------------------------------------------------------------ */
/* Window helpers                                                            */

static DWORD pid_of(HWND h)
{
    DWORD pid = 0;
    GetWindowThreadProcessId(h, &pid);
    return pid;
}

static DWORD cloak_state(HWND h)
{
    DWORD c = 0;
    if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, &c, sizeof c) != S_OK) c = 0;
    return c;
}

/*
 * Is h a client window (the Alt-Tab / taskbar set: visible, titled, unowned top-level
 * windows that are not tool windows, unless WS_EX_APPWINDOW)? The host's own windows
 * (the clickered bar) are always included. *mapped = visible, not minimized, not cloaked.
 */
static int is_client(HWND h, int *mapped)
{
    if (!h || h == overlay_hwnd || !IsWindow(h)) return 0;
    if (GetAncestor(h, GA_ROOT) != h) return 0;
    LONG_PTR st = GetWindowLongPtrW(h, GWL_STYLE);
    LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
    if (!(st & WS_VISIBLE)) return 0;
    int host = host_pid && pid_of(h) == host_pid;
    if (!host && !(ex & WS_EX_APPWINDOW)) {
        if (ex & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)) return 0;
        if (GetWindow(h, GW_OWNER)) return 0;
    }
    /* GetWindowText does not send messages to other processes' windows (cannot hang). */
    WCHAR t[2];
    if (GetWindowTextW(h, t, 2) <= 0) return 0;
    DWORD cloaked = cloak_state(h);
    if (cloaked && !on_other_desktop(h, cloaked)) return 0;
    if (mapped) *mapped = !cloaked && !IsIconic(h);
    return 1;
}

/* The client window a top-level window belongs to: itself, or its root owner (e.g. a
 * game's popup / dropdown counts as the game window). 0 if none. */
static HWND client_of(HWND root)
{
    if (!root) return NULL;
    if (is_client(root, NULL)) return root;
    HWND o = GetAncestor(root, GA_ROOTOWNER);
    if (o && o != root && is_client(o, NULL)) return o;
    return NULL;
}

static HWND active_client(void)
{
    HWND fg = GetForegroundWindow();
    return fg ? client_of(GetAncestor(fg, GA_ROOT)) : NULL;
}

/* Exists, visible, not minimized, not cloaked. */
static int window_ok(HWND h)
{
    if (!h || !IsWindow(h)) return 0;
    return IsWindowVisible(h) && !IsIconic(h) && !cloak_state(h);
}

typedef struct {
    int x, y, w, h;
} Rect;

/* Content rect = client area in (physical) screen coordinates. Both corners are mapped
 * with ClientToScreen so DPI-virtualized (system/unaware) windows come out in physical
 * pixels too. Returns 0 if the window does not exist. */
static int content_rect(HWND h, Rect *r)
{
    RECT rc;
    if (!h || !GetClientRect(h, &rc)) return 0;
    POINT a = {0, 0}, b = {rc.right, rc.bottom};
    if (!ClientToScreen(h, &a) || !ClientToScreen(h, &b)) return 0;
    r->x = a.x;
    r->y = a.y;
    r->w = b.x - a.x;
    r->h = b.y - a.y;
    return 1;
}

/* Topmost visible top-level window at pt, ignoring our overlay (fallback for when hit
 * testing lands on the overlay). */
static HWND zwalk_at(POINT pt)
{
    for (HWND h = GetTopWindow(NULL); h; h = GetWindow(h, GW_HWNDNEXT)) {
        if (h == overlay_hwnd || !IsWindowVisible(h) || IsIconic(h) || cloak_state(h)) continue;
        LONG_PTR ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        if ((ex & WS_EX_LAYERED) && (ex & WS_EX_TRANSPARENT)) continue; /* click-through */
        RECT wr;
        if (!GetWindowRect(h, &wr) || !PtInRect(&wr, pt)) continue;
        HRGN rg = CreateRectRgn(0, 0, 0, 0);
        if (rg) {
            int kind = GetWindowRgn(h, rg);
            int inside = kind == ERROR || kind == NULLREGION ||
                         PtInRegion(rg, pt.x - wr.left, pt.y - wr.top);
            DeleteObject(rg);
            if (!inside) continue;
        }
        return h;
    }
    return NULL;
}

/* Top-level window under pt (the real one, never the pick overlay: for a pick click
 * the hook thread has made the overlay click-through before main resolves it). */
static HWND root_at(POINT pt)
{
    HWND h = WindowFromPoint(pt);
    HWND r = h ? GetAncestor(h, GA_ROOT) : NULL;
    if (overlay_hwnd && r == overlay_hwnd) r = zwalk_at(pt);
    return r;
}

static HWND client_at(POINT pt)
{
    return client_of(root_at(pt));
}

static POINT cursor_pos(void)
{
    POINT p = {0, 0};
    if (!GetCursorPos(&p)) p.x = p.y = 0;
    return p;
}

/* ------------------------------------------------------------------------ */
/* windows message                                                           */

typedef struct {
    HWND *v;
    size_t n, cap;
} HwndList;

static BOOL CALLBACK enum_cb(HWND h, LPARAM lp)
{
    HwndList *l = (HwndList *)lp;
    if (l->n == l->cap) {
        l->cap = l->cap ? l->cap * 2 : 256;
        l->v = xrealloc(l->v, l->cap * sizeof *l->v);
    }
    l->v[l->n++] = h;
    return TRUE;
}

static char *last_windows;
static size_t last_windows_len;

/* dedupe: skip if identical to the last windows line sent (debounced notifications). */
static void emit_windows(int dedupe)
{
    windows_due = 0;
    HwndList l = {0};
    EnumWindows(enum_cb, (LPARAM)&l);
    Buf *b = &out;
    b_printf(b, "{\"t\":\"windows\",\"active\":%lu,\"list\":[", hwnd_id(active_client()));
    int first = 1;
    WCHAR wbuf[1024];
    for (size_t i = 0; i < l.n; i++) {
        HWND w = l.v[i];
        int mapped = 0;
        Rect r;
        if (!is_client(w, &mapped) || !content_rect(w, &r)) continue;
        if (!first) b_putc(b, ',');
        first = 0;
        b_printf(b, "{\"id\":%lu,\"title\":", hwnd_id(w));
        b_jwstr(b, wbuf, GetWindowTextW(w, wbuf, (int)(sizeof wbuf / sizeof wbuf[0])));
        b_puts(b, ",\"cls\":");
        b_jwstr(b, wbuf, GetClassNameW(w, wbuf, (int)(sizeof wbuf / sizeof wbuf[0])));
        b_printf(b, ",\"pid\":%lu,\"x\":%d,\"y\":%d,\"w\":%d,\"h\":%d,\"mapped\":%s}",
                 (unsigned long)pid_of(w), r.x, r.y, r.w, r.h, mapped ? "true" : "false");
    }
    free(l.v);
    b_puts(b, "]}");
    if (dedupe && last_windows && last_windows_len == b->n && memcmp(last_windows, b->p, b->n) == 0) {
        b->n = 0;
        b->p[0] = 0;
        return;
    }
    last_windows = xrealloc(last_windows, b->n);
    memcpy(last_windows, b->p, b->n);
    last_windows_len = b->n;
    emit_buf(b);
}

/* ------------------------------------------------------------------------ */
/* Hook thread                                                               */

static unsigned btn_passed;    /* hook thread: physical presses passed on to the system */
static unsigned btn_swallowed; /* hook thread: physical presses we swallowed */
static int wheel_acc_v, wheel_acc_h;
static int esc_held;
static HCURSOR cross_cursor;
static HANDLE hook_ready_ev;
static int hook_ok;

/* cs held. Returns 1 if main needs waking. */
static int evq_push(int type, int button, int down, int suppressed, POINT pt)
{
    if (type == EV_MOTION && evq_len && evq[(evq_head + evq_len - 1) % EVQ_SIZE].type == EV_MOTION)
        return 0; /* coalesced: main reads the cursor position when it emits */
    if (evq_len == EVQ_SIZE) {
        evq_dropped++;
        return 1;
    }
    InEv *e = &evq[(evq_head + evq_len) % EVQ_SIZE];
    e->type = (unsigned char)type;
    e->button = (unsigned char)button;
    e->down = (unsigned char)down;
    e->suppressed = (unsigned char)suppressed;
    e->pt = pt;
    evq_len++;
    return 1;
}

/* cs held: the picked click's button came up (or timed out): end the pick, or go again. */
static void pick_release_locked(void)
{
    if (pick_rearm) {
        pick_rearm = 0;
        pick_state = 1;
    } else {
        pick_state = 0;
        PostThreadMessageW(hook_tid, WM_APP_SYNC_OVERLAY, 0, 0);
    }
}

static int sgn(int v)
{
    return (v > 0) - (v < 0);
}

/* Accumulate wheel delta; whole WHEEL_DELTA notches become ticks (high-resolution
 * wheels report fractions). Returns signed tick count. */
static int wheel_ticks(int *acc, int delta)
{
    if (sgn(*acc) != sgn(delta)) *acc = 0;
    *acc += delta;
    int t = *acc / WHEEL_DELTA;
    *acc -= t * WHEEL_DELTA;
    if (t > 10) t = 10;
    if (t < -10) t = -10;
    return t;
}

static LRESULT CALLBACK mouse_hook(int code, WPARAM wp, LPARAM lp)
{
    if (code != HC_ACTION) return CallNextHookEx(NULL, code, wp, lp);
    const MSLLHOOKSTRUCT *m = (const MSLLHOOKSTRUCT *)lp;
    /* Injected input (ours, tagged INJECT_MAGIC, or anyone else's) is never reported
     * and never blocked. */
    if (m->flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) return CallNextHookEx(NULL, code, wp, lp);

    int button = 0, down = 0, wheel = 0, hwheel = 0;
    switch (wp) {
    case WM_MOUSEMOVE: break;
    case WM_LBUTTONDOWN: button = 1; down = 1; break;
    case WM_LBUTTONUP: button = 1; break;
    case WM_MBUTTONDOWN: button = 2; down = 1; break;
    case WM_MBUTTONUP: button = 2; break;
    case WM_RBUTTONDOWN: button = 3; down = 1; break;
    case WM_RBUTTONUP: button = 3; break;
    case WM_XBUTTONDOWN:
    case WM_XBUTTONUP: {
        WORD x = HIWORD(m->mouseData);
        button = x == XBUTTON1 ? 8 : x == XBUTTON2 ? 9 : 0;
        down = wp == WM_XBUTTONDOWN;
        if (!button) return CallNextHookEx(NULL, code, wp, lp);
        break;
    }
    case WM_MOUSEWHEEL: wheel = (short)HIWORD(m->mouseData); break;
    case WM_MOUSEHWHEEL: hwheel = (short)HIWORD(m->mouseData); break;
    default: return CallNextHookEx(NULL, code, wp, lp);
    }

    long long t = now_ms();
    int swallow = 0, wake = 0;
    EnterCriticalSection(&cs);
    int lock = seq_running && !seq_bg && t - heartbeat < LOCK_STALE_MS;
    int suppressed = seq_running || t < suppress_until || pick_state != 0;
    unsigned bit = 1u << button;
    if (wp == WM_MOUSEMOVE) {
        swallow = lock;
        if (!suppressed) wake |= evq_push(EV_MOTION, 0, 0, 0, m->pt);
    } else if (button && down) {
        if (pick_state == 1) {
            swallow = 1;
            if (button == 1 || button == 3) {
                if (button == 1) /* resolved outside the hook callback, see hook_thread */
                    PostThreadMessageW(hook_tid, WM_APP_PICK_CLICK, (WPARAM)(LONG_PTR)m->pt.x,
                                       (LPARAM)m->pt.y);
                else
                    wake |= evq_push(EV_PICK_RIGHT, button, 1, 1, m->pt);
                pick_state = 2;
                pick_button = button;
                pick_deadline = t + PICK_RELEASE_TIMEOUT_MS;
            }
        } else {
            swallow = pick_state != 0 || lock;
        }
        if (swallow) btn_swallowed |= bit;
        else btn_passed |= bit;
        wake |= evq_push(EV_BTN, button, 1, suppressed, m->pt);
    } else if (button) {
        /* A release always goes where its press went, so no application ever sees a
         * stray release or a stuck button. */
        if (btn_passed & bit) {
            btn_passed &= ~bit;
        } else if (btn_swallowed & bit) {
            btn_swallowed &= ~bit;
            swallow = 1;
            if (pick_state == 2 && button == pick_button) pick_release_locked();
        } else {
            swallow = pick_state != 0 || lock;
        }
        wake |= evq_push(EV_BTN, button, 0, suppressed, m->pt);
    } else {
        swallow = pick_state != 0 || lock;
        int ticks = wheel ? wheel_ticks(&wheel_acc_v, wheel) : wheel_ticks(&wheel_acc_h, hwheel);
        /* X numbering: 4 up, 5 down, 6 left, 7 right. */
        int b = wheel ? (ticks > 0 ? 4 : 5) : (ticks > 0 ? 7 : 6);
        for (int i = abs(ticks); i > 0; i--) {
            wake |= evq_push(EV_BTN, b, 1, suppressed, m->pt);
            wake |= evq_push(EV_BTN, b, 0, suppressed, m->pt);
        }
    }
    LeaveCriticalSection(&cs);
    if (wake) SetEvent(wake_ev);
    return swallow ? 1 : CallNextHookEx(NULL, code, wp, lp);
}

static LRESULT CALLBACK kbd_hook(int code, WPARAM wp, LPARAM lp)
{
    if (code == HC_ACTION) {
        const KBDLLHOOKSTRUCT *k = (const KBDLLHOOKSTRUCT *)lp;
        if (k->vkCode == VK_ESCAPE && !(k->flags & (LLKHF_INJECTED | LLKHF_LOWER_IL_INJECTED))) {
            if (wp == WM_KEYDOWN || wp == WM_SYSKEYDOWN) {
                if (!esc_held) { /* auto-repeat presses are not reported */
                    esc_held = 1;
                    POINT z = {0, 0};
                    EnterCriticalSection(&cs);
                    if (seq_running) InterlockedExchange(&abort_flag, 1);
                    evq_push(EV_ESC, 0, 1, 0, z);
                    LeaveCriticalSection(&cs);
                    SetEvent(wake_ev);
                }
            } else {
                esc_held = 0;
            }
        }
    }
    return CallNextHookEx(NULL, code, wp, lp); /* never swallowed */
}

static void CALLBACK win_event(HWINEVENTHOOK hk, DWORD ev, HWND h, LONG obj, LONG child, DWORD tid,
                               DWORD ms)
{
    (void)hk;
    (void)tid;
    (void)ms;
    if (ev != EVENT_SYSTEM_FOREGROUND && ev != EVENT_SYSTEM_MINIMIZESTART &&
        ev != EVENT_SYSTEM_MINIMIZEEND) {
        if (obj != OBJID_WINDOW || child != CHILDID_SELF || !h) return;
        if (ev != EVENT_OBJECT_DESTROY && GetAncestor(h, GA_ROOT) != h) return;
    }
    if (!InterlockedExchange(&windows_dirty, 1)) SetEvent(wake_ev);
}

static LRESULT CALLBACK overlay_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp)
{
    switch (msg) {
    case WM_SETCURSOR: SetCursor(cross_cursor); return TRUE;
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    default: return DefWindowProcW(h, msg, wp, lp);
    }
}

static void overlay_create(void)
{
    HINSTANCE hi = GetModuleHandleW(NULL);
    cross_cursor = LoadCursorW(NULL, IDC_CROSS);
    WNDCLASSEXW wc;
    memset(&wc, 0, sizeof wc);
    wc.cbSize = sizeof wc;
    wc.lpfnWndProc = overlay_proc;
    wc.hInstance = hi;
    wc.hCursor = cross_cursor;
    wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
    wc.lpszClassName = L"ClickeredPickOverlay";
    if (!RegisterClassExW(&wc)) {
        diag("pick overlay: RegisterClassEx failed (%lu)", GetLastError());
        return;
    }
    overlay_hwnd = CreateWindowExW(WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                                   wc.lpszClassName, L"", WS_POPUP, 0, 0, 1, 1, NULL, NULL, hi, NULL);
    if (!overlay_hwnd) {
        diag("pick overlay: CreateWindowEx failed (%lu)", GetLastError());
        return;
    }
    /* Alpha 1/255: invisible, but still hit-testable so it owns the cursor shape. */
    SetLayeredWindowAttributes(overlay_hwnd, 0, 1, LWA_ALPHA);
}

/* Make the overlay invisible to hit testing (a layered + WS_EX_TRANSPARENT window is
 * skipped by WindowFromPoint) or hit-testable again. Hook thread only. */
static void overlay_click_through(int on)
{
    if (!overlay_hwnd) return;
    LONG_PTR ex = GetWindowLongPtrW(overlay_hwnd, GWL_EXSTYLE);
    LONG_PTR want = on ? (ex | WS_EX_TRANSPARENT) : (ex & ~(LONG_PTR)WS_EX_TRANSPARENT);
    if (want != ex) SetWindowLongPtrW(overlay_hwnd, GWL_EXSTYLE, want);
}

/* Show the overlay (crosshair cursor) exactly while a pick is active. */
static void overlay_sync(void)
{
    if (!overlay_hwnd) return;
    EnterCriticalSection(&cs);
    int want = pick_state != 0;
    LeaveCriticalSection(&cs);
    if (want) {
        int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        SetWindowPos(overlay_hwnd, HWND_TOPMOST, vx, vy, vw, vh, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        SetCursor(cross_cursor);
    } else {
        ShowWindow(overlay_hwnd, SW_HIDE);
    }
}

static DWORD WINAPI hook_thread(LPVOID unused)
{
    (void)unused;
    MSG msg;
    PeekMessageW(&msg, NULL, WM_USER, WM_USER, PM_NOREMOVE); /* create the queue */
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    HINSTANCE hi = GetModuleHandleW(NULL);
    HHOOK mh = SetWindowsHookExW(WH_MOUSE_LL, mouse_hook, hi, 0);
    if (!mh) diag("SetWindowsHookEx(WH_MOUSE_LL) failed (%lu)", GetLastError());
    HHOOK kh = SetWindowsHookExW(WH_KEYBOARD_LL, kbd_hook, hi, 0);
    if (!kh) diag("SetWindowsHookEx(WH_KEYBOARD_LL) failed (%lu)", GetLastError());
    static const DWORD ranges[][2] = {
        {EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND},
        {EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND},
        {EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE}, /* create, destroy, show, hide */
        {EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE},
        {EVENT_OBJECT_CLOAKED, EVENT_OBJECT_UNCLOAKED},
    };
    for (size_t i = 0; i < sizeof ranges / sizeof ranges[0]; i++) {
        if (!SetWinEventHook(ranges[i][0], ranges[i][1], NULL, win_event, 0, 0,
                             WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS))
            diag("SetWinEventHook(0x%lx) failed", (unsigned long)ranges[i][0]);
    }
    overlay_create();
    hook_ok = mh && kh;
    SetEvent(hook_ready_ev);
    if (!hook_ok) return 1;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        if (msg.hwnd == NULL) {
            if (msg.message == WM_APP_SYNC_OVERLAY) {
                overlay_sync();
                continue;
            }
            if (msg.message == WM_APP_PICK_CLICK) {
                POINT pt = {(LONG)(LONG_PTR)msg.wParam, (LONG)msg.lParam};
                overlay_click_through(1);
                EnterCriticalSection(&cs);
                evq_push(EV_PICK_LEFT, 1, 1, 1, pt);
                LeaveCriticalSection(&cs);
                SetEvent(wake_ev);
                continue;
            }
            if (msg.message == WM_APP_OVERLAY_SOLID) {
                overlay_click_through(0);
                continue;
            }
        }
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}

static void request_overlay_sync(void)
{
    PostThreadMessageW(hook_tid, WM_APP_SYNC_OVERLAY, 0, 0);
}

/* ------------------------------------------------------------------------ */
/* stdin thread                                                              */

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
    EnterCriticalSection(&cs);
    if (seq_running && strcmp(trim(l->s), "abort") == 0) {
        InterlockedExchange(&abort_flag, 1);
        LeaveCriticalSection(&cs);
        free(l);
        SetEvent(wake_ev);
        return;
    }
    if (q_tail) q_tail->next = l;
    else q_head = l;
    q_tail = l;
    LeaveCriticalSection(&cs);
    SetEvent(wake_ev);
}

static DWORD WINAPI stdin_thread(LPVOID unused)
{
    (void)unused;
    HANDLE h = GetStdHandle(STD_INPUT_HANDLE);
    int is_pipe = h && h != INVALID_HANDLE_VALUE && GetFileType(h) == FILE_TYPE_PIPE;
    char *buf = NULL;
    size_t len = 0, cap = 0;
    int zero_reads = 0;
    for (;;) {
        if (cap - len < 4096) {
            cap = cap ? cap * 2 : 65536;
            buf = xrealloc(buf, cap);
        }
        DWORD got = 0;
        if (!h || h == INVALID_HANDLE_VALUE) break;
        if (!ReadFile(h, buf + len, (DWORD)(cap - len), &got, NULL)) break; /* EOF / broken pipe */
        if (got == 0) {
            /* On Windows a closed pipe fails ReadFile with ERROR_BROKEN_PIPE and a
             * successful 0-byte read is a zero-length write. Some environments (Wine)
             * report EOF as a 0-byte success instead: treat it as EOF unless the pipe is
             * demonstrably still open, and never spin on it. */
            DWORD avail = 0;
            if (!is_pipe || !PeekNamedPipe(h, NULL, 0, NULL, &avail, NULL)) break;
            if (++zero_reads > 50) break;
            Sleep(1);
            continue;
        }
        zero_reads = 0;
        size_t start = 0, end = len + got;
        for (size_t i = len; i < end; i++) {
            if (buf[i] == '\n') {
                push_line(buf + start, i - start);
                start = i + 1;
            }
        }
        memmove(buf, buf + start, end - start);
        len = end - start;
    }
    /* an unterminated partial line is dropped */
    free(buf);
    InterlockedExchange(&stdin_eof, 1);
    SetEvent(wake_ev);
    return 0;
}

static Line *pop_line(void)
{
    EnterCriticalSection(&cs);
    Line *l = q_head;
    if (l) {
        q_head = l->next;
        if (!q_head) q_tail = NULL;
    }
    LeaveCriticalSection(&cs);
    return l;
}

/* ------------------------------------------------------------------------ */
/* Capture (main thread side)                                                */

static int input_suppressed(void)
{
    return seq_running || now_ms() < suppress_until; /* main is the only writer */
}

static int pick_active(void)
{
    EnterCriticalSection(&cs);
    int p = pick_state != 0;
    LeaveCriticalSection(&cs);
    return p;
}

static void frac(HWND w, int x, int y, double *fx, double *fy)
{
    Rect r;
    *fx = *fy = 0;
    if (!w || !content_rect(w, &r) || r.w <= 0 || r.h <= 0) return;
    *fx = (double)(x - r.x) / r.w;
    *fy = (double)(y - r.y) / r.h;
}

static void emit_motion(void)
{
    POINT p = cursor_pos();
    double fx, fy;
    frac(gesture_win, p.x, p.y, &fx, &fy);
    b_printf(&out, "{\"t\":\"motion\",\"win\":%lu,\"fx\":", hwnd_id(gesture_win));
    b_num(&out, fx);
    b_puts(&out, ",\"fy\":");
    b_num(&out, fy);
    b_printf(&out, ",\"x\":%ld,\"y\":%ld,\"time\":%lld}", (long)p.x, (long)p.y, now_ms());
    emit_buf(&out);
    last_motion_ms = now_ms();
    motion_pending = 0;
}

static void emit_picked(HWND w)
{
    b_printf(&out, "{\"t\":\"picked\",\"win\":%lu}", hwnd_id(w));
    emit_buf(&out);
}

static void on_button(const InEv *e)
{
    int b = e->button;
    unsigned bit = 1u << b;
    if (e->down) {
        if (e->suppressed) return;
        if (held_mask & bit) return;
        if (held_mask == 0) {
            gesture_win = client_at(e->pt);
            motion_pending = 0;
        }
        held_mask |= bit;
    } else {
        if (!(held_mask & bit)) return;
        held_mask &= ~bit;
        if (held_mask == 0) motion_pending = 0;
        if (e->suppressed) return;
    }
    double fx, fy;
    frac(gesture_win, e->pt.x, e->pt.y, &fx, &fy);
    b_printf(&out, "{\"t\":\"btn\",\"down\":%s,\"button\":%d,\"win\":%lu,\"fx\":",
             e->down ? "true" : "false", b, hwnd_id(gesture_win));
    b_num(&out, fx);
    b_puts(&out, ",\"fy\":");
    b_num(&out, fy);
    b_printf(&out, ",\"x\":%ld,\"y\":%ld,\"time\":%lld}", (long)e->pt.x, (long)e->pt.y, now_ms());
    emit_buf(&out);
}

static void handle_event(const InEv *e)
{
    switch (e->type) {
    case EV_BTN: on_button(e); break;
    case EV_MOTION:
        if (!held_mask || input_suppressed() || pick_active()) return;
        if (now_ms() - last_motion_ms >= MOTION_INTERVAL_MS) emit_motion();
        else motion_pending = 1;
        break;
    case EV_ESC:
        b_printf(&out, "{\"t\":\"esc\",\"time\":%lld}", now_ms());
        emit_buf(&out);
        break;
    case EV_PICK_LEFT:
        emit_picked(client_at(e->pt));
        PostThreadMessageW(hook_tid, WM_APP_OVERLAY_SOLID, 0, 0);
        break;
    case EV_PICK_RIGHT: emit_picked(NULL); break;
    default: break;
    }
}

/* Fire timers that are due. */
static void service_timers(void)
{
    long long t = now_ms();
    if (windows_due && t >= windows_due) emit_windows(1);
    if (motion_pending && t - last_motion_ms >= MOTION_INTERVAL_MS) {
        if (held_mask && !input_suppressed() && !pick_active()) emit_motion();
        else motion_pending = 0;
    }
    EnterCriticalSection(&cs);
    if (pick_state == 2 && t >= pick_deadline) pick_release_locked();
    LeaveCriticalSection(&cs);
}

/* Handle everything the other threads queued, then timers. */
static void process_pending(void)
{
    for (;;) {
        InEv e;
        unsigned dropped;
        EnterCriticalSection(&cs);
        int have = evq_len > 0;
        if (have) {
            e = evq[evq_head];
            evq_head = (evq_head + 1) % EVQ_SIZE;
            evq_len--;
        }
        dropped = evq_dropped;
        evq_dropped = 0;
        LeaveCriticalSection(&cs);
        if (dropped) diag("input queue overflow, %u events dropped", dropped);
        if (!have) break;
        handle_event(&e);
    }
    if (InterlockedExchange(&windows_dirty, 0) && !windows_due)
        windows_due = now_ms() + WINDOWS_DEBOUNCE_MS;
    service_timers();
}

/* Milliseconds until the next timer, capped by cap; INFINITE = none. */
static DWORD next_timeout(long long cap)
{
    long long t = now_ms(), best = 0;
    int have = 0;
#define CONSIDER(expr)                     \
    do {                                   \
        long long d_ = (expr);             \
        if (d_ < 0) d_ = 0;                \
        if (!have || d_ < best) best = d_; \
        have = 1;                          \
    } while (0)
    if (cap >= 0) CONSIDER(cap);
    if (windows_due) CONSIDER(windows_due - t);
    if (motion_pending) CONSIDER(last_motion_ms + MOTION_INTERVAL_MS - t);
    EnterCriticalSection(&cs);
    int p2 = pick_state == 2;
    long long pd = pick_deadline;
    LeaveCriticalSection(&cs);
    if (p2) CONSIDER(pd - t);
#undef CONSIDER
    if (!have) return INFINITE;
    if (best > 1000000) best = 1000000;
    return (DWORD)best;
}

static void main_wait(DWORD ms)
{
    MsgWaitForMultipleObjects(1, &wake_ev, FALSE, ms, QS_ALLINPUT);
    MSG msg;
    while (PeekMessageW(&msg, NULL, 0, 0, PM_REMOVE)) DispatchMessageW(&msg);
}

/* ------------------------------------------------------------------------ */
/* Pick (main thread side)                                                   */

static void pick_start(void)
{
    EnterCriticalSection(&cs);
    if (pick_state == 2) {
        /* Picking several windows in a row: keep going, wait for the next click. */
        pick_rearm = 1;
        LeaveCriticalSection(&cs);
        return;
    }
    if (pick_state) {
        LeaveCriticalSection(&cs);
        emit_error("pick already active");
        return;
    }
    if (!hook_ok) {
        LeaveCriticalSection(&cs);
        emit_error("pick: mouse hook unavailable");
        emit_picked(NULL);
        return;
    }
    pick_state = 1;
    LeaveCriticalSection(&cs);
    request_overlay_sync();
}

static void pick_cancel(void)
{
    int emit = 0;
    EnterCriticalSection(&cs);
    if (pick_state == 1) {
        pick_state = 0;
        pick_rearm = 0;
        emit = 1;
    } else if (pick_state == 2 && pick_rearm) {
        pick_rearm = 0; /* the pick ends with the pending release */
        emit = 1;
    }
    LeaveCriticalSection(&cs);
    if (emit) {
        request_overlay_sync();
        emit_picked(NULL);
    }
}

/* ------------------------------------------------------------------------ */
/* Waiting inside a seq                                                      */

static int seq_interrupted(void)
{
    return abort_flag || stdin_eof || exit_requested;
}

static void touch_heartbeat(void)
{
    long long t = now_ms();
    EnterCriticalSection(&cs);
    heartbeat = t;
    LeaveCriticalSection(&cs);
}

/*
 * Wait up to ms milliseconds while servicing the hook and stdin threads. If wait_active
 * is set, return early as soon as it is the active (foreground) client window. Returns 0
 * if the seq was interrupted (abort / Escape / EOF), 1 otherwise.
 */
static int seq_wait(long long ms, HWND wait_active)
{
    long long deadline = now_ms() + ms;
    for (;;) {
        touch_heartbeat();
        process_pending();
        if (seq_interrupted()) return 0;
        if (wait_active && active_client() == wait_active) return 1;
        long long left = deadline - now_ms();
        if (left <= 0) {
            process_pending();
            return !seq_interrupted();
        }
        long long cap = left;
        if (wait_active && cap > 5) cap = 5;
        if (cap > 100) cap = 100;
        main_wait(next_timeout(cap));
    }
}

/* ------------------------------------------------------------------------ */
/* Injection                                                                 */

static void send_mouse(DWORD flags, LONG dx, LONG dy, DWORD data)
{
    INPUT in;
    memset(&in, 0, sizeof in);
    in.type = INPUT_MOUSE;
    in.mi.dx = dx;
    in.mi.dy = dy;
    in.mi.mouseData = data;
    in.mi.dwFlags = flags;
    in.mi.dwExtraInfo = INJECT_MAGIC;
    if (SendInput(1, &in, sizeof in) != 1) diag("SendInput failed (%lu)", GetLastError());
}

static LONG clampl(LONG v, LONG lo, LONG hi)
{
    return v < lo ? lo : v > hi ? hi : v;
}

/* Where the cursor can actually end up for a target (nearest monitor, cursor clip). */
static POINT reachable(POINT p)
{
    MONITORINFO mi;
    mi.cbSize = sizeof mi;
    HMONITOR mon = MonitorFromPoint(p, MONITOR_DEFAULTTONEAREST);
    if (mon && GetMonitorInfoW(mon, &mi)) {
        p.x = clampl(p.x, mi.rcMonitor.left, mi.rcMonitor.right - 1);
        p.y = clampl(p.y, mi.rcMonitor.top, mi.rcMonitor.bottom - 1);
    }
    RECT clip;
    if (GetClipCursor(&clip)) {
        p.x = clampl(p.x, clip.left, clip.right - 1);
        p.y = clampl(p.y, clip.top, clip.bottom - 1);
    }
    return p;
}

/* Absolute pointer move (a real input event, so raw-input readers see it too). Waits
 * briefly until the cursor is there, then corrects exactly with SetCursorPos if the
 * normalized-coordinate rounding or a clip got in the way. */
static void warp(int x, int y)
{
    int vx = GetSystemMetrics(SM_XVIRTUALSCREEN), vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN), vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (vw <= 0 || vh <= 0) return;
    /* Aim at the pixel centre: correct under both rounding conventions Windows uses. */
    long long nx = ((long long)(x - vx) * 65536 + 32768) / vw;
    long long ny = ((long long)(y - vy) * 65536 + 32768) / vh;
    if (nx < 0) nx = 0;
    if (nx > 65535) nx = 65535;
    if (ny < 0) ny = 0;
    if (ny > 65535) ny = 65535;
    send_mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, (LONG)nx, (LONG)ny, 0);
    POINT want = {x, y};
    want = reachable(want);
    long long until = now_ms() + WARP_SETTLE_MS;
    for (;;) {
        POINT p = cursor_pos();
        if (p.x == want.x && p.y == want.y) return;
        if (now_ms() >= until) break;
        Sleep(1);
    }
    SetCursorPos(want.x, want.y);
}

static int any_btn_held(void)
{
    for (int i = 0; i < 256; i++)
        if (held_btn[i]) return 1;
    return 0;
}

/* Inject a button transition. Wheel "buttons" 4-7 inject one notch on press and nothing
 * on release. Returns 0 if the button cannot be injected. */
static int inject_button(int b, int down)
{
    switch (b) {
    case 1: send_mouse(down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP, 0, 0, 0); break;
    case 2: send_mouse(down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP, 0, 0, 0); break;
    case 3: send_mouse(down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP, 0, 0, 0); break;
    case 8: send_mouse(down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP, 0, 0, XBUTTON1); break;
    case 9: send_mouse(down ? MOUSEEVENTF_XDOWN : MOUSEEVENTF_XUP, 0, 0, XBUTTON2); break;
    case 4: if (down) send_mouse(MOUSEEVENTF_WHEEL, 0, 0, (DWORD)WHEEL_DELTA); return 1;
    case 5: if (down) send_mouse(MOUSEEVENTF_WHEEL, 0, 0, (DWORD)-WHEEL_DELTA); return 1;
    case 6: if (down) send_mouse(MOUSEEVENTF_HWHEEL, 0, 0, (DWORD)-WHEEL_DELTA); return 1;
    case 7: if (down) send_mouse(MOUSEEVENTF_HWHEEL, 0, 0, (DWORD)WHEEL_DELTA); return 1;
    default: return 0;
    }
    held_btn[b] = (unsigned char)down;
    return 1;
}

static int bg_recv_active(void);
static void bg_release_all(void);

static void release_all(void)
{
    if (bg_recv_active()) {
        bg_release_all();
        return;
    }
    for (int i = 0; i < 256; i++)
        if (held_btn[i]) inject_button(i, 0);
}

/*
 * Ask for w to become the foreground window. A background process may not normally do
 * that (foreground lock). Injecting an (empty) input event first makes this process the
 * last one to have produced input, which lets SetForegroundWindow through; as a fallback
 * we attach to the current foreground thread's input queue for the call.
 */
static void force_foreground(HWND w, int attach)
{
    send_mouse(0, 0, 0, 0);
    if (!attach) {
        SetForegroundWindow(w);
        return;
    }
    HWND fg = GetForegroundWindow();
    DWORD ft = fg ? GetWindowThreadProcessId(fg, NULL) : 0, me = GetCurrentThreadId();
    BOOL attached = ft && ft != me && AttachThreadInput(me, ft, TRUE);
    SetForegroundWindow(w);
    BringWindowToTop(w);
    if (attached) AttachThreadInput(me, ft, FALSE);
}

/*
 * Activate + raise; wait (bounded) until it is the foreground client window. Returns 1
 * only if w is active afterwards; 0 if Windows refused or was too slow, or on interrupt.
 */
static int activate(HWND w)
{
    if (active_client() == w) return 1;
    force_foreground(w, 0);
    if (!seq_wait(ACTIVATE_WAIT_MS / 2, w)) return 0;
    if (active_client() == w) return 1;
    force_foreground(w, 1);
    if (!seq_wait(ACTIVATE_WAIT_MS / 2, w)) return 0;
    return active_client() == w;
}

/* Wait (bounded) until the client window under the pointer is w. */
static int pointer_on(HWND w)
{
    long long deadline = now_ms() + POINTER_SETTLE_MS;
    for (;;) {
        if (client_at(cursor_pos()) == w) return 1;
        if (now_ms() >= deadline) return 0;
        if (!seq_wait(10, NULL)) return 0;
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

/* ------------------------------------------------------------------------ */
/* Background mode: window messages instead of input injection               */
/*
 * Nothing here touches the real pointer, the foreground window, or SendInput. Mouse
 * messages are posted straight to the deepest child window at the point. Posted
 * messages never pass through the low-level mouse hook, so they are never reported.
 * All of this runs on the main thread only.
 */

static int bg_mode;         /* `bg 1` seen: the next seq runs in background mode */
static HWND bg_recv;      /* receiver of the gesture in progress (until every button is up) */
static int vp_valid;      /* virtual pointer set by an `m` in this seq */
static POINT vp_pt;       /* virtual pointer, screen coordinates */
static HWND vp_win;       /* window the virtual pointer was last aimed at */
static long long bg_last_move_ms = -1000;
/* Last button press, kept across seqs (a host double click is two gestures/seqs). */
static struct {
    HWND recv;
    int button;
    long long t;
    POINT pt;
} bg_last_down;

static int bg_recv_active(void)
{
    return bg_recv != NULL;
}

/* WM_NCHITTEST without blocking on a hung target. HTNOWHERE on timeout. */
static LRESULT bg_hittest(HWND h, POINT s)
{
    DWORD_PTR r = HTNOWHERE;
    if (!SendMessageTimeoutW(h, WM_NCHITTEST, 0, MAKELPARAM((SHORT)s.x, (SHORT)s.y),
                             SMTO_ABORTIFHUNG | SMTO_BLOCK, BG_HITTEST_TIMEOUT_MS, &r))
        return HTNOWHERE;
    return (LRESULT)r;
}

/*
 * Deepest window under screen point s inside top's subtree, found by walking down:
 * children front to back, skipping hidden, disabled and WS_EX_TRANSPARENT ones, honouring
 * window regions, and letting each candidate answer HTTRANSPARENT to fall through.
 * (WindowFromPoint would return whatever occludes top; ChildWindowFromPointEx returns
 * static labels; RealChildWindowFromPoint returns disabled windows.) Returns 1 and the
 * window only if the point is a client-area hit there, else 0 (title bar, borders,
 * outside the window...): such a point must never receive button messages.
 */
static int bg_lookup(HWND top, POINT s, HWND *found)
{
    RECT wr;
    if (!top || !IsWindow(top) || !GetWindowRect(top, &wr) || !PtInRect(&wr, s)) return 0;
    HWND cur = top;
    for (int depth = 0; depth < 64; depth++) {
        RECT cr;
        POINT a = {0, 0};
        if (!GetClientRect(cur, &cr) || !ClientToScreen(cur, &a)) break;
        OffsetRect(&cr, a.x, a.y);
        if (!PtInRect(&cr, s)) break; /* children are clipped to the parent's client area */
        HWND hit = NULL;
        for (HWND ch = GetWindow(cur, GW_CHILD); ch; ch = GetWindow(ch, GW_HWNDNEXT)) {
            LONG_PTR st = GetWindowLongPtrW(ch, GWL_STYLE), ex = GetWindowLongPtrW(ch, GWL_EXSTYLE);
            if (!(st & WS_VISIBLE) || (st & WS_DISABLED) || (ex & WS_EX_TRANSPARENT)) continue;
            RECT r;
            if (!GetWindowRect(ch, &r) || !PtInRect(&r, s)) continue;
            HRGN rg = CreateRectRgn(0, 0, 0, 0);
            if (rg) {
                int kind = GetWindowRgn(ch, rg);
                int inside = kind == ERROR || (kind != NULLREGION && PtInRegion(rg, s.x - r.left, s.y - r.top));
                DeleteObject(rg);
                if (!inside) continue;
            }
            if (bg_hittest(ch, s) == HTTRANSPARENT) continue;
            hit = ch;
            break;
        }
        if (!hit) break;
        cur = hit;
    }
    if (bg_hittest(cur, s) != HTCLIENT) return 0;
    *found = cur;
    return 1;
}

/* Windows that are not DPI aware (or only system aware) see virtualized coordinates in
 * real input; scale the same way so a posted message matches what they expect. Falls
 * back to 1 when the (Windows 10 / 8.1) APIs are missing. */
static double bg_dpi_scale(HWND h)
{
    static int tried;
    static UINT(WINAPI * get_win_dpi)(HWND);
    static HRESULT(WINAPI * get_mon_dpi)(HMONITOR, int, UINT *, UINT *);
    if (!tried) {
        tried = 1;
        HMODULE u = GetModuleHandleW(L"user32.dll");
        if (u) get_win_dpi = (UINT(WINAPI *)(HWND))(void (*)(void))GetProcAddress(u, "GetDpiForWindow");
        HMODULE sh = LoadLibraryW(L"shcore.dll");
        if (sh)
            get_mon_dpi = (HRESULT(WINAPI *)(HMONITOR, int, UINT *, UINT *))(void (*)(void))GetProcAddress(
                sh, "GetDpiForMonitor");
    }
    if (!get_win_dpi || !get_mon_dpi) return 1.0;
    UINT wd = get_win_dpi(h), dx = 0, dy = 0;
    HMONITOR mon = MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST);
    if (!wd || !mon || FAILED(get_mon_dpi(mon, 0 /* MDT_EFFECTIVE_DPI */, &dx, &dy)) || !dx) return 1.0;
    return (double)wd / (double)dx;
}

/* lParam for a client-area mouse message to h at screen point s. */
static LPARAM bg_client_lp(HWND h, POINT s)
{
    POINT c = s;
    ScreenToClient(h, &c);
    double k = bg_dpi_scale(h);
    if (k != 1.0) {
        c.x = (LONG)floor(c.x * k + 0.5);
        c.y = (LONG)floor(c.y * k + 0.5);
    }
    return MAKELPARAM((SHORT)c.x, (SHORT)c.y);
}

/* MK_* flags for the buttons this seq holds. */
static WPARAM bg_keyflags(void)
{
    WPARAM f = 0;
    if (held_btn[1]) f |= MK_LBUTTON;
    if (held_btn[2]) f |= MK_MBUTTON;
    if (held_btn[3]) f |= MK_RBUTTON;
    if (held_btn[8]) f |= MK_XBUTTON1;
    if (held_btn[9]) f |= MK_XBUTTON2;
    return f;
}

static int bg_post_move(HWND h, POINT s)
{
    bg_last_move_ms = now_ms();
    return PostMessageW(h, WM_MOUSEMOVE, bg_keyflags(), bg_client_lp(h, s)) != 0;
}

/* `m`: move the virtual pointer to screen point s of window w. Returns 0 if a click
 * cannot be delivered there (skip mode). While a gesture is in progress the receiver is
 * fixed (stand-in for mouse capture) and only gets throttled moves. */
static int bg_m(HWND w, POINT s)
{
    vp_valid = 1;
    vp_pt = s;
    vp_win = w;
    if (bg_recv) {
        if (now_ms() - bg_last_move_ms < BG_MOVE_INTERVAL_MS) return 1;
        return bg_post_move(bg_recv, s);
    }
    HWND c;
    if (!bg_lookup(w, s, &c)) return 0;
    return bg_post_move(c, s);
}

static int bg_msgs(int b, UINT *down, UINT *up, UINT *dbl)
{
    switch (b) {
    case 1: *down = WM_LBUTTONDOWN; *up = WM_LBUTTONUP; *dbl = WM_LBUTTONDBLCLK; return 1;
    case 2: *down = WM_MBUTTONDOWN; *up = WM_MBUTTONUP; *dbl = WM_MBUTTONDBLCLK; return 1;
    case 3: *down = WM_RBUTTONDOWN; *up = WM_RBUTTONUP; *dbl = WM_RBUTTONDBLCLK; return 1;
    case 8:
    case 9: *down = WM_XBUTTONDOWN; *up = WM_XBUTTONUP; *dbl = WM_XBUTTONDBLCLK; return 1;
    default: return 0;
    }
}

static WPARAM bg_button_wp(int b, WPARAM flags)
{
    return b == 8 ? MAKEWPARAM(flags, XBUTTON1) : b == 9 ? MAKEWPARAM(flags, XBUTTON2) : flags;
}

static WPARAM bg_own_flag(int b)
{
    switch (b) {
    case 1: return MK_LBUTTON;
    case 2: return MK_MBUTTON;
    case 3: return MK_RBUTTON;
    case 8: return MK_XBUTTON1;
    case 9: return MK_XBUTTON2;
    default: return 0;
    }
}

/* `d BTN`. Returns 0 for skip mode. */
static int bg_down(int b)
{
    if (!vp_valid) {
        diag("background press without a preceding m, ignored");
        return 1;
    }
    UINT dn, up, dbl;
    if (b >= 4 && b <= 7) {
        HWND c;
        if (!bg_lookup(vp_win, vp_pt, &c)) return 0;
        int delta = (b == 4 || b == 7) ? WHEEL_DELTA : -WHEEL_DELTA;
        /* Wheel messages carry SCREEN coordinates. */
        return PostMessageW(c, b <= 5 ? WM_MOUSEWHEEL : WM_MOUSEHWHEEL, MAKEWPARAM(bg_keyflags(), (WORD)(short)delta),
                            MAKELPARAM((SHORT)vp_pt.x, (SHORT)vp_pt.y)) != 0;
    }
    if (!bg_msgs(b, &dn, &up, &dbl)) {
        diag("button %d cannot be delivered in background mode, ignored", b);
        return 1;
    }
    if (held_btn[b]) return 1;
    HWND c = bg_recv;
    if (!c && !bg_lookup(vp_win, vp_pt, &c)) return 0;
    if (!bg_post_move(c, vp_pt)) return 0;
    /* Posted messages are not turned into double clicks by the system: do it here for
     * classes that ask for them (CS_DBLCLKS). */
    UINT msg = dn;
    long long t = now_ms();
    int dcx = GetSystemMetrics(SM_CXDOUBLECLK) / 2, dcy = GetSystemMetrics(SM_CYDOUBLECLK) / 2;
    if (!bg_recv && bg_last_down.recv == c && bg_last_down.button == b &&
        t - bg_last_down.t <= (long long)GetDoubleClickTime() && labs(vp_pt.x - bg_last_down.pt.x) <= dcx &&
        labs(vp_pt.y - bg_last_down.pt.y) <= dcy && (GetClassLongPtrW(c, GCL_STYLE) & CS_DBLCLKS)) {
        msg = dbl;
        bg_last_down.recv = NULL; /* a third press starts over */
    } else {
        bg_last_down.recv = c;
        bg_last_down.button = b;
        bg_last_down.t = t;
        bg_last_down.pt = vp_pt;
    }
    if (!PostMessageW(c, msg, bg_button_wp(b, bg_keyflags() | bg_own_flag(b)), bg_client_lp(c, vp_pt))) return 0;
    held_btn[b] = 1;
    bg_recv = c;
    return 1;
}

/* `u BTN`: the release goes to the receiver of the press. Returns 0 if it was refused. */
static int bg_up(int b)
{
    UINT dn, up, dbl;
    if (b >= 4 && b <= 7) return 1; /* wheel: the matching u is a no-op */
    if (!bg_msgs(b, &dn, &up, &dbl) || !held_btn[b]) return 1;
    held_btn[b] = 0;
    HWND c = bg_recv;
    if (!any_btn_held()) bg_recv = NULL;
    if (!c) return 1;
    return PostMessageW(c, up, bg_button_wp(b, bg_keyflags()), bg_client_lp(c, vp_pt)) != 0;
}

static void bg_release_all(void)
{
    for (int i = 0; i < 256; i++)
        if (held_btn[i]) bg_up(i);
    bg_recv = NULL;
}

/* ------------------------------------------------------------------------ */
/* seq                                                                       */

typedef struct {
    char op; /* f m d u s w */
    unsigned long win;
    double fx, fy;
    long a, b;
} Op;

/* strtok-like, portable (no strtok_r / strtok_s difference). */
static char *next_tok(char **cur, const char *delims)
{
    char *s = *cur;
    while (*s && strchr(delims, *s)) s++;
    if (!*s) {
        *cur = s;
        return NULL;
    }
    char *start = s;
    while (*s && !strchr(delims, *s)) s++;
    if (*s) *s++ = 0;
    *cur = s;
    return start;
}

static int parse_ops(char *s, Op **out_ops, size_t *out_n, char *err, size_t errlen)
{
    Op *ops = NULL;
    size_t n = 0, cap = 0;
    char *cur = s;
    /* Segments are split by ';' first; each is then tokenized. Empty segments are skipped. */
    for (;;) {
        char *seg = cur;
        if (!*seg) break;
        char *semi = strchr(seg, ';');
        if (semi) {
            *semi = 0;
            cur = semi + 1;
        } else {
            cur = seg + strlen(seg);
        }
        char *t = trim(seg);
        if (!*t) continue;
        char *tok[4];
        int nt = 0;
        char *tc = t;
        for (char *w = next_tok(&tc, " \t"); w; w = next_tok(&tc, " \t")) {
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
#define NUMUL(i, dst)                                                         \
    do {                                                                      \
        errno = 0;                                                            \
        unsigned long long v_ = strtoull(tok[i], &end, 0);                    \
        if (errno || *end || end == tok[i] || tok[i][0] == '-' || v_ > 0xFFFFFFFFull) ok = 0; \
        (dst) = (unsigned long)v_;                                            \
    } while (0)
#define NUML(i, dst)                                \
    do {                                            \
        errno = 0;                                  \
        (dst) = strtol(tok[i], &end, 10);           \
        if (errno || *end || end == tok[i]) ok = 0; \
    } while (0)
#define NUMD(i, dst)                                                                            \
    do {                                                                                        \
        errno = 0;                                                                              \
        (dst) = strtod(tok[i], &end);                                                           \
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
        if (!ok || ((o.op == 'f' || o.op == 'm') && o.win == 0)) {
            snprintf(err, errlen, "bad seq op #%u", (unsigned)(n + 1));
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

/* cs held: consume `abort` lines queued after this seq and before the next seq. */
static void scan_queued_abort_locked(void)
{
    Line *prev = NULL, *l = q_head;
    while (l) {
        char *t = trim(l->s);
        if (strncmp(t, "seq", 3) == 0 && (t[3] == ' ' || t[3] == '\t' || t[3] == 0)) break;
        if (strcmp(t, "abort") == 0) {
            InterlockedExchange(&abort_flag, 1);
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
    if (errno || end == args || args[0] == '-' || (*end != ' ' && *end != '\t' && *end != 0)) {
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

    /* Start: suppress reporting + lock the mouse (the hook swallows physical mouse input
     * while seq_running and the heartbeat is fresh). */
    InterlockedExchange(&abort_flag, 0);
    timeBeginPeriod(1); /* 1 ms wait granularity for `s` sleeps and settle polls */
    EnterCriticalSection(&cs);
    seq_running = 1;
    seq_bg = bg_mode;
    heartbeat = now_ms();
    scan_queued_abort_locked();
    LeaveCriticalSection(&cs);

    int skip = 0;
    HWND skipwin = NULL;
    int any_target = 0, any_ok = 0;
    const int bg = bg_mode;
    vp_valid = 0;
    bg_recv = NULL;

    for (size_t i = 0; i < n; i++) {
        /* service the other threads between ops so `abort` is noticed promptly */
        if (!seq_wait(0, NULL)) break;
        Op *o = &ops[i];
        switch (o->op) {
        case 'f':
        case 'm': {
            any_target = 1;
            HWND w = id_hwnd(o->win);
            if (skip && w == skipwin) break;
            if (!window_ok(w)) {
                release_all();
                skip = 1;
                skipwin = w;
                break;
            }
            skip = 0;
            if (bg) {
                /* No activation, no real pointer: only the virtual one moves. */
                int ok = 1;
                if (o->op == 'm') {
                    Rect r;
                    ok = content_rect(w, &r) &&
                         bg_m(w, (POINT){frac_to_px(o->fx, r.x, r.w), frac_to_px(o->fy, r.y, r.h)});
                }
                if (!ok) {
                    release_all();
                    skip = 1;
                    skipwin = w;
                    break;
                }
                any_ok = 1;
                break;
            }
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
            Rect r;
            if (!content_rect(w, &r)) {
                release_all();
                skip = 1;
                skipwin = w;
                break;
            }
            warp(frac_to_px(o->fx, r.x, r.w), frac_to_px(o->fy, r.y, r.h));
            if (!any_btn_held() && client_at(cursor_pos()) != w) {
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
            if (bg) {
                if (!(o->op == 'd' ? bg_down((int)o->a) : bg_up((int)o->a))) {
                    release_all();
                    skip = 1;
                    skipwin = vp_win;
                }
                break;
            }
            if (!inject_button((int)o->a, o->op == 'd'))
                diag("button %ld cannot be injected on Windows, ignored", o->a);
            break;
        case 's':
            if (skip) break;
            seq_wait(o->a, NULL);
            break;
        case 'w':
            skip = 0;
            if (bg) break;
            warp((int)o->a, (int)o->b);
            break;
        }
        if (seq_interrupted()) break;
    }
    int interrupted = seq_interrupted();
    release_all();
    free(ops);
    EnterCriticalSection(&cs);
    seq_running = 0;
    seq_bg = 0;
    suppress_until = now_ms() + POST_SEQ_SUPPRESS_MS;
    LeaveCriticalSection(&cs);
    timeEndPeriod(1);
    InterlockedExchange(&abort_flag, 0);
    emit_done(id, !interrupted && (!any_target || any_ok));
}

/* ------------------------------------------------------------------------ */
/* Commands                                                                  */

static void exec_line(char *line)
{
    char *t = trim(line);
    if (!*t) return;
    if (strcmp(t, "list") == 0) {
        emit_windows(0);
    } else if (strcmp(t, "pick") == 0) {
        pick_start();
    } else if (strcmp(t, "pickcancel") == 0) {
        pick_cancel();
    } else if (strncmp(t, "seq", 3) == 0 && (t[3] == ' ' || t[3] == '\t')) {
        run_seq(trim(t + 4));
    } else if (strncmp(t, "bg", 2) == 0 && (t[2] == ' ' || t[2] == '\t' || t[2] == 0)) {
        char *a = trim(t + 2);
        if (strcmp(a, "0") == 0) bg_mode = 0;
        else if (strcmp(a, "1") == 0) bg_mode = 1;
        else emit_error("bad bg argument (expected 0 or 1)");
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
    release_all();
    EnterCriticalSection(&cs);
    pick_state = 0;
    pick_rearm = 0;
    LeaveCriticalSection(&cs);
    ExitProcess((UINT)code); /* hooks and the overlay die with the process */
}

static BOOL WINAPI on_ctrl(DWORD type)
{
    (void)type;
    InterlockedExchange(&exit_requested, 1);
    SetEvent(wake_ev);
    return TRUE;
}

/* Per-monitor DPI awareness v2, so every coordinate is in physical pixels. */
static void set_dpi_awareness(void)
{
    HMODULE u = GetModuleHandleW(L"user32.dll");
    typedef BOOL(WINAPI * SetCtxFn)(HANDLE);
    SetCtxFn set_ctx = u ? (SetCtxFn)(void (*)(void))GetProcAddress(u, "SetProcessDpiAwarenessContext") : NULL;
    if (set_ctx && (set_ctx((HANDLE)(LONG_PTR)-4) || set_ctx((HANDLE)(LONG_PTR)-3))) return;
    HMODULE sh = LoadLibraryW(L"shcore.dll");
    typedef HRESULT(WINAPI * SetAwFn)(int);
    SetAwFn set_aw = sh ? (SetAwFn)(void (*)(void))GetProcAddress(sh, "SetProcessDpiAwareness") : NULL;
    if (set_aw && SUCCEEDED(set_aw(2 /* PROCESS_PER_MONITOR_DPI_AWARE */))) return;
    SetProcessDPIAware();
}

static DWORD parent_pid(void)
{
    DWORD me = GetCurrentProcessId(), parent = 0;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe;
    pe.dwSize = sizeof pe;
    for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) {
        if (pe.th32ProcessID == me) {
            parent = pe.th32ParentProcessID;
            break;
        }
    }
    CloseHandle(snap);
    return parent;
}

static int helper_main(void)
{
    set_dpi_awareness();
    QueryPerformanceFrequency(&qpf);
    InitializeCriticalSection(&cs);
    wake_ev = CreateEventW(NULL, FALSE, FALSE, NULL);
    hook_ready_ev = CreateEventW(NULL, TRUE, FALSE, NULL);
    out_h = GetStdHandle(STD_OUTPUT_HANDLE);
    err_h = GetStdHandle(STD_ERROR_HANDLE);
    SetConsoleCtrlHandler(on_ctrl, TRUE);
    host_pid = parent_pid();
    CoInitializeEx(NULL, COINIT_MULTITHREADED);
    MSG msg;
    PeekMessageW(&msg, NULL, WM_USER, WM_USER, PM_NOREMOVE); /* this thread's queue */

    HANDLE ht = CreateThread(NULL, 0, hook_thread, NULL, 0, &hook_tid);
    if (!ht || WaitForSingleObject(hook_ready_ev, 10000) != WAIT_OBJECT_0 || !hook_ok) {
        diag("cannot install the low-level input hooks");
        return 1;
    }
    CloseHandle(ht);

    b_printf(&out, "{\"t\":\"ready\",\"version\":%d}", PROTOCOL_VERSION);
    emit_buf(&out);
    emit_windows(0);

    HANDLE st = CreateThread(NULL, 0, stdin_thread, NULL, 0, NULL);
    if (!st) {
        diag("cannot start the stdin thread");
        shutdown_and_exit(1);
    }
    CloseHandle(st);

    for (;;) {
        if (exit_requested) shutdown_and_exit(0);
        process_pending();
        if (stdin_eof || exit_requested) shutdown_and_exit(0);
        Line *l = pop_line();
        if (l) {
            exec_line(l->s);
            free(l);
            continue;
        }
        main_wait(next_timeout(-1));
    }
}

/* GUI subsystem: no console window is ever created, whoever launches us. The standard
 * handles passed by the parent (pipes) still work. */
int WINAPI WinMain(HINSTANCE inst, HINSTANCE prev, LPSTR cmd, int show)
{
    (void)inst;
    (void)prev;
    (void)cmd;
    (void)show;
    return helper_main();
}

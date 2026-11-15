/*
 * bgtarget.exe - logging test window for background mode (bg.py, see ../README.md).
 *
 *   bgtarget.exe LOG      -> "BG Target" top-level window with children, logs mouse messages
 *   bgtarget.exe front    -> "BG Front" plain window that makes itself foreground and covers
 *                            part of BG Target (an occluder)
 *   bgtarget.exe min      -> "BG Min" window that starts minimized
 *
 * Layout of "BG Target" (client area 400x300):
 *   EDIT   (multi-line, 60 lines)   client (0,0)-(200,150)
 *   BUTTON "Push"                   client (0,160)-(200,200)
 *   Panel  (custom, logs)           client (200,0)-(400,300)
 *     Inner (custom, logs)          panel  (50,50)-(150,150)  = client (250,50)-(350,150)
 *     Hidden (custom, invisible)    panel  (0,200)-(200,300)
 *     Disabled (custom, disabled)   panel  (0,160)-(100,200)
 *   STATIC "label" (no SS_NOTIFY -> HTTRANSPARENT) over the top-level background at (0,210)-(200,240)
 *
 * Every line logged goes to target.log (path from argv / cwd), flushed immediately.
 * Each mouse message logs: window name, message, lParam coords, wParam key flags, plus the
 * state the receiving app could consult: GetCursorPos, GetMessagePos, GetKeyState(VK_LBUTTON),
 * GetAsyncKeyState(VK_LBUTTON), GetCapture, GetForegroundWindow, GetActiveWindow, GetFocus.
 */
#include <windows.h>
#include <windowsx.h>
#include <stdio.h>
#include <string.h>

static FILE *lg;
static HWND top, edit, button, panel, inner, hiddenw, disabledw, label;

static const char *name_of(HWND h)
{
    if (h == NULL) return "null";
    if (h == top) return "top";
    if (h == edit) return "edit";
    if (h == button) return "button";
    if (h == panel) return "panel";
    if (h == inner) return "inner";
    if (h == hiddenw) return "hidden";
    if (h == disabledw) return "disabled";
    if (h == label) return "label";
    return "other";
}

static const char *msg_name(UINT m)
{
    switch (m) {
    case WM_MOUSEMOVE: return "WM_MOUSEMOVE";
    case WM_LBUTTONDOWN: return "WM_LBUTTONDOWN";
    case WM_LBUTTONUP: return "WM_LBUTTONUP";
    case WM_LBUTTONDBLCLK: return "WM_LBUTTONDBLCLK";
    case WM_RBUTTONDOWN: return "WM_RBUTTONDOWN";
    case WM_RBUTTONUP: return "WM_RBUTTONUP";
    case WM_MBUTTONDOWN: return "WM_MBUTTONDOWN";
    case WM_MBUTTONUP: return "WM_MBUTTONUP";
    case WM_MOUSEWHEEL: return "WM_MOUSEWHEEL";
    case WM_MOUSEHWHEEL: return "WM_MOUSEHWHEEL";
    case WM_MOUSEACTIVATE: return "WM_MOUSEACTIVATE";
    case WM_SETCURSOR: return "WM_SETCURSOR";
    case WM_NCHITTEST: return "WM_NCHITTEST";
    case WM_CAPTURECHANGED: return "WM_CAPTURECHANGED";
    case WM_MOUSELEAVE: return "WM_MOUSELEAVE";
    case WM_ACTIVATE: return "WM_ACTIVATE";
    case WM_SETFOCUS: return "WM_SETFOCUS";
    case WM_KILLFOCUS: return "WM_KILLFOCUS";
    case WM_CONTEXTMENU: return "WM_CONTEXTMENU";
    default: return NULL;
    }
}

static void logmsg(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    const char *mn = msg_name(m);
    if (!mn || !lg) return;
    POINT cp;
    GetCursorPos(&cp);
    DWORD mp = GetMessagePos();
    int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
    fprintf(lg,
            "MSG win=%s msg=%s x=%d y=%d wp=0x%llx cursor=%ld,%ld msgpos=%d,%d keystate_lb=%d async_lb=%d "
            "capture=%s fg_is_top=%d active=%s focus=%s\n",
            name_of(h), mn, x, y, (unsigned long long)wp, cp.x, cp.y, GET_X_LPARAM(mp), GET_Y_LPARAM(mp),
            (GetKeyState(VK_LBUTTON) & 0x8000) ? 1 : 0, (GetAsyncKeyState(VK_LBUTTON) & 0x8000) ? 1 : 0,
            name_of(GetCapture()), GetForegroundWindow() == top, name_of(GetActiveWindow()), name_of(GetFocus()));
    fflush(lg);
}

/* Custom windows: log, and do the typical "SetCapture on down, ReleaseCapture on up" drag dance. */
static LRESULT CALLBACK logwnd_proc(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    logmsg(h, m, wp, lp);
    switch (m) {
    case WM_MOUSEMOVE:
        if (h == inner) { /* hover tracking, as most toolkits do */
            TRACKMOUSEEVENT tme = {sizeof tme, TME_LEAVE, h, 0};
            TrackMouseEvent(&tme);
        }
        return 0;
    case WM_LBUTTONDOWN:
        SetCapture(h);
        return 0;
    case WM_LBUTTONUP:
        if (GetCapture() == h) ReleaseCapture();
        return 0;
    case WM_COMMAND:
        if (lg && (HWND)lp == button && HIWORD(wp) == BN_CLICKED) {
            fprintf(lg, "EVT button BN_CLICKED\n");
            fflush(lg);
        }
        break;
    case WM_DESTROY:
        if (h == top) PostQuitMessage(0);
        break;
    }
    return DefWindowProcW(h, m, wp, lp);
}

/* Subclass stock controls to log what they receive, then let them handle it. */
static WNDPROC edit_orig, button_orig, label_orig;
static LRESULT CALLBACK edit_sub(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    logmsg(h, m, wp, lp);
    LRESULT r = CallWindowProcW(edit_orig, h, m, wp, lp);
    if (lg && (m == WM_LBUTTONUP || m == WM_MOUSEWHEEL || m == WM_LBUTTONDOWN || m == WM_MOUSEMOVE)) {
        DWORD s = 0, e = 0;
        CallWindowProcW(edit_orig, h, EM_GETSEL, (WPARAM)&s, (LPARAM)&e);
        int first = (int)CallWindowProcW(edit_orig, h, EM_GETFIRSTVISIBLELINE, 0, 0);
        fprintf(lg, "EVT edit after=%s sel=%lu,%lu firstline=%d\n", msg_name(m), s, e, first);
        fflush(lg);
    }
    return r;
}
static LRESULT CALLBACK button_sub(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    logmsg(h, m, wp, lp);
    return CallWindowProcW(button_orig, h, m, wp, lp);
}
static LRESULT CALLBACK label_sub(HWND h, UINT m, WPARAM wp, LPARAM lp)
{
    LRESULT r = CallWindowProcW(label_orig, h, m, wp, lp);
    if (m == WM_NCHITTEST && lg) {
        fprintf(lg, "MSG win=label msg=WM_NCHITTEST result=%ld\n", (long)r);
        fflush(lg);
    } else {
        logmsg(h, m, wp, lp);
    }
    return r;
}

static HWND mk(const wchar_t *cls, const wchar_t *txt, DWORD style, int x, int y, int w, int hh, HWND parent)
{
    return CreateWindowExW(0, cls, txt, style, x, y, w, hh, parent, NULL, GetModuleHandleW(NULL), NULL);
}

int main(int argc, char **argv)
{
    HINSTANCE hi = GetModuleHandleW(NULL);
    WNDCLASSW wc = {0};
    wc.style = CS_DBLCLKS;
    wc.lpfnWndProc = logwnd_proc;
    wc.hInstance = hi;
    wc.hCursor = LoadCursor(NULL, IDC_ARROW);
    wc.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    wc.lpszClassName = L"BgLog";
    RegisterClassW(&wc);

    if (argc > 1 && strcmp(argv[1], "min") == 0) {
        HWND m = CreateWindowExW(0, L"BgLog", L"BG Min", WS_OVERLAPPEDWINDOW, 700, 100, 200, 150, NULL, NULL, hi, NULL);
        ShowWindow(m, SW_SHOWMINNOACTIVE);
        MSG msg;
        while (GetMessageW(&msg, NULL, 0, 0) > 0) DispatchMessageW(&msg);
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "front") == 0) {
        HWND f = CreateWindowExW(0, L"BgLog", L"BG Front", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 300, 150, 300, 200,
                                 NULL, NULL, hi, NULL);
        SetForegroundWindow(f);
        MSG msg;
        while (GetMessageW(&msg, NULL, 0, 0) > 0) DispatchMessageW(&msg);
        return 0;
    }

    lg = fopen(argc > 1 ? argv[1] : "target.log", "w");
    RECT r = {0, 0, 400, 300};
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    top = CreateWindowExW(0, L"BgLog", L"BG Target", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 100, 100, r.right - r.left,
                          r.bottom - r.top, NULL, NULL, hi, NULL);
    edit = mk(L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_BORDER | WS_VSCROLL | ES_MULTILINE | ES_AUTOVSCROLL, 0, 0, 200,
              150, top);
    {
        static wchar_t buf[60 * 16];
        buf[0] = 0;
        for (int i = 0; i < 60; i++) {
            wchar_t l[16];
            swprintf(l, 16, L"line %02d\r\n", i);
            wcscat(buf, l);
        }
        SetWindowTextW(edit, buf);
    }
    button = mk(L"BUTTON", L"Push", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 0, 160, 200, 40, top);
    label = mk(L"STATIC", L"label", WS_CHILD | WS_VISIBLE, 0, 210, 200, 30, top);
    panel = mk(L"BgLog", L"panel", WS_CHILD | WS_VISIBLE | WS_CLIPCHILDREN, 200, 0, 200, 300, top);
    inner = mk(L"BgLog", L"inner", WS_CHILD | WS_VISIBLE, 50, 50, 100, 100, panel);
    hiddenw = mk(L"BgLog", L"hidden", WS_CHILD, 0, 200, 200, 100, panel);
    disabledw = mk(L"BgLog", L"disabled", WS_CHILD | WS_VISIBLE | WS_DISABLED, 0, 160, 100, 40, panel);
    edit_orig = (WNDPROC)SetWindowLongPtrW(edit, GWLP_WNDPROC, (LONG_PTR)edit_sub);
    button_orig = (WNDPROC)SetWindowLongPtrW(button, GWLP_WNDPROC, (LONG_PTR)button_sub);
    label_orig = (WNDPROC)SetWindowLongPtrW(label, GWLP_WNDPROC, (LONG_PTR)label_sub);
    fprintf(lg, "READY top=%p\n", (void *)top);
    fflush(lg);

    MSG msg;
    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }
    return 0;
}

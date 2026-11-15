# clickered-helper.exe (Windows)

Windows port of `native/helper.c`, built from `helper.c` in this directory. It speaks the same
line protocol, **version 3** (`docs/PROTOCOL.md`; no keyboard replication: no `keys`, no `key`,
no `kd`/`ku`, but the Escape panic key is kept; plus the experimental [background mode](#background-mode-experimental)). The Electron host drives it the same way it
drives the X11 helper. It is plain C11 using the Win32 API only (user32, gdi32, dwmapi, ole32,
winmm), with no third-party code.

## Build

| Where | Command |
|---|---|
| Linux, cross-compiling | `make -C native/win` (uses `x86_64-w64-mingw32-gcc` when it is on `PATH`) |
| MSYS2 / Git-for-Windows / GitHub `windows-latest` | `make -C native/win` or `mingw32-make -C native/win` (uses `gcc`) |
| Any other compiler | `make -C native/win CC=...` |
| Docker, nothing installed locally | `native/win/test/wine-docker.sh` (builds, then runs the Wine tests) |

Output: `resources/clickered-helper.exe`, a GUI-subsystem exe. It is built with
`-std=c11 -Wall -Wextra -O2 -mwindows -static -static-libgcc -s`. It imports only system DLLs:
`KERNEL32 USER32 GDI32 dwmapi ole32 WINMM msvcrt` (`msvcrt.dll` ships with every Windows
version). The code also compiles cleanly with `-Wpedantic -Wshadow`.

MSVC (not tested): `cl /nologo /O2 /W4 /std:c11 native\win\helper.c /Fe:resources\clickered-helper.exe /link /SUBSYSTEM:WINDOWS`.
The needed `.lib`s are pulled in by `#pragma comment(lib, ...)`.

## Process model

* **GUI subsystem** (`WinMain`): no console window ever appears, whoever launches the helper and
  whatever `windowsHide` is set to. The stdin/stdout/stderr pipes handed over by the parent
  (`child_process.spawn`) work as usual. All I/O goes through `ReadFile`/`WriteFile` on the std
  handles. Each JSON line is written whole by the main thread, with no CRT buffering.
* **Three threads:**
  * **hook thread.** Owns `WH_MOUSE_LL`, `WH_KEYBOARD_LL`, the `SetWinEventHook` hooks and the
    pick overlay window. The hook callbacks only classify events, decide whether to swallow
    them, and queue them. They never block and never write to stdout, so the low-level hooks
    always return well inside `LowLevelHooksTimeout`. The thread runs at
    `THREAD_PRIORITY_HIGHEST`.
  * **stdin thread.** A blocking `ReadFile`. It splits lines and queues them. `abort` while a
    seq runs is applied immediately; anything else is queued for after the seq.
  * **main thread.** Runs commands and seqs and does all output. Every wait is
    `MsgWaitForMultipleObjects` on an event that the other two threads signal. That includes
    `s` sleeps and the activation and pointer-settle waits, so abort, Escape and EOF are noticed
    within about 1 ms, and windows/btn/esc messages keep flowing.
* **stdin EOF**: a running seq stops, held buttons are released, `done ok:false` is sent, queued
  commands are dropped, and the process exits with code 0. **Prefer closing stdin to
  `child.kill()`.** On Windows `kill()` is `TerminateProcess`, which gives the helper no chance
  to release buttons held by a seq. The hooks and overlay vanish with the process either way,
  so the mouse can never stay locked.
* **DPI**: per-monitor-aware v2, with fallbacks to per-monitor and then system-aware on old
  systems. It is set at runtime before any window is created, so no manifest is needed. Every
  coordinate in and out is in **physical pixels** in virtual-screen space. Coordinates can be
  negative when a monitor sits left of or above the primary one.
* `time` is QueryPerformanceCounter in milliseconds, which is monotonic.

## Platform mapping

| Protocol concept | Windows implementation |
|---|---|
| window id | HWND, as its 32 significant bits (handles are sign-extended 32-bit values even in 64-bit processes; ids are parsed back accordingly) |
| client windows | `EnumWindows`, keeping top-level windows that are visible, have a non-empty title, are not owned, and are not `WS_EX_TOOLWINDOW` / `WS_EX_NOACTIVATE` (unless `WS_EX_APPWINDOW`). This is the taskbar / Alt-Tab set. Also kept: every visible titled top-level window of the **parent process**, so the clickered bar is in the list even though it skips the taskbar. The host's `isOwnWindow` (pid check) relies on this. Cloaked windows (`DWMWA_CLOAKED`) are dropped, **except** windows the shell cloaked because they are on another virtual desktop (checked with `IVirtualDesktopManager`). Those stay in the list as `mapped:false`, like X windows on another workspace, so switching desktops does not drop group members. |
| `title` | `GetWindowTextW` → UTF-8. For other processes' windows it reads the stored caption and sends no message, so a hung app cannot block us. Unpaired surrogates become U+FFFD; output is always valid UTF-8 and JSON-escaped. |
| `cls` | `GetClassNameW` (e.g. `Notepad`, `Chrome_WidgetWin_1`, `UnityWndClass`) |
| `pid` | `GetWindowThreadProcessId` |
| `mapped` | visible, not minimized (`IsIconic`), not cloaked. Minimized windows are `mapped:false`; a seq skips them and **never restores** them. |
| content rect | the client area in screen coordinates. Both corners go through `ClientToScreen`, so DPI-virtualized (DPI-unaware) windows also come out in physical pixels. Title bar and borders are excluded natively, so the X11 "Wine child window" heuristic is not needed. |
| `active` | `GetForegroundWindow` → `GA_ROOT` → client window (itself, or its root owner if that is a client window); 0 otherwise |
| change notification | `SetWinEventHook` (out of context, skipping our own process) for foreground, minimize start/end, object create/destroy/show/hide, name change and cloak/uncloak, filtered to top-level windows. Debounced 100 ms like X11. A debounced `windows` message that is byte-identical to the previous one is not sent again. `list` always answers. Moves and resizes are not notified (the same as X11); content rects are resolved fresh whenever they are needed. |
| client window under the pointer | `WindowFromPoint` → `GA_ROOT`. If that is not a client window but its **root owner** is, the owner counts: a game's dropdown or popup belongs to the game window. A click inside a target's own popup during replay therefore does not make the helper re-activate the target and close the popup. |
| capture | `WH_MOUSE_LL`. Events with `LLMHF_INJECTED` / `LLMHF_LOWER_IL_INJECTED` are never reported. That covers ours (also tagged with `dwExtraInfo = 'CLKR'`) and any other software's injected input, which matches X11 ignoring every XTEST device. Buttons use X numbering: 1 left, 2 middle, 3 right, 8/9 X1/X2. The wheel becomes 4 up / 5 down / 6 left / 7 right, each a press immediately followed by a release, one per full `WHEEL_DELTA`. High-resolution wheels are accumulated, not multiplied. Motion events are coalesced, and the position is read with `GetCursorPos` when the event is emitted (throttled to one per 8 ms). |
| Escape | `WH_KEYBOARD_LL`, `VK_ESCAPE`, not injected, auto-repeat filtered. It sets the abort flag straight from the hook. **Never swallowed.** No other key is looked at. |
| pick | The click is swallowed in the LL hook (`return 1`). Crosshair feedback comes from an **invisible overlay**: a layered (alpha 1/255), topmost, no-activate, tool window covering the whole virtual screen, with an `IDC_CROSS` class cursor. It is shown exactly while a pick is active. It never takes focus and dies with the process, so the system cursor is never left changed. To resolve the click, the hook thread makes the overlay click-through (`WS_EX_TRANSPARENT`, set on the thread that owns the window, so there is no cross-thread send) and then main calls `WindowFromPoint`. If that still hits the overlay, a Z-order walk is the fallback. Every button press and release, and the wheel, is swallowed while a pick is active. Right-click cancels, and re-arm and the 3 s release timeout work as on X11. |
| inject | `SendInput`: `MOUSEEVENTF_MOVE \| ABSOLUTE \| VIRTUALDESK`, aimed at the pixel centre (`((x-left)*65536+32768)/width`, which is correct under both rounding rules Windows has used). Each move waits up to 50 ms until `GetCursorPos` reports the reachable target (nearest monitor, `ClipCursor`). If it never gets there, `SetCursorPos` corrects it exactly. Moves stay real input events, so games that read raw input also see them. Buttons 1/2/3/8/9 are press/release. `d 4`..`d 7` inject one wheel notch and the matching `u` is a no-op. Buttons 10–255 parse but are ignored (diagnostic on stderr). |
| activation (`f`, and `m` when the target is covered) | If the target is already the foreground client window, nothing is done. Otherwise, to get past the foreground lock: (1) inject an empty mouse input (the PowerToys trick), then `SetForegroundWindow`. (2) If that is not effective within 100 ms, briefly `AttachThreadInput` to the current foreground window's thread and call `SetForegroundWindow` + `BringWindowToTop`, then detach. The helper then waits until the foreground client window is the target, with a 200 ms total budget. Failure puts the helper in skip mode for that window, exactly as on X11. It never restores a minimized window. |
| mouse lock during a seq | The LL hook swallows every non-injected mouse event (moves, buttons, wheel) while a seq runs. `BlockInput` is not used (it needs elevation). Rules: a release always goes where its press went, so no app ever gets a stray release or a stuck button. The lock is only honoured while the main thread refreshes a heartbeat (at least every 100 ms during a seq), so a wedged helper releases the mouse after 1 s at most. The keyboard is never locked. |
| suppression | No btn/motion is reported during a seq, for 30 ms after it, or while a pick is active. The decision is made in the hook at event time. A press that was suppressed is never reported, and neither is its release, as specified. |
| timer resolution | `timeBeginPeriod(1)` only while a seq runs (`s` sleep accuracy), restored afterwards |

Wire behaviour is otherwise identical to X11: message formats, `error` texts (`unknown command:
…`, `bad seq op #N`, `bad seq id`, `pick already active`), parse limits, skip mode, release-all,
queued commands, and `abort` queued behind a `seq`.

## Background mode (experimental)

`bg 1` makes the following seqs deliver clicks **without touching the user's pointer or the
foreground window**; `bg 0` (the default) returns to the injection described above, which is
unchanged. Anything other than `bg 0` / `bg 1` is an `error`.

How it works, all in user space (no hooking or injection into other processes, no
`AttachThreadInput`):

* `m` aims a *virtual pointer* at a point of the target's client area. Nothing is warped,
  grabbed or activated, and the mouse is **not locked** (the hook only swallows input for
  foreground seqs). Minimized, missing and other-desktop windows are skipped as before.
* The receiver is the deepest child window at that point, found by a walk down from the
  target's top-level window: children front to back, skipping hidden, disabled and
  `WS_EX_TRANSPARENT` ones, honouring window regions, and asking each candidate
  `WM_NCHITTEST` (`SendMessageTimeout`, 50 ms, `SMTO_ABORTIFHUNG`) so `HTTRANSPARENT` falls
  through to the parent. `WindowFromPoint` is not usable (it returns whatever *covers* the
  target), and the `ChildWindowFromPoint*` family returns disabled windows or static labels.
  Covered windows are therefore reachable.
* Only a **client-area** hit (`HTCLIENT`) is delivered. A title bar, border, scrollbar owned by
  the window itself, or a point outside the window is skip mode: `WM_NC*` button messages are
  never posted (a title-bar press would start a modal move loop that follows the real cursor).
* `d`/`u` `PostMessageW` `WM_MOUSEMOVE` then `WM_xBUTTONDOWN` (with the `MK_*` flags), later
  `WM_xBUTTONUP`. The window that got the press also gets every later move (with the held
  flags, throttled to one per 8 ms) and the release, coordinates re-relativized to it. That is
  a stand-in for mouse capture and also works when the pointer leaves the window. Wheel
  buttons 4-7 post `WM_MOUSEWHEEL` / `WM_MOUSEHWHEEL` with **screen** coordinates. `WM_SETCURSOR`
  is never sent.
* The system does not synthesize double clicks from posted messages, so a second press of the
  same button on the same receiver within `GetDoubleClickTime()` and the double-click rectangle
  is posted as `WM_xBUTTONDBLCLK` when the window class has `CS_DBLCLKS`. The memory of the last
  press survives across seqs.
* `PostMessage` failing (typically `ERROR_ACCESS_DENIED` for an elevated target) is skip mode.
* Release-at-end, `abort`, Escape and stdin EOF post the pending button-up to the gesture's
  receiver.
* Client coordinates of targets that are not per-monitor DPI aware are scaled by
  `GetDpiForWindow / monitor DPI` so they look like virtualized real input (best effort,
  untested on real hardware; wheel screen coordinates are not scaled).
* Posted messages never pass through the low-level mouse hook, so the helper cannot see its
  own background clicks (verified in the Wine test with the real capture code). Capture is
  otherwise unchanged: no `btn`/`motion` during a seq or for 30 ms after.

Limits. This is message posting, not input, so an app has to cooperate:

* Apps that read **raw input / DirectInput** or poll `GetCursorPos` / `GetAsyncKeyState` /
  `GetKeyState` for the buttons see nothing (many games, some drawing and CAD tools).
* **WPF, UWP / WinUI** and some Chromium/Electron versions take pointer input from a different
  path (or only react to real input) and may ignore posted clicks. Whatever the control
  toolkit does with `WM_NCHITTEST` decides where the click lands.
* **Hover state drops**: the real cursor is elsewhere, so hover effects, tooltips, `WM_SETCURSOR`
  cursors and `TrackMouseEvent` leave notifications are not driven by the helper.
* Elevated targets are skipped (UIPI). Keyboard modifier keys are not added to `wParam`.
* A click can make the target activate itself; the helper never does, but the app may.

## Known limits

* **UIPI / elevated windows.** A non-elevated helper cannot inject input into windows of
  elevated processes (Run as administrator, Task Manager, some game launchers and anti-cheat
  clients). `SendInput` is silently blocked there. Its low-level hooks may also not see input
  while such a window is focused. This is deliberate and not worked around. To replicate into
  elevated windows the whole app would have to run elevated. When an elevated window covers
  the target point, `m` fails the "under pointer" check and the window is skipped.
* **Exclusive-fullscreen games** (real exclusive mode, not borderless): activating another
  window minimizes them or changes display mode, so replicating between several exclusive
  fullscreen games cannot work. Use borderless/windowed mode.
* **Raw-input / DirectInput games**: replicated moves are real input events, so raw input sees
  them. Whether swallowing in the LL hook also hides physical movement from raw-input readers
  during the (short) mouse lock is untested.
* **Games that call `ClipCursor`** confine our injected moves the same way. Warps outside the
  clip end at its edge.
* **Always-on-top windows** (including the clickered bar) that cover a target point make `m`
  skip that target, as on X11.
* **Secure desktop** (UAC prompt, Ctrl+Alt+Del, lock screen): no hooks and no injection there.
* **`cls` is the Win32 class name**, which is often shared between unrelated apps (all
  Electron/Chromium apps use `Chrome_WidgetWin_1`). It is fine for display, but it is a poor
  grouping key on Windows.
* Windows on other virtual desktops are listed with `mapped:false`. A seq that targets them is
  skipped. They are not switched to.
* **`child.kill()`** cannot release buttons held mid-seq (see above). Close stdin instead.

## Tested here (Linux host, Docker + Wine)

`native/win/test/wine-docker.sh` cross-compiles with Debian bookworm's mingw-w64 (GCC 12) and
runs three scripts under Wine 8 + Xvfb:

* `test/smoke.py` checks the protocol loop: `ready` v3, `windows` at startup and on `list`
  (including a real Notepad window with title, class, pid, rect and mapped), `keys` and
  `kd`/`ku` rejected, malformed seqs giving `error` + `done ok:false`, `w`/`s` timing, skip for
  a missing window, `abort` during a sleep and right behind a seq, pick/pickcancel, stdin EOF
  during a seq giving `done ok:false` and exit 0. It also runs `f`, `m` + click, and drag on
  Notepad (all `ok:true`).
* `test/capture.py` drives X input with xdotool, which Wine feeds through the LL hooks. It
  checks btn press/release with the gesture window and fractions, motion while held, wheel → 4,
  right → 3, own injected clicks not reported, pick by left click (swallowed, correct window),
  right-click pick cancel, Escape aborting a seq, idle Escape, and that no other key is ever
  reported.
* `test/bg.py` (with `test/bgtarget.c`, a logging window with an edit, a button, nested custom
  panels, a hidden, a disabled and a click-through child, plus an occluding window and a
  minimized one) checks background mode: `bg` parsing, click/drag/right-click/wheel/hwheel
  arriving at the right child with the right coordinates while the real pointer and the
  foreground window stay put, an occluded target, a non-client / outside / missing /
  minimized target giving `done ok:false`, double-click synthesis (within a seq, across seqs,
  too slow, too far, third press), the mouse not being locked, no `btn`/`motion` reported,
  `abort` and stdin EOF mid-drag posting the up, release-at-end, and foreground mode still
  working after `bg 0`.

Wine is not Windows, and **a passing run proves nothing about real Windows behaviour**,
background mode least of all: it only shows the helper sends the intended messages to the
intended windows. Foreground lock, UIPI, DPI virtualization, DWM cloaking, virtual desktops
and the real input stack are not exercised there. One Wine-only quirk: the first keyboard event
right after the pick overlay hides is delivered late, apparently because of Wine's X focus
handling. The capture test therefore sends one key before the post-pick Escape check. Check
this on real Windows (checklist item 7).

## Manual test checklist (real Windows 10/11)

Run the app with two or more instances of some windowed program (e.g. two Notepads, or a
windowed game) and, ideally, two monitors with different scaling (100 % and 150 %).

1. **Startup**: the helper starts with no console window flashing. The bar shows up, the window
   list contains the open apps and the bar, and does not contain tool windows, tray stuff,
   invisible or cloaked UWP frames.
2. **Window list updates**: opening, closing, minimizing, restoring and retitling windows, and
   switching focus, updates the list within about 0.1 s. A minimized window shows as unmapped.
   On another virtual desktop a window stays listed but unmapped.
3. **Pick**: Grab shows a crosshair everywhere (both monitors, over the bar and the taskbar).
   Clicking a window adds it, and the click does **not** reach the window. Several picks work
   in a row. Right-click or Done ends it, and the cursor returns to normal. Clicking the bar
   ends picking. Clicking the desktop cancels. A dropdown or popup of an app counts as that
   app.
4. **Click replication**: clicks in the source are replayed at the same relative spot in every
   target. Test windows of different sizes, a target partly covered by another window (it gets
   raised), and a target on the second monitor with different DPI. Also test a DPI-unaware
   app, e.g. an old Win32 tool with "System (Enhanced)" off.
5. **Drag / wheel**: drags replay with timing, and the wheel scrolls targets by the same number
   of notches. Try a high-resolution / free-spinning wheel and horizontal tilt. Also try
   X1/X2 buttons and the middle button.
6. **Mouse lock**: move the mouse wildly during a long drag replay. The pointer must not move
   until the replay ends, and must be free immediately after. Kill the helper from Task
   Manager mid-replay: the mouse must be free at once.
7. **Escape**: Escape during a replay stops it at once (and pauses the app). Escape at other
   times reaches the focused app normally. Also check Escape right after finishing a pick.
8. **Activation**: replication into a target that is behind the source works on the first
   try, without the taskbar just flashing instead of switching. Also try while the source is a
   fullscreen-borderless game.
9. **Minimized / closed targets**: they are skipped. The rest of the group still gets the
   click. A minimized target is not restored.
10. **Elevated target**: start one Notepad "as administrator". It is skipped or not clicked;
    nothing hangs, and the other targets still work.
11. **Own input**: replays never get re-recorded as new gestures (no feedback loop).
12. **Shutdown**: quitting the app ends the helper (stdin EOF), and nothing stays pressed.

Background mode (`bg 1`; run each with the real mouse parked elsewhere, and keep using it):

13. **Pointer and focus**: a background replay does not move the cursor, change the foreground
    window or flash the taskbar. The mouse is free during a long replay.
14. **Covered target**: a target fully behind other windows still gets the click, in the
    child control at that spot (try a button, a text box, a list and a web view).
15. **Drag**: dragging inside a target (selection, a slider, a scrollbar thumb, moving an item)
    works, also when the drag leaves the target's window. Releasing early with `abort` or Escape
    leaves nothing stuck.
16. **Wheel / double click**: the wheel scrolls the control under the virtual pointer.
    Double-clicking selects a word in a text box, or opens a list item.
17. **Skipped**: a point on the title bar or border, a minimized window, a closed window and
    an elevated (administrator) target are skipped, `done` is `ok:false` when nothing was left,
    and the other targets still work.
18. **Own input**: background clicks are never captured as new gestures.
19. **Per-app survey**: record which apps honour posted clicks. Check DPI-unaware apps on a
    150 % monitor for coordinate offsets, and expect Chromium/Electron, WPF, UWP/WinUI and
    games to be the unreliable ones (see the limits above).

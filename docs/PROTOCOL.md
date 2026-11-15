# Helper protocol (version 2)

The native helper is spawned by the Electron main process. There is one per OS, and
all three speak this protocol (see [Platforms](#platforms) for where they differ). This
document describes the reference X11 helper, `resources/clickered-helper` built from
`native/helper.c`: a single-threaded C program (Xlib + XInput2 + XTest). The
TypeScript mirror of this document is `src/shared/protocol.ts` — the two must agree.

- **stdout**: one JSON object per line, flushed after every line.
- **stdin**: one text command per line. EOF on stdin ⇒ release anything held, exit 0.
- **stderr**: free-form diagnostics.

## Windows and content rects

"Client windows" are the entries of `_NET_CLIENT_LIST` on the root window.

The **content rect** of a client window is what fractions are relative to. It is
the window's own rect in root coordinates (via `XTranslateCoordinates`), except:
if the window has exactly one mapped InputOutput child that is smaller than the
window but covers at least 80% of its area (Wine draws its own title bar this
way: e.g. a 640x1408 window with one 632x1374+4+30 child), the content rect is
that child's rect. Content rects are resolved fresh every time they are needed
(windows move and resize).

The **client window under the pointer**: `XQueryPointer(root)` gives the
top-level child of root under the pointer; the client window is the
`_NET_CLIENT_LIST` entry that is that window or a descendant of it (walk
`XQueryTree` parents up from each client). 0 when there is none.

## helper → host

| Message | Meaning |
|---|---|
| `{"t":"ready","version":2}` | Sent once at startup, followed by a `windows` message. |
| `{"t":"windows","active":ID,"list":[{"id","title","cls","pid","x","y","w","h","mapped"}]}` | Full client list. Sent at startup, on `list`, and (debounced ~100 ms) whenever `_NET_CLIENT_LIST` or `_NET_ACTIVE_WINDOW` changes. `x,y,w,h` = content rect. `cls` = WM_CLASS class part. `title` = `_NET_WM_NAME`, falling back to `WM_NAME`. Strings JSON-escaped, valid UTF-8. |
| `{"t":"btn","down":BOOL,"button":N,"win":ID,"fx":F,"fy":F,"x":N,"y":N,"time":MS}` | Physical button transition. See gesture window below. |
| `{"t":"motion","win":ID,"fx":F,"fy":F,"x":N,"y":N,"time":MS}` | Only while ≥1 physical button is held; at most one per 8 ms. |
| `{"t":"esc","time":MS}` | Panic key: a physical Escape press (auto-repeat ignored). Always sent, also during a `seq`. If a `seq` is running it is aborted exactly as by `abort`. No other key is ever reported. |
| `{"t":"picked","win":ID}` | Result of `pick`. 0 = cancelled. |
| `{"t":"done","id":N,"ok":BOOL}` | A `seq` finished (`ok:false` if aborted or every target was skipped). |
| `{"t":"error","msg":"..."}` | Non-fatal problem (bad command, X error). Optional `"perm"`: only on an `error` sent before `ready` while the helper waits for an OS permission, naming it: `"accessibility"` or `"input-monitoring"` (macOS only; see Platforms, Startup). Hosts ignore unknown values. |

**Input source filtering.** Raw events are selected for `XIAllMasterDevices` on
the root window (`XI_RawButtonPress/Release`, `XI_RawMotion`,
`XI_RawKeyPress`, only to detect Escape). An event whose `sourceid` is an XTEST
slave device ("Virtual core XTEST pointer"/"keyboard") is never reported.
Additionally no `btn`/`motion` is reported while a `seq` is executing nor for
30 ms after.

**Gesture window.** When a button goes down and no other physical button is
held, the helper resolves the client window under the pointer and remembers it
as the gesture window. Every `btn` and `motion` until all buttons are released
carries that `win`, with `fx,fy` relative to *its* content rect (these may fall
outside 0..1 when the pointer leaves the window). `win` is 0 when the press was
not over a client window (then `fx,fy` are 0). Wheel buttons 4–7 arrive as a
press immediately followed by a release.

`time` is `CLOCK_MONOTONIC` in milliseconds.

## host → helper

| Command | Meaning |
|---|---|
| `list` | Emit a `windows` message now. |
| `pick` | Grab the pointer with a crosshair cursor. Next left click: reply `picked` with the client window under the pointer; the click is swallowed. Right click or `pickcancel`: reply `picked` with 0. A `pick` sent right after a `picked` (before that click's button is released) keeps the grab and waits for the next click, so several windows can be picked in a row. |
| `pickcancel` | Cancel an active pick. No-op otherwise. |
| `seq ID OP;OP;...` | Execute ops in order, then reply `done`. |
| `abort` | Abort the running `seq` (if any) as soon as possible. |

### seq ops

| Op | Meaning |
|---|---|
| `f WIN` | Activate WIN (`_NET_ACTIVE_WINDOW` client message, source indication 2, plus `XRaiseWindow`) and wait until `_NET_ACTIVE_WINDOW` equals WIN, at most 200 ms. If WIN is still not active after that, enter skip mode for WIN. |
| `m WIN FX FY` | Warp (XTest fake motion) to that fraction of WIN's content rect. If the client window under the pointer is then not WIN and no button is currently held by this seq, activate + raise WIN as in `f`, then warp again and wait (at most 100 ms) until WIN is under the pointer. If activation or that wait fails, enter skip mode for WIN. |
| `d BTN` / `u BTN` | XTest button press / release. |
| `s MS` | Sleep. |
| `w X Y` | Warp to absolute root coordinates. |

`FX`/`FY` must be finite with an absolute value of at most 100. `X`/`Y` must be within ±32767. Out-of-range values reject the whole `seq` (`error`, then `done` with `ok:false`).

Rules:

- **Skip mode**: if `f` or `m` names a window that no longer exists (or is
  unmapped, or cannot be focused / brought under the pointer as described above), the helper first releases anything this seq holds, then ignores
  `d`/`u`/`s` until the next `f`, `m` or `w` op. A `m` for the *same*
  missing window stays skipped.
- At the end of a seq (normal, aborted, or stdin EOF) every button the seq
  pressed and has not released is released.
- Sleeps must not block the process: keep reading stdin (for `abort`) and
  draining X events while sleeping. Commands other than `abort` that arrive
  during a seq are queued and run afterwards.
- **Mouse lock**: for the duration of a seq every physical pointer device is grabbed
  with `XIGrabDevice` (which detaches it from the master pointer), so moving the
  mouse cannot disturb the replay. Released at the end of the seq, on abort, and
  automatically by the X server if the helper dies. Keyboards are not locked
  (Escape must keep working).
- `XFlush`/`XSync` after every injected event.
- A custom X error handler must swallow `BadWindow`/`BadMatch`/`BadDrawable`
  (windows vanish at any time); the helper must never die from them.

## Platforms

| OS | Source | Binary (`resources/`, and the app's resources dir when packaged) | Details |
|---|---|---|---|
| Linux (X11) | `native/helper.c`, `native/Makefile` | `clickered-helper` | this document |
| macOS 11+ | `native/mac/helper.m` | `clickered-helper` (universal arm64 + x86_64) | [native/mac/README.md](../native/mac/README.md) |
| Windows 10/11 | `native/win/helper.c` | `clickered-helper.exe` | [native/win/README.md](../native/win/README.md) |

`npm run build:helper` (`scripts/build-helper.mjs`) builds the one for the host OS. The
wire format, commands, messages, `error` texts, skip mode and stdin-EOF behaviour are
the same everywhere. What differs:

- **Units and ids.** Window ids are 32-bit on all three (X11 window, `CGWindowID`,
  HWND). Coordinates and content rects are pixels in root coordinates on X11, **points**
  in global display coordinates on macOS, and **physical pixels** in virtual-screen
  coordinates on Windows (per-monitor DPI aware). Coordinates can be negative on macOS
  and Windows (monitors left of or above the main one). The host's click offset is in
  these units.
- **Content rect.** X11: the window, or its Wine child (above). macOS: the **whole
  frame including the title bar** (there is no general way to find another app's
  content area). Windows: the client area (title bar and borders excluded).
- **`cls`.** X11: the `WM_CLASS` class. macOS: the owner's bundle id (then its name).
  Windows: the Win32 class name, often shared by unrelated apps (`Chrome_WidgetWin_1`
  for every Chromium/Electron app). The host only shows it; its own bar is recognised
  by `pid`.
- **`mapped:false`.** Minimized windows and windows on another workspace (X11), Space
  (macOS) or virtual desktop (Windows). macOS also keeps windows that an app only
  ordered out in the list as unmapped until they are destroyed; X11 drops withdrawn
  windows.
- **Activation.** macOS: `m` also activates a target that is under the pointer but not
  active (macOS drops the first click into an inactive window), costing up to 200 ms
  per target per gesture. Windows: only when covered, as on X11, using the
  foreground-lock workarounds. Neither ever restores a minimized window or switches
  Spaces/desktops.
- **Startup.** The macOS helper needs the Accessibility (and maybe Input Monitoring)
  permission. Without it, it sends `error` lines with instructions **before** `ready`
  and waits, re-checking about once a second, for as long as it takes. Those `error`s
  carry `"perm":"accessibility"` / `"perm":"input-monitoring"`. The host therefore has
  no startup timeout; it shows such an `error` in the bar until `ready`, and a `perm`
  makes it offer to open that System Settings page.
- **Not reachable.** Windows: windows of elevated processes (UIPI), exclusive-fullscreen
  games, the secure desktop. macOS: Secure Input fields and apps that read raw HID.
  Some games ignore injected input on every OS.
- **Shutdown.** Close stdin and wait; kill only as a last resort. On Windows `kill()`
  is `TerminateProcess`, which cannot release buttons a `seq` is holding. The host
  closes stdin and kills after 1 s.
- **While a `seq` runs**, the macOS helper does not poll or emit `windows`; a pending
  change is sent right after the `seq`.

## Changes

- **Version 2, addition**: the optional `perm` field of `error` (macOS startup
  permissions). Older hosts ignore it, so the version number did not change.

- **Version 2**: keyboard replication was removed — the `keys` command, the `key`
  message and the `kd`/`ku` seq ops no longer exist (they are rejected as unknown).
  The `esc` panic key is unchanged.

## Implementation notes (clarifications, no wire changes)

- `mapped` (and "unmapped" in skip mode) means `map_state == IsViewable`; a
  minimized window or one on another workspace is `mapped:false` and is skipped.
- While a `pick` is active (until the swallowed click's button is released) no
  `btn`/`motion` is reported.
- A press that was suppressed (during/just after a `seq`, or during `pick`) is
  never reported, nor is its release. A release that happens while suppressed
  is dropped even if its press was reported — the host must tolerate a press
  without a release (e.g. reset gesture state when a replay starts).
- A malformed `seq` executes nothing and replies `error` then `done ok:false`.
- An `abort` already queued behind a `seq` (before the next `seq` line) aborts it.
- On stdin EOF (or SIGTERM/SIGINT/SIGHUP) a running `seq` stops, everything it
  holds is released, `done ok:false` is sent, queued commands are dropped, exit 0.

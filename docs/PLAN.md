# Clickered — plan

Replicate mouse clicks and drags from one window to a group of windows. First
target: Linux / X11 (Pop!_OS, Mutter), where the game windows are Wine/Proton
windows that all share one `WM_CLASS`. macOS 11+ and Windows 10/11 run the same app
and bar with their own native helper (see "Platforms" below).

## How it works

There is a single pointer (on every OS), so replication is *record, then replay*.
On X11:

1. **Capture** — a tiny native helper listens to XInput2 *raw* events on the root
   window (passive: nothing is grabbed, the click reaches the game normally).
   Events coming from the XTEST device (our own injected input) are ignored.
2. **Record** — press → motion → release inside a group window is one gesture,
   stored as fractions of that window's content rect (so different window sizes
   map to the same UI element).
3. **Replay** — on release, for every other included window: warp the pointer to
   the same fraction, make sure the window is on top there, and inject the
   press / path / release with XTEST. Then warp back to where the mouse was and
   re-activate the source window.

Clicks replay in ~80 ms per window. Drags replay with their original timing so
scroll inertia matches. Wheel ticks are collected until the
wheel has been still for 250 ms (`timing.wheelIdle`), then replayed in one go, so
the replay never takes the pointer away while you are still scrolling.

**Click offset** (off by default; 1, 5, 10, 15 or 20 px): instead of hitting the
exact same relative spot everywhere, each target window's replay of a gesture is
shifted by one random point inside a disc of that radius, drawn fresh per target
per gesture. The whole gesture moves (a drag keeps its shape); the source window
is never touched. The host converts pixels to fractions with the target's
current content rect, so the helper protocol is unchanged.

**Click delay** (off by default; up to 50, 100, 200, 300 or 500 ms): before each
target window (the first one too) the replay pauses for a random whole number of
milliseconds between 0 and that maximum, drawn fresh per target per gesture. It is a
plain `s` op placed right after the warp onto the target and before its press, so
no button is ever held during it and a skipped previous window cannot swallow it
(skip mode ignores sleeps only until the next `m`). The `seq` timeout grows with it;
Escape still aborts mid-pause. Random draws per target, in target order: the offset
(radius, angle) first, then the delay.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Native helper (C: Xlib, XInput2, XTest) | `native/` → `resources/clickered-helper` | Dumb I/O. Line protocol on stdin/stdout — `docs/PROTOCOL.md` |
| macOS helper (Objective-C: CGEventTap, CGEvent, Accessibility) | `native/mac/` → `resources/clickered-helper` | Same protocol; universal binary |
| Windows helper (C: low-level hooks, SendInput) | `native/win/` → `resources/clickered-helper.exe` | Same protocol |
| Engine (TypeScript + Effect) | `src/main/` | Group tracking, gesture recording, replay script building, queue, config |
| Bar UI (Tailwind, no framework) | `src/renderer/` | Frameless transparent always-on-top bar, light/dark from system |
| Contracts | `src/shared/` | `protocol.ts` (helper) and `ipc.ts` (renderer) — fixed, shared by all pieces |

## Setup flow (must be fast)

- **Grab**: press the grab button, then click each window you want in the group
  (any app, any mix of apps). Clicking a window again removes it. Finish with
  **Done** on the bar or a right-click. The picking clicks are swallowed.
- The **first window picked is the source** (master): only clicks in it are
  replicated. The crown in the expandable list moves the source to another
  window; clicking the crown of the current source switches to *auto*, where
  whichever group window you click in is the source.
- Windows that close drop out of the group. Nothing is remembered between runs:
  window ids do not survive a restart of the app they belong to.
- **Toggle**: on/off control on the bar plus a global hotkey (default
  ``Control+` ``) for fixing up a single window without replication.
- **Escape** during a replay stops it immediately, drops anything queued and
  switches to Paused. Escape at any other time is left alone.
- Only the mouse is replicated. The keyboard is never captured, except that the
  helper watches for Escape (the panic key above).

## Known limits

- While a replay runs (a fraction of a second for clicks) the real mouse should
  be left alone; physical input during replay is ignored for recording.
- A target window covered by another window is raised before it is clicked.
- No Wayland. It would need a completely different injection path.

## Platforms

The engine and the bar are the same on every OS; only the helper differs (built by
`npm run build:helper` for the host). The protocol differences are listed in
`docs/PROTOCOL.md` ("Platforms"); details in `native/mac/README.md` and
`native/win/README.md`. In short:

- **macOS** (11+): capture with an active `CGEventTap`, replay with `CGEventPost`,
  windows from CoreGraphics plus Accessibility. Needs the Accessibility permission;
  until it is granted the bar shows the helper's instructions. The app has no Dock
  icon or menu bar (`LSUIElement`), like the bar skipping the taskbar elsewhere.
  Units are points, rects include the title bar, and inactive targets are activated
  before every click.
- **Windows** (10/11): capture with `WH_MOUSE_LL`/`WH_KEYBOARD_LL`, replay with
  `SendInput`. Cannot reach elevated windows (UIPI). Units are physical pixels.
- The bar is a frameless, transparent, always-on-top window on all three, on every
  workspace / Space (incl. fullscreen Spaces) where the OS allows; Windows has no API
  for virtual desktops. Settings live in a `clickered` folder in the OS's app-data
  directory.
- Font: the bar uses the system UI font (`system-ui`: Cantarell/Ubuntu/DejaVu on
  Linux, SF Pro on macOS, Segoe UI on Windows), so text metrics differ slightly; the
  window sizes itself to its content, so the layout is the same.

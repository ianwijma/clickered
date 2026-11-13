# clickered — plan

Replicate mouse clicks, drags (and optionally keys) from one window to a group of
windows. Target: Linux / X11 (Pop!_OS, Mutter). The game windows are Wine/Proton
windows that all share one `WM_CLASS`.

## How it works

X11 has a single pointer, so replication is *record, then replay*:

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

Clicks replay in ~80 ms per window. Drags replay with their original timing
(configurable speed) so scroll inertia matches. Wheel ticks are coalesced.

## Pieces

| Piece | Where | Notes |
|---|---|---|
| Native helper (C: Xlib, XInput2, XTest) | `native/` → `resources/clickered-helper` | Dumb I/O. Line protocol on stdin/stdout — `docs/PROTOCOL.md` |
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
- Keyboard replication is opt-in (off by default) and experimental.

## Known limits

- While a replay runs (a fraction of a second for clicks) the real mouse should
  be left alone; physical input during replay is ignored for recording.
- A target window covered by another window is raised before it is clicked.
- X11 only. Wayland would need a completely different injection path.

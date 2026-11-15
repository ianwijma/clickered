# clickered-helper for macOS

A macOS port of `native/helper.c`. It speaks the same line protocol
(`docs/PROTOCOL.md`, **protocol version 2**: no keyboard replication), so the
Electron host drives it unchanged.

> **Status: unverified on a real Mac.** It was written on Linux. It compiles
> warning-free (`-Wall -Wextra`) for arm64 and x86_64 against the macOS 14.5 SDK
> headers with deployment target 11.0, and it links against the SDK's `.tbd` stubs.
> It has never been run. Use the checklist at the end before relying on it.

## Build

```sh
xcode-select --install        # once, if no Xcode / command line tools
cd native/mac && make         # -> resources/clickered-helper (universal, macOS 11+)
make check                    # lipo -info + minimum OS of the result
```

- `clang -std=c11 -fobjc-arc -fblocks -Wall -Wextra -O2 -arch arm64 -arch x86_64
  -mmacosx-version-min=11.0`, frameworks AppKit, ApplicationServices,
  CoreGraphics and CoreFoundation. Only system frameworks are used.
- Objective-C objects use **ARC**. CoreFoundation objects are released by hand.
- `make ARCHS="-arch arm64"` builds for one architecture only.
- The binary is not signed here. Signing happens when the Electron app is
  packaged (see "Integration notes").

## Architecture

There are two threads:

- **Main thread.** Handles stdin, command execution (`seq`, `pick`, `list`),
  window enumeration (CoreGraphics and Accessibility), event injection, the pick
  overlay, and every stdout write. It runs on the main `CFRunLoop`: stdin comes in
  through a `CFFileDescriptor`, signals through dispatch sources, and the window
  poll through a 50 ms timer. Sleeps inside a `seq` run nested run-loop slices
  (5–10 ms), so `abort`, Escape, timers and output keep working during a replay.
- **Tap thread.** Owns the `CGEventTap` and its own `CFRunLoop`. An active event
  tap holds up the whole system's input while its callback runs. So this thread
  never makes Accessibility calls and never writes to a pipe. It decides whether
  to pass or drop each event, keeps the gesture state, and queues JSON lines that
  the main thread writes. If the host stops reading stdout, the mouse keeps
  working; the queue is capped at 8 MB and further lines are dropped.

## Platform mapping

| Protocol concept | macOS implementation |
|---|---|
| Window id | `CGWindowID` (`kCGWindowNumber`). |
| Client windows | Windows from `CGWindowListCopyWindowInfo(kCGWindowListOptionAll \| kCGWindowListExcludeDesktopElements)` that are on layer 0, visible (alpha > 0.01), at least 8×8 points, and owned by a *regular* app (`NSRunningApplication.activationPolicy == Regular`, i.e. one with a Dock icon). The window must also be on screen now, or have been seen on screen before, or (if first seen off screen, e.g. minimized when the helper starts) be listed in the app's Accessibility windows. This filters out the many off-screen buffer windows that apps create. The helper's own windows never count. |
| `pid` | `kCGWindowOwnerPID`. |
| `cls` | The owner's bundle identifier, then its localized name, then `kCGWindowOwnerName`. |
| `title` | `kAXTitleAttribute` of the matching Accessibility window. If that is missing, `kCGWindowName`, which is only filled in with Screen Recording permission on 10.15+. If that is missing too, the owner app name. |
| Content rect `x,y,w,h` | `kCGWindowBounds`, in points, in global display coordinates: origin at the top-left of the main display, y grows downward, and it can be negative on other monitors. These are the same coordinates CGEvent locations use. **The rect includes the title bar**, because there is no general way to find the content area of another app's window. Fractions are therefore relative to the whole frame. That is consistent across windows of the same app, which is what replication needs. |
| `mapped` | `kCGWindowIsOnscreen`. It is false for minimized windows, windows of hidden apps (⌘H), and windows on another Space. |
| `active` | Accessibility: system-wide `kAXFocusedApplicationAttribute`, then that app's `kAXFocusedWindowAttribute`. If that fails, the frontmost layer-0 window of `NSWorkspace.frontmostApplication`. |
| Window under pointer | The topmost on-screen window containing the point, in front-to-back order from `CGWindowListCopyWindowInfo(OnScreenOnly)`. The helper's own windows, fully transparent windows, and Window Server windows are skipped. If that topmost window is a client window it is the answer; otherwise the answer is 0 (for example the menu bar, the Dock, or a floating window such as the clickered bar). |
| AX element ↔ window id | `_AXUIElementGetWindow`, a private function that every window manager uses (Rectangle, AltTab, yabai, Hammerspoon). It is looked up with `dlsym`. If it is missing, the helper matches by frame (`kAXPosition`/`kAXSize` against the CG bounds, within 1 point), which is ambiguous only for windows of the same app stacked exactly on top of each other. |
| `windows` change notification | A cheap poll every 400 ms of the CG window list plus the active window. NSWorkspace activate, launch, terminate, hide, unhide and Space-change notifications trigger the poll sooner. The helper compares a signature of (window ids, mapped flags, active id) and emits a `windows` message 100 ms after it changes, and only if it changed. Titles and moves alone do not trigger a message; the X11 helper behaves the same way. Polling pauses while a `seq` runs. |
| Activation (`f`, and `m` when needed) | `kAXMainAttribute = true` and `AXRaise` on the window, then `kAXFrontmostAttribute = true` on the app, then `-[NSRunningApplication activateWithOptions:]`. After that the helper waits up to 200 ms until the window is the focused window of the frontmost app. |
| Capture | A `CGEventTap` at `kCGSessionEventTap`, `kCGHeadInsertEventTap`, `kCGEventTapOptionDefault` (an active tap), for mouse down/up/dragged/moved, scroll wheel and key down. If the system disables the tap (`kCGEventTapDisabledByTimeout` / `…ByUserInput`), it is turned straight back on. |
| Buttons | CG 0 → 1 (left), 2 → 2 (middle), 1 → 3 (right), and CG *n* ≥ 3 → *n* + 5 (back = 8, forward = 9). Injection maps them back the same way. |
| Wheel | Every non-momentum scroll event with a non-zero line delta is reported as one press+release: `kCGScrollWheelEventDeltaAxis1` > 0 → 4, < 0 → 5; `DeltaAxis2` > 0 → 6, < 0 → 7. Momentum ("inertia") events are not reported. Injecting button 4–7 posts one line-unit scroll event in the same direction, so a captured gesture replays with the same sign, whatever the "natural scrolling" setting is. |
| Escape | Key code 53 (`kVK_Escape`) down, not auto-repeat. The helper always emits `esc` and aborts a running seq. The key event always passes through. |
| Injection | `CGEventPost(kCGHIDEventTap, …)` using a `kCGEventSourceStateHIDSystemState` source. Moves are `kCGEventMouseMoved`, or `…Dragged` while the seq holds a button, with `kCGMouseEventDeltaX/Y` set. Down and up events carry `kCGMouseEventClickState`: the helper counts clicks itself using `NSEvent.doubleClickInterval` and a 4-point distance, so a replayed double-click is a double-click on macOS too. Injected events carry the current physical modifier flags, as XTest input does. The source's local-events suppression interval is 0, so the user's real mouse is not frozen after a replay. |
| Own-event tagging | Every posted event has `kCGEventSourceUserData = 0x636c6b72` ("clkr"). The tap also treats any event whose `kCGEventSourceUnixProcessID` is the helper's own pid as its own. Such events are never reported and never dropped. On top of that, reporting is suppressed during a `seq` and for 30 ms after it, as in the protocol. |
| Mouse lock during a seq | While a `seq` runs, the active tap drops every *physical* mouse event: presses (and the matching release later), drags, moves and scrolls. A physical release whose press had already gone through is let through, so no app is left with a stuck button. Every injected event carries an explicit location, so even if the visible cursor drifts, clicks land at the replayed position. The lock is just a flag checked by the tap. It ends when the seq ends, on abort, on Escape and on every exit path, and when the process dies the tap dies with it, so the mouse can never stay locked. `CGAssociateMouseAndMouseCursorPosition` is deliberately *not* used: Apple documents it as applying "while an application is in the foreground", the helper never is, and it could stop the injected moves from moving the cursor. |
| `pick` | The active tap swallows the click (the callback returns `NULL`), and also the release of that button and anything dragged meanwhile. The state machine is the same as on X11: left → `picked` with the window, right → `picked 0`, re-arm, `pickcancel`, and a 3 s release timeout. Wheel and other buttons are swallowed while picking. |
| Pick feedback | A background helper cannot reliably change the system cursor; cursor rects only apply to the active app. Instead the helper shows a click-through overlay (`ignoresMouseEvents`, borderless, `NSScreenSaverWindowLevel`, on all Spaces, allowed over fullscreen apps) that tints the window a click would pick and draws a small crosshair in its centre. It follows the pointer at about 30 Hz. The helper's own windows are ignored when resolving the window under the pointer. |
| stdin | Non-blocking `CFFileDescriptor` on the main run loop. On EOF, a running seq stops, everything it holds is released, `done ok:false` is sent, and the helper exits 0. |
| Signals | SIGTERM, SIGINT and SIGHUP go through dispatch sources and lead to the same clean exit. SIGPIPE is ignored. |

### Deviations from the X11 helper

- **`m` also activates a target that is under the pointer but not the active
  window**, when no button is held (`ACTIVATE_INACTIVE_TARGET` in `helper.m`). On
  macOS, for most apps the first click into a window that is not key, or into an
  app that is not active, only brings it to the front and is never delivered as a
  click. X11 has no such behaviour. So the rule "activate only if covered" would
  lose most replayed clicks. The cost is one activation, up to 200 ms, per target
  per gesture. Set the macro to 0 to get the exact X11 rule, for example if your
  target apps accept the first click (`acceptsFirstMouse`).
- While a `seq` runs, the helper does not poll or emit `windows`. A pending change
  is sent right after the seq instead.
- Off-screen windows stay in the list (`mapped:false`) until they are destroyed.
  The X11 helper drops withdrawn windows. A window that an app only orders out,
  without destroying it, stays in the list here.

## Permissions

The helper needs **Accessibility**. Depending on the macOS version, the event tap
may also need **Input Monitoring**. macOS attributes TCC permissions of a child
process to its *responsible* app, which is the Electron app that spawns the helper.
So the permission prompts and the System Settings entries show clickered, not
`clickered-helper`. Do not expect the helper to have a TCC entry of its own.

Startup sequence:

1. If `AXIsProcessTrusted()` is false, the helper calls
   `AXIsProcessTrustedWithOptions({kAXTrustedCheckOptionPrompt: true})` once. This
   shows the system prompt.
2. It then emits once:
   `{"t":"error","msg":"clickered needs the Accessibility permission … System Settings > Privacy & Security > Accessibility …"}`.
3. It checks again about once a second. Meanwhile it services stdin, so EOF exits
   0. Commands sent while waiting are queued and run once the helper is ready.
4. If creating the event tap fails, the helper calls `CGRequestListenEventAccess()`
   once, emits one `error` naming *Privacy & Security > Input Monitoring*, and
   retries every second.
5. Only then does it start the tap and send `ready` (version 2) and `windows`.

The helper never busy-loops and never exits because a permission is missing. The
host may see `error` lines long before `ready`, and should show them to the user.

## Known limits

- **Spaces.** Windows on another Space are `mapped:false`, so a `seq` skips them,
  just as the X11 helper skips windows on other workspaces. The helper never
  switches Spaces. A window first seen while on another Space (for example one
  that was already there when the helper started) may be missing from the list
  until it has been visible once, because Accessibility usually reports only
  current-Space windows.
- **Fullscreen apps** live on their own Space. A fullscreen window is mapped only
  while its Space is the active one.
- **The content rect includes the title bar** (see the mapping table). If the
  windows in a group have different title-bar heights, a fraction lands a few
  points differently in each.
- **Private API:** `_AXUIElementGetWindow` (looked up at runtime; there is a
  fallback). No SkyLight / CGS private calls are used.
- **Activation on macOS 14+:** cooperative activation can refuse
  `activateWithOptions:` from a background process. The helper relies mostly on
  the Accessibility calls (`AXRaise`, `kAXFrontmostAttribute`), which still work.
  If an app does not activate within 200 ms, the target is skipped (`done
  ok:false` if every target fails). If activation proves unreliable, the
  next step would be the private `_SLPSSetFrontProcessWithOptions` that AltTab
  uses.
- **Apps that ignore synthetic events:** some games and anti-cheat software,
  apps that read raw HID input, and anything behind Secure Input (password fields)
  ignore or never see injected events. Apps that track the mouse through relative
  deltas only get the deltas the helper sets on its moves.
- **Trackpad scrolling** is reported only for events with a whole-line delta, so
  slow two-finger scrolls may report fewer ticks than the content actually moved.
  Pixel-precise scrolling is not replicated.
- **Cursor feedback:** the system cursor does not change to a crosshair while
  picking; the overlay highlight is the feedback.
- **The mouse lock is soft:** the visible cursor may still follow the physical
  mouse during a replay. Events the apps see are not affected (see the mapping
  table).
- **Display coordinates:** everything is in points. On mixed-DPI setups that
  matches what CGEvent and the window list use, but differs from pixel counts.

## Manual test checklist (real Mac)

Build with `make`, then run the helper by hand from Terminal. Grant Accessibility
(and Input Monitoring if asked) to **Terminal** for this, because Terminal is the
responsible app. Type commands on stdin and watch stdout.

1. **Permissions:** with Accessibility off, the helper prompts, prints one `error`,
   keeps running and uses no CPU (check in Activity Monitor). Pressing ⌃D exits
   with code 0. Turn the permission on: within about 1 s you get `ready`
   (`"version":2`) followed by `windows`.
2. **Window list:** ids, titles (titles should be real even without Screen
   Recording), `cls` = bundle id, `pid`, and rects matching the windows,
   including on a secondary monitor left of or above the main one (negative
   coordinates). Minimize a window: about 0.5 s later a `windows` message shows
   it as `mapped:false`. Close it: it disappears. Switch apps: `active` changes. No
   messages arrive while nothing changes.
3. **btn/motion:** click and drag in a window. Check that `win` and `fx/fy` are
   right, `motion` arrives at most every 8 ms only while a button is held, and the
   button numbers are 1/2/3, 8/9 for side buttons, 4/5 and 6/7 for the wheel. A
   click on the menu bar or Dock gives `win:0`.
4. **Escape:** pressing Escape prints `esc` and still reaches the focused app
   (try it in a text field or dialog).
5. **pick:** type `pick`. Hovering highlights windows. A left click prints
   `picked` with that window's id and the app does *not* receive the click.
   Typing `pick` again quickly lets you pick another window. A right click, or
   `pickcancel`, prints `picked 0`. Afterwards, clicks reach apps again.
6. **seq:** `seq 1 m <id> 0.5 0.5;s 50;d 1;s 30;u 1` clicks the centre of a
   background window (covered, or another app's), activating it first. `done ok`
   is true. Also try a drag (`d 1`, several `m`, `u 1`) in a canvas or a list, a
   double click (two clicks within 100 ms: it must select a word in a text
   editor), and `d 4;u 4` scrolling.
7. **Mouse lock:** start a long seq (`s 3000` between ops) and move and click the
   physical mouse: no app receives the clicks, and the replay is not disturbed.
   Escape aborts it (`esc`, then `done ok:false`), and the mouse works right away.
8. **Skip mode:** `m` on a minimized window, or on a window on another Space,
   skips the following `d/u/s` until the next `f/m/w`. A seq whose only target
   fails replies `done ok:false`.
9. **Robustness:** close stdin in the middle of a seq: held buttons are
   released, `done ok:false` is sent, and the helper exits 0. `kill -TERM`
   behaves the same. `keys 1` and ops `kd`/`ku` are rejected with `error` (and
   `done ok:false` for the seq). Make an app hang (for example `kill -STOP`) and
   confirm the system mouse stays responsive and the helper recovers.
10. **Own events:** during a seq no `btn`/`motion` is reported, nor for 30 ms
    after it.
11. **Universal binary:** `make check` shows `x86_64 arm64` and minos 11.0. Run it
    on both an Intel and an Apple Silicon Mac if possible.

## Integration notes (Electron side)

- Build `resources/clickered-helper` with this Makefile on macOS, instead of
  `native/Makefile`, which is X11 only.
- **Signing:** with the hardened runtime, sign the helper with the app's
  Developer ID and ship it inside the bundle, for example
  `Contents/Resources/clickered-helper` or `Contents/MacOS/`. The arm64 slice must
  carry at least an ad-hoc signature to run at all. Apple's linker adds one, and
  `codesign` replaces it with the real one when the app is packaged. The helper
  needs no special entitlements: Accessibility and Input Monitoring are TCC grants,
  not entitlements. It does not use JIT or unsigned memory, and it loads no
  libraries except system frameworks.
- **TCC attribution:** permissions belong to the Electron app (the responsible
  process), so a stable code signature and bundle id matter. Re-signing with a
  different identity resets the grants. During development, the grants belong to
  whatever launched the app (Terminal, an IDE).
- **Info.plist:** macOS shows no purpose string for Accessibility or Input
  Monitoring. Setting `NSAppleEventsUsageDescription` is harmless but not
  needed, since no Apple Events are sent. The helper never captures the screen,
  so no Screen Recording permission is needed.
- **Startup:** `error` messages (permission instructions) can arrive before
  `ready` and the wait can be unbounded, so there must be no startup timeout that
  kills the helper. Show the error text to the user.
- **Protocol:** version 2, as documented, with the deviations listed above.
  Window ids are `CGWindowID`s (32 bit). Coordinates are in points.

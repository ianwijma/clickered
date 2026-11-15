# clickered-helper for macOS

A macOS port of `native/helper.c`. It speaks the same line protocol
(`docs/PROTOCOL.md`, **protocol version 3**: no keyboard replication, optional
experimental background mode), so the Electron host drives it unchanged.

> **Status: unverified on a real Mac.** It was written on Linux. It compiles
> warning-free (`-Wall -Wextra`) for arm64 and x86_64 against the macOS 14.5 SDK
> headers with deployment target 11.0, and it links against the SDK's `.tbd` stubs.
> It has never been run. Use the checklist at the end before relying on it.
> **Background mode** (`bg 1`) is even less certain: see
> [Background mode](#background-mode-experimental-never-executed).

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
| Activation (`f`, and `m` when needed; foreground mode only) | `kAXMainAttribute = true` and `AXRaise` on the window, then `kAXFrontmostAttribute = true` on the app, then `-[NSRunningApplication activateWithOptions:]`. After that the helper waits up to 200 ms until the window is the focused window of the frontmost app. |
| Capture | A `CGEventTap` at `kCGSessionEventTap`, `kCGHeadInsertEventTap`, `kCGEventTapOptionDefault` (an active tap), for mouse down/up/dragged/moved, scroll wheel and key down. If the system disables the tap (`kCGEventTapDisabledByTimeout` / `…ByUserInput`), it is turned straight back on. |
| Buttons | CG 0 → 1 (left), 2 → 2 (middle), 1 → 3 (right), and CG *n* ≥ 3 → *n* + 5 (back = 8, forward = 9). Injection maps them back the same way. |
| Wheel | Every non-momentum scroll event with a non-zero line delta is reported as one press+release: `kCGScrollWheelEventDeltaAxis1` > 0 → 4, < 0 → 5; `DeltaAxis2` > 0 → 6, < 0 → 7. Momentum ("inertia") events are not reported. Injecting button 4–7 posts one line-unit scroll event in the same direction, so a captured gesture replays with the same sign, whatever the "natural scrolling" setting is. |
| Escape | Key code 53 (`kVK_Escape`) down, not auto-repeat. The helper always emits `esc` and aborts a running seq. The key event always passes through. |
| Injection | `CGEventPost(kCGHIDEventTap, …)` using a `kCGEventSourceStateHIDSystemState` source. Moves are `kCGEventMouseMoved`, or `…Dragged` while the seq holds a button, with `kCGMouseEventDeltaX/Y` set. Down and up events carry `kCGMouseEventClickState`: the helper counts clicks itself using `NSEvent.doubleClickInterval` and a 4-point distance, so a replayed double-click is a double-click on macOS too. Injected events carry the current physical modifier flags, as XTest input does. The source's local-events suppression interval is 0, so the user's real mouse is not frozen after a replay. |
| Own-event tagging | Every posted event (foreground and background) has `kCGEventSourceUserData = 0x636c6b72` ("clkr"). The tap also treats any event whose `kCGEventSourceUnixProcessID` is the helper's own pid as its own. Such events are never reported and never dropped. On top of that, reporting is suppressed during a `seq` and for 30 ms after it, as in the protocol. |
| Mouse lock during a seq | Foreground mode only. While a `seq` runs, the active tap drops every *physical* mouse event: presses (and the matching release later), drags, moves and scrolls. A physical release whose press had already gone through is let through, so no app is left with a stuck button. Every injected event carries an explicit location, so even if the visible cursor drifts, clicks land at the replayed position. The lock is just a flag checked by the tap. It ends when the seq ends, on abort, on Escape and on every exit path, and when the process dies the tap dies with it, so the mouse can never stay locked. `CGAssociateMouseAndMouseCursorPosition` is deliberately *not* used: Apple documents it as applying "while an application is in the foreground", the helper never is, and it could stop the injected moves from moving the cursor. |
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
5. Only then does it start the tap and send `ready` (version 3) and `windows`.

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

## Background mode (experimental, never executed)

> **This code path has never been executed.** It compiles and links, nothing more.
> Nobody has run it on a Mac. The technique comes from third-party reports, listed below,
> that we could only read, not reproduce. Expect it to fail on some or all apps until
> someone works through the checklist (steps 12–20).

`bg 1` makes the next `seq` a background seq (`bg 0` switches back; any other argument
is an `error` and leaves the mode unchanged; there is no reply). A `bg` sent while a seq
runs is queued like any other command, so it applies to the next one.

What a background seq does:

| Op | Background behaviour |
|---|---|
| `f WIN` | Checks only: WIN exists, belongs to another process, and is on screen (`kCGWindowIsOnscreen`). Otherwise skip mode. Never activates. |
| `m WIN FX FY` | Same check, then moves a **virtual pointer** to that point of WIN's frame. If no button is held and the point lies outside WIN (a fraction outside 0..1), skip mode. During a drag the point may leave WIN. Posts a mouse-moved (or a drag while a button is held) to the target. The real cursor is not moved and nothing is activated or raised. |
| `d BTN` | Buttons 1–3 and 8+: re-checks the target when no button is held yet (it may have closed, minimized or left the Space during an `s`; skip mode if so), posts a mouse-moved, then the press. The first press "grabs" that window: drags and releases go to it until every button is up, even if `m` names another window meanwhile. Wheel 4–7: one line-unit scroll tick at the virtual pointer, as in foreground. A `d` before any successful `m` in this seq does nothing. |
| `u BTN` | Release to the grabbed window, only for buttons this seq pressed. |
| `w X Y` | Only ends skip mode. The virtual pointer does not move. |
| `s`, `abort`, Escape, EOF | As in foreground. The end of the seq, abort, Escape and EOF post the pending releases to the grabbed window. |

Skip mode also clears the virtual pointer, so a `w` that ends skip mode does not let a
later `d` click the previous window. The virtual pointer starts empty in every seq.

**How an event is built.** Public APIs only; nothing private is called or looked up
for this (the only `dlsym` in the helper is still `_AXUIElementGetWindow`).

1. `+[NSEvent mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:]`
   with the target's `CGWindowID` as window number, modifier flags 0, the click count,
   and pressure 1 for down/drag, 0 otherwise. The location is in the window's base
   coordinate system, as Apple documents for this method: origin at the bottom-left of
   the window frame, y up, in points. Window frame and point both come from the same
   CG (top-left origin) global coordinates, so the conversion is
   `(px − x, y + h − py)` and never involves a display height. Multi-monitor layouts
   do not matter.
2. `-CGEvent`, copied with `CGEventCreateCopy`.
3. `CGEventSetLocation` with the global CG point;
   `kCGMouseEventWindowUnderMousePointer` (91) and
   `kCGMouseEventWindowUnderMousePointerThatCanHandleThisEvent` (92) set to the window
   id (both public in `CGEventTypes.h`, "made public in 10.7");
   `kCGMouseEventButtonNumber`; `kCGMouseEventClickState` from the same double-click
   counter the foreground path uses; deltas on moves and drags; and the "clkr" tag in
   `kCGEventSourceUserData`.
4. `CGEventPostToPid(owner pid, event)`.

Scroll ticks cannot be built with that `NSEvent` method, so they are
`CGEventCreateScrollWheelEvent2` with the same location, fields 91/92, the tag, and
flags 0, posted with `CGEventPostToPid`. Nobody has reported anything about routing
pid-posted scroll events, so this is the least certain part.

**Modifiers.** Background events carry no modifier flags. The user's physical
modifiers belong to the app they are typing in. Foreground events still copy the
physical modifier state.

**No mouse lock.** The tap drops physical mouse events only while a *foreground* seq
runs. During a background seq, physical presses, drags, moves and scrolls pass
through. They are not *reported* (`btn`/`motion` are suppressed during every seq and for
30 ms after), as the protocol requires.

**No self-capture.** `CGEventPostToPid` events never reach the helper's
`kCGSessionEventTap`. Apple's `CGEvent.h` says they are posted "immediately before any
event taps instantiated for the specified process", that is, only that process's own
taps see them. They are also tagged like foreground events, and reporting is
suppressed while any seq runs, so even if a future macOS routed them through the
session tap they would not be reported.

**Permission.** Posting needs post-event access (`CGPreflightPostEventAccess`), which
macOS grants together with Accessibility. Without it, `bg 1` and the next background seq
emit one `error`, and every background target is skipped (`done ok:false`). There is no
fallback to foreground replay.

**Not addressable → skip mode:** the window is gone; it is minimized, hidden (⌘H) or on
another Space (`kCGWindowIsOnscreen` false); it is one of the helper's own windows; or
post-event access is missing. A covered window is *not* skipped: the events are
addressed to the window, not to whatever is on top at that point.

### Which claims this rests on

Confirmed from Apple's SDK headers (macOS 14.5 SDK):

- `CGEventPostToPid` (10.11+), `CGPreflightPostEventAccess` (10.15+), fields 91/92, and
  `-[NSEvent CGEvent]` / the `NSEvent` factory are public.
- Pid-posted events only pass the target process's own taps, so the helper's session
  tap does not see them.

From code that others ran, but not us:

- Electron PR [#54493](https://github.com/electron/electron/pull/54493) has a test
  helper that builds a left down/up with the `NSEvent` factory and a foreign window
  number, takes `-CGEvent`, and calls `CGEventPostToPid`. It reports that the click
  reaches a background Electron window **without activating the app**, on macOS 15 CI.
  That test passes *global* Cocoa coordinates as the location and checks only that a
  mouse-down arrived, not where. We pass window-base coordinates, as Apple documents,
  and set the global location explicitly, so the point is right whichever of the two
  the target reads. This is a deliberate difference from that test, and it is untested.

Reported only (write-ups, or code we could not see run):

- The visible cursor does not move with `CGEventPostToPid`
  ([cua blog](https://github.com/trycua/cua/blob/main/blog/inside-macos-window-internals.md)).
- Fields 91/92 alone are not enough; a move before each click "is the one that
  mattered" ([agent-desktop #227](https://github.com/lahfir/agent-desktop/pull/227)).
  Caution: that PR's working recipe also used the private `CGEventSetWindowLocation` and
  SkyLight `SLEventPostToPid`, which we do not use, and it was closed unmerged. So it
  does not show that the public-only recipe routes.
- A reverse-engineered closed-source app builds the event with the `NSEvent` factory,
  sets fields 91/92, and posts per pid
  ([bgclick-rev-skill](https://github.com/Lakr233/bgclick-rev-skill/blob/main/bgclick-rev-skill.md)).
  It also sets the window location through the private `CGEventSetWindowLocation`,
  sets subtype 3 (outside the public enum), and sets ⌘ in the flags when the target is
  inactive. We do none of these. ⌘-click changes what a click means in many apps. That
  write-up reports that the target window becomes key while its app stays inactive.

### Apps expected to ignore it

- **AppKit views that answer NO to `acceptsFirstMouse:`** in an inactive window. Per the
  Electron PR, AppKit then drops the click, and because the window server never saw it,
  nothing is activated either. Many standard controls accept the first mouse; text
  views and many custom views do not.
- **Chromium / Electron before Chromium 157** (the fix is crrev.com/c/8470994,
  backported to Electron 42–45). Chromium also still drops posted mouse-moved events in
  an inactive window, so hover effects do not happen. Chrome itself is reported to filter
  pid-posted clicks.
- **WKWebView** content (reported to ignore them).
- **Games and canvas apps** (Unity, Blender and others) that read the HID stream or need
  a real leading mouse-moved.
- **Drags** in the background: nobody has reported anything either way.
- **Scroll**: see above.

## Manual test checklist (real Mac)

Build with `make`, then run the helper by hand from Terminal. Grant Accessibility
(and Input Monitoring if asked) to **Terminal** for this, because Terminal is the
responsible app. Type commands on stdin and watch stdout.

1. **Permissions:** with Accessibility off, the helper prompts, prints one `error`,
   keeps running and uses no CPU (check in Activity Monitor). Pressing ⌃D exits
   with code 0. Turn the permission on: within about 1 s you get `ready`
   (`"version":3`) followed by `windows`.
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

Background mode (send `bg 1` first; `bg 2` must print an `error` and change nothing).
Keep Terminal frontmost and type in it between steps, so you can see who has the
keyboard:

12. **Click (AppKit):** put TextEdit (or Finder) behind Terminal, partly visible.
    `seq 1 m <id> 0.5 0.5;d 1;s 30;u 1` places the caret, or selects a Finder item.
    Check: the visible cursor does not move; Terminal stays frontmost and keeps the
    keyboard (keep typing); `done ok:true`. Note whether TextEdit's window shows as key
    (active traffic lights) or the app activates itself. Try a plain button too, which
    usually accepts the first mouse.
13. **Double-click:** `m … ;d 1;u 1;s 50;d 1;u 1` selects a word in TextEdit, or opens a
    folder in Finder.
14. **Drag:** `d 1`, several `m` along a line with `s 20` between them, then `u 1`.
    This should select text in TextEdit, or rubber-band select in a Finder icon view.
    Also drag so that the point leaves the window: it must still end with a release.
15. **Scroll:** `d 4;u 4` and `d 5;u 5` scroll a long TextEdit document or a Finder
    list. `d 6`/`d 7` scroll horizontally where possible.
16. **Covered window:** fully cover TextEdit with another window. A click still reaches
    it (and does not touch the covering window), or it does nothing. Write down which.
17. **Electron:** an Electron app on Chromium ≥ 157 (and one older one): the click lands
    in the page; hover effects are not expected. Also try Safari or another WKWebView app
    (expected to ignore it).
18. **Escape mid-drag:** `seq 1 m <id> 0.2 0.2;d 1;s 3000;m <id> 0.8 0.8;u 1`. Press
    Escape during the sleep: `esc`, then `done ok:false`. The target gets the
    mouse-up (no stuck selection drag in TextEdit). Do the same with `abort` and by
    closing stdin.
19. **No lock, no self-capture:** during a long background seq, move and click the
    physical mouse. It works normally in other apps, and no `btn`/`motion` is printed
    for the seq's own clicks, during the seq or after it. Physical clicks after the
    seq (30 ms or more) are reported again.
20. **Skip mode:** a minimized window, a window of a hidden app, and a window on another
    Space are skipped (`done ok:false` if they are the only target). `m <id> 1.5 0.5`
    (outside the window) with no button held is skipped. `bg 0` restores the
    foreground behaviour exactly (activation, mouse lock, cursor moves).

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
- **Protocol:** version 3, as documented, with the deviations listed above.
  Window ids are `CGWindowID`s (32 bit). Coordinates are in points.

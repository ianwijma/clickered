<img src="assets/icon.svg" width="64" height="64" alt="">

# Clickered

[![Unit tests](https://github.com/ianwijma/clickered/actions/workflows/unit.yml/badge.svg)](https://github.com/ianwijma/clickered/actions/workflows/unit.yml)
[![E2E tests](https://github.com/ianwijma/clickered/actions/workflows/e2e.yml/badge.svg)](https://github.com/ianwijma/clickered/actions/workflows/e2e.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Created in [T3 Code](https://t3.codes).

Replicate clicks and drags from one window into a group of other windows.
Runs on Linux (X11), macOS 11+ and Windows 10/11, with the same bar and the same
features everywhere. Design notes: [docs/PLAN.md](docs/PLAN.md).

> The macOS and Windows builds are new: their native helpers
> ([`native/mac`](native/mac/README.md), [`native/win`](native/win/README.md)) have been
> compiled and (Windows, under Wine) smoke-tested, but not yet run much on real machines.
> Bug reports are very welcome.

## Install

Download from the [latest release](https://github.com/ianwijma/clickered/releases/latest):

| OS | File |
|---|---|
| Linux x64 (X11; Debian, Ubuntu, Pop!_OS, ...) | `clickered-X.Y.Z-amd64.deb`: `sudo apt install ./clickered-X.Y.Z-amd64.deb` |
| macOS 11+, Apple silicon | `clickered-X.Y.Z-arm64.dmg` |
| macOS 11+, Intel | `clickered-X.Y.Z-x64.dmg` |
| Windows 10/11 x64 | `clickered-X.Y.Z-x64.exe` (installs for the current user, no admin rights needed) |

`SHA256SUMS.txt` has the checksums. Releasing: [docs/RELEASING.md](docs/RELEASING.md).

The builds are **not signed** with an Apple or Microsoft certificate yet, so the first
start needs one extra step:

- **macOS:** open the dmg and drag Clickered to Applications. On first start macOS
  says it "cannot verify" the app: open **System Settings → Privacy & Security**, scroll
  down and click **Open Anyway** (on macOS 14 and older you can also right-click the
  app → **Open**). Or run `xattr -dr com.apple.quarantine /Applications/Clickered.app`.
  Clickered then asks for the **Accessibility** permission (and, on some versions,
  **Input Monitoring**): turn Clickered on under **System Settings → Privacy & Security
  → Accessibility**. Until then the bar shows what is missing; it continues by itself
  once the permission is granted. Each update of an unsigned build can make macOS
  ask again: switch the old entry off and on, or remove it and add Clickered again.
- **Windows:** SmartScreen shows "Windows protected your PC": click **More info →
  Run anyway**.

Platform limits worth knowing:

- **Linux:** X11 only. Wayland does not let one app inject input into another.
- **macOS:** windows on another Space or minimized are skipped, as are windows on
  another workspace on Linux. A window that is not active gets activated before the
  click (macOS drops the first click into an inactive window otherwise). Window
  rects include the title bar, so mixing windows with different title bars shifts
  clicks a little.
- **Windows:** Clickered cannot click into windows of programs that run **as
  administrator** (UIPI), unless Clickered itself runs as administrator. Some game
  launchers and anti-cheat clients do. Exclusive-fullscreen games cannot be
  replicated into; use borderless or windowed mode. Windows on another virtual
  desktop are skipped, and the bar stays on the desktop it was opened on.

## Run from source

Node.js 22.12+ and a C toolchain for the native helper:

| OS | Toolchain |
|---|---|
| Linux | `sudo apt install build-essential pkg-config libx11-dev libxi-dev libxtst-dev` |
| macOS | Xcode command line tools: `xcode-select --install` |
| Windows | MinGW-w64 `gcc` and GNU `make` on `PATH`, e.g. from [MSYS2](https://www.msys2.org/) (`pacman -S mingw-w64-x86_64-gcc make`), run from Git Bash or the MSYS2 shell |

```sh
npm install
npm start        # builds the native helper for this OS and launches the bar
npm run dist     # packages for this OS into dist/ (.deb, .dmg or .exe installer)
```

On macOS the Accessibility permission then belongs to the app that started
Clickered (Terminal, your editor), not to Clickered itself.

## Use

1. **Grab windows**, click each window you want to control, then **Done** (or right-click).
   The first window picked is the source; the crown in the expanded list changes it.
2. Click or drag in the source window: the other windows follow at the same relative position.
3. The **Live / Paused** toggle (or ``Ctrl+` ``, the Control key on macOS too) switches replication off while you fix up one window.
4. **Escape** during a replay stops it and pauses.
5. Optional humanizers in the expanded panel, both off by default:
   - **Click offset**: each other window gets a small random shift of up to 1–20 px,
     instead of the exact same spot.
   - **Click delay**: a random pause of up to 50–500 ms before each other window is
     replayed into, instead of hitting them all back to back.
6. **Background clicks** (experimental, off by default): click the other windows
   without moving your mouse, so you can keep using it during a replay. Clicks into a
   window that is covered by another one are skipped on Linux, and some apps (notably
   games) ignore background clicks, so test it with your game first.

Unless Background clicks is on, the mouse is locked while a replay runs, so moving it cannot disturb the other windows.

## Test

```sh
npm test           # unit tests (vitest, fake helper — touches nothing on your desktop)
npm run typecheck
npm run test:e2e   # E2E in Docker: needs only Docker on the host
```

CI runs the unit tests and builds the native helper on Linux, macOS and Windows. The
E2E suites are Linux-only. `test:e2e` builds `e2e/Dockerfile` and runs everything against a private Xvfb inside the
container, so your real desktop is never touched:

1. `native/test/run.py` — the native helper's protocol test (fake WM, physical vs XTEST input).
2. `e2e/engine.e2e.test.ts` — real helper + engine: picking, click/drag replay, pause, pinned master, Escape.
3. `e2e/app.e2e.test.ts` — the built Electron app driven through the bar UI with Playwright.

The E2E suites refuse to run outside the container. Pass a filter through to vitest with
`docker run --rm --init --shm-size=512m -e SKIP_NATIVE=1 clickered-e2e -t Escape` after a build.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Please report
security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Ian Wijma

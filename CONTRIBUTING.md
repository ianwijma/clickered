# Contributing to Clickered

Thanks for your interest! Bug reports, fixes and small focused features are welcome.

## Before you start

- For anything bigger than a small fix, please open an issue first so we can agree on the approach.
- Clickered runs on Linux (X11), macOS and Windows. Each OS has its own native helper that
  speaks the same protocol: `native/helper.c` (X11), `native/mac/` and `native/win/`.
  Wayland is out of scope: it does not allow one client to inject input into another.
- Read [docs/PLAN.md](docs/PLAN.md) for the design and [docs/PROTOCOL.md](docs/PROTOCOL.md) for the
  contract between the Electron app and the native helper. If you change the helper's behaviour,
  update `docs/PROTOCOL.md` in the same PR, and keep the three helpers in step (or document
  the difference in that platform's README).

## Setup

You need Node.js 22.12+ and a C toolchain for the native helper of your OS:

- **Linux:** `sudo apt install build-essential pkg-config libx11-dev libxi-dev libxtst-dev`
- **macOS:** `xcode-select --install` (see [native/mac/README.md](native/mac/README.md))
- **Windows:** MinGW-w64 `gcc` and GNU `make`, e.g. from MSYS2; run the commands from Git
  Bash or the MSYS2 shell (see [native/win/README.md](native/win/README.md))

```sh
npm install
npm start          # builds the native helper for this OS (npm run build:helper) and launches the bar
```

## Layout

| Path | What |
|---|---|
| `src/main/` | Electron main process: engine (recording / replay), helper process, config, IPC |
| `src/preload/` | The `window.clickered` bridge exposed to the bar UI |
| `src/renderer/` | The bar UI |
| `src/shared/` | Types shared between processes, including the helper protocol |
| `native/helper.c` | X11 helper: input capture (XInput2) and replay (XTest) |
| `native/mac/` | macOS helper (CGEventTap, CGEvent, Accessibility) |
| `native/win/` | Windows helper (low-level hooks, SendInput) and its Wine-based tests |
| `scripts/` | `build-helper.mjs` (per-OS helper build), `dist.mjs` (packaging), release scripts |
| `e2e/` | End-to-end tests run in Docker against Xvfb |

## Tests

Please run these before opening a PR:

```sh
npm run typecheck
npm test           # unit tests, uses a fake helper and never touches your desktop
npm run test:e2e   # needs Docker; runs the real helper and the app against a private Xvfb
```

Add or update tests for behaviour changes: unit tests next to the code (`*.test.ts`), native
helper checks in `native/test/run.py`, and app-level flows in `e2e/`.

> **Never run the native helper tests against your real display.** They inject clicks and keys.
> `npm run test:e2e` keeps everything inside the container.

## Pull requests

- Keep each PR focused on one change, and explain *why* in the description.
- Make sure CI is green: unit tests and the helper build on Linux, macOS and Windows, and
  the (Linux-only) E2E suites. If you can, try a change that touches the bar or the engine on
  a real Mac or Windows machine too; CI cannot click anything there.
- By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

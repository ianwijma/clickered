<img src="assets/icon.svg" width="64" height="64" alt="">

# clickered

Created in [T3 Code](https://t3.codes).

Replicate clicks and drags from one window into a group of other windows.
Linux / X11 only. Design notes: [docs/PLAN.md](docs/PLAN.md).

## Install

Download the AppImage, `.deb` or `.tar.gz` from the
[latest release](https://github.com/ianwijma/clickered/releases/latest) (Linux x64).
Releasing: [docs/RELEASING.md](docs/RELEASING.md).

## Run from source

```sh
npm install
npm start        # builds the native helper (needs gcc, libx11-dev, libxi-dev, libxtst-dev) and launches the bar
```

## Use

1. **Grab windows**, click each window you want to control, then **Done** (or right-click).
   The first window picked is the source; the crown in the expanded list changes it.
2. Click or drag in the source window: the other windows follow at the same relative position.
3. The **Live / Paused** toggle (or ``Ctrl+` ``) switches replication off while you fix up one window.
4. **Escape** during a replay stops it and pauses.

The mouse is locked while a replay runs, so moving it cannot disturb the other windows.

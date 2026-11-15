/**
 * Electron main process: app lifecycle, the bar window, IPC and the global hotkey.
 * All replication logic lives in ./engine.
 */
import { join } from "node:path"
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron"
import { Effect } from "effect"
import { IPC } from "@shared/ipc"
import { parseCommand } from "./command"
import { ConfigStore, loadConfig, type BarPosition } from "./config"
import { startEngine, type Engine } from "./engine"

const INITIAL_SIZE = { width: 420, height: 64 }
const SIZE_LIMITS = { minW: 80, maxW: 1600, minH: 24, maxH: 1200 }

// Transparent windows on Linux/X11 need an ARGB visual.
if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals")

// Settings live in a lowercase "clickered" folder on every platform (~/.config/clickered,
// ~/Library/Application Support/clickered, %APPDATA%\clickered), whatever the visible
// product name is. Must be set before the app is ready (and before the single-instance
// lock, which lives in userData).
app.setPath("userData", join(app.getPath("appData"), "clickered"))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

/** The native helper: native/Makefile (Linux), native/mac (macOS) or native/win (Windows). */
function helperPath(): string {
  const override = process.env["CLICKERED_HELPER"]
  if (override) return override
  const name = process.platform === "win32" ? "clickered-helper.exe" : "clickered-helper"
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), "resources", name)
}

// Window icon (taskbar, alt-tab, window lists). Electron can't load SVG here, so use the PNG.
const appIconPath = (): string => join(app.getAppPath(), "assets", "icon.png")

function onSomeDisplay(p: BarPosition, size: { width: number; height: number }): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => {
    const cx = p.x + Math.min(size.width, 80) / 2
    const cy = p.y + Math.min(size.height, 24) / 2
    return cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height
  })
}

function defaultPosition(size: { width: number; height: number }): BarPosition {
  const a = screen.getPrimaryDisplay().workArea
  return { x: Math.round(a.x + (a.width - size.width) / 2), y: a.y + 8 }
}

function main(): void {
  let win: BrowserWindow | null = null
  let engine: Engine | null = null
  let config: ConfigStore | null = null
  let quitting = false

  const createWindow = (store: ConfigStore): BrowserWindow => {
    const saved = store.get().bar
    const pos = saved && onSomeDisplay(saved, INITIAL_SIZE) ? saved : defaultPosition(INITIAL_SIZE)
    const w = new BrowserWindow({
      ...INITIAL_SIZE,
      ...pos,
      useContentSize: true,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // macOS: frameless windows get rounded corners by default, which would clip the
      // transparent margin around the bar differently than on Linux and Windows.
      roundedCorners: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: "Clickered",
      icon: appIconPath(),
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // The bar never opens other windows or navigates away from its own page.
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    w.webContents.on("will-navigate", (e) => e.preventDefault())
    w.setAlwaysOnTop(true, "screen-saver")
    // All workspaces (X11), all Spaces incl. fullscreen ones (macOS). Windows has no API
    // for virtual desktops, so there the bar stays on the desktop it was opened on.
    // skipTransformProcessType: on macOS the app is already an agent (no Dock icon, see
    // below); without it Electron briefly hides the window and the Dock to switch types.
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    w.once("ready-to-show", () => w.showInactive())
    w.on("move", () => {
      const [x, y] = w.getPosition()
      if (x !== undefined && y !== undefined) store.update({ bar: { x, y } })
    })
    w.on("closed", () => {
      win = null
    })
    const devUrl = process.env["ELECTRON_RENDERER_URL"]
    if (!app.isPackaged && devUrl) void w.loadURL(devUrl)
    else void w.loadFile(join(__dirname, "../renderer/index.html"))
    return w
  }

  const setSize = (width: number, height: number): void => {
    if (!win || win.isDestroyed() || !Number.isFinite(width) || !Number.isFinite(height)) return
    const w = Math.round(Math.min(SIZE_LIMITS.maxW, Math.max(SIZE_LIMITS.minW, width)))
    const h = Math.round(Math.min(SIZE_LIMITS.maxH, Math.max(SIZE_LIMITS.minH, height)))
    const [cw, ch] = win.getContentSize()
    if (cw === w && ch === h) return
    // resizable:false also blocks programmatic resizes on some WMs; lift it briefly.
    win.setResizable(true)
    win.setContentSize(w, h)
    win.setResizable(false)
  }

  app.on("second-instance", () => win?.showInactive())

  // Only the bar window's own top-level page may talk to main.
  const fromBar = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean =>
    win !== null && !win.isDestroyed() && e.sender === win.webContents && e.senderFrame === win.webContents.mainFrame

  ipcMain.handle(IPC.getState, (e) => (fromBar(e) ? (engine?.getState() ?? null) : null))
  ipcMain.on(IPC.command, (e, raw: unknown) => {
    if (!fromBar(e)) return
    const cmd = parseCommand(raw)
    if (!cmd) return
    switch (cmd.c) {
      case "setSize":
        return setSize(cmd.width, cmd.height)
      case "quit":
        return app.quit()
      default:
        return engine?.command(cmd)
    }
  })

  app.on("window-all-closed", () => app.quit())

  app.on("will-quit", (e) => {
    globalShortcut.unregisterAll()
    config?.flush()
    if (engine && !quitting) {
      quitting = true
      e.preventDefault()
      const done = (): void => app.exit(0)
      const timer = setTimeout(done, 2000)
      engine.shutdown().then(
        () => {
          clearTimeout(timer)
          done()
        },
        () => done(),
      )
    }
  })

  void app.whenReady().then(async () => {
    // macOS: like the bar on Linux and Windows (skipTaskbar), no Dock icon and no menu
    // bar; the bar's own Quit button ends the app. Packaged builds set LSUIElement in
    // Info.plist (electron-builder.yml) so the icon never even flashes up.
    if (process.platform === "darwin") app.dock?.hide()

    const store = new ConfigStore(
      join(app.getPath("userData"), "config.json"),
      await Effect.runPromise(loadConfig(join(app.getPath("userData"), "config.json"))),
    )
    config = store

    engine = startEngine({
      config: store,
      helper: {
        command: helperPath(),
        onStderr: (line) => console.log(`[helper] ${line}`),
      },
      onState: (s) => {
        if (win && !win.isDestroyed()) win.webContents.send(IPC.state, s)
      },
    })

    const hotkey = store.get().hotkey
    try {
      if (!globalShortcut.register(hotkey, () => engine?.toggleEnabled())) {
        console.warn(`[clickered] could not register global hotkey ${hotkey}`)
      }
    } catch (err) {
      console.warn(`[clickered] invalid global hotkey ${hotkey}: ${String(err)}`)
    }

    // Give the compositor a moment, otherwise the transparent window can come up black on X11.
    const delay = process.platform === "linux" ? 300 : 0
    setTimeout(() => {
      win = createWindow(store)
    }, delay)
  })
}

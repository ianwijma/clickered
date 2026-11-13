/**
 * Electron main process: app lifecycle, the bar window, IPC and the global hotkey.
 * All replication logic lives in ./engine.
 */
import { join } from "node:path"
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron"
import { Effect } from "effect"
import { IPC, type IpcCommand } from "@shared/ipc"
import { ConfigStore, loadConfig, type BarPosition } from "./config"
import { startEngine, type Engine } from "./engine"

const INITIAL_SIZE = { width: 420, height: 64 }
const SIZE_LIMITS = { minW: 80, maxW: 1600, minH: 24, maxH: 1200 }

// Transparent windows on Linux/X11 need an ARGB visual.
if (process.platform === "linux") app.commandLine.appendSwitch("enable-transparent-visuals")

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function helperPath(): string {
  const override = process.env["CLICKERED_HELPER"]
  if (override) return override
  return app.isPackaged
    ? join(process.resourcesPath, "clickered-helper")
    : join(app.getAppPath(), "resources", "clickered-helper")
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

const isCommand = (u: unknown): u is IpcCommand =>
  typeof u === "object" && u !== null && typeof (u as { c?: unknown }).c === "string"

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
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      title: "clickered",
      icon: appIconPath(),
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        sandbox: false,
      },
    })
    w.setAlwaysOnTop(true, "screen-saver")
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
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

  ipcMain.handle(IPC.getState, () => engine?.getState() ?? null)
  ipcMain.on(IPC.command, (_e, cmd: unknown) => {
    if (!isCommand(cmd)) return
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

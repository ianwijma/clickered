/**
 * DEV-ONLY mock of `window.clickered` for previewing the bar in a plain browser.
 * Only loaded when `window.clickered` is missing and `import.meta.env.DEV` is true,
 * so it is never part of a production build.
 *
 *   ?state=empty|picking|waiting|live|paused|busy|partial|error|starting|permission
 *   ?update=available|prerelease|skipped|downloading|verifying|installing|failed-checksum|failed-download|failed-install
 *                   the update chip; "Install"/"Retry" plays the whole sequence on timers;
 *                   "Skip" / "Show again" and the "Pre-release updates" switch work too
 *                   (prerelease = available 1.5.0-rc.1 with the switch on; skipped = 0.3.0
 *                   skipped; "What's new" just logs to the console)
 *                   (state=permission: "Open Settings" grants the permission after 3 s)
 *   ?cycle          step through all states every 2.5 s
 *   ?expanded       open the panel
 *   ?plain          no fake game backdrop
 */
import type { AppState, ClickeredApi, GroupWindow, UpdateFailure, UpdateSnapshot, UpdateState } from "@shared/ipc"

const windows = (n: number, overrides: Partial<Record<number, Partial<GroupWindow>>> = {}): GroupWindow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: 0x3a00001 + i * 0x100,
    index: i + 1,
    title: i === 2 ? "LastZ: Survival Shooter — a rather long window title" : "LastZ",
    included: true,
    isMaster: i === 0,
    ...overrides[i],
  }))

const base: AppState = {
  enabled: true,
  helper: "ready",
  helperError: null,
  picking: false,
  groupClass: "steam_app_123456",
  groupLabel: "LastZ",
  windows: windows(4),
  masterMode: "auto",
  masterId: null,
  clickOffset: 0,
  clickDelay: 0,
  hotkey: "Control+`",
  busy: false,
  permission: "ok",
}

const STATES: Record<string, AppState> = {
  starting: { ...base, helper: "starting", groupClass: null, groupLabel: null, windows: [] },
  permission: {
    ...base,
    helper: "starting",
    helperError:
      "Clickered needs the Accessibility permission. Open System Settings > Privacy & Security > Accessibility and turn on Clickered.",
    groupClass: null,
    groupLabel: null,
    windows: [],
    permission: "missing",
  },
  empty: { ...base, groupClass: null, groupLabel: null, windows: [] },
  picking: { ...base, groupClass: null, groupLabel: null, windows: [], picking: true },
  waiting: { ...base, windows: [] },
  live: base,
  paused: { ...base, enabled: false },
  busy: { ...base, busy: true },
  partial: {
    ...base,
    masterMode: "pinned",
    masterId: 0x3a00101,
    windows: windows(4, { 0: { isMaster: false }, 1: { isMaster: true }, 3: { included: false } }),
    clickOffset: 10,
    clickDelay: 200,
  },
  error: { ...base, helper: "error", helperError: "XInput2 not available on display :1 (XIQueryVersion failed)" },
}

const VERSION = "0.3.0"
const PRERELEASE_VERSION = "1.5.0-rc.1"

function updateFromParam(param: string | null): UpdateState {
  switch (param) {
    case "available":
      return { status: "available", version: VERSION, prerelease: false }
    case "prerelease":
      return { status: "available", version: PRERELEASE_VERSION, prerelease: true }
    case "skipped":
      return { status: "skipped", version: VERSION }
    case "downloading":
      return { status: "downloading", version: VERSION, progress: 0.42 }
    case "verifying":
      return { status: "verifying", version: VERSION }
    case "installing":
      return { status: "installing", version: VERSION }
    case "failed-checksum":
    case "failed-download":
    case "failed-install": {
      const reason = param.slice("failed-".length) as UpdateFailure
      return { status: "failed", version: VERSION, reason, message: `mock ${reason} failure` }
    }
    default:
      return { status: "none" }
  }
}

export function installMock(): ClickeredApi {
  const params = new URLSearchParams(location.search)
  if (!params.has("plain")) {
    document.documentElement.style.background =
      "linear-gradient(135deg, #3b5d2a 0%, #7a6a3a 35%, #2c4a6b 70%, #6b2c3a 100%)"
  }
  const names = Object.keys(STATES)
  let current: AppState = STATES[params.get("state") ?? "live"] ?? base
  const listeners = new Set<(s: AppState) => void>()
  const set = (patch: Partial<AppState>): void => {
    current = { ...current, ...patch }
    for (const l of listeners) l(current)
  }
  if (params.has("cycle")) {
    let i = 0
    setInterval(() => {
      i = (i + 1) % names.length
      set(STATES[names[i] ?? "live"] ?? base)
    }, 2500)
  }

  let prereleases = params.get("update") === "prerelease"
  let update: UpdateState = updateFromParam(params.get("update"))
  const snapshot = (): UpdateSnapshot => ({ ...update, prereleases })
  const updateListeners = new Set<(u: UpdateSnapshot) => void>()
  const setUpdate = (u: UpdateState): void => {
    update = u
    for (const l of updateListeners) l(snapshot())
  }
  /** The newest offerable release: the pre-release one only while the switch is on. */
  const offered = (): UpdateState =>
    prereleases
      ? { status: "available", version: PRERELEASE_VERSION, prerelease: true }
      : { status: "available", version: "1.4.0", prerelease: false }
  /** The version a skip applies to (undefined when nothing is offered). */
  let skippedVersion: string | undefined = update.status === "skipped" ? update.version : undefined
  const recheck = (): void => {
    const next = offered()
    if (next.status === "available" && next.version === skippedVersion) setUpdate({ status: "skipped", version: skippedVersion })
    else setUpdate(next)
  }
  let installTimer: ReturnType<typeof setTimeout> | undefined
  /** download 3.2 s -> verify 1.5 s -> install 2.6 s -> back to "available" (a real app restarts). */
  const playInstall = (): void => {
    const t0 = Date.now()
    const tick = (): void => {
      const f = Math.min(1, (Date.now() - t0) / 3200)
      setUpdate({ status: "downloading", version: VERSION, progress: f })
      if (f < 1) {
        installTimer = setTimeout(tick, 100)
        return
      }
      setUpdate({ status: "verifying", version: VERSION })
      installTimer = setTimeout(() => {
        setUpdate({ status: "installing", version: VERSION })
        installTimer = setTimeout(() => setUpdate({ status: "available", version: VERSION, prerelease: false }), 2600)
      }, 1500)
    }
    tick()
  }

  // Draw the size the renderer reports, so sizing can be checked visually.
  const outline = document.createElement("div")
  outline.style.cssText = "position:fixed;left:0;top:0;outline:1px dashed rgb(255 0 255 / .8);pointer-events:none"
  document.body.append(outline)

  return {
    getState: async () => current,
    onState: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    setEnabled: (enabled) => set({ enabled }),
    startPick: () => set({ picking: true }),
    cancelPick: () => set({ picking: false }),
    clearGroup: () => set({ groupClass: null, groupLabel: null, windows: [] }),
    setIncluded: (id, included) => set({ windows: current.windows.map((w) => (w.id === id ? { ...w, included } : w)) }),
    setMaster: (id) =>
      set({
        masterMode: id === null ? "auto" : "pinned",
        masterId: id,
        windows: current.windows.map((w) => ({ ...w, isMaster: id === null ? w.index === 1 : w.id === id })),
      }),
    setClickOffset: (clickOffset) => set({ clickOffset }),
    setClickDelay: (clickDelay) => set({ clickDelay }),
    setSize: (width, height) => {
      outline.style.width = `${width}px`
      outline.style.height = `${height}px`
      document.title = `Clickered ${width}x${height}`
    },
    getUpdate: async () => snapshot(),
    onUpdate: (l) => {
      updateListeners.add(l)
      return () => updateListeners.delete(l)
    },
    installUpdate: () => {
      if (update.status !== "available" && update.status !== "failed") return
      clearTimeout(installTimer)
      playInstall()
    },
    skipUpdate: () => {
      if (update.status !== "available" && update.status !== "failed") return
      skippedVersion = update.version
      setUpdate({ status: "skipped", version: update.version })
    },
    unskipUpdate: () => {
      if (update.status !== "skipped") return
      skippedVersion = undefined
      setUpdate({ status: "available", version: update.version, prerelease: update.version === PRERELEASE_VERSION })
    },
    openReleaseNotes: () => {
      if (update.status !== "none") console.info("[mock] open release notes for", update.version)
    },
    setPrereleaseUpdates: (enabled) => {
      prereleases = enabled
      // A real check takes a moment; skip the install/failed states, which main would also keep.
      if (update.status === "available" || update.status === "skipped") recheck()
      else setUpdate(update)
    },
    openPermissionSettings: () => {
      if (current.permission !== "missing") return
      console.info("[mock] open settings; granting in 3 s")
      setTimeout(() => set({ permission: "ok", helper: "ready", helperError: null }), 3000)
    },
    quit: () => console.info("[mock] quit"),
  }
}

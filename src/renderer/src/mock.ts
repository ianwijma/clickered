/**
 * DEV-ONLY mock of `window.clickered` for previewing the bar in a plain browser.
 * Only loaded when `window.clickered` is missing and `import.meta.env.DEV` is true,
 * so it is never part of a production build.
 *
 *   ?state=empty|picking|waiting|live|paused|busy|partial|error|starting|permission
 *   ?cycle          step through all states every 2.5 s
 *   ?expanded       open the panel
 *   ?plain          no fake game backdrop
 */
import type { AppState, ClickeredApi, GroupWindow } from "@shared/ipc"

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
  backgroundClicks: false,
  hotkey: "Control+`",
  busy: false,
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
    setBackgroundClicks: (backgroundClicks) => set({ backgroundClicks }),
    setSize: (width, height) => {
      outline.style.width = `${width}px`
      outline.style.height = `${height}px`
      document.title = `Clickered ${width}x${height}`
    },
    quit: () => console.info("[mock] quit"),
  }
}

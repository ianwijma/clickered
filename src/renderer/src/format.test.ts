import { describe, expect, it } from "vitest"
import type { AppState, GroupWindow } from "@shared/ipc"
import { countText, formatHotkey, groupName, nearestSpeed } from "./format"

const w = (id: number, included = true): GroupWindow => ({ id, index: id, title: `W${id}`, included, isMaster: false })
const state = (windows: GroupWindow[], label: string | null = null, cls: string | null = null): AppState => ({
  enabled: true,
  helper: "ready",
  helperError: null,
  picking: false,
  groupClass: cls,
  groupLabel: label,
  windows,
  masterMode: "auto",
  masterId: null,
  replicateKeys: false,
  dragSpeed: 1,
  hotkey: "Control+`",
  busy: false,
})

describe("formatHotkey", () => {
  it("shortens modifier names", () => {
    expect(formatHotkey("Control+`")).toBe("Ctrl `")
    expect(formatHotkey("CommandOrControl+Shift+Escape")).toBe("Ctrl Shift Esc")
    expect(formatHotkey("Meta+Option+Return")).toBe("Super Alt Enter")
  })
  it("handles empty input", () => {
    expect(formatHotkey("")).toBe("")
  })
})

describe("countText", () => {
  it("counts all windows when all are included", () => {
    expect(countText(state([w(1)]))).toBe("1 window")
    expect(countText(state([w(1), w(2), w(3)]))).toBe("3 windows")
    expect(countText(state([]))).toBe("0 windows")
  })
  it("shows 'n of m' when some are excluded", () => {
    expect(countText(state([w(1), w(2, false), w(3)]))).toBe("2 of 3")
  })
})

describe("groupName", () => {
  it("prefers the label, then the class, then a generic name", () => {
    expect(groupName(state([], "Game", "picked"))).toBe("Game")
    expect(groupName(state([], null, "picked"))).toBe("picked")
    expect(groupName(state([]))).toBe("app")
  })
})

describe("nearestSpeed", () => {
  it("snaps to the closest preset", () => {
    expect(nearestSpeed(1)).toBe(1)
    expect(nearestSpeed(1.2)).toBe(1)
    expect(nearestSpeed(1.4)).toBe(1.5)
    expect(nearestSpeed(2.4)).toBe(2)
    expect(nearestSpeed(10)).toBe(3)
    expect(nearestSpeed(0.25)).toBe(1)
  })
})

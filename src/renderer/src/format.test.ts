import { describe, expect, it } from "vitest"
import { CLICK_DELAYS, CLICK_OFFSETS, type AppState, type GroupWindow } from "@shared/ipc"
import { clickDelayLabel, clickOffsetLabel, countText, formatHotkey, groupName } from "./format"

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
  clickOffset: 0,
  clickDelay: 0,
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

describe("clickOffsetLabel", () => {
  it("shows Off for 0 and the pixel count otherwise", () => {
    expect(CLICK_OFFSETS.map(clickOffsetLabel)).toEqual(["Off", "1", "5", "10", "15", "20"])
  })
})

describe("clickDelayLabel", () => {
  it("shows Off for 0 and the millisecond count otherwise", () => {
    expect(CLICK_DELAYS.map(clickDelayLabel)).toEqual(["Off", "50", "100", "200", "300", "500"])
  })
})

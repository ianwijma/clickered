import { describe, expect, it } from "vitest"
import { CLICK_DELAYS, CLICK_OFFSETS, type AppState, type GroupWindow, type UpdateState } from "@shared/ipc"
import {
  chipView,
  clickDelayLabel,
  clickOffsetLabel,
  countText,
  formatHotkey,
  groupName,
  permissionPhaseAfter,
  progressPercent,
  updateFailureText,
} from "./format"

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
  permission: "ok",
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

describe("progressPercent", () => {
  it("rounds and clamps", () => {
    expect(progressPercent(0)).toBe(0)
    expect(progressPercent(0.336)).toBe(34)
    expect(progressPercent(1)).toBe(100)
    expect(progressPercent(1.5)).toBe(100)
    expect(progressPercent(-0.2)).toBe(0)
    expect(progressPercent(Number.NaN)).toBe(0)
  })
})

describe("updateFailureText", () => {
  it("has a text per reason", () => {
    expect(updateFailureText("checksum")).toBe("Update failed its checksum")
    expect(updateFailureText("download")).toBe("Update download failed")
    expect(updateFailureText("install")).toBe("Update was not installed")
  })
})

describe("permissionPhaseAfter", () => {
  it("stays idle while ok", () => {
    expect(permissionPhaseAfter("idle", null, "ok")).toBe("idle")
    expect(permissionPhaseAfter("idle", "ok", "ok")).toBe("idle")
  })
  it("keeps idle/waiting while missing", () => {
    expect(permissionPhaseAfter("idle", null, "missing")).toBe("idle")
    expect(permissionPhaseAfter("waiting", "missing", "missing")).toBe("waiting")
  })
  it("confirms when missing becomes ok, clicked or not", () => {
    expect(permissionPhaseAfter("waiting", "missing", "ok")).toBe("granted")
    expect(permissionPhaseAfter("idle", "missing", "ok")).toBe("granted")
  })
  it("holds granted until the caller resets it, and drops it if missing again", () => {
    expect(permissionPhaseAfter("granted", "ok", "ok")).toBe("granted")
    expect(permissionPhaseAfter("granted", "ok", "missing")).toBe("idle")
  })
})

describe("chipView", () => {
  const none: UpdateState = { status: "none" }
  const missing = { ...state([]), permission: "missing" as const }
  it("shows nothing when there is nothing to show or while picking", () => {
    expect(chipView(none, state([]), "idle").kind).toBe("none")
    expect(chipView(none, null, "idle").kind).toBe("none")
    const picking = { ...missing, picking: true }
    expect(chipView({ status: "available", version: "1.0.0", prerelease: false }, picking, "idle").kind).toBe("none")
  })
  it("prefers the permission chip over the update chip", () => {
    const upd: UpdateState = { status: "available", version: "1.0.0", prerelease: false }
    expect(chipView(upd, missing, "idle")).toEqual({ kind: "permission-missing", text: "macOS permission missing" })
    expect(chipView(upd, missing, "waiting").kind).toBe("permission-waiting")
    expect(chipView(upd, state([]), "granted").kind).toBe("permission-granted")
    expect(chipView(upd, state([]), "idle").kind).toBe("update-available")
  })
  it("describes the update steps", () => {
    const s = state([])
    expect(chipView({ status: "available", version: "0.3.0", prerelease: false }, s, "idle")).toEqual({
      kind: "update-available",
      text: "Update 0.3.0",
      version: "0.3.0",
      prerelease: false,
    })
    expect(chipView({ status: "available", version: "1.5.0-rc.1", prerelease: true }, s, "idle")).toEqual({
      kind: "update-available",
      text: "Update 1.5.0-rc.1",
      version: "1.5.0-rc.1",
      prerelease: true,
    })
    expect(chipView({ status: "skipped", version: "0.3.0" }, s, "idle")).toEqual({ kind: "none" })
    expect(chipView({ status: "downloading", version: "0.3.0", progress: 0.456 }, s, "idle")).toEqual({
      kind: "update-progress",
      title: "Updating to 0.3.0",
      sub: "Downloading · 46%",
      progress: 46,
    })
    expect(chipView({ status: "verifying", version: "0.3.0" }, s, "idle")).toEqual({
      kind: "update-progress",
      title: "Updating to 0.3.0",
      sub: "Verifying checksum…",
      progress: null,
    })
    expect(chipView({ status: "installing", version: "0.3.0" }, s, "idle")).toEqual({
      kind: "update-progress",
      title: "Installing 0.3.0",
      sub: "Clickered restarts by itself",
      progress: null,
    })
    expect(
      chipView({ status: "failed", version: "0.3.0", reason: "download", message: "ECONNRESET" }, s, "idle"),
    ).toEqual({ kind: "update-failed", text: "Update download failed", version: "0.3.0", message: "ECONNRESET" })
  })
})

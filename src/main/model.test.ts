import { describe, expect, it } from "vitest"
import type { HelperWindow } from "@shared/protocol"
import {
  applyWindows,
  groupWindows,
  isSource,
  permissionOf,
  permissionSettingsUrl,
  targetsFor,
  toAppState,
  type Model,
} from "./engine"

const win = (id: number, x: number, y = 0, mapped = true): HelperWindow => ({
  id,
  title: `W${id}`,
  cls: "game",
  pid: 1,
  x,
  y,
  w: 100,
  h: 100,
  mapped,
})

const model = (patch: Partial<Model> = {}): Model => ({
  enabled: true,
  helper: "ready",
  helperError: null,
  permission: null,
  picking: false,
  members: new Set([1, 2, 3]),
  allWindows: [win(3, 200), win(1, 0, 50), win(2, 0, 10), win(9, 50)],
  excluded: new Set(),
  masterMode: "auto",
  masterId: null,
  clickOffset: 0,
  clickDelay: 0,
  hotkey: "Control+`",
  busy: false,
  ...patch,
})

describe("groupWindows", () => {
  it("returns only members, ordered by x then y, with 1-based indexes", () => {
    expect(groupWindows(model()).map((w) => [w.id, w.index])).toEqual([
      [2, 1],
      [1, 2],
      [3, 3],
    ])
  })
  it("is empty without members", () => {
    expect(groupWindows(model({ members: new Set() }))).toEqual([])
  })
})

describe("isSource / targetsFor", () => {
  it("in auto mode any included, mapped member is a source", () => {
    const m = model()
    expect([1, 2, 3].map((id) => isSource(m, id))).toEqual([true, true, true])
    expect(isSource(m, 9)).toBe(false)
    expect(isSource(m, 0)).toBe(false)
  })
  it("in pinned mode only the master is a source", () => {
    const m = model({ masterMode: "pinned", masterId: 3 })
    expect([1, 2, 3].map((id) => isSource(m, id))).toEqual([false, false, true])
  })
  it("excluded and unmapped windows are neither sources nor targets", () => {
    const m = model({ excluded: new Set([1]), allWindows: [win(1, 0), win(2, 10), win(3, 20, 0, false)] })
    expect(isSource(m, 1)).toBe(false)
    expect(isSource(m, 3)).toBe(false)
    expect(targetsFor(m, 2)).toEqual([])
  })
  it("targets every other member in index order", () => {
    expect(targetsFor(model(), 1)).toEqual([2, 3])
  })
})

describe("applyWindows", () => {
  it("drops closed members and exclusions", () => {
    const m = applyWindows(model({ excluded: new Set([3, 2]) }), [win(1, 0), win(2, 10)])
    expect([...m.members]).toEqual([1, 2])
    expect([...m.excluded]).toEqual([2])
  })
  it("returns to auto mode when the pinned master closes", () => {
    const m = applyWindows(model({ masterMode: "pinned", masterId: 3 }), [win(1, 0), win(2, 10)])
    expect(m.masterMode).toBe("auto")
    expect(m.masterId).toBeNull()
  })
  it("keeps a pinned master that is still open", () => {
    const m = applyWindows(model({ masterMode: "pinned", masterId: 1 }), [win(1, 0), win(2, 10)])
    expect([m.masterMode, m.masterId]).toEqual(["pinned", 1])
  })
})

describe("toAppState", () => {
  it("projects the model for the renderer", () => {
    const s = toAppState(model({ excluded: new Set([1]), masterMode: "pinned", masterId: 2 }))
    expect(s.groupClass).toBe("picked")
    expect(s.groupLabel).toBe("W2")
    expect(s.windows).toEqual([
      { id: 2, index: 1, title: "W2", included: true, isMaster: true },
      { id: 1, index: 2, title: "W1", included: false, isMaster: false },
      { id: 3, index: 3, title: "W3", included: true, isMaster: false },
    ])
  })
  it("has no group without members", () => {
    const s = toAppState(model({ members: new Set() }))
    expect([s.groupClass, s.groupLabel, s.windows]).toEqual([null, null, []])
  })
})

describe("permission", () => {
  it("is missing only while the helper waits for a permission before ready", () => {
    expect(toAppState(model({ helper: "starting", permission: "accessibility" })).permission).toBe("missing")
    expect(toAppState(model({ helper: "starting", permission: "input-monitoring" })).permission).toBe("missing")
    expect(toAppState(model({ helper: "starting", permission: null })).permission).toBe("ok")
    expect(toAppState(model({ helper: "ready", permission: "accessibility" })).permission).toBe("ok")
    expect(toAppState(model({ helper: "error", permission: "accessibility" })).permission).toBe("ok")
  })

  it("only trusts known perm values", () => {
    expect(permissionOf({ t: "error", msg: "x", perm: "accessibility" })).toBe("accessibility")
    expect(permissionOf({ t: "error", msg: "x", perm: "input-monitoring" })).toBe("input-monitoring")
    expect(permissionOf({ t: "error", msg: "needs the Accessibility permission" })).toBeNull()
    expect(permissionOf({ t: "error", msg: "x", perm: "camera" } as never)).toBeNull()
    expect(permissionOf({ t: "error", msg: "x", perm: 1 } as never)).toBeNull()
  })

  it("maps each permission to its System Settings page", () => {
    expect(permissionSettingsUrl("accessibility")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
    )
    expect(permissionSettingsUrl("input-monitoring")).toBe(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    )
  })
})

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"
import { ConfigStore, DEFAULT_CONFIG, DEFAULT_HOTKEY, loadConfig, sanitizeConfig, timingOf } from "./config"
import { DEFAULT_TIMING } from "./script"

const tmp = (): string => mkdtempSync(join(tmpdir(), "clickered-config-"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("sanitizeConfig", () => {
  it("returns defaults for anything that is not an object", () => {
    for (const raw of [null, undefined, 42, "x", [], true]) expect(sanitizeConfig(raw)).toEqual(DEFAULT_CONFIG)
  })

  it("keeps valid fields", () => {
    const c = sanitizeConfig({
      groupClass: "steam_app_1",
      groupLabel: "Game",
      clickOffset: 15,
      clickDelay: 300,
      backgroundClicks: true,
      hotkey: "Alt+F1",
      bar: { x: 10.4, y: 20.6 },
      timing: { clickHold: 50 },
    })
    expect(c).toEqual({
      groupClass: "steam_app_1",
      groupLabel: "Game",
      clickOffset: 15,
      clickDelay: 300,
      backgroundClicks: true,
      hotkey: "Alt+F1",
      bar: { x: 10, y: 21 },
      timing: { clickHold: 50 },
    })
  })

  it("drops invalid fields one by one", () => {
    const c = sanitizeConfig({
      groupClass: "",
      groupLabel: "orphan label",
      clickOffset: "5",
      clickDelay: "100",
      backgroundClicks: "yes",
      hotkey: 5,
      bar: { x: 1 },
      timing: "fast",
    })
    expect(c).toEqual(DEFAULT_CONFIG)
  })

  it("snaps the click offset to the nearest allowed value", () => {
    for (const px of [0, 1, 5, 10, 15, 20]) expect(sanitizeConfig({ clickOffset: px }).clickOffset).toBe(px)
    expect(sanitizeConfig({ clickOffset: 2 }).clickOffset).toBe(1)
    expect(sanitizeConfig({ clickOffset: 4 }).clickOffset).toBe(5)
    expect(sanitizeConfig({ clickOffset: 12 }).clickOffset).toBe(10)
    expect(sanitizeConfig({ clickOffset: 100 }).clickOffset).toBe(20)
    expect(sanitizeConfig({ clickOffset: -3 }).clickOffset).toBe(0)
    for (const bad of [Number.NaN, Infinity, "10", null, true]) expect(sanitizeConfig({ clickOffset: bad }).clickOffset).toBe(0)
  })

  it("loads background clicks tolerantly: only true enables it", () => {
    expect(DEFAULT_CONFIG.backgroundClicks).toBe(false)
    expect(sanitizeConfig({ backgroundClicks: true }).backgroundClicks).toBe(true)
    expect(sanitizeConfig({}).backgroundClicks).toBe(false)
    for (const bad of [false, 1, "true", "1", null, [], {}]) expect(sanitizeConfig({ backgroundClicks: bad }).backgroundClicks).toBe(false)
  })

  it("snaps the click delay to the nearest allowed value", () => {
    for (const ms of [0, 50, 100, 200, 300, 500]) expect(sanitizeConfig({ clickDelay: ms }).clickDelay).toBe(ms)
    expect(sanitizeConfig({ clickDelay: 25 }).clickDelay).toBe(0) // tie -> the smaller
    expect(sanitizeConfig({ clickDelay: 30 }).clickDelay).toBe(50)
    expect(sanitizeConfig({ clickDelay: 400 }).clickDelay).toBe(300)
    expect(sanitizeConfig({ clickDelay: 450 }).clickDelay).toBe(500)
    expect(sanitizeConfig({ clickDelay: 10_000 }).clickDelay).toBe(500)
    expect(sanitizeConfig({ clickDelay: -3 }).clickDelay).toBe(0)
    for (const bad of [Number.NaN, Infinity, "100", null, true]) expect(sanitizeConfig({ clickDelay: bad }).clickDelay).toBe(0)
  })

  it("silently drops settings of removed features (keyboard replication, drag speed)", () => {
    const c = sanitizeConfig({
      hotkey: "Alt+F2",
      replicateKeys: true,
      dragSpeed: 2,
      timing: { clickHold: 40, keyFocusSettle: 40, keyGap: 8, keyIdleFlush: 350, keyMaxBuffer: 200, keyStuckTimeout: 5000 },
    })
    expect(c).toEqual({ ...DEFAULT_CONFIG, hotkey: "Alt+F2", timing: { clickHold: 40 } })
    expect(c).not.toHaveProperty("replicateKeys")
    expect(c).not.toHaveProperty("dragSpeed")
  })

  it("only keeps known, finite, non-negative timing overrides", () => {
    const c = sanitizeConfig({ timing: { clickHold: 10, clickAfter: -1, bogus: 3, dragAfter: "5", clickSlop: Infinity } })
    expect(c.timing).toEqual({ clickHold: 10 })
    expect(timingOf(c)).toEqual({ ...DEFAULT_TIMING, clickHold: 10 })
  })
})

describe("loadConfig", () => {
  it("falls back to defaults when the file is missing", async () => {
    expect(await Effect.runPromise(loadConfig(join(tmp(), "nope.json")))).toEqual(DEFAULT_CONFIG)
  })

  it("falls back to defaults on invalid JSON", async () => {
    const p = join(tmp(), "config.json")
    writeFileSync(p, "{ not json")
    expect(await Effect.runPromise(loadConfig(p))).toEqual(DEFAULT_CONFIG)
  })

  it("sanitizes what it reads", async () => {
    const p = join(tmp(), "config.json")
    writeFileSync(p, JSON.stringify({ hotkey: "Alt+X", clickOffset: 99, clickDelay: 99, extra: 1 }))
    const c = await Effect.runPromise(loadConfig(p))
    expect(c.hotkey).toBe("Alt+X")
    expect(c.clickOffset).toBe(20)
    expect(c.clickDelay).toBe(100)
    expect(c).not.toHaveProperty("extra")
  })

  it("loads an old config with keyboard/drag-speed settings without warnings", async () => {
    const p = join(tmp(), "config.json")
    writeFileSync(
      p,
      JSON.stringify({
        groupClass: null,
        groupLabel: null,
        replicateKeys: true,
        dragSpeed: 1.5,
        hotkey: "Control+`",
        bar: { x: 5, y: 6 },
        timing: { keyGap: 8, keyIdleFlush: 350 },
      }),
    )
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m))
    try {
      const c = await Effect.runPromise(loadConfig(p))
      expect(c).toEqual({ ...DEFAULT_CONFIG, bar: { x: 5, y: 6 } })
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe("ConfigStore", () => {
  it("debounces writes and round-trips through loadConfig", async () => {
    const p = join(tmp(), "sub", "config.json")
    const store = new ConfigStore(p, DEFAULT_CONFIG, 30)
    store.update({ hotkey: "Alt+A" })
    store.update({ clickOffset: 5 })
    store.update({ clickDelay: 200 })
    expect(store.get().hotkey).toBe("Alt+A")
    expect(existsSync(p)).toBe(false)
    await sleep(80)
    expect(existsSync(p)).toBe(true)
    expect(existsSync(`${p}.tmp`)).toBe(false)
    const back = await Effect.runPromise(loadConfig(p))
    expect(back).toEqual({ ...DEFAULT_CONFIG, hotkey: "Alt+A", clickOffset: 5, clickDelay: 200 })
  })

  it("does not schedule a write for a no-op update", async () => {
    const p = join(tmp(), "config.json")
    const store = new ConfigStore(p, DEFAULT_CONFIG, 10)
    store.update({ hotkey: DEFAULT_HOTKEY })
    await sleep(40)
    expect(existsSync(p)).toBe(false)
  })

  it("flush writes a pending change immediately, and only then", () => {
    const p = join(tmp(), "config.json")
    const store = new ConfigStore(p, DEFAULT_CONFIG, 60_000)
    store.flush()
    expect(existsSync(p)).toBe(false)
    store.update({ clickOffset: 10 })
    store.flush()
    expect(JSON.parse(readFileSync(p, "utf8")).clickOffset).toBe(10)
  })
})

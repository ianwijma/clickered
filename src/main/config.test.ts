import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { ConfigStore, DEFAULT_CONFIG, DEFAULT_HOTKEY, loadConfig, sanitizeConfig, timingOf } from "./config"
import { DEFAULT_TIMING, MAX_DRAG_SPEED, MIN_DRAG_SPEED } from "./script"

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
      replicateKeys: true,
      dragSpeed: 2,
      hotkey: "Alt+F1",
      bar: { x: 10.4, y: 20.6 },
      timing: { clickHold: 50 },
    })
    expect(c).toEqual({
      groupClass: "steam_app_1",
      groupLabel: "Game",
      replicateKeys: true,
      dragSpeed: 2,
      hotkey: "Alt+F1",
      bar: { x: 10, y: 21 },
      timing: { clickHold: 50 },
    })
  })

  it("drops invalid fields one by one", () => {
    const c = sanitizeConfig({
      groupClass: "",
      groupLabel: "orphan label",
      replicateKeys: "yes",
      dragSpeed: Number.NaN,
      hotkey: 5,
      bar: { x: 1 },
      timing: "fast",
    })
    expect(c).toEqual(DEFAULT_CONFIG)
  })

  it("clamps drag speed", () => {
    expect(sanitizeConfig({ dragSpeed: 100 }).dragSpeed).toBe(MAX_DRAG_SPEED)
    expect(sanitizeConfig({ dragSpeed: 0 }).dragSpeed).toBe(MIN_DRAG_SPEED)
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
    writeFileSync(p, JSON.stringify({ hotkey: "Alt+X", dragSpeed: 99, extra: 1 }))
    const c = await Effect.runPromise(loadConfig(p))
    expect(c.hotkey).toBe("Alt+X")
    expect(c.dragSpeed).toBe(MAX_DRAG_SPEED)
    expect(c).not.toHaveProperty("extra")
  })
})

describe("ConfigStore", () => {
  it("debounces writes and round-trips through loadConfig", async () => {
    const p = join(tmp(), "sub", "config.json")
    const store = new ConfigStore(p, DEFAULT_CONFIG, 30)
    store.update({ hotkey: "Alt+A" })
    store.update({ dragSpeed: 2 })
    expect(store.get().hotkey).toBe("Alt+A")
    expect(existsSync(p)).toBe(false)
    await sleep(80)
    expect(existsSync(p)).toBe(true)
    expect(existsSync(`${p}.tmp`)).toBe(false)
    const back = await Effect.runPromise(loadConfig(p))
    expect(back).toEqual({ ...DEFAULT_CONFIG, hotkey: "Alt+A", dragSpeed: 2 })
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
    store.update({ replicateKeys: true })
    store.flush()
    expect(JSON.parse(readFileSync(p, "utf8")).replicateKeys).toBe(true)
  })
})

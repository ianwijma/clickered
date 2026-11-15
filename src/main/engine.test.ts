import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AppState } from "@shared/ipc"
import type { HelperMessage, HelperWindow } from "@shared/protocol"
import { ConfigStore, DEFAULT_CONFIG, type Config } from "./config"
import { startEngine, type Engine } from "./engine"
import { fakeHelper } from "./__fixtures__/fake"

const win = (id: number, x: number, cls = "game", title = `Game ${id}`): HelperWindow => ({
  id,
  title,
  cls,
  pid: id,
  x,
  y: 40,
  w: 640,
  h: 1374,
  mapped: true,
})
const WINDOWS = [win(30, 1400), win(10, 0), win(20, 700), win(40, 300, "firefox", "Browser")]

const btn = (down: boolean, button: number, w: number, fx: number, fy: number, x: number, y: number, time: number): HelperMessage => ({
  t: "btn",
  down,
  button,
  win: w,
  fx,
  fy,
  x,
  y,
  time,
})

const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let engines: Engine[] = []
afterEach(async () => {
  await Promise.all(engines.map((e) => e.shutdown()))
  engines = []
})

const setup = (opts: {
  config?: Partial<Config>
  events?: HelperMessage[]
  env?: Record<string, string>
  members?: number[]
  rng?: () => number
  onReplay?: (active: boolean) => void
}) => {
  const fake = fakeHelper({
    FAKE_WINDOWS: JSON.stringify(WINDOWS),
    FAKE_EVENTS: JSON.stringify(opts.events ?? []),
    ...opts.env,
  })
  const cfgPath = join(mkdtempSync(join(tmpdir(), "clickered-cfg-")), "config.json")
  const store = new ConfigStore(cfgPath, { ...DEFAULT_CONFIG, ...opts.config }, 10)
  const states: AppState[] = []
  const engine = startEngine({
    config: store,
    helper: fake.opts,
    initialMembers: opts.members ?? [10, 20, 30],
    onState: (s) => states.push(s),
    ...(opts.rng ? { rng: opts.rng } : {}),
    ...(opts.onReplay ? { onReplay: opts.onReplay } : {}),
  })
  engines.push(engine)
  const seqs = () => fake.log().filter((l) => l.startsWith("seq "))
  return { engine, fake, store, cfgPath, states, seqs }
}

describe("engine (fake helper)", () => {
  it("indexes the group windows left to right", async () => {
    const { engine, states } = setup({})
    await waitFor(() => engine.getState().helper === "ready" && engine.getState().windows.length === 3)
    const s = engine.getState()
    expect(s.windows.map((w) => [w.id, w.index, w.included])).toEqual([
      [10, 1, true],
      [20, 2, true],
      [30, 3, true],
    ])
    expect(s.masterMode).toBe("auto")
    await waitFor(() => states.at(-1)?.windows.length === 3)
    // snapshots are deduplicated
    const keys = states.map((x) => JSON.stringify(x))
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("replays a click from the source into the other windows, then restores", async () => {
    const { engine, seqs } = setup({
      events: [btn(true, 1, 20, 0.5, 0.25, 1020, 383, 1000), btn(false, 1, 20, 0.5, 0.25, 1021, 383, 1060)],
    })
    await waitFor(() => seqs().length === 1)
    expect(seqs()[0]).toBe(
      "seq 1 m 10 0.50000 0.25000;s 25;d 1;s 35;u 1;s 20;m 30 0.50000 0.25000;s 25;d 1;s 35;u 1;s 20;w 1021 383;f 20",
    )
    await waitFor(() => engine.getState().masterId === 20 && !engine.getState().busy)
    expect(engine.getState().windows.find((w) => w.isMaster)?.id).toBe(20)
  })

  it("signals replay start and end around a seq (bar goes click-through)", async () => {
    const calls: Array<[boolean, number]> = []
    const { engine, seqs } = setup({
      events: [btn(true, 1, 20, 0.5, 0.25, 1020, 383, 1000), btn(false, 1, 20, 0.5, 0.25, 1021, 383, 1060)],
      onReplay: (active) => calls.push([active, seqs().length]),
    })
    await waitFor(() => calls.length === 2 && !engine.getState().busy)
    // Started before the seq reached the helper, ended after it.
    expect(calls).toEqual([
      [true, 0],
      [false, 1],
    ])
  })

  it("replays a drag", async () => {
    const { seqs } = setup({
      events: [
        btn(true, 1, 10, 0.5, 0.5, 320, 700, 1000),
        { t: "motion", win: 10, fx: 0.5, fy: 0.45, x: 320, y: 640, time: 1016 },
        { t: "motion", win: 10, fx: 0.5, fy: 0.4, x: 320, y: 580, time: 1032 },
        btn(false, 1, 10, 0.5, 0.4, 320, 580, 1050),
      ],
    })
    await waitFor(() => seqs().length === 1)
    expect(seqs()[0]).toBe(
      "seq 1 " +
        [20, 30]
          .map((t) => `m ${t} 0.50000 0.50000;s 25;d 1;s 20;m ${t} 0.50000 0.45000;s 16;m ${t} 0.50000 0.40000;s 18;m ${t} 0.50000 0.40000;u 1;s 30`)
          .join(";") +
        ";w 320 580;f 10",
    )
  })

  it("ignores gestures from non-group windows, excluded windows, and when disabled", async () => {
    const { engine, seqs } = setup({
      events: [
        btn(true, 1, 40, 0.5, 0.5, 600, 300, 1000), // firefox
        btn(false, 1, 40, 0.5, 0.5, 600, 300, 1010),
      ],
    })
    await waitFor(() => engine.getState().windows.length === 3)
    await sleep(200)
    expect(seqs()).toEqual([])

    engine.command({ c: "setIncluded", id: 30, included: false })
    await waitFor(() => engine.getState().windows.find((w) => w.id === 30)?.included === false)
    engine.command({ c: "setEnabled", enabled: false })
    await waitFor(() => !engine.getState().enabled)
    engine.toggleEnabled()
    await waitFor(() => engine.getState().enabled)
  })

  it("only replays from the pinned master", async () => {
    const { engine, seqs } = setup({
      env: { FAKE_EVENTS_DELAY: "300" },
      events: [
        btn(true, 1, 20, 0.5, 0.5, 1020, 700, 1000),
        btn(false, 1, 20, 0.5, 0.5, 1020, 700, 1010),
        btn(true, 1, 10, 0.1, 0.1, 64, 177, 2000),
        btn(false, 1, 10, 0.1, 0.1, 64, 177, 2010),
      ],
    })
    await waitFor(() => engine.getState().windows.length === 3)
    engine.command({ c: "setMaster", id: 10 })
    engine.command({ c: "setIncluded", id: 30, included: false })
    await waitFor(() => seqs().length === 1)
    await sleep(100)
    expect(seqs()).toEqual(["seq 1 m 20 0.10000 0.10000;s 25;d 1;s 35;u 1;s 20;w 64 177;f 10"])
    expect(engine.getState().masterMode).toBe("pinned")
  })

  it("picks windows one by one; the first is the source; picking again removes", async () => {
    // 40 (added, becomes source), 10 (added), 10 (removed again), 20 (added), then right-click.
    const { engine, fake } = setup({ members: [], env: { FAKE_PICK: "40,10,10,20" } })
    await waitFor(() => engine.getState().helper === "ready")
    expect(engine.getState().windows).toEqual([])
    expect(engine.getState().groupClass).toBeNull()
    engine.command({ c: "startPick" })
    await waitFor(() => fake.log().filter((l) => l === "pick").length === 5 && !engine.getState().picking)
    const s = engine.getState()
    expect(s.windows.map((w) => w.id)).toEqual([40, 20])
    expect(s.groupClass).not.toBeNull()
    expect(s.masterMode).toBe("pinned")
    expect(s.masterId).toBe(40)
    engine.command({ c: "clearGroup" })
    await waitFor(() => engine.getState().groupClass === null)
    expect(engine.getState().windows).toEqual([])
  })

  it("Done stops picking and keeps what was picked", async () => {
    // FAKE_PICK_WAIT: after the first pick the fake waits for the next click instead of
    // answering "cancelled", so picking is still on when Done is pressed (otherwise it is a
    // race between the test and the fake, lost on slow runners).
    const { engine, fake } = setup({ members: [], env: { FAKE_PICK: "10", FAKE_PICK_WAIT: "1" } })
    await waitFor(() => engine.getState().helper === "ready")
    engine.command({ c: "startPick" })
    await waitFor(() => engine.getState().windows.length === 1)
    expect(engine.getState().picking).toBe(true)
    engine.command({ c: "cancelPick" })
    await waitFor(() => !engine.getState().picking)
    // The fake helper is a separate process: wait for it to log the command rather than
    // assuming it has after a fixed delay (flaky on slow CI runners).
    await waitFor(() => fake.log().includes("pickcancel"))
    expect(engine.getState().picking).toBe(false)
    expect(engine.getState().windows.map((w) => w.id)).toEqual([10])
  })

  it("shifts each target by its own random click offset, converted with that window's size", async () => {
    // rng 0.25 -> radius 20 * sqrt(0.25) = 10 px at angle pi/2: straight down. Windows are 640x1374.
    const { seqs } = setup({
      config: { clickOffset: 20 },
      rng: () => 0.25,
      events: [btn(true, 1, 20, 0.5, 0.25, 1020, 383, 1000), btn(false, 1, 20, 0.5, 0.25, 1021, 383, 1060)],
    })
    await waitFor(() => seqs().length === 1)
    const fy = (0.25 + 10 / 1374).toFixed(5)
    expect(seqs()[0]).toBe(
      `seq 1 m 10 0.50000 ${fy};s 25;d 1;s 35;u 1;s 20;m 30 0.50000 ${fy};s 25;d 1;s 35;u 1;s 20;w 1021 383;f 20`,
    )
  })

  it("persists the click offset, snapped to an allowed value", async () => {
    const { engine, store } = setup({})
    await waitFor(() => engine.getState().helper === "ready")
    expect(engine.getState().clickOffset).toBe(0)
    engine.command({ c: "setClickOffset", px: 12 })
    await waitFor(() => engine.getState().clickOffset === 10)
    expect(store.get().clickOffset).toBe(10)
    engine.command({ c: "setClickOffset", px: 500 })
    await waitFor(() => engine.getState().clickOffset === 20)
  })

  it("pauses a random time before each target, drawn after that target's offset", async () => {
    // rng 0.25: offset 10 px down (as above), delay floor(0.25 * 501) = 125 ms per target.
    const { seqs } = setup({
      config: { clickOffset: 20, clickDelay: 500 },
      rng: () => 0.25,
      events: [btn(true, 1, 20, 0.5, 0.25, 1020, 383, 1000), btn(false, 1, 20, 0.5, 0.25, 1021, 383, 1060)],
    })
    await waitFor(() => seqs().length === 1)
    const fy = (0.25 + 10 / 1374).toFixed(5)
    expect(seqs()[0]).toBe(
      `seq 1 m 10 0.50000 ${fy};s 125;s 25;d 1;s 35;u 1;s 20;m 30 0.50000 ${fy};s 125;s 25;d 1;s 35;u 1;s 20;w 1021 383;f 20`,
    )
  })

  it("persists the click delay, snapped to an allowed value", async () => {
    const { engine, store } = setup({})
    await waitFor(() => engine.getState().helper === "ready")
    expect(engine.getState().clickDelay).toBe(0)
    engine.command({ c: "setClickDelay", ms: 120 })
    await waitFor(() => engine.getState().clickDelay === 100)
    expect(store.get().clickDelay).toBe(100)
    engine.command({ c: "setClickDelay", ms: 5000 })
    await waitFor(() => engine.getState().clickDelay === 500)
    expect(store.get().clickDelay).toBe(500)
  })

  it("stays busy through a slow (delayed) replay and does not time it out", async () => {
    // The fake answers after 1.2 s; with a 500 ms max delay per target that is a plausible replay.
    const { engine, seqs, fake } = setup({
      config: { clickDelay: 500 },
      rng: () => 0.9999,
      env: { FAKE_SEQ_DELAY: "1200" },
      events: [btn(true, 1, 20, 0.5, 0.5, 1020, 700, 1000), btn(false, 1, 20, 0.5, 0.5, 1020, 700, 1010)],
    })
    // Busy is set before the fake has logged the seq line, so wait for both.
    await waitFor(() => engine.getState().busy && seqs().length === 1)
    expect(seqs()[0]).toContain("s 500;")
    await sleep(900)
    expect(engine.getState().busy).toBe(true)
    await waitFor(() => !engine.getState().busy, 3000)
    expect(fake.log()).not.toContain("abort")
    expect(engine.getState().enabled).toBe(true)
  })

  it("sends abort when disabled mid-replay", async () => {
    const { engine, fake } = setup({
      env: { FAKE_SEQ_HANG: "1" },
      events: [btn(true, 1, 20, 0.5, 0.5, 1020, 700, 1000), btn(false, 1, 20, 0.5, 0.5, 1020, 700, 1010)],
    })
    await waitFor(() => engine.getState().busy)
    engine.command({ c: "setEnabled", enabled: false })
    await waitFor(() => fake.log().includes("abort") && !engine.getState().busy)
  })

  it("pauses when Escape aborts a replay, even if the done arrives right behind the esc", async () => {
    const { engine } = setup({
      env: { FAKE_ESC_ON_SEQ: "30" },
      events: [btn(true, 1, 20, 0.5, 0.5, 1020, 700, 1000), btn(false, 1, 20, 0.5, 0.5, 1020, 700, 1010)],
    })
    await waitFor(() => engine.getState().busy)
    await waitFor(() => !engine.getState().busy)
    await sleep(50)
    expect(engine.getState().enabled).toBe(false)
  })

  it("Escape during a long click delay still stops and pauses", async () => {
    const { engine } = setup({
      config: { clickDelay: 500 },
      rng: () => 0.9999,
      env: { FAKE_ESC_ON_SEQ: "200" },
      events: [btn(true, 1, 20, 0.5, 0.5, 1020, 700, 1000), btn(false, 1, 20, 0.5, 0.5, 1020, 700, 1010)],
    })
    await waitFor(() => engine.getState().busy)
    await waitFor(() => !engine.getState().busy)
    await sleep(50)
    expect(engine.getState().enabled).toBe(false)
  })

  it("surfaces a missing helper as an error", async () => {
    const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), "clickered-cfg-")), "c.json"), DEFAULT_CONFIG)
    const engine = startEngine({ config: store, helper: { command: "/nonexistent/helper" }, onState: () => {} })
    engines.push(engine)
    await waitFor(() => engine.getState().helper === "error")
    expect(engine.getState().helperError).toContain("not found")
  })

  it("shows an error sent before ready while the helper waits, and clears it on ready", async () => {
    const msg = "Clickered needs the Accessibility permission (System Settings > Privacy & Security > Accessibility)"
    const { engine, states } = setup({ env: { FAKE_STARTUP_ERROR: msg, FAKE_READY_DELAY: "300" } })
    await waitFor(() => states.some((s) => s.helper === "starting" && s.helperError === msg))
    expect(engine.getState().helper).toBe("starting")
    await waitFor(() => engine.getState().helper === "ready")
    expect(engine.getState().helperError).toBeNull()
    await waitFor(() => states.at(-1)?.helper === "ready" && states.at(-1)?.helperError === null)
  })

  it("only logs an error that arrives after ready", async () => {
    const { engine } = setup({ events: [{ t: "error", msg: "unknown command: bogus" }] })
    await waitFor(() => engine.getState().helper === "ready")
    await sleep(150)
    expect(engine.getState().helperError).toBeNull()
  })

  it("closes the helper's stdin on shutdown", async () => {
    const { engine, fake } = setup({})
    await waitFor(() => engine.getState().helper === "ready")
    await engine.shutdown()
    await waitFor(() => fake.log().includes("EOF"))
  })
})

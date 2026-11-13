/**
 * Real helper + real engine + fake WM on Xvfb. "Physical" input goes in through the
 * Xvfb's own devices; assertions are on what the fake WM's windows actually received.
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { AppState } from "@shared/ipc"
import { ConfigStore, DEFAULT_CONFIG } from "../src/main/config"
import { startEngine, type Engine } from "../src/main/engine"
import { B_FREE, HELPER, assertSandbox, inA, phys, pointer, sleep, startFakeWm, waitFor, waitForPickGrab, type FakeWm } from "./support/x11"

const ESCAPE = 9

let wm: FakeWm
let engine: Engine | null = null

beforeAll(() => assertSandbox())
beforeEach(async () => {
  wm = await startFakeWm()
})
afterEach(async () => {
  await engine?.shutdown()
  engine = null
  wm.stop()
  await sleep(100)
})

const start = async (members: number[]): Promise<{ engine: Engine; states: AppState[] }> => {
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), "clickered-e2e-")), "config.json"), DEFAULT_CONFIG)
  const states: AppState[] = []
  engine = startEngine({ config: store, helper: { command: HELPER }, initialMembers: members, onState: (s) => states.push(s) })
  const e = engine
  await waitFor(() => e.getState().helper === "ready" && e.getState().windows.length === members.length, "helper ready")
  return { engine: e, states }
}

const near = (actual: number | undefined, expected: number, tol = 1) => {
  expect(actual).toBeDefined()
  expect(Math.abs((actual ?? NaN) - expected)).toBeLessThanOrEqual(tol)
}

describe("engine e2e (real helper, Xvfb)", () => {
  it("lists the group windows from the X server", async () => {
    const { engine } = await start([wm.ids.A, wm.ids.B])
    expect(engine.getState().windows.map((w) => [w.id, w.index, w.title])).toEqual([
      [wm.ids.A, 1, "Test A é☃"],
      [wm.ids.B, 2, 'Test B "quoted"'],
    ])
  })

  it("replays a click from A into B at the same relative position, then restores the pointer", async () => {
    const { engine } = await start([wm.ids.A, wm.ids.B])
    const at = inA(0.5, 0.5)
    phys.click(...at)

    await waitFor(() => wm.on("B", "release").length === 1, "replayed click on B")
    // The physical click reached A normally (nothing is grabbed)...
    expect(wm.on("A", "press")).toHaveLength(1)
    // ...and exactly one click landed on B at the same fraction of its content rect.
    const [press] = wm.on("B", "press")
    near(press?.x, 200)
    near(press?.y, 150)
    // B was covered by C at that point, so it had to be raised first.
    expect(wm.on("B", "activate")).toHaveLength(1)
    expect(wm.on("C", "press")).toHaveLength(0)

    await waitFor(() => !engine.getState().busy, "replay finished")
    const p = pointer()
    expect([p.x, p.y]).toEqual(at)
  })

  it("replays a drag as press, motion path, release", async () => {
    await start([wm.ids.A, wm.ids.B])
    await phys.drag(inA(0.1, 0.1), inA(0.6, 0.8), 12, 240)

    await waitFor(() => wm.on("B", "release").length === 1, "replayed drag on B", 8000)
    // Warping onto B produces a motion event before the press; the gesture starts at the press.
    const all = wm.on("B").filter((e) => e.ev !== "activate")
    const b = all.slice(all.findIndex((e) => e.ev === "press"))
    expect(b[0]?.ev).toBe("press")
    expect(b.at(-1)?.ev).toBe("release")
    expect(b.filter((e) => e.ev === "motion").length).toBeGreaterThanOrEqual(3)
    near(b[0]?.x, 40, 2)
    near(b[0]?.y, 30, 2)
    near(b.at(-1)?.x, 240, 2)
    near(b.at(-1)?.y, 240, 2)
  })

  it("does not replay while paused, or from a window outside the group", async () => {
    const { engine } = await start([wm.ids.A, wm.ids.B])
    engine.command({ c: "setEnabled", enabled: false })
    await waitFor(() => !engine.getState().enabled, "paused")
    phys.click(...inA(0.5, 0.5))
    await sleep(500)
    expect(wm.on("B", "press")).toHaveLength(0)
    expect(wm.on("A", "press")).toHaveLength(1)

    engine.command({ c: "setEnabled", enabled: true })
    await waitFor(() => engine.getState().enabled, "live")
    // Live, but C is not in the group: it gets the click, nobody else does.
    phys.click(850, 200)
    await sleep(500)
    expect(wm.on("C", "press")).toHaveLength(1)
    expect(wm.on("A", "press")).toHaveLength(1)
    expect(wm.on("B", "press")).toHaveLength(0)

    phys.click(...inA(0.25, 0.25))
    await waitFor(() => wm.on("B", "press").length === 1, "replay after resume")
  })

  it("only replays from the pinned master", async () => {
    const { engine } = await start([wm.ids.A, wm.ids.B])
    engine.command({ c: "setMaster", id: wm.ids.B })
    await waitFor(() => engine.getState().masterMode === "pinned", "pinned")
    phys.click(...inA(0.5, 0.5))
    await sleep(500)
    expect(wm.on("B", "press")).toHaveLength(0)
  })

  it("builds the group by picking windows, then replays between them", async () => {
    const { engine } = await start([])
    engine.command({ c: "startPick" })
    await waitFor(() => engine.getState().picking, "picking")
    // Picking clicks are swallowed by the helper's grab.
    await waitForPickGrab(wm, B_FREE)
    phys.click(...B_FREE)
    await waitFor(() => engine.getState().windows.length === 1, "B picked")
    await waitForPickGrab(wm, inA(0.5, 0.5))
    phys.click(...inA(0.5, 0.5))
    await waitFor(() => engine.getState().windows.length === 2, "A picked")
    engine.command({ c: "cancelPick" })
    await waitFor(() => !engine.getState().picking, "done picking")

    const s = engine.getState()
    expect(s.windows.map((w) => w.id)).toEqual([wm.ids.A, wm.ids.B])
    // The first window picked is the source.
    expect(s.masterId).toBe(wm.ids.B)
    expect(wm.on("A", "press")).toHaveLength(0)
    expect(wm.on("B", "press")).toHaveLength(0)

    await sleep(200)
    phys.click(...B_FREE)
    await waitFor(() => wm.on("A", "press").length === 1, "replayed into A")
    const [press] = wm.on("A", "press")
    expect(press?.win).toBe("A.child")
    near(press?.x, Math.round(((B_FREE[0] - 650) / 400) * 632), 2)
    near(press?.y, Math.round((B_FREE[1] / 300) * 374), 2)
  })

  it("Escape during a replay aborts it, releases the button and pauses", async () => {
    const { engine } = await start([wm.ids.A, wm.ids.B])
    // A slow drag: its replay takes about as long as the original.
    await phys.drag(inA(0.1, 0.5), inA(0.9, 0.5), 30, 1500)
    await waitFor(() => wm.on("B", "press").length === 1, "replay started", 5000)
    await sleep(200)
    phys.key(ESCAPE, true)
    phys.key(ESCAPE, false)

    await waitFor(() => !engine.getState().enabled && !engine.getState().busy, "paused after Escape")
    await waitFor(() => wm.on("B", "release").length === 1, "button released on B")
    const motions = wm.on("B", "motion")
    // Aborted well before the end of the path.
    expect(Math.max(...motions.map((m) => m.x ?? 0))).toBeLessThan(300)
  })
})

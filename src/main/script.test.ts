import { describe, expect, it } from "vitest"
import { encodeOp, type SeqOp } from "@shared/protocol"
import {
  DEFAULT_TIMING as T,
  buildScript,
  classify,
  enqueueCoalesced,
  estimateDuration,
  resample,
  seqTimeout,
  type Gesture,
  type Point,
} from "./script"

const pt = (x: number, y: number, time: number, fx = x / 1000, fy = y / 1000): Point => ({ fx, fy, x, y, time })
const enc = (ops: ReadonlyArray<SeqOp>): string => ops.map(encodeOp).join(";")
const opts = { timing: T, dragSpeed: 1 }

describe("classify", () => {
  it("is a click when the pointer stays within the slop", () => {
    expect(classify([pt(100, 100, 0), pt(104, 103, 10), pt(102, 100, 20)], 6)).toBe("click")
    expect(classify([pt(100, 100, 0), pt(106, 100, 20)], 6)).toBe("click")
  })
  it("is a drag once the pointer left the slop, even if it came back", () => {
    expect(classify([pt(100, 100, 0), pt(110, 100, 10), pt(100, 100, 20)], 6)).toBe("drag")
  })
})

describe("click", () => {
  const g: Gesture = { kind: "press", source: 1, button: 1, points: [pt(500, 250, 0, 0.5, 0.25), pt(501, 250, 80, 0.501, 0.25)] }

  it("replays one click per target in the given order, then restores pointer and focus", () => {
    expect(enc(buildScript(g, [2, 3], opts))).toBe(
      [
        "m 2 0.50000 0.25000;s 25;d 1;s 35;u 1;s 20",
        "m 3 0.50000 0.25000;s 25;d 1;s 35;u 1;s 20",
        "w 501 250;f 1",
      ].join(";"),
    )
  })

  it("never targets the source and returns nothing without targets", () => {
    expect(buildScript(g, [1], opts)).toEqual([])
    expect(buildScript(g, [], opts)).toEqual([])
    expect(enc(buildScript(g, [1, 4], opts))).toBe("m 4 0.50000 0.25000;s 25;d 1;s 35;u 1;s 20;w 501 250;f 1")
  })

  it("uses the gesture's button", () => {
    const right: Gesture = { ...g, button: 3 }
    expect(enc(buildScript(right, [2], opts))).toContain("d 3;s 35;u 3")
  })
})

describe("resample", () => {
  it("keeps first and last, drops points closer than minStep", () => {
    const pts = [pt(0, 0, 0), pt(1, 0, 3), pt(2, 0, 9), pt(3, 0, 12), pt(4, 0, 20), pt(5, 0, 22)]
    expect(resample(pts, 8).map((p) => p.time)).toEqual([0, 9, 22])
  })
  it("keeps the exact release point when it is too close to the previous kept point", () => {
    const pts = [pt(0, 0, 0), pt(10, 0, 10), pt(20, 0, 20), pt(21, 0, 23)]
    const r = resample(pts, 8)
    expect(r.map((p) => p.time)).toEqual([0, 10, 23])
    expect(r[r.length - 1]!.x).toBe(21)
  })
  it("leaves short inputs alone", () => {
    expect(resample([pt(0, 0, 0), pt(1, 1, 1)], 8)).toHaveLength(2)
  })
})

describe("drag", () => {
  // press, 3 motions, a 100 ms hold still, then release
  const points = [pt(100, 100, 1000), pt(120, 100, 1016), pt(140, 100, 1020), pt(160, 100, 1032), pt(160, 100, 1132)]
  const g: Gesture = { kind: "press", source: 7, button: 1, points }

  it("replays the path with original timing and keeps the final pause", () => {
    expect(enc(buildScript(g, [8], opts))).toBe(
      [
        "m 8 0.10000 0.10000;s 25;d 1;s 20",
        // 1020 is dropped (only 4 ms after 1016)
        "m 8 0.12000 0.10000;s 16",
        "m 8 0.16000 0.10000;s 100",
        "m 8 0.16000 0.10000",
        "u 1;s 30",
        "w 160 100;f 7",
      ].join(";"),
    )
  })

  it("divides deltas by dragSpeed and resamples so replay spacing stays >= 8 ms", () => {
    const ops = buildScript(g, [8], { timing: T, dragSpeed: 2 })
    const sleeps = ops.filter((o): o is Extract<SeqOp, { op: "s" }> => o.op === "s").map((o) => o.ms)
    // settle 25, press 20, path sleeps, after 30
    const pathSleeps = sleeps.slice(2, -1)
    expect(pathSleeps.at(-1)).toBe(50) // final 100 ms pause at 2x
    for (const ms of pathSleeps) expect(ms).toBeGreaterThanOrEqual(8)
  })

  it("slows down with dragSpeed < 1", () => {
    const ops = buildScript(g, [8], { timing: T, dragSpeed: 0.5 })
    expect(enc(ops)).toContain("m 8 0.16000 0.10000;s 200;m 8 0.16000 0.10000;u 1")
  })

  it("repeats the whole drag per target", () => {
    const enc2 = enc(buildScript(g, [8, 9], opts))
    expect(enc2.match(/d 1/g)).toHaveLength(2)
    expect(enc2.indexOf("m 9 ")).toBeGreaterThan(enc2.indexOf("u 1"))
    expect(enc2.endsWith("w 160 100;f 7")).toBe(true)
  })
})

describe("wheel", () => {
  const tick = (source: number, button: number, x: number, y: number): Gesture => ({
    kind: "wheel",
    source,
    button,
    at: pt(x, y, 0),
    count: 1,
  })

  it("replays n ticks per target", () => {
    const g: Gesture = { ...tick(1, 5, 300, 400), count: 3 } as Gesture
    expect(enc(buildScript(g, [2, 3], opts))).toBe(
      [
        "m 2 0.30000 0.40000;s 20;d 5;u 5;s 12;d 5;u 5;s 12;d 5;u 5;s 12",
        "m 3 0.30000 0.40000;s 20;d 5;u 5;s 12;d 5;u 5;s 12;d 5;u 5;s 12",
        "w 300 400;f 1",
      ].join(";"),
    )
  })

  it("coalesces consecutive ticks of the same button/window/position", () => {
    let q: Gesture[] = []
    q = enqueueCoalesced(q, tick(1, 4, 300, 400), T)
    q = enqueueCoalesced(q, tick(1, 4, 302, 401), T)
    q = enqueueCoalesced(q, tick(1, 4, 303, 401), T)
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ kind: "wheel", count: 3, at: { x: 303, y: 401 } })
  })

  it("does not coalesce across different button, window, position or an intervening gesture", () => {
    let q: Gesture[] = []
    q = enqueueCoalesced(q, tick(1, 4, 300, 400), T)
    q = enqueueCoalesced(q, tick(1, 5, 300, 400), T) // other direction
    q = enqueueCoalesced(q, tick(2, 5, 300, 400), T) // other window
    q = enqueueCoalesced(q, tick(2, 5, 400, 400), T) // moved
    q = enqueueCoalesced(q, { kind: "press", source: 2, button: 1, points: [pt(0, 0, 0)] }, T)
    q = enqueueCoalesced(q, tick(2, 5, 400, 400), T)
    expect(q.map((g) => g.kind)).toEqual(["wheel", "wheel", "wheel", "wheel", "press", "wheel"])
  })

  it("caps a coalesced gesture at wheelMaxTicks", () => {
    let q: Gesture[] = []
    for (let i = 0; i < T.wheelMaxTicks + 5; i++) q = enqueueCoalesced(q, tick(1, 4, 300, 400), T)
    expect(q).toHaveLength(2)
    expect(q.map((g) => (g.kind === "wheel" ? g.count : 0))).toEqual([T.wheelMaxTicks, 5])
  })
})

describe("keys", () => {
  it("focuses each target, types, then refocuses the source without warping", () => {
    const g: Gesture = {
      kind: "keys",
      source: 1,
      events: [
        { down: true, keycode: 38 },
        { down: false, keycode: 38 },
      ],
    }
    expect(enc(buildScript(g, [2, 3], opts))).toBe(
      "f 2;s 40;kd 38;s 8;ku 38;s 8;f 3;s 40;kd 38;s 8;ku 38;s 8;f 1",
    )
  })
})

describe("timeout estimate", () => {
  it("is the sleep total plus activation allowance plus slack", () => {
    const g: Gesture = { kind: "press", source: 1, button: 1, points: [pt(0, 0, 0)] }
    const ops = buildScript(g, [2], opts)
    // sleeps 25+35+20 = 80, one m onto a new window (200), d/u/w (3), f (200)
    expect(estimateDuration(ops, T)).toBe(80 + 200 + 3 + 200)
    expect(seqTimeout(ops, T)).toBe(80 + 200 + 3 + 200 + 3000)
  })
})

import { describe, expect, it } from "vitest"
import { encodeOp, type SeqOp } from "@shared/protocol"
import {
  DEFAULT_TIMING as T,
  buildScript,
  classify,
  drawDelay,
  drawShift,
  enqueueCoalesced,
  estimateDuration,
  randomInDisc,
  resample,
  seqTimeout,
  snapClickDelay,
  snapClickOffset,
  type Gesture,
  type Point,
} from "./script"

const pt = (x: number, y: number, time: number, fx = x / 1000, fy = y / 1000): Point => ({ fx, fy, x, y, time })
const enc = (ops: ReadonlyArray<SeqOp>): string => ops.map(encodeOp).join(";")
const opts = { timing: T }

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

  it("resamples so replay spacing stays >= dragMinStep", () => {
    const ops = buildScript(g, [8], opts)
    const sleeps = ops.filter((o): o is Extract<SeqOp, { op: "s" }> => o.op === "s").map((o) => o.ms)
    // settle 25, press 20, path sleeps, after 30
    const pathSleeps = sleeps.slice(2, -1)
    expect(pathSleeps).toEqual([16, 100])
    for (const ms of pathSleeps) expect(ms).toBeGreaterThanOrEqual(T.dragMinStep)
  })

  it("keeps a long hold between the press and the first motion", () => {
    const held: Gesture = { kind: "press", source: 7, button: 1, points: [pt(100, 100, 1000), pt(160, 100, 3000)] }
    expect(enc(buildScript(held, [8], opts))).toContain("d 1;s 2000;m 8 0.16000 0.10000;u 1")
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

describe("click offset", () => {
  const size = { w: 1000, h: 500 }
  const sizeOf = (): { w: number; h: number } => size
  const click: Gesture = { kind: "press", source: 1, button: 1, points: [pt(500, 250, 0, 0.5, 0.5), pt(500, 250, 50, 0.5, 0.5)] }
  const dragPts = [pt(100, 100, 0, 0.1, 0.2), pt(200, 100, 20, 0.2, 0.2), pt(300, 150, 40, 0.3, 0.3), pt(300, 150, 60, 0.3, 0.3)]
  const drag: Gesture = { kind: "press", source: 1, button: 1, points: dragPts }
  const wheel: Gesture = { kind: "wheel", source: 1, button: 4, at: pt(500, 250, 0, 0.5, 0.5), count: 1 }
  /** A deterministic rng that replays `vals` in a loop. */
  const seq = (...vals: number[]) => {
    let i = 0
    return () => vals[i++ % vals.length]!
  }
  const moves = (ops: ReadonlyArray<SeqOp>) => ops.filter((o): o is Extract<SeqOp, { op: "m" }> => o.op === "m")

  it("is off by default and at 0: output identical to no offset", () => {
    for (const g of [click, drag, wheel]) {
      const base = buildScript(g, [2, 3], opts)
      const rng = () => {
        throw new Error("rng must not be used when the offset is off")
      }
      expect(buildScript(g, [2, 3], { ...opts, clickOffset: 0, sizeOf, rng })).toEqual(base)
      expect(buildScript(g, [2, 3], { ...opts, sizeOf, rng })).toEqual(base)
    }
  })

  it("shifts a click by a random point inside the disc, converted with the target's size", () => {
    // rng 0.25, 0 -> r = 20 * sqrt(0.25) = 10 px, angle 0: 10 px right = 0.01 of a 1000 px wide window
    const ops = buildScript(click, [2], { ...opts, clickOffset: 20, sizeOf, rng: seq(0.25, 0) })
    expect(enc(ops)).toBe("m 2 0.51000 0.50000;s 25;d 1;s 35;u 1;s 20;w 500 250;f 1")
  })

  it("never leaves the radius", () => {
    let x = 0.123
    const rng = () => (x = (x * 9301 + 0.49297) % 1)
    for (const radius of [1, 5, 10, 15, 20]) {
      for (let i = 0; i < 500; i++) {
        const { dx, dy } = randomInDisc(radius, rng)
        expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(radius + 1e-9)
      }
      const ops = buildScript(click, [2, 3, 4], { ...opts, clickOffset: radius, sizeOf, rng })
      for (const o of moves(ops)) {
        expect(Math.hypot((o.fx - 0.5) * size.w, (o.fy - 0.5) * size.h)).toBeLessThanOrEqual(radius + 1e-9)
      }
    }
    // the edge of the disc is reachable: rng 1 -> full radius
    expect(Math.hypot(...Object.values(randomInDisc(20, () => 0.9999999)))).toBeCloseTo(20, 3)
  })

  it("moves every point of a drag by the same offset, so the drag keeps its shape", () => {
    const ops = buildScript(drag, [2], { ...opts, clickOffset: 20, sizeOf, rng: seq(0.25, 0.25) })
    // 10 px straight down -> +0.02 of a 500 px high window
    const ms = moves(ops)
    const path = [dragPts[0]!, dragPts[1]!, dragPts[2]!, dragPts[3]!]
    expect(ms).toHaveLength(path.length)
    ms.forEach((o, i) => {
      expect(o.fx).toBeCloseTo(path[i]!.fx, 9)
      expect(o.fy).toBeCloseTo(path[i]!.fy + 0.02, 9)
    })
    // timing is untouched
    expect(ops.filter((o) => o.op === "s")).toEqual(buildScript(drag, [2], opts).filter((o) => o.op === "s"))
  })

  it("shifts a wheel position too", () => {
    const ops = buildScript(wheel, [2], { ...opts, clickOffset: 20, sizeOf, rng: seq(0.25, 0) })
    expect(enc(ops)).toContain("m 2 0.51000 0.50000;s 20;d 4;u 4")
  })

  it("draws an independent offset per target, and never touches the source or the restore warp", () => {
    // target 2: rng 0.25, 0 -> +10 px x; target 3: rng 0.25, 0.5 -> -10 px x
    const ops = buildScript(click, [1, 2, 3], { ...opts, clickOffset: 20, sizeOf, rng: seq(0.25, 0, 0.25, 0.5) })
    const ms = moves(ops)
    expect(ms.map((o) => o.win)).toEqual([2, 3])
    expect(ms[0]!.fx).toBeCloseTo(0.51, 9)
    expect(ms[1]!.fx).toBeCloseTo(0.49, 9)
    expect(enc(ops).endsWith("w 500 250;f 1")).toBe(true)
  })

  it("draws a new offset for every gesture", () => {
    let n = 0
    const rng = () => [0.25, 0, 0.25, 0.5][n++ % 4]!
    const a = buildScript(click, [2], { ...opts, clickOffset: 20, sizeOf, rng })
    const b = buildScript(click, [2], { ...opts, clickOffset: 20, sizeOf, rng })
    expect(moves(a)[0]!.fx).not.toBeCloseTo(moves(b)[0]!.fx, 5)
  })

  it("keeps points that were inside the window inside it, and leaves outside points unclamped", () => {
    const edge: Gesture = {
      kind: "press",
      source: 1,
      button: 1,
      points: [pt(0, 0, 0, 0.995, 0.002), pt(100, 0, 20, 1.2, -0.1), pt(100, 0, 40, 1.2, -0.1)],
    }
    // 20 px at angle -pi/4 (rng 1-ish, 0.875): right and up
    const ops = buildScript(edge, [2], { ...opts, clickOffset: 20, sizeOf, rng: seq(0.9999999999, 0.875) })
    const [first, out] = moves(ops)
    expect(first!.fx).toBe(1) // 0.995 + 0.014 clamped
    expect(first!.fy).toBe(0) // 0.002 - 0.028 clamped
    expect(out!.fx).toBeCloseTo(1.2 + 20 * Math.SQRT1_2 / 1000, 6)
    expect(out!.fy).toBeCloseTo(-0.1 - 20 * Math.SQRT1_2 / 500, 6)
  })

  it("applies no offset when the target's size is unknown or zero", () => {
    const base = enc(buildScript(click, [2, 3, 4], opts))
    const sizes = new Map([
      [3, { w: 0, h: 500 }],
      [4, { w: 1000, h: 0 }],
    ])
    expect(enc(buildScript(click, [2, 3, 4], { ...opts, clickOffset: 20, sizeOf: (w) => sizes.get(w), rng: seq(0.5, 0.1) }))).toBe(base)
    expect(enc(buildScript(click, [2], { ...opts, clickOffset: 20, rng: seq(0.5, 0.1) }))).toBe(enc(buildScript(click, [2], opts)))
    expect(drawShift(20, undefined, Math.random)).toEqual({ dfx: 0, dfy: 0 })
  })

  it("snaps arbitrary values to the allowed list", () => {
    expect([0, 1, 5, 10, 15, 20].map(snapClickOffset)).toEqual([0, 1, 5, 10, 15, 20])
    expect([0.4, 0.6, 3, 3.1, 7.4, 12.6, 17.6, 25, 1e9, -1].map(snapClickOffset)).toEqual([0, 1, 1, 5, 5, 15, 20, 20, 20, 0])
    expect([Number.NaN, Infinity, "5", null, undefined].map(snapClickOffset)).toEqual([0, 0, 0, 0, 0])
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

describe("click delay", () => {
  const size = { w: 1000, h: 500 }
  const sizeOf = (): { w: number; h: number } => size
  const click: Gesture = { kind: "press", source: 1, button: 1, points: [pt(500, 250, 0, 0.5, 0.5), pt(500, 250, 50, 0.5, 0.5)] }
  const dragPts = [pt(100, 100, 0, 0.1, 0.2), pt(200, 100, 20, 0.2, 0.2), pt(300, 150, 40, 0.3, 0.3), pt(300, 150, 60, 0.3, 0.3)]
  const drag: Gesture = { kind: "press", source: 1, button: 1, points: dragPts }
  const wheel: Gesture = { kind: "wheel", source: 1, button: 4, at: pt(500, 250, 0, 0.5, 0.5), count: 2 }
  /** A deterministic rng that replays `vals` in a loop, recording how often it was called. */
  const seq = (...vals: number[]) => {
    const f = () => vals[f.calls++ % vals.length]!
    f.calls = 0
    return f
  }

  it("is off by default and at 0: output identical, rng never called", () => {
    const rng = () => {
      throw new Error("rng must not be used when offset and delay are off")
    }
    for (const g of [click, drag, wheel]) {
      const base = buildScript(g, [2, 3], opts)
      expect(buildScript(g, [2, 3], { ...opts, clickDelay: 0, rng })).toEqual(base)
      expect(enc(buildScript(g, [2, 3], { ...opts, clickDelay: 0, clickOffset: 0, sizeOf, rng }))).toBe(enc(base))
    }
  })

  it("pauses after warping onto each target (including the first), before its press", () => {
    // 100 ms max, rng 0.5 -> floor(0.5 * 101) = 50 ms; rng 0.25 -> 25 ms
    const ops = buildScript(click, [2, 3], { ...opts, clickDelay: 100, rng: seq(0.5, 0.25) })
    expect(enc(ops)).toBe(
      "m 2 0.50000 0.50000;s 50;s 25;d 1;s 35;u 1;s 20;m 3 0.50000 0.50000;s 25;s 25;d 1;s 35;u 1;s 20;w 500 250;f 1",
    )
  })

  it("applies to drags and wheels too, and never sits between a press and its release", () => {
    for (const g of [click, drag, wheel]) {
      const ops = buildScript(g, [2, 3, 4], { ...opts, clickDelay: 300, rng: seq(0.7) })
      const base = buildScript(g, [2, 3, 4], opts)
      expect(ops.length).toBe(base.length + 3)
      // remove the three delays (always right after a target's first m) -> exactly the base script
      // floor(0.7 * 301) = 210 ms, a value no other sleep of these gestures has
      const delayAt = ops.flatMap((o, i) => (o.op === "s" && o.ms === 210 ? [i] : []))
      expect(delayAt).toHaveLength(3)
      expect(ops.filter((_, i) => !delayAt.includes(i))).toEqual(base)
      for (const i of delayAt) {
        expect(ops[i - 1]).toMatchObject({ op: "m", win: [2, 3, 4][delayAt.indexOf(i)] })
        expect(ops[i - 2]?.op ?? "s").toBe("s") // that m is the target's first op
        const before = ops.slice(0, i).filter((o) => o.op === "d" || o.op === "u")
        const downs = before.filter((o) => o.op === "d").length
        const ups = before.filter((o) => o.op === "u").length
        expect(downs).toBe(ups) // no button held while pausing
      }
    }
  })

  it("puts the delay after the target's m, so a skipped previous window cannot swallow it", () => {
    // Helper skip mode ignores s until the next f/m/w. Simulate it: if window 2 is skipped,
    // everything up to the next m is ignored, and window 3's delay must still run.
    const ops = buildScript(click, [2, 3], { ...opts, clickDelay: 500, rng: seq(0.2, 0.6) })
    const executedSleeps: number[] = []
    let skipping = false
    for (const o of ops) {
      if (o.op === "m" || o.op === "f" || o.op === "w") skipping = o.op === "m" && o.win === 2
      else if (o.op === "s" && !skipping) executedSleeps.push(o.ms)
    }
    // floor(0.6 * 501) = 300: window 3's pause survives window 2 being skipped
    expect(executedSleeps).toEqual([300, 25, 35, 20])
  })

  it("respects the bounds: whole ms in [0, max], both ends reachable", () => {
    for (const max of [50, 100, 200, 300, 500]) {
      expect(drawDelay(max, () => 0)).toBe(0)
      expect(drawDelay(max, () => 0.9999999999)).toBe(max)
      let x = 0.321
      const rng = () => (x = (x * 9301 + 0.49297) % 1)
      for (let i = 0; i < 300; i++) {
        const d = drawDelay(max, rng)
        expect(Number.isInteger(d)).toBe(true)
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(max)
      }
    }
    expect(drawDelay(0, () => 0.5)).toBe(0)
    // a delay of 0 drawn is not emitted as an op
    expect(buildScript(click, [2], { ...opts, clickDelay: 500, rng: () => 0 })).toEqual(buildScript(click, [2], opts))
  })

  it("draws once per target per gesture, and nothing for the source", () => {
    const rng = seq(0.1, 0.2, 0.3)
    buildScript(click, [1, 2, 3, 4], { ...opts, clickDelay: 200, rng })
    expect(rng.calls).toBe(3)
    buildScript(wheel, [2, 3], { ...opts, clickDelay: 200, rng })
    expect(rng.calls).toBe(5)
  })

  it("with offset and delay on, each target draws its offset (radius, angle) then its delay", () => {
    // target 2: 0.25, 0 -> +10 px x; delay 0.5 -> 100 ms. target 3: 0.25, 0.5 -> -10 px x; delay 0.1 -> 20 ms
    const rng = seq(0.25, 0, 0.5, 0.25, 0.5, 0.1)
    const ops = buildScript(click, [2, 3], { ...opts, clickOffset: 20, clickDelay: 200, sizeOf, rng })
    expect(rng.calls).toBe(6)
    expect(enc(ops)).toBe(
      "m 2 0.51000 0.50000;s 100;s 25;d 1;s 35;u 1;s 20;m 3 0.49000 0.50000;s 20;s 25;d 1;s 35;u 1;s 20;w 500 250;f 1",
    )
    // a target without a known size draws no offset, only its delay
    const r2 = seq(0.5)
    buildScript(click, [2, 3], { ...opts, clickOffset: 20, clickDelay: 200, sizeOf: () => undefined, rng: r2 })
    expect(r2.calls).toBe(2)
  })

  it("is included in the seq timeout estimate", () => {
    const base = buildScript(click, [2, 3, 4], opts)
    const slow = buildScript(click, [2, 3, 4], { ...opts, clickDelay: 500, rng: () => 0.9999999 })
    expect(estimateDuration(slow, T) - estimateDuration(base, T)).toBe(1500)
    expect(seqTimeout(slow, T)).toBe(seqTimeout(base, T) + 1500)
  })

  it("snaps arbitrary values to the allowed list", () => {
    expect([0, 50, 100, 200, 300, 500].map(snapClickDelay)).toEqual([0, 50, 100, 200, 300, 500])
    expect([24, 25, 26, 75, 149, 150, 151, 250, 400, 401, 1e9, -1].map(snapClickDelay)).toEqual([
      0, 0, 50, 50, 100, 100, 200, 200, 300, 500, 500, 0,
    ])
    expect([Number.NaN, Infinity, "100", null, undefined].map(snapClickDelay)).toEqual([0, 0, 0, 0, 0])
  })
})

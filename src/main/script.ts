/**
 * Pure replay-script construction: recorded gestures -> helper `SeqOp[]`.
 * No Electron, no Effect, no I/O — everything here is unit-tested.
 */
import { CLICK_DELAYS, CLICK_OFFSETS } from "@shared/ipc"
import type { SeqOp, WindowId } from "@shared/protocol"

/** Every timing / threshold constant of the engine, in one place (ms / px). Overridable from config. */
export interface Timing {
  /** click: pause after warping onto the target before pressing. */
  readonly clickMoveSettle: number
  /** click: how long the button is held. */
  readonly clickHold: number
  /** click: pause after release before the next target. */
  readonly clickAfter: number
  /** drag: pause after warping onto the start point before pressing. */
  readonly dragMoveSettle: number
  /** drag: pause after pressing before the path starts. */
  readonly dragPressSettle: number
  /** drag: pause after release before the next target. */
  readonly dragAfter: number
  /** drag: minimum spacing (replay time) between path points. */
  readonly dragMinStep: number
  /** wheel: pause after warping before the first tick. */
  readonly wheelMoveSettle: number
  /** wheel: pause after each tick. */
  readonly wheelTickGap: number
  /** wheel: maximum ticks replayed for one coalesced wheel gesture. */
  readonly wheelMaxTicks: number
  /** Root-pixel radius within which a press/release counts as a click. Also used for wheel coalescing. */
  readonly clickSlop: number
  /** Gestures longer than this are discarded. */
  readonly maxGestureMs: number
  /** Added to the estimated script duration to get the `seq` timeout. */
  readonly seqTimeoutSlack: number
  /** Worst-case cost assumed for an op that may activate a window (`f`, or `m` onto a new window). */
  readonly activateCost: number
}

export const DEFAULT_TIMING: Timing = {
  clickMoveSettle: 25,
  clickHold: 35,
  clickAfter: 20,
  dragMoveSettle: 25,
  dragPressSettle: 20,
  dragAfter: 30,
  dragMinStep: 8,
  wheelMoveSettle: 20,
  wheelTickGap: 12,
  wheelMaxTicks: 60,
  clickSlop: 6,
  maxGestureMs: 20000,
  seqTimeoutSlack: 3000,
  activateCost: 200,
}

/** Snap any number to the nearest of `allowed` (ascending; non-numbers -> 0, ties -> the smaller). */
const snapTo = (allowed: ReadonlyArray<number>, v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0
  let best = allowed[0]!
  for (const o of allowed) if (Math.abs(o - v) < Math.abs(best - v)) best = o
  return best
}

/** Snap any number to the nearest allowed click offset (non-numbers -> 0, ties -> the smaller). */
export const snapClickOffset = (px: unknown): number => snapTo(CLICK_OFFSETS, px)

/** Snap any number to the nearest allowed click delay (non-numbers -> 0, ties -> the smaller). */
export const snapClickDelay = (ms: unknown): number => snapTo(CLICK_DELAYS, ms)

/** One recorded pointer sample (from a `btn` or `motion` helper message). */
export interface Point {
  readonly fx: number
  readonly fy: number
  /** Root pixels. */
  readonly x: number
  readonly y: number
  /** Monotonic ms. */
  readonly time: number
}

export type Gesture =
  /** Button 1–3 press … release. `points[0]` is the press, the last point the release. */
  | { readonly kind: "press"; readonly source: WindowId; readonly button: number; readonly points: ReadonlyArray<Point> }
  /** `count` wheel ticks of `button` (4–7) at one position. */
  | {
      readonly kind: "wheel"
      readonly source: WindowId
      readonly button: number
      readonly at: Point
      readonly count: number
    }

export type PressKind = "click" | "drag"

/** Click if the pointer never moved more than `slop` root pixels from the press point. */
export const classify = (points: ReadonlyArray<Point>, slop: number): PressKind => {
  const p0 = points[0]
  if (!p0) return "click"
  const s2 = slop * slop
  for (const p of points) {
    const dx = p.x - p0.x
    const dy = p.y - p0.y
    if (dx * dx + dy * dy > s2) return "drag"
  }
  return "click"
}

/**
 * Drop intermediate points so consecutive kept points are at least `minStep` ms apart
 * (in original time). The first and last points are always kept; if the last point is
 * too close to the previous kept one, that previous one is dropped instead (so the
 * release position stays exact and the final pause only grows).
 */
export const resample = (points: ReadonlyArray<Point>, minStep: number): ReadonlyArray<Point> => {
  if (points.length <= 2) return points
  const first = points[0]!
  const last = points[points.length - 1]!
  const out: Point[] = [first]
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!
    if (p.time - out[out.length - 1]!.time >= minStep) out.push(p)
  }
  if (out.length > 1 && last.time - out[out.length - 1]!.time < minStep) out.pop()
  out.push(last)
  return out
}

/** A shift of a whole gesture, as fractions of the target's content rect. */
export interface Shift {
  readonly dfx: number
  readonly dfy: number
}

export const NO_SHIFT: Shift = { dfx: 0, dfy: 0 }

/** A uniformly random point inside a disc of `radius` (pixels). */
export const randomInDisc = (radius: number, rng: () => number): { readonly dx: number; readonly dy: number } => {
  if (!(radius > 0)) return { dx: 0, dy: 0 }
  const r = radius * Math.sqrt(rng())
  const a = 2 * Math.PI * rng()
  return { dx: r * Math.cos(a), dy: r * Math.sin(a) }
}

/**
 * Draw one random click offset for a target window of content size `w`x`h` pixels,
 * converted to fractions. No offset when the radius is 0 or the size is unknown / empty.
 */
export const drawShift = (
  radius: number,
  size: { readonly w: number; readonly h: number } | undefined,
  rng: () => number,
): Shift => {
  if (!(radius > 0) || !size || !(size.w > 0) || !(size.h > 0)) return NO_SHIFT
  const { dx, dy } = randomInDisc(radius, rng)
  return { dfx: dx / size.w, dfy: dy / size.h }
}

/**
 * Draw one random pause for a target window: uniform over the whole milliseconds
 * `0..max` (both ends included). One rng draw when `max > 0`, none otherwise.
 */
export const drawDelay = (max: number, rng: () => number): number => {
  if (!(max > 0)) return 0
  return Math.min(max, Math.floor(rng() * (Math.floor(max) + 1)))
}

/** Shift one coordinate; a point that was inside the window (0..1) stays inside it. */
const shiftAxis = (f: number, d: number): number => {
  if (d === 0) return f
  const v = f + d
  return f >= 0 && f <= 1 ? Math.min(1, Math.max(0, v)) : v
}

const s = (ms: number): SeqOp => ({ op: "s", ms })
const m = (win: WindowId, p: { readonly fx: number; readonly fy: number }, sh: Shift): SeqOp => ({
  op: "m",
  win,
  fx: shiftAxis(p.fx, sh.dfx),
  fy: shiftAxis(p.fy, sh.dfy),
})

export const clickOps = (target: WindowId, button: number, at: Point, t: Timing, sh: Shift = NO_SHIFT): SeqOp[] => [
  m(target, at, sh),
  s(t.clickMoveSettle),
  { op: "d", button },
  s(t.clickHold),
  { op: "u", button },
  s(t.clickAfter),
]

/**
 * Drag replay for one target. `path` must already be resampled. Between consecutive
 * points the original delta is slept — including the hold between the press and the first
 * motion, and the pause between the last motion and the release, which governs fling
 * inertia. The whole path is moved by `sh`, so the drag keeps its shape.
 */
export const dragOps = (
  target: WindowId,
  button: number,
  path: ReadonlyArray<Point>,
  t: Timing,
  sh: Shift = NO_SHIFT,
): SeqOp[] => {
  const p0 = path[0]
  if (!p0) return []
  // Hold after the press for the recorded press-to-first-motion delay (at least the settle),
  // so a long press before moving is preserved.
  const p1 = path[1]
  const hold = p1 ? Math.max(t.dragPressSettle, p1.time - p0.time) : t.dragPressSettle
  const ops: SeqOp[] = [m(target, p0, sh), s(t.dragMoveSettle), { op: "d", button }, s(hold)]
  for (let i = 1; i < path.length; i++) {
    const p = path[i]!
    ops.push(m(target, p, sh))
    const next = path[i + 1]
    if (next) ops.push(s(next.time - p.time))
  }
  ops.push({ op: "u", button }, s(t.dragAfter))
  return ops
}

export const wheelOps = (
  target: WindowId,
  button: number,
  at: Point,
  count: number,
  t: Timing,
  sh: Shift = NO_SHIFT,
): SeqOp[] => {
  const ops: SeqOp[] = [m(target, at, sh), s(t.wheelMoveSettle)]
  for (let i = 0; i < count; i++) ops.push({ op: "d", button }, { op: "u", button }, s(t.wheelTickGap))
  return ops
}

export interface ScriptOptions {
  readonly timing: Timing
  /** Click offset radius in pixels (0 / omitted = every target gets the exact same spot). */
  readonly clickOffset?: number
  /** Current content-rect size of each target, needed to turn the pixel offset into fractions. */
  readonly sizeOf?: (win: WindowId) => { readonly w: number; readonly h: number } | undefined
  /** Maximum random pause in ms before replaying into each target (0 / omitted = no pause). */
  readonly clickDelay?: number
  /** Uniform [0, 1) random source (default `Math.random`). */
  readonly rng?: () => number
}

/**
 * Insert a target's random pause into its ops, directly after the target's first op (the
 * `m` that warps onto it), before anything is pressed. Not before the `m`: in the helper's
 * skip mode (previous target vanished / could not be activated) every `s` is ignored until
 * the next `f`/`m`/`w`, so a pause placed in front of the `m` would be swallowed. After the
 * `m` it can only be skipped together with its own target, which is then not replayed at all.
 */
const withDelay = (ops: SeqOp[], ms: number): SeqOp[] => (ms > 0 && ops.length > 0 ? [ops[0]!, s(ms), ...ops.slice(1)] : ops)

/** Where the user's pointer was when the gesture ended (root pixels). */
const restorePoint = (g: Gesture): Point | undefined =>
  g.kind === "press" ? g.points[g.points.length - 1] : g.at

/**
 * Full replay script for `targets` (already filtered: included, not the source, in index
 * order). Each target gets its own random click offset (see `ScriptOptions.clickOffset`)
 * and its own random pause (see `ScriptOptions.clickDelay`, placement: `withDelay`).
 *
 * Random draws, per target in target order: first the offset (2 draws, only when the offset
 * is on and the target's size is known: radius, then angle), then the delay (1 draw, only
 * when the delay is on). With both off the rng is never called.
 *
 * Ends with a warp back to the user's pointer position and re-focusing the source. Empty
 * when there is nothing to do.
 */
export const buildScript = (g: Gesture, targets: ReadonlyArray<WindowId>, opts: ScriptOptions): SeqOp[] => {
  const t = opts.timing
  const ts = targets.filter((w) => w !== 0 && w !== g.source)
  if (ts.length === 0) return []
  const radius = opts.clickOffset ?? 0
  const rng = opts.rng ?? Math.random
  const maxDelay = opts.clickDelay ?? 0
  const shiftFor = (w: WindowId): Shift => (radius > 0 ? drawShift(radius, opts.sizeOf?.(w), rng) : NO_SHIFT)
  /** Ops for one target: draws its offset, then its delay (that order, see above). */
  const forTarget = (w: WindowId, build: (sh: Shift) => SeqOp[]): SeqOp[] => {
    const sh = shiftFor(w)
    return withDelay(build(sh), drawDelay(maxDelay, rng))
  }
  const ops: SeqOp[] = []
  switch (g.kind) {
    case "press": {
      if (g.points.length === 0) return []
      if (classify(g.points, t.clickSlop) === "click") {
        const at = g.points[0]!
        for (const w of ts) ops.push(...forTarget(w, (sh) => clickOps(w, g.button, at, t, sh)))
      } else {
        const path = resample(g.points, t.dragMinStep)
        for (const w of ts) ops.push(...forTarget(w, (sh) => dragOps(w, g.button, path, t, sh)))
      }
      break
    }
    case "wheel": {
      const n = Math.min(Math.max(0, Math.floor(g.count)), t.wheelMaxTicks)
      if (n === 0) return []
      for (const w of ts) ops.push(...forTarget(w, (sh) => wheelOps(w, g.button, g.at, n, t, sh)))
      break
    }
  }
  const back = restorePoint(g)
  if (back) ops.push({ op: "w", x: back.x, y: back.y })
  ops.push({ op: "f", win: g.source })
  return ops
}

/** Rough upper estimate of how long the helper needs for `ops` (ms). */
export const estimateDuration = (ops: ReadonlyArray<SeqOp>, t: Timing): number => {
  let total = 0
  let lastWin: WindowId | null = null
  for (const o of ops) {
    switch (o.op) {
      case "s":
        total += Math.max(0, o.ms)
        break
      case "f":
        total += t.activateCost
        lastWin = o.win
        break
      case "m":
        total += o.win === lastWin ? 1 : t.activateCost
        lastWin = o.win
        break
      default:
        total += 1
    }
  }
  return Math.ceil(total)
}

/** `seq` timeout for a script: estimated duration + slack. */
export const seqTimeout = (ops: ReadonlyArray<SeqOp>, t: Timing): number => estimateDuration(ops, t) + t.seqTimeoutSlack

const near = (a: Point, b: Point, slop: number): boolean => {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy <= slop * slop
}

/**
 * Append `g` to a queue of waiting gestures, merging it into the last waiting gesture
 * when both are wheel ticks of the same button in the same source window at roughly
 * the same position. Returns a new array.
 */
export const enqueueCoalesced = (
  waiting: ReadonlyArray<Gesture>,
  g: Gesture,
  t: Timing,
): Gesture[] => {
  const last = waiting[waiting.length - 1]
  if (
    g.kind === "wheel" &&
    last?.kind === "wheel" &&
    last.source === g.source &&
    last.button === g.button &&
    near(last.at, g.at, t.clickSlop) &&
    last.count + g.count <= t.wheelMaxTicks
  ) {
    return [...waiting.slice(0, -1), { ...last, at: g.at, count: last.count + g.count }]
  }
  return [...waiting, g]
}

/**
 * Pure replay-script construction: recorded gestures -> helper `SeqOp[]`.
 * No Electron, no Effect, no I/O — everything here is unit-tested.
 */
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
  /** keys: pause after focusing a target. */
  readonly keyFocusSettle: number
  /** keys: pause after each key event. */
  readonly keyGap: number
  /** keys: flush the key buffer after this long without key events (and no keys held). */
  readonly keyIdleFlush: number
  /** keys: drop the buffer when it would grow beyond this many events. */
  readonly keyMaxBuffer: number
  /** keys: drop the buffer if keys stay "held" without any event for this long. */
  readonly keyStuckTimeout: number
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
  keyFocusSettle: 40,
  keyGap: 8,
  keyIdleFlush: 350,
  keyMaxBuffer: 200,
  keyStuckTimeout: 5000,
  clickSlop: 6,
  maxGestureMs: 20000,
  seqTimeoutSlack: 3000,
  activateCost: 200,
}

export const MIN_DRAG_SPEED = 0.25
export const MAX_DRAG_SPEED = 4

export const clampDragSpeed = (speed: number): number =>
  Number.isFinite(speed) ? Math.min(MAX_DRAG_SPEED, Math.max(MIN_DRAG_SPEED, speed)) : 1

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

export interface KeyEvent {
  readonly down: boolean
  readonly keycode: number
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
  /** A burst of typing in `source`. */
  | { readonly kind: "keys"; readonly source: WindowId; readonly events: ReadonlyArray<KeyEvent> }

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

const s = (ms: number): SeqOp => ({ op: "s", ms })
const m = (win: WindowId, p: { readonly fx: number; readonly fy: number }): SeqOp => ({ op: "m", win, fx: p.fx, fy: p.fy })

export const clickOps = (target: WindowId, button: number, at: Point, t: Timing): SeqOp[] => [
  m(target, at),
  s(t.clickMoveSettle),
  { op: "d", button },
  s(t.clickHold),
  { op: "u", button },
  s(t.clickAfter),
]

/**
 * Drag replay for one target. `path` must already be resampled. Between consecutive
 * points the original delta divided by `speed` is slept — including the hold between the
 * press and the first motion, and the pause between the last motion and the release, which
 * governs fling inertia.
 */
export const dragOps = (
  target: WindowId,
  button: number,
  path: ReadonlyArray<Point>,
  speed: number,
  t: Timing,
): SeqOp[] => {
  const p0 = path[0]
  if (!p0) return []
  // Hold after the press for the recorded press-to-first-motion delay (at least the settle),
  // so a long press before moving is preserved.
  const p1 = path[1]
  const hold = p1 ? Math.max(t.dragPressSettle, (p1.time - p0.time) / speed) : t.dragPressSettle
  const ops: SeqOp[] = [m(target, p0), s(t.dragMoveSettle), { op: "d", button }, s(hold)]
  for (let i = 1; i < path.length; i++) {
    const p = path[i]!
    ops.push(m(target, p))
    const next = path[i + 1]
    if (next) ops.push(s((next.time - p.time) / speed))
  }
  ops.push({ op: "u", button }, s(t.dragAfter))
  return ops
}

export const wheelOps = (target: WindowId, button: number, at: Point, count: number, t: Timing): SeqOp[] => {
  const ops: SeqOp[] = [m(target, at), s(t.wheelMoveSettle)]
  for (let i = 0; i < count; i++) ops.push({ op: "d", button }, { op: "u", button }, s(t.wheelTickGap))
  return ops
}

export const keyOps = (target: WindowId, events: ReadonlyArray<KeyEvent>, t: Timing): SeqOp[] => {
  const ops: SeqOp[] = [{ op: "f", win: target }, s(t.keyFocusSettle)]
  for (const e of events) ops.push({ op: e.down ? "kd" : "ku", keycode: e.keycode }, s(t.keyGap))
  return ops
}

export interface ScriptOptions {
  readonly timing: Timing
  readonly dragSpeed: number
}

/** Where the user's pointer was when the gesture ended (root pixels), if it is a pointer gesture. */
const restorePoint = (g: Gesture): Point | undefined => {
  switch (g.kind) {
    case "press":
      return g.points[g.points.length - 1]
    case "wheel":
      return g.at
    case "keys":
      return undefined
  }
}

/**
 * Full replay script for `targets` (already filtered: included, not the source, in index
 * order). Ends with a warp back to the user's pointer position (pointer gestures) and
 * re-focusing the source. Empty when there is nothing to do.
 */
export const buildScript = (g: Gesture, targets: ReadonlyArray<WindowId>, opts: ScriptOptions): SeqOp[] => {
  const t = opts.timing
  const ts = targets.filter((w) => w !== 0 && w !== g.source)
  if (ts.length === 0) return []
  const ops: SeqOp[] = []
  switch (g.kind) {
    case "press": {
      if (g.points.length === 0) return []
      if (classify(g.points, t.clickSlop) === "click") {
        const at = g.points[0]!
        for (const w of ts) ops.push(...clickOps(w, g.button, at, t))
      } else {
        const speed = clampDragSpeed(opts.dragSpeed)
        const path = resample(g.points, t.dragMinStep * speed)
        for (const w of ts) ops.push(...dragOps(w, g.button, path, speed, t))
      }
      break
    }
    case "wheel": {
      const n = Math.min(Math.max(0, Math.floor(g.count)), t.wheelMaxTicks)
      if (n === 0) return []
      for (const w of ts) ops.push(...wheelOps(w, g.button, g.at, n, t))
      break
    }
    case "keys": {
      if (g.events.length === 0) return []
      for (const w of ts) ops.push(...keyOps(w, g.events, t))
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

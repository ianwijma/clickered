/**
 * The replication engine: group tracking, gesture recording, the replay queue,
 * picking — driven by helper messages and renderer commands. All observable state lives
 * in one `SubscriptionRef<Model>`; every change is pushed to the renderer as an
 * `AppState` snapshot (coalesced + deduplicated).
 */
import { Cause, Duration, Effect, Queue, Scope, Stream, SubscriptionRef, Exit } from "effect"
import type { AppState, GroupWindow, IpcCommand } from "@shared/ipc"
import { PROTOCOL_VERSION, type HelperMessage, type HelperWindow, type WindowId } from "@shared/protocol"
import { timingOf, type ConfigStore } from "./config"
import { superviseHelper, type Helper, type HelperSpawnOptions } from "./helper"
import {
  buildScript,
  classify,
  enqueueCoalesced,
  seqTimeout,
  snapClickDelay,
  snapClickOffset,
  type Gesture,
  type Point,
  type Timing,
} from "./script"

// ---------------------------------------------------------------------------
// Model (pure)

export interface Model {
  readonly enabled: boolean
  readonly helper: AppState["helper"]
  readonly helperError: string | null
  readonly picking: boolean
  /** The group: windows the user picked one by one. Ids vanish when their window closes. */
  readonly members: ReadonlySet<WindowId>
  /** Latest full client list from the helper. */
  readonly allWindows: ReadonlyArray<HelperWindow>
  /** Window ids the user excluded (everything else is included by default). */
  readonly excluded: ReadonlySet<WindowId>
  readonly masterMode: AppState["masterMode"]
  readonly masterId: WindowId | null
  readonly clickOffset: number
  readonly clickDelay: number
  readonly hotkey: string
  readonly busy: boolean
}

export interface IndexedWindow extends HelperWindow {
  readonly index: number
}

/** Open windows of the group, 1-based index ordered by x then y. */
export const groupWindows = (m: Model): ReadonlyArray<IndexedWindow> => {
  if (m.members.size === 0) return []
  return m.allWindows
    .filter((w) => m.members.has(w.id))
    .slice()
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id - b.id)
    .map((w, i) => ({ ...w, index: i + 1 }))
}

const included = (m: Model, id: WindowId): boolean => !m.excluded.has(id)

/** Can `win` be the source of a gesture right now? */
export const isSource = (m: Model, win: WindowId): boolean => {
  if (win === 0) return false
  if (m.masterMode === "pinned" && m.masterId !== win) return false
  return groupWindows(m).some((w) => w.id === win && w.mapped && included(m, w.id))
}

/** Replay targets for a gesture from `source`, in index order. */
export const targetsFor = (m: Model, source: WindowId): ReadonlyArray<WindowId> =>
  groupWindows(m)
    .filter((w) => w.id !== source && w.mapped && included(m, w.id))
    .map((w) => w.id)

/** The ids that define "the group" for abort-on-change purposes. */
const groupKey = (m: Model): string =>
  groupWindows(m)
    .filter((w) => w.mapped && included(m, w.id))
    .map((w) => w.id)
    .sort((a, b) => a - b)
    .join(",")

export const toAppState = (m: Model): AppState => ({
  enabled: m.enabled,
  helper: m.helper,
  helperError: m.helperError,
  picking: m.picking,
  groupClass: m.members.size > 0 ? "picked" : null,
  groupLabel: groupWindows(m)[0]?.title ?? null,
  windows: groupWindows(m).map(
    (w): GroupWindow => ({
      id: w.id,
      index: w.index,
      title: w.title,
      included: included(m, w.id),
      isMaster: m.masterId === w.id,
    }),
  ),
  masterMode: m.masterMode,
  masterId: m.masterId,
  clickOffset: m.clickOffset,
  clickDelay: m.clickDelay,
  hotkey: m.hotkey,
  busy: m.busy,
})

/** Apply a new client list: prune exclusions, fix up the master. */
export const applyWindows = (m: Model, list: ReadonlyArray<HelperWindow>): Model => {
  const ids = new Set(list.map((w) => w.id))
  const groupIds = new Set([...m.members].filter((id) => ids.has(id)))
  const excluded = new Set([...m.excluded].filter((id) => ids.has(id)))
  let { masterMode, masterId } = m
  if (masterId !== null && !groupIds.has(masterId)) {
    masterMode = "auto"
    masterId = null
  }
  return { ...m, allWindows: list, members: groupIds, excluded, masterMode, masterId }
}

// ---------------------------------------------------------------------------
// Engine

export interface EngineOptions {
  readonly config: ConfigStore
  readonly helper: HelperSpawnOptions
  /** Called with every (deduplicated, coalesced) state snapshot. */
  readonly onState: (state: AppState) => void
  /**
   * Called synchronously right before a replay starts (true) and after it ends (false),
   * without the debounce `onState` has, so the bar can get out of the way in time.
   */
  readonly onReplay?: (active: boolean) => void
  /** Windows that start out in the group (tests; normally the user picks them). */
  readonly initialMembers?: ReadonlyArray<WindowId>
  /** Start with replication switched on (default true). */
  readonly enabledOnStart?: boolean
  /** Random source for click offsets and delays (tests; default `Math.random`). */
  readonly rng?: () => number
}

export interface Engine {
  getState(): AppState
  command(cmd: IpcCommand): void
  /** Hotkey: flip `enabled`. */
  toggleEnabled(): void
  /** Stop everything (helper included). */
  shutdown(): Promise<void>
}

interface Recording {
  readonly source: WindowId
  readonly button: number
  readonly points: Point[]
}

const log = (msg: string): Effect.Effect<void> => Effect.sync(() => console.log(`[clickered] ${msg}`))

export const startEngine = (opts: EngineOptions): Engine => {
  const scope = Scope.makeUnsafe()
  const cfg = opts.config.get()
  const timing: Timing = timingOf(cfg)

  const setup = Effect.gen(function* () {
    const model = yield* SubscriptionRef.make<Model>({
      enabled: opts.enabledOnStart ?? true,
      helper: "starting",
      helperError: null,
      picking: false,
      members: new Set(opts.initialMembers ?? []),
      allWindows: [],
      excluded: new Set(),
      masterMode: "auto",
      masterId: null,
      clickOffset: cfg.clickOffset,
      clickDelay: cfg.clickDelay,
      hotkey: cfg.hotkey,
      busy: false,
    })
    const get = (): Model => SubscriptionRef.getUnsafe(model)
    const update = (f: (m: Model) => Model): Effect.Effect<void> => SubscriptionRef.update(model, f)

    let helper: Helper | null = null
    let rec: Recording | null = null
    let waiting: Gesture[] = []
    /** Window id from a `picked` whose class we did not know yet (waiting for a `windows`). */
    let pickedUnknown: WindowId | null = null

    const wake = yield* Queue.sliding<true>(1)

    const send = (cmd: Parameters<Helper["send"]>[0]): Effect.Effect<void> =>
      Effect.suspend(() => (helper ? helper.send(cmd) : Effect.void))

    // --- push snapshots to the renderer --------------------------------------------
    yield* SubscriptionRef.changes(model).pipe(
      Stream.map(toAppState),
      Stream.debounce(Duration.millis(16)),
      Stream.map((s) => [s, JSON.stringify(s)] as const),
      Stream.changesWith((a, b) => a[1] === b[1]),
      Stream.runForEach(([s]) => Effect.sync(() => opts.onState(s))),
      Effect.forkScoped,
    )

    // --- queue / replay ------------------------------------------------------------
    /** Drop everything waiting and abort the running seq. */
    const abortAll = (why: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const hadWork = waiting.length > 0 || get().busy
        waiting = []
        if (get().busy) yield* send({ c: "abort" })
        if (hadWork) yield* log(`replay aborted: ${why}`)
      })

    const enqueue = (g: Gesture): Effect.Effect<void> =>
      Effect.sync(() => {
        waiting = enqueueCoalesced(waiting, g, timing)
        Queue.offerUnsafe(wake, true)
      })

    const replay = (g: Gesture): Effect.Effect<void> =>
      Effect.gen(function* () {
        const m = get()
        const h = helper
        if (!m.enabled || !h || m.helper !== "ready" || m.picking) return
        // The source may have been excluded or un-pinned while the gesture was queued.
        if (!isSource(m, g.source)) return
        const sizes = new Map(m.allWindows.map((w) => [w.id, w] as const))
        const ops = buildScript(g, targetsFor(m, g.source), {
          timing,
          clickOffset: m.clickOffset,
          clickDelay: m.clickDelay,
          sizeOf: (id) => sizes.get(id),
          ...(opts.rng ? { rng: opts.rng } : {}),
        })
        if (ops.length === 0) return
        yield* Effect.sync(() => opts.onReplay?.(true))
        yield* update((s) => ({ ...s, busy: true }))
        yield* h.runSeq(ops, seqTimeout(ops, timing)).pipe(
          Effect.catchTags({
            SeqTimeout: (e) => log(`seq ${e.id} timed out after ${e.ms} ms`),
            HelperGone: (e) => log(`seq lost: ${e.message}`),
            SeqEscaped: () => pauseOnEscape,
          }),
          Effect.asVoid,
          Effect.ensuring(
            update((s) => ({ ...s, busy: false })).pipe(Effect.andThen(Effect.sync(() => opts.onReplay?.(false)))),
          ),
        )
      })

    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(wake)
        for (let g = waiting.shift(); g; g = waiting.shift()) yield* replay(g)
      }),
    ).pipe(Effect.forkScoped)

    // --- mouse recording -----------------------------------------------------------
    const canRecord = (m: Model): boolean => m.enabled && m.helper === "ready" && !m.picking && m.members.size > 0

    const onBtn = (e: Extract<HelperMessage, { t: "btn" }>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const m = get()
        if (!canRecord(m)) {
          rec = null
          return
        }
        const p: Point = { fx: e.fx, fy: e.fy, x: e.x, y: e.y, time: e.time }
        if (e.button >= 1 && e.button <= 3) {
          if (e.down) {
            // A press for the button we are already tracking means its release was never
            // reported (the helper drops input during and just after a replay): start over.
            if (rec && (e.button === rec.button || e.time - rec.points[0]!.time > timing.maxGestureMs)) rec = null
            if (rec || m.busy || !isSource(m, e.win)) return
            rec = { source: e.win, button: e.button, points: [p] }
            if (m.masterMode === "auto" && m.masterId !== e.win) yield* update((s) => ({ ...s, masterId: e.win }))
          } else if (rec && e.button === rec.button) {
            const r = rec
            rec = null
            r.points.push(p)
            const first = r.points[0]!
            if (p.time - first.time > timing.maxGestureMs) return yield* log("gesture too long; discarded")
            yield* log(`${classify(r.points, timing.clickSlop)} b${r.button} from ${r.source}`)
            yield* enqueue({ kind: "press", source: r.source, button: r.button, points: r.points })
          }
          return
        }
        if (e.button >= 4 && e.button <= 7 && e.down) {
          if (rec && e.time - rec.points[0]!.time > timing.maxGestureMs) rec = null
          if (rec || m.busy || !isSource(m, e.win)) return
          if (m.masterMode === "auto" && m.masterId !== e.win) yield* update((s) => ({ ...s, masterId: e.win }))
          yield* enqueue({ kind: "wheel", source: e.win, button: e.button, at: p, count: 1 })
        }
      })

    const onMotion = (e: Extract<HelperMessage, { t: "motion" }>): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!rec || e.win !== rec.source) return
        if (!canRecord(get())) {
          rec = null
          return
        }
        if (e.time - rec.points[0]!.time > timing.maxGestureMs) {
          rec = null
          return yield* log("gesture too long; discarded")
        }
        rec.points.push({ fx: e.fx, fy: e.fy, x: e.x, y: e.y, time: e.time })
      })

    // --- group / pick --------------------------------------------------------------
    const clearGroup: Effect.Effect<void> = Effect.gen(function* () {
      yield* abortAll("group cleared")
      rec = null
      yield* update((s) => ({ ...s, members: new Set<WindowId>(), excluded: new Set<WindowId>(), masterMode: "auto", masterId: null }))
    })

    /** Is this one of our own windows (the bar)? Clicking it while picking means "done". */
    const isOwnWindow = (w: HelperWindow): boolean => w.pid === process.pid || w.cls.toLowerCase() === "clickered"

    /**
     * A window was clicked while picking: toggle its membership. Returns "unknown" when the
     * window is not in the client list yet, "done" when the click means picking is over.
     */
    const togglePicked = (win: WindowId): Effect.Effect<"toggled" | "unknown" | "done"> =>
      Effect.gen(function* () {
        const w = get().allWindows.find((x) => x.id === win)
        if (!w) return "unknown"
        if (isOwnWindow(w)) return "done"
        yield* update((s) => {
          const members = new Set(s.members)
          if (members.has(win)) members.delete(win)
          else members.add(win)
          const excluded = new Set(s.excluded)
          excluded.delete(win)
          // The first window picked becomes the source; the crown in the list changes it.
          if (s.members.size === 0 && members.size === 1) return { ...s, members, excluded, masterMode: "pinned", masterId: win }
          const lostMaster = s.masterId !== null && !members.has(s.masterId)
          return { ...s, members, excluded, ...(lostMaster ? { masterMode: "auto" as const, masterId: null } : {}) }
        })
        yield* log(`${get().members.has(win) ? "added" : "removed"} window ${win} (${w.title})`)
        return "toggled"
      })

    /** After a pick click was handled: keep picking, or finish. */
    const afterPick = (r: "toggled" | "unknown" | "done"): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (r === "done" || !get().picking) return yield* update((s) => ({ ...s, picking: false }))
        yield* send({ c: "pick" })
      })

    /** Run `f` and abort replay if it changed the effective group. */
    const guardGroup = <A>(f: Effect.Effect<A>): Effect.Effect<A> =>
      Effect.gen(function* () {
        const before = groupKey(get())
        const a = yield* f
        if (groupKey(get()) !== before) yield* abortAll("group membership changed")
        // Excluding a window or pinning another master can make an in-progress recording's
        // source ineligible without changing the group itself; forget what it recorded.
        if (rec && !isSource(get(), rec.source)) rec = null
        return a
      })

    const onMessage = (msg: HelperMessage): Effect.Effect<void> => {
      switch (msg.t) {
        case "ready":
          return Effect.gen(function* () {
            yield* log(`helper ready (protocol v${msg.version})`)
            if (msg.version !== PROTOCOL_VERSION)
              yield* log(`warning: helper speaks protocol v${msg.version}, expected v${PROTOCOL_VERSION}; rebuild it`)
            yield* update((s) => ({ ...s, helper: "ready", helperError: null }))
          })
        case "windows":
          return Effect.gen(function* () {
            yield* guardGroup(update((s) => applyWindows(s, msg.list)))
            if (pickedUnknown !== null) {
              const win = pickedUnknown
              pickedUnknown = null
              const r = yield* togglePicked(win)
              if (r === "unknown") yield* log(`picked window ${win} not in client list`)
              yield* afterPick(r)
            }
          })
        case "btn":
          return onBtn(msg)
        case "motion":
          return onMotion(msg)
        case "picked":
          return Effect.gen(function* () {
            // 0 = right-click / Done: picking is over. Otherwise toggle the window and keep
            // picking until the user finishes.
            if (msg.win === 0 || !get().picking) return yield* update((s) => ({ ...s, picking: false }))
            const r = yield* togglePicked(msg.win)
            if (r === "unknown") {
              pickedUnknown = msg.win
              return yield* send({ c: "list" })
            }
            yield* afterPick(r)
          })
        case "esc":
          // Panic key. Only acts when a replay is running or queued: stop it and pause, so
          // nothing else gets replicated until the user switches back to Live.
          // (A replay that the helper already aborted may have finished by now; runSeq
          // reports that case as SeqEscaped.)
          return Effect.gen(function* () {
            if (!get().busy && waiting.length === 0) return
            yield* pauseOnEscape
          })
        case "done":
          return Effect.void
        case "error":
          return Effect.gen(function* () {
            yield* log(`helper error: ${msg.msg}`)
            // Before `ready` an error is something the user has to fix while the helper
            // waits (e.g. the macOS Accessibility permission): show it until `ready`
            // clears it. Later errors (a rejected command) are only logged.
            if (get().helper === "starting") yield* update((s) => ({ ...s, helperError: msg.msg }))
          })
      }
    }

    // --- helper supervision --------------------------------------------------------
    const resetTransient = Effect.gen(function* () {
      helper = null
      rec = null
      waiting = []
      pickedUnknown = null
      yield* update((s) => ({ ...s, busy: false, picking: false }))
    })

    yield* superviseHelper({
      spawn: opts.helper,
      onStart: (h) =>
        Effect.gen(function* () {
          helper = h
          yield* log(`helper started (pid ${h.pid ?? "?"})`)
          yield* update((s) => ({ ...s, helper: "starting", helperError: null }))
          yield* Effect.addFinalizer(() => resetTransient)
          yield* Effect.forever(Queue.take(h.messages).pipe(Effect.flatMap(onMessage))).pipe(Effect.forkScoped)
        }),
      onDown: (reason, final) =>
        Effect.gen(function* () {
          yield* log(`helper down: ${reason}${final ? " (giving up)" : ""}`)
          yield* resetTransient
          yield* update((s) => ({
            ...s,
            helper: "error",
            helperError: final ? `${reason} — gave up restarting` : `${reason} — restarting…`,
          }))
        }),
    }).pipe(Effect.forkScoped)

    // --- commands ------------------------------------------------------------------
    const setEnabled = (on: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!on) {
          yield* abortAll("disabled")
          rec = null
        }
        yield* update((s) => ({ ...s, enabled: on }))
      })

    /** Escape during a replay: drop the queue and switch to Paused (once). */
    const pauseOnEscape: Effect.Effect<void> = Effect.suspend(() => {
      if (!get().enabled) return Effect.void
      return log("Escape pressed during replay: stopping and pausing").pipe(Effect.andThen(setEnabled(false)))
    })

    const command = (cmd: IpcCommand): Effect.Effect<void> => {
      switch (cmd.c) {
        case "setEnabled":
          return setEnabled(cmd.enabled)
        case "startPick":
          return Effect.gen(function* () {
            const m = get()
            if (m.picking || m.helper !== "ready") return
            yield* abortAll("picking")
            rec = null
            yield* update((s) => ({ ...s, picking: true }))
            yield* send({ c: "pick" })
          })
        case "cancelPick":
          return Effect.gen(function* () {
            // "Done". Flip the flag first so a click still in flight does not restart the pick.
            if (!get().picking) return
            yield* update((s) => ({ ...s, picking: false }))
            if (helper && get().helper === "ready") yield* send({ c: "pickcancel" })
          })
        case "clearGroup":
          return clearGroup
        case "setIncluded":
          return guardGroup(
            update((s) => {
              const ex = new Set(s.excluded)
              if (cmd.included) ex.delete(cmd.id)
              else ex.add(cmd.id)
              return { ...s, excluded: ex }
            }),
          )
        case "setMaster":
          return guardGroup(
            update((s) => {
              if (cmd.id === null) return { ...s, masterMode: "auto" }
              if (!groupWindows(s).some((w) => w.id === cmd.id)) return s
              const ex = new Set(s.excluded)
              ex.delete(cmd.id)
              return { ...s, masterMode: "pinned", masterId: cmd.id, excluded: ex }
            }),
          )
        case "setClickOffset":
          return Effect.gen(function* () {
            const px = snapClickOffset(cmd.px)
            yield* update((s) => ({ ...s, clickOffset: px }))
            opts.config.update({ clickOffset: px })
          })
        case "setClickDelay":
          return Effect.gen(function* () {
            const ms = snapClickDelay(cmd.ms)
            yield* update((s) => ({ ...s, clickDelay: ms }))
            opts.config.update({ clickDelay: ms })
          })
        case "setSize":
        case "quit":
          return Effect.void // window concerns, handled by index.ts
      }
    }

    return {
      get,
      command,
      toggle: Effect.suspend(() => setEnabled(!get().enabled)),
    }
  })

  const inner = Effect.runSync(Scope.provide(setup, scope))
  const run = (eff: Effect.Effect<void>): void => {
    Effect.runFork(
      eff.pipe(Effect.catchCause((c) => (Cause.hasInterruptsOnly(c) ? Effect.void : Effect.logError(Cause.pretty(c))))),
    )
  }

  let stopped: Promise<void> | null = null
  return {
    getState: () => toAppState(inner.get()),
    command: (cmd) => run(inner.command(cmd)),
    toggleEnabled: () => run(inner.toggle),
    shutdown: () => (stopped ??= Effect.runPromise(Scope.close(scope, Exit.void))),
  }
}

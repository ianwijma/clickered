/**
 * The native X11 helper as a scoped resource.
 *
 * `spawnHelper` starts the process; closing the scope closes its stdin (which makes the
 * helper release anything held and exit) and SIGKILLs it if it has not exited shortly
 * after. `superviseHelper` keeps one running, restarting it (bounded) when it dies.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { createInterface } from "node:readline"
import { Cause, Data, Deferred, Duration, Effect, Exit, Queue, Scope } from "effect"
import { encodeCommand, type HelperCommand, type HelperMessage, type SeqOp } from "@shared/protocol"

export class HelperSpawnError extends Data.TaggedError("HelperSpawnError")<{ readonly message: string }> {}
export class HelperGone extends Data.TaggedError("HelperGone")<{ readonly message: string }> {}
export class SeqTimeout extends Data.TaggedError("SeqTimeout")<{ readonly id: number; readonly ms: number }> {}

export interface Helper {
  /** Every parsed stdout message, in order (`done` messages included). */
  readonly messages: Queue.Dequeue<HelperMessage>
  /** Write one command line. Silently dropped if the process is gone. */
  readonly send: (cmd: HelperCommand) => Effect.Effect<void>
  /**
   * Run a `seq` and wait for its `done` (true = ok). On timeout an `abort` is sent.
   */
  readonly runSeq: (ops: ReadonlyArray<SeqOp>, timeoutMs: number) => Effect.Effect<boolean, HelperGone | SeqTimeout>
  /** Completes with a human-readable reason when the process exits. */
  readonly exited: Effect.Effect<string>
  readonly pid: number | undefined
}

export interface HelperSpawnOptions {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly env?: NodeJS.ProcessEnv
  /** Free-form stderr lines (diagnostics). */
  readonly onStderr?: (line: string) => void
  /** How long to wait for a clean exit after closing stdin before SIGKILL. */
  readonly killAfterMs?: number
}

/** Every helper process still running; SIGKILLed if the host process exits abruptly. */
const live = new Set<ChildProcess>()
process.once("exit", () => {
  for (const cp of live) cp.kill("SIGKILL")
})

const KNOWN = new Set(["ready", "windows", "btn", "motion", "key", "esc", "picked", "done", "error"])

/** Parse one stdout line; null for anything that is not a recognisable message. */
export const parseHelperLine = (line: string): HelperMessage | null => {
  const s = line.trim()
  if (!s.startsWith("{")) return null
  try {
    const v: unknown = JSON.parse(s)
    if (typeof v !== "object" || v === null) return null
    const t = (v as { t?: unknown }).t
    if (typeof t !== "string" || !KNOWN.has(t)) return null
    if (t === "windows" && !Array.isArray((v as { list?: unknown }).list)) return null
    return v as HelperMessage
  } catch {
    return null
  }
}

export const spawnHelper = (opts: HelperSpawnOptions): Effect.Effect<Helper, HelperSpawnError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.try({
      try: () => accessSync(opts.command, constants.X_OK),
      catch: () => new HelperSpawnError({ message: `helper binary not found or not executable: ${opts.command}` }),
    })

    const messages = yield* Queue.unbounded<HelperMessage>()
    const exitedD = yield* Deferred.make<string>()
    const pending = new Map<number, Deferred.Deferred<boolean, HelperGone>>()
    let nextId = 1
    let alive = true

    const child = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          spawn(opts.command, [...(opts.args ?? [])], {
            stdio: ["pipe", "pipe", "pipe"],
            env: opts.env ?? process.env,
          }),
        catch: (e) => new HelperSpawnError({ message: `failed to start helper: ${String(e)}` }),
      }),
      (cp) =>
        Effect.gen(function* () {
          if (!alive) return
          cp.stdin.end()
          const exitedInTime = yield* Deferred.await(exitedD).pipe(Effect.timeoutOption(opts.killAfterMs ?? 1000))
          if (exitedInTime._tag === "None" && alive) cp.kill("SIGKILL")
        }),
    )

    live.add(child)
    const markExited = (reason: string): void => {
      if (!alive) return
      alive = false
      live.delete(child)
      Deferred.doneUnsafe(exitedD, Exit.succeed(reason))
      for (const d of pending.values()) Deferred.doneUnsafe(d, Exit.fail(new HelperGone({ message: reason })))
      pending.clear()
    }

    child.on("error", (e) => markExited(`helper process error: ${e.message}`))
    child.on("exit", (code, signal) =>
      markExited(signal ? `helper killed by ${signal}` : `helper exited with code ${code ?? "?"}`),
    )
    child.stdin.on("error", () => {
      /* EPIPE when the helper died; reported via "exit" */
    })

    createInterface({ input: child.stdout }).on("line", (line) => {
      const msg = parseHelperLine(line)
      if (!msg) return
      if (msg.t === "done") {
        const d = pending.get(msg.id)
        if (d) {
          pending.delete(msg.id)
          Deferred.doneUnsafe(d, Exit.succeed(msg.ok))
        }
      }
      Queue.offerUnsafe(messages, msg)
    })
    createInterface({ input: child.stderr }).on("line", (line) => opts.onStderr?.(line))

    const writeLine = (cmd: HelperCommand): void => {
      if (!alive || !child.stdin.writable) return
      child.stdin.write(encodeCommand(cmd) + "\n")
    }

    const send = (cmd: HelperCommand): Effect.Effect<void> => Effect.sync(() => writeLine(cmd))

    const runSeq = (ops: ReadonlyArray<SeqOp>, timeoutMs: number): Effect.Effect<boolean, HelperGone | SeqTimeout> =>
      Effect.suspend(() => {
        if (!alive) return Effect.fail(new HelperGone({ message: "helper not running" }))
        const id = nextId++
        const d = Deferred.makeUnsafe<boolean, HelperGone>()
        pending.set(id, d)
        writeLine({ c: "seq", id, ops })
        return Deferred.await(d).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(Math.max(1, timeoutMs)),
            orElse: () =>
              Effect.sync(() => writeLine({ c: "abort" })).pipe(
                Effect.andThen(Effect.fail(new SeqTimeout({ id, ms: timeoutMs }))),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        )
      })

    return {
      messages,
      send,
      runSeq,
      exited: Deferred.await(exitedD),
      pid: child.pid,
    } satisfies Helper
  })

export interface SuperviseOptions {
  readonly spawn: HelperSpawnOptions
  /** Called (within the helper's scope) once the process is spawned. Fibers forked with
   *  `Effect.forkScoped` here are interrupted when the helper goes away. */
  readonly onStart: (helper: Helper) => Effect.Effect<void, never, Scope.Scope>
  /** Called with a reason when the helper failed to start or exited. `final` = no more retries. */
  readonly onDown: (reason: string, final: boolean) => Effect.Effect<void>
  readonly maxRestarts?: number
  readonly restartDelayMs?: number
  /** A helper that ran at least this long resets the restart budget. */
  readonly healthyAfterMs?: number
}

/** Keep the helper running. Never fails; returns once the restart budget is exhausted. */
export const superviseHelper = (o: SuperviseOptions): Effect.Effect<void> =>
  Effect.gen(function* () {
    const maxRestarts = o.maxRestarts ?? 5
    const delay = o.restartDelayMs ?? 2000
    const healthy = o.healthyAfterMs ?? 30_000
    let failures = 0
    for (;;) {
      const started = Date.now()
      const reason = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* spawnHelper(o.spawn)
          yield* o.onStart(h)
          return yield* h.exited
        }),
      ).pipe(Effect.catchTag("HelperSpawnError", (e) => Effect.succeed(e.message)))
      failures = Date.now() - started >= healthy ? 1 : failures + 1
      const final = failures > maxRestarts
      yield* o.onDown(reason, final)
      if (final) return
      yield* Effect.sleep(Duration.millis(delay * failures))
    }
  }).pipe(Effect.catchCause((c) => (Cause.hasInterruptsOnly(c) ? Effect.interrupt : Effect.logError(Cause.pretty(c)))))

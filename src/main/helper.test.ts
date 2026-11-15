import { Effect, Exit, Queue, Scope } from "effect"
import { describe, expect, it } from "vitest"
import { PROTOCOL_VERSION, type HelperMessage } from "@shared/protocol"
import { parseHelperLine, spawnHelper, superviseHelper } from "./helper"
import { fakeHelper } from "./__fixtures__/fake"

const takeUntil = (q: Queue.Dequeue<HelperMessage>, t: HelperMessage["t"]) =>
  Effect.gen(function* () {
    for (;;) {
      const m = yield* Queue.take(q)
      if (m.t === t) return m
    }
  }).pipe(Effect.timeout(2000))

const waitFor = async (pred: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timed out waiting")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("parseHelperLine", () => {
  it("parses known messages and rejects everything else", () => {
    expect(parseHelperLine('{"t":"done","id":3,"ok":true}')).toEqual({ t: "done", id: 3, ok: true })
    expect(parseHelperLine('  {"t":"ready","version":2}  ')).toEqual({ t: "ready", version: 2 })
    expect(parseHelperLine("garbage")).toBeNull()
    expect(parseHelperLine("{not json")).toBeNull()
    expect(parseHelperLine('{"t":"bogus"}')).toBeNull()
    expect(parseHelperLine('{"t":"windows"}')).toBeNull()
    // Keyboard replication was removed in protocol v2.
    expect(parseHelperLine('{"t":"key","down":true,"keycode":38,"win":1,"time":0}')).toBeNull()
    expect(parseHelperLine("null")).toBeNull()
  })
})

describe("spawnHelper (fake helper)", () => {
  it("streams messages, runs seqs and closes stdin on scope close", async () => {
    const fake = fakeHelper({ FAKE_WINDOWS: JSON.stringify([{ id: 5, title: "a", cls: "c", pid: 1, x: 0, y: 0, w: 1, h: 1, mapped: true }]) })
    const scope = Scope.makeUnsafe()
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const h = yield* spawnHelper(fake.opts)
        const ready = yield* takeUntil(h.messages, "ready")
        const wins = yield* takeUntil(h.messages, "windows")
        const ok = yield* h.runSeq([{ op: "m", win: 5, fx: 0.5, fy: 0.5 }, { op: "s", ms: 10 }], 2000)
        yield* h.send({ c: "list" })
        yield* takeUntil(h.messages, "windows")
        return { ready, wins, ok }
      }).pipe(Scope.provide(scope)),
    )
    expect(result.ready).toEqual({ t: "ready", version: PROTOCOL_VERSION })
    expect(result.wins.t === "windows" && result.wins.list[0]?.id).toBe(5)
    expect(result.ok).toBe(true)
    expect(fake.log()).toEqual(["seq 1 m 5 0.50000 0.50000;s 10", "list"])
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await waitFor(() => fake.log().includes("EOF"))
  })

  it("times out a seq and sends abort", async () => {
    const fake = fakeHelper({ FAKE_SEQ_HANG: "1" })
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* spawnHelper(fake.opts)
          return yield* Effect.exit(h.runSeq([{ op: "s", ms: 1 }], 100))
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("SeqTimeout")
    expect(fake.log()).toContain("abort")
  })

  it("fails a seq with SeqEscaped when Escape aborted it", async () => {
    const fake = fakeHelper({ FAKE_ESC_ON_SEQ: "20" })
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* spawnHelper(fake.opts)
          return yield* Effect.exit(h.runSeq([{ op: "s", ms: 1 }], 5000))
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain("SeqEscaped")
  })

  it("fails pending seqs with HelperGone when the process exits", async () => {
    const fake = fakeHelper({ FAKE_SEQ_HANG: "1", FAKE_EXIT_AFTER: "100" })
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* spawnHelper(fake.opts)
          const exit = yield* Effect.exit(h.runSeq([{ op: "s", ms: 1 }], 5000))
          const reason = yield* h.exited
          return { exit, reason }
        }),
      ),
    )
    expect(JSON.stringify(out.exit)).toContain("HelperGone")
    expect(out.reason).toBe("helper exited with code 3")
  })

  it("lets a helper exit cleanly on stdin EOF instead of killing it", async () => {
    const fake = fakeHelper({})
    const scope = Scope.makeUnsafe()
    const exited = await Effect.runPromise(
      Effect.gen(function* () {
        const h = yield* spawnHelper({ ...fake.opts, killAfterMs: 5000 })
        yield* takeUntil(h.messages, "ready")
        return h.exited
      }).pipe(Scope.provide(scope)),
    )
    const started = Date.now()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    // Closing the scope waited for the exit (well inside killAfterMs) and did not kill.
    expect(await Effect.runPromise(exited)).toBe("helper exited with code 0")
    expect(Date.now() - started).toBeLessThan(4000)
    expect(fake.log()).toContain("EOF")
  })

  it("SIGKILLs a helper that ignores stdin EOF", async () => {
    const fake = fakeHelper({ FAKE_IGNORE_EOF: "1" })
    let pid: number | undefined
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* spawnHelper(fake.opts)
          pid = h.pid
          yield* takeUntil(h.messages, "ready")
        }),
      ),
    )
    expect(pid).toBeDefined()
    await waitFor(() => {
      try {
        process.kill(pid!, 0)
        return false
      } catch {
        return true
      }
    })
  })

  it("reports a missing binary as HelperSpawnError", async () => {
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(spawnHelper({ command: "/nonexistent/clickered-helper" }))))
    expect(JSON.stringify(exit)).toContain("not found")
  })
})

describe("superviseHelper", () => {
  it("retries a bounded number of times and then gives up", async () => {
    const downs: Array<[string, boolean]> = []
    await Effect.runPromise(
      superviseHelper({
        spawn: { command: "/nonexistent/clickered-helper" },
        onStart: () => Effect.void,
        onDown: (reason, final) => Effect.sync(() => downs.push([reason, final])),
        maxRestarts: 2,
        restartDelayMs: 5,
      }),
    )
    expect(downs.map((d) => d[1])).toEqual([false, false, true])
    expect(downs[0]![0]).toContain("not found")
  })

  it("restarts a helper that exits", async () => {
    const fake = fakeHelper({ FAKE_EXIT_AFTER: "50" })
    let starts = 0
    await Effect.runPromise(
      superviseHelper({
        spawn: fake.opts,
        onStart: () => Effect.sync(() => void starts++),
        onDown: () => Effect.void,
        maxRestarts: 1,
        restartDelayMs: 5,
      }),
    )
    expect(starts).toBe(2)
  })
})

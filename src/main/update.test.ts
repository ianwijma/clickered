import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { UpdateState } from "@shared/ipc"
import { GITHUB_POLICY, githubEndpoints, type Target } from "./update-core"
import {
  ChecksumError,
  cleanDownloads,
  MAX_ATTEMPTS,
  retryDelay,
  InstallError,
  openUrl,
  readBody,
  startUpdater,
  type AfterInstall,
  type HttpClient,
  type HttpResponse,
  type InstallRequest,
  type Updater,
  type UpdaterDeps,
} from "./update"

// ---------------------------------------------------------------------------
// A fake GitHub

interface Route {
  readonly status?: number
  readonly location?: string
  readonly body?: Uint8Array | string
  /** Override Content-Length (null = none). */
  readonly contentLength?: number | null
  /** Never answer (tests the headers timeout). */
  readonly hang?: boolean
  /** Stop sending after this many bytes, without ending (tests the idle timeout). */
  readonly stallAfter?: number
}

const fakeHttp = (routes: Record<string, Route>) => {
  const requested: string[] = []
  const http: HttpClient = {
    get: (url, _headers, signal) => {
      requested.push(url)
      const r = routes[url]
      if (!r) return Promise.resolve(resp(404, null, new Uint8Array(), null))
      if (r.hang)
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))
      const body = typeof r.body === "string" ? Buffer.from(r.body) : (r.body ?? new Uint8Array())
      return Promise.resolve(
        resp(r.status ?? 200, r.location ?? null, body, r.contentLength === undefined ? body.byteLength : r.contentLength, r.stallAfter),
      )
    },
  }
  return { http, requested }
}

const resp = (status: number, location: string | null, body: Uint8Array, contentLength: number | null, stallAfter?: number): HttpResponse => {
  let aborted: (() => void) | null = null
  return {
    status,
    location,
    contentLength,
    consume: (onChunk) =>
      new Promise((resolve, reject) => {
        aborted = () => reject(new Error("aborted"))
        let off = 0
        const step = (): void => {
          if (aborted === null) return
          if (stallAfter !== undefined && off >= stallAfter) return // hang
          if (off >= body.byteLength) return resolve()
          const end = Math.min(body.byteLength, off + 4096, stallAfter ?? Infinity)
          onChunk(body.subarray(off, end))
          off = end
          setImmediate(step)
        }
        setImmediate(step)
      }),
    abort: () => {
      const a = aborted
      aborted = null
      a?.()
    },
  }
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex")

const VERSION = "0.3.0"
const TAG = "v0.3.0"
const DEB = `clickered-${VERSION}-amd64.deb`
const PAYLOAD = Buffer.alloc(100_000, 7)
const e = githubEndpoints()
const CDN = "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=abc"
const CDN_SUMS = "https://release-assets.githubusercontent.com/github-production-release-asset/2?sig=abc"
const linux: Target = { platform: "linux", arch: "x64", rosetta: false }

const github = (
  o: { payload?: Buffer; sums?: string; digest?: string | null; sumsDigest?: string; release?: Record<string, unknown> } = {},
) => {
  const payload = o.payload ?? PAYLOAD
  const sums = o.sums ?? `${sha(PAYLOAD)}  ${DEB}\n${"c".repeat(64)}  clickered-${VERSION}-x64.exe\n`
  const digest = o.digest === undefined ? `sha256:${sha(PAYLOAD)}` : o.digest
  const release = {
    tag_name: TAG,
    draft: false,
    prerelease: false,
    assets: [
      { name: DEB, size: PAYLOAD.byteLength, state: "uploaded", digest },
      { name: "SHA256SUMS.txt", size: Buffer.byteLength(sums), state: "uploaded", ...(o.sumsDigest ? { digest: o.sumsDigest } : {}) },
    ],
    ...o.release,
  }
  return {
    [e.latest]: { body: JSON.stringify(release) },
    [e.download(TAG, DEB)]: { status: 302, location: CDN },
    [CDN]: { body: payload },
    [e.download(TAG, "SHA256SUMS.txt")]: { status: 302, location: CDN_SUMS },
    [CDN_SUMS]: { body: sums },
  } satisfies Record<string, Route>
}

// ---------------------------------------------------------------------------

let updaters: Updater[] = []
afterEach(() => {
  for (const u of updaters) u.shutdown()
  updaters = []
})

const setup = (
  routes: Record<string, Route>,
  over: Partial<UpdaterDeps> & { installResult?: Effect.Effect<AfterInstall, InstallError | ChecksumError> } = {},
) => {
  const root = join(mkdtempSync(join(tmpdir(), "clickered-upd-")), "updates")
  const states: UpdateState[] = []
  const installs: InstallRequest[] = []
  const after: string[] = []
  const logs: string[] = []
  const { http, requested } = fakeHttp(routes)
  const u = startUpdater(
    {
      currentVersion: "0.2.0",
      target: linux,
      endpoints: e,
      http,
      eligible: async () => ({ ok: true }),
      downloadRoot: root,
      install: (req) => {
        installs.push(req)
        return over.installResult ?? Effect.succeed({ kind: "relaunch" } as const)
      },
      afterInstall: (a) => after.push(a.kind),
      onState: (s) => states.push(s),
      log: (m) => logs.push(m),
      progressEveryMs: 0,
      timeouts: { headersMs: 200, idleMs: 200 },
      ...over,
    },
    { autoCheck: false },
  )
  updaters.push(u)
  return { u, root, states, installs, after, logs, requested }
}

describe("check", () => {
  it("offers a newer release", async () => {
    const { u, states } = setup(github())
    await u.check()
    expect(u.getState()).toEqual({ status: "available", version: VERSION })
    expect(states).toEqual([{ status: "available", version: VERSION }])
    await u.check() // the same offer again: no new push
    expect(states).toHaveLength(1)
  })

  it("stays silent when up to date, on HTTP errors, bad JSON, or when not eligible", async () => {
    const cases: Array<[Record<string, Route>, Partial<UpdaterDeps>]> = [
      [github(), { currentVersion: VERSION }],
      [github(), { currentVersion: "1.0.0" }],
      [{ [e.latest]: { status: 404, body: "Not Found" } }, {}], // private repo
      [{ [e.latest]: { status: 403, body: "rate limited" } }, {}],
      [{ [e.latest]: { body: "<html>" } }, {}],
      [{ [e.latest]: { hang: true } }, {}],
      [github(), { eligible: async () => ({ ok: false, why: "dev run" }) }],
      [github(), { eligible: () => Promise.reject(new Error("boom")) }],
      [github({ release: { prerelease: true } }), {}],
      [github(), { target: { platform: "linux", arch: "arm64", rosetta: false } }],
    ]
    for (const [routes, over] of cases) {
      const { u, states, logs } = setup(routes, over)
      await u.check()
      expect(u.getState()).toEqual({ status: "none" })
      expect(states).toEqual([])
      expect(logs.length).toBeGreaterThan(0)
    }
  })

  it("does not query GitHub when this copy cannot update itself", async () => {
    const { u, requested } = setup(github(), { eligible: async () => ({ ok: false, why: "dev run" }) })
    await u.check()
    expect(requested).toEqual([])
  })

  it("never follows a redirect off GitHub", async () => {
    const { u, requested } = setup({ [e.latest]: { status: 302, location: "https://evil.example/latest" } })
    await u.check()
    expect(u.getState()).toEqual({ status: "none" })
    expect(requested).toEqual([e.latest])
  })
})

describe("install", () => {
  it("downloads, verifies and installs: available → downloading → verifying → installing", async () => {
    const { u, states, installs, after, root, requested } = setup(github())
    await u.check()
    u.install()
    await u.idle()
    const statuses = states.map((s) => s.status)
    expect(statuses[0]).toBe("available")
    expect(statuses.slice(1, 3)).toEqual(["downloading", "downloading"])
    expect(statuses.slice(-2)).toEqual(["verifying", "installing"])
    const progress = states.flatMap((s) => (s.status === "downloading" ? [s.progress] : []))
    expect(progress[0]).toBe(0)
    expect(progress.at(-1)).toBe(1)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    // SHA256SUMS.txt before the package.
    expect(requested.indexOf(e.download(TAG, "SHA256SUMS.txt"))).toBeLessThan(requested.indexOf(e.download(TAG, DEB)))
    expect(installs).toHaveLength(1)
    const req = installs[0]!
    expect(req.version).toBe(VERSION)
    expect(req.file).toBe(join(req.dir, DEB))
    expect(req.dir.startsWith(root)).toBe(true)
    if (process.platform !== "win32") {
      // Node ignores POSIX modes on Windows.
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(req.dir).mode & 0o777).toBe(0o700)
      expect(statSync(req.file).mode & 0o777).toBe(0o600)
    }
    expect(after).toEqual(["relaunch"])
  })

  it("rejects a file that does not match SHA256SUMS.txt, and deletes it", async () => {
    const bad = Buffer.from(PAYLOAD)
    bad[5] = 9
    const routes = github({ payload: bad, digest: null })
    const { u, installs, root } = setup(routes)
    await u.check()
    u.install()
    await u.idle()
    const s = u.getState()
    expect(s.status === "failed" && [s.reason, s.message]).toEqual(["checksum", expect.stringMatching(/SHA256SUMS/)])
    expect(installs).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })

  it("rejects a file that matches SHA256SUMS.txt but not GitHub's digest", async () => {
    const { u, installs } = setup(github({ digest: `sha256:${"d".repeat(64)}` }))
    await u.check()
    u.install()
    await u.idle()
    const s = u.getState()
    expect(s.status === "failed" && s.reason).toBe("checksum")
    expect(installs).toEqual([])
  })

  it("fails on a release whose SHA256SUMS.txt lacks the file or is malformed", async () => {
    for (const sums of [`${"c".repeat(64)}  other.deb\n`, "<html>not sums</html>"]) {
      const { u, installs } = setup(github({ sums }))
      await u.check()
      u.install()
      await u.idle()
      const s = u.getState()
      expect(s.status === "failed" && s.reason).toBe("checksum")
      expect(installs).toEqual([])
    }
  })

  it("fails the download on a redirect to another host, a short or long body, or a stall", async () => {
    const variants: Array<Record<string, Route>> = [
      { ...github(), [e.download(TAG, DEB)]: { status: 302, location: "https://evil.example/x.deb" } },
      { ...github(), [e.download(TAG, DEB)]: { status: 302, location: "http://release-assets.githubusercontent.com/x" } },
      { ...github(), [CDN]: { body: PAYLOAD.subarray(0, 5000) } },
      { ...github(), [CDN]: { body: Buffer.concat([PAYLOAD, Buffer.alloc(10)]), contentLength: null } },
      { ...github(), [CDN]: { body: PAYLOAD, contentLength: PAYLOAD.byteLength + 1 } },
      { ...github(), [CDN]: { body: PAYLOAD, stallAfter: 8192 } },
      { ...github(), [CDN]: { status: 500 } },
    ]
    for (const routes of variants) {
      const { u, installs, root } = setup(routes)
      await u.check()
      u.install()
      await u.idle()
      const s = u.getState()
      expect(s.status === "failed" && s.reason).toBe("download")
      expect(installs).toEqual([])
      expect(readdirSync(root)).toEqual([])
    }
  })

  it("reports installer failures, and retries from the start", async () => {
    let fail = true
    const { u, installs, after, states } = setup(github(), {
      installResult: Effect.suspend(() =>
        fail ? Effect.fail(new InstallError({ message: "The password prompt was cancelled." })) : Effect.succeed({ kind: "relaunch" } as const),
      ),
    })
    await u.check()
    u.install()
    await u.idle()
    expect(u.getState()).toEqual({ status: "failed", version: VERSION, reason: "install", message: "The password prompt was cancelled." })
    fail = false
    u.install()
    await u.idle()
    expect(installs).toHaveLength(2)
    expect(installs[0]!.dir).not.toBe(installs[1]!.dir)
    expect(after).toEqual(["relaunch"])
    expect(states.filter((s) => s.status === "verifying")).toHaveLength(2)
  })

  it("shows a manual fallback as failed/install with its message", async () => {
    const { u, after } = setup(github(), {
      installResult: Effect.succeed({ kind: "manual", message: "The disk image was opened." } as const),
    })
    await u.check()
    u.install()
    await u.idle()
    expect(u.getState()).toEqual({ status: "failed", version: VERSION, reason: "install", message: "The disk image was opened." })
    expect(after).toEqual([])
  })

  it("ignores installUpdate unless available or failed (no double start)", async () => {
    const { u, installs, requested } = setup(github())
    u.install() // nothing offered yet
    await u.idle()
    expect(requested).toEqual([])
    await u.check()
    u.install()
    u.install()
    u.install()
    await u.idle()
    expect(installs).toHaveLength(1)
    u.install() // "installing": ignored
    await u.idle()
    expect(installs).toHaveLength(1)
  })

  it("does not let a re-check disturb a running install", async () => {
    const { u, installs } = setup(github())
    await u.check()
    u.install()
    await u.check()
    await u.idle()
    expect(installs).toHaveLength(1)
    expect(u.getState().status).toBe("installing")
  })

  it("waits for a running replay before installing", async () => {
    let busy = true
    const { u, installs } = setup(github(), { isBusy: () => busy })
    await u.check()
    u.install()
    await new Promise((r) => setTimeout(r, 300))
    expect(u.getState().status).toBe("verifying")
    expect(installs).toEqual([])
    busy = false
    await u.idle()
    expect(installs).toHaveLength(1)
  })
})

describe("re-hash before install (deterministic)", () => {
  it("catches a file changed after verification", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "clickered-upd-")), "updates")
    const installs: InstallRequest[] = []
    const { http } = fakeHttp(github())
    const u = startUpdater(
      {
        currentVersion: "0.2.0",
        target: linux,
        endpoints: e,
        http,
        eligible: async () => ({ ok: true }),
        downloadRoot: root,
        install: (req) => {
          installs.push(req)
          return Effect.succeed({ kind: "relaunch" } as const)
        },
        afterInstall: () => {},
        // Called once verification passed: swap the file under the updater.
        isBusy: () => {
          for (const d of readdirSync(root)) writeFileSync(join(root, d, DEB), "evil")
          return false
        },
        onState: () => {},
        log: () => {},
      },
      { autoCheck: false },
    )
    updaters.push(u)
    await u.check()
    u.install()
    await u.idle()
    const s = u.getState()
    expect(s.status === "failed" && [s.reason, s.message]).toEqual(["checksum", "the download changed after it was verified"])
    expect(installs).toEqual([])
  })
})

describe("openUrl / readBody", () => {
  const H = {}
  const T = { headersMs: 100, idleMs: 100 }
  it("follows at most 5 redirects, all on allowed hosts", async () => {
    const hop = (i: number) => `https://github.com/r/${i}`
    const routes: Record<string, Route> = {}
    for (let i = 0; i < 7; i++) routes[hop(i)] = { status: 302, location: `/r/${i + 1}` }
    routes[hop(5)] = { body: "ok" }
    const { http } = fakeHttp(routes)
    const res = await openUrl(http, hop(0), GITHUB_POLICY, H, T, new AbortController().signal)
    expect(res.status).toBe(200)
    routes[hop(5)] = { status: 302, location: `/r/6` }
    routes[hop(6)] = { body: "ok" }
    await expect(openUrl(http, hop(0), GITHUB_POLICY, H, T, new AbortController().signal)).rejects.toThrow(/too many redirects/)
  })

  it("times out a request that never answers", async () => {
    const { http } = fakeHttp({ "https://github.com/x": { hang: true } })
    await expect(openUrl(http, "https://github.com/x", GITHUB_POLICY, H, T, new AbortController().signal)).rejects.toThrow(/timed out/)
  })

  it("refuses a disallowed first URL without requesting it", async () => {
    const { http, requested } = fakeHttp({})
    await expect(openUrl(http, "http://github.com/x", GITHUB_POLICY, H, T, new AbortController().signal)).rejects.toThrow(/refusing/)
    expect(requested).toEqual([])
  })

  it("enforces the byte cap without a Content-Length", async () => {
    const r = resp(200, null, Buffer.alloc(10_000), null)
    await expect(readBody(r, { maxBytes: 5000, exactBytes: null }, 100, new AbortController().signal, () => {})).rejects.toThrow(/larger/)
  })
})

describe("cleanDownloads", () => {
  it("removes everything left in the download root", async () => {
    const root = mkdtempSync(join(tmpdir(), "clickered-upd-"))
    mkdirSync(join(root, "dl-1"))
    writeFileSync(join(root, "dl-1", "x.deb"), "x")
    writeFileSync(join(root, "stray"), "x")
    await cleanDownloads(root)
    expect(readdirSync(root)).toEqual([])
    await cleanDownloads(join(root, "missing")) // no error
    expect(existsSync(join(root, "missing"))).toBe(false)
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const failOnce = (msg = "The password prompt was cancelled.") => Effect.fail(new InstallError({ message: msg }))

describe("SHA256SUMS.txt digest (fix 4)", () => {
  it("accepts SHA256SUMS.txt matching its own GitHub digest", async () => {
    const sums = `${sha(PAYLOAD)}  ${DEB}\n`
    const { u, installs } = setup(github({ sums, sumsDigest: `sha256:${sha(Buffer.from(sums))}` }))
    await u.check()
    u.install()
    await u.idle()
    expect(installs).toHaveLength(1)
  })

  it("rejects SHA256SUMS.txt that differs from its GitHub digest, before downloading the package", async () => {
    const { u, installs, requested } = setup(github({ sumsDigest: `sha256:${"f".repeat(64)}` }))
    await u.check()
    u.install()
    await u.idle()
    const s = u.getState()
    expect(s.status === "failed" && [s.reason, s.message]).toEqual(["checksum", "SHA256SUMS.txt does not match GitHub's digest"])
    expect(installs).toEqual([])
    expect(requested).not.toContain(e.download(TAG, DEB))
  })
})

describe("replays (fix 3)", () => {
  it("fails with a try-again message instead of installing during a long replay", async () => {
    const { u, installs } = setup(github(), { isBusy: () => true, busyWaitMs: 150 })
    await u.check()
    u.install()
    await u.idle()
    expect(u.getState()).toEqual({
      status: "failed",
      version: VERSION,
      reason: "install",
      message: "A replay kept running; try again when it is done.",
    })
    expect(installs).toEqual([])
  })

  it("re-checks for a replay right before restarting", async () => {
    let busy = false
    const order: string[] = []
    const { u } = setup(github(), {
      isBusy: () => busy,
      install: () =>
        Effect.sync(() => {
          // A replay starts while the installer runs.
          busy = true
          setTimeout(() => {
            order.push("replay done")
            busy = false
          }, 150)
          return { kind: "relaunch" } as const
        }),
      afterInstall: () => order.push("relaunch"),
    })
    await u.check()
    u.install()
    await u.idle()
    expect(order).toEqual(["replay done", "relaunch"])
  })
})

describe("retry backoff and cap (fix 6)", () => {
  it("computes the delays", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => retryDelay(n))).toEqual([0, 0, 10_000, 30_000, 120_000, null, null])
    expect(MAX_ATTEMPTS).toBe(5)
  })

  it("delays retries, ignores clicks while waiting, and stops after the cap", async () => {
    const { u, installs, logs } = setup(github(), { installResult: failOnce(), retryDelaysMs: [0, 150, 150, 150] })
    await u.check()
    u.install() // attempt 1
    await u.idle()
    u.install() // attempt 2: no delay after the first failure
    await u.idle()
    expect(installs).toHaveLength(2)
    const t = Date.now()
    u.install() // attempt 3: waits 150 ms
    u.install() // ignored: already waiting
    u.install()
    expect(u.getState().status).toBe("downloading")
    await u.idle()
    expect(Date.now() - t).toBeGreaterThanOrEqual(140)
    expect(installs).toHaveLength(3)
    u.install()
    await u.idle()
    u.install()
    await u.idle()
    expect(installs).toHaveLength(5)
    const s = u.getState()
    expect(s.status === "failed" && s.message).toMatch(/No more attempts; restart Clickered/)
    u.install() // capped
    await u.idle()
    expect(installs).toHaveLength(5)
    expect(logs.some((l) => /no attempts left/.test(l))).toBe(true)
  })

  it("resets the count when a newer version is offered", async () => {
    const routes = github()
    const { u, installs } = setup(routes, { installResult: failOnce(), retryDelaysMs: [0, 0, 0, 0] })
    await u.check()
    for (let i = 0; i < 6; i++) {
      u.install()
      await u.idle()
    }
    expect(installs).toHaveLength(5)
    const next = "0.4.0"
    const deb4 = `clickered-${next}-amd64.deb`
    routes[e.latest] = {
      body: JSON.stringify({
        tag_name: `v${next}`,
        draft: false,
        prerelease: false,
        assets: [
          { name: deb4, size: 10, state: "uploaded" },
          { name: "SHA256SUMS.txt", size: 10, state: "uploaded" },
        ],
      }),
    }
    await u.check()
    expect(u.getState()).toEqual({ status: "available", version: next })
    u.install()
    await u.idle()
    expect(u.getState().status).toBe("failed") // the fake release has no files: a download failure
    expect(installs).toHaveLength(5)
  })
})

describe("critical sections (fix 2)", () => {
  it("criticalDone waits for a critical install step, which shutdown cannot interrupt", async () => {
    const steps: string[] = []
    const { u } = setup(github(), {
      install: (req) =>
        req.critical(
          Effect.gen(function* () {
            steps.push("rename 1")
            yield* Effect.sleep("150 millis")
            steps.push("rename 2")
            return { kind: "relaunch" } as const
          }),
        ),
    })
    await expect(u.criticalDone()).resolves.toBeUndefined() // nothing running
    await u.check()
    u.install()
    while (!steps.includes("rename 1")) await sleep(5)
    u.shutdown() // e.g. the app quitting
    let done = false
    void u.criticalDone().then(() => (done = true))
    await sleep(20)
    expect(done).toBe(false)
    await u.criticalDone()
    expect(steps).toEqual(["rename 1", "rename 2"])
  })
})

describe("startup cleanup hook (fix 5)", () => {
  it("asks before removing each entry, and keeps the ones it refuses", async () => {
    const root = mkdtempSync(join(tmpdir(), "clickered-upd-"))
    for (const n of ["dl-a", "dl-b"]) {
      mkdirSync(join(root, n, "mnt"), { recursive: true })
      writeFileSync(join(root, n, "x.dmg"), "x")
    }
    const asked: string[] = []
    await cleanDownloads(root, async (entry) => {
      asked.push(entry)
      return !entry.endsWith("dl-b")
    })
    expect(asked.sort()).toEqual([join(root, "dl-a"), join(root, "dl-b")])
    expect(readdirSync(root)).toEqual(["dl-b"])
    // A hook that throws keeps the entry too.
    await cleanDownloads(root, () => Promise.reject(new Error("hdiutil gone")))
    expect(readdirSync(root)).toEqual(["dl-b"])
  })

  it("runs on startup before the first check", async () => {
    const root = join(mkdtempSync(join(tmpdir(), "clickered-upd-")), "updates")
    mkdirSync(join(root, "dl-old"), { recursive: true })
    const order: string[] = []
    const { http } = fakeHttp({})
    const u = startUpdater({
      currentVersion: "0.2.0",
      target: linux,
      endpoints: e,
      http,
      eligible: async () => {
        order.push("check")
        return { ok: false, why: "test" }
      },
      downloadRoot: root,
      beforeClean: async (entry) => {
        order.push(`clean ${entry.slice(root.length + 1)}`)
        return true
      },
      install: () => Effect.succeed({ kind: "relaunch" } as const),
      afterInstall: () => {},
      onState: () => {},
      log: () => {},
    })
    updaters.push(u)
    const end = Date.now() + 2000
    while (order.length < 2 && Date.now() < end) await sleep(5)
    expect(order).toEqual(["clean dl-old", "check"])
    expect(existsSync(join(root, "dl-old"))).toBe(false)
  })
})


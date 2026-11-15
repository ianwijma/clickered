import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import type { UpdateSnapshot } from "@shared/ipc"
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
  type UpdateSettings,
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
  const states: UpdateSnapshot[] = []
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
    expect(u.getState()).toEqual({ status: "available", version: VERSION, prerelease: false })
    expect(u.getSnapshot()).toEqual({ status: "available", version: VERSION, prerelease: false, prereleases: false })
    expect(states).toEqual([{ status: "available", version: VERSION, prerelease: false, prereleases: false }])
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
    expect(u.getState()).toEqual({ status: "available", version: next, prerelease: false })
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


// ---------------------------------------------------------------------------
// Pre-release updates, skip, release notes

/** A release JSON for `tag` with a .deb and SHA256SUMS.txt (enough to be offered). */
const rel = (tag: string, o: { draft?: boolean; pre?: boolean } = {}) => {
  const version = tag.replace(/^v/, "")
  return {
    tag_name: tag,
    draft: o.draft ?? false,
    prerelease: o.pre ?? version.includes("-"),
    assets: [
      { name: `clickered-${version}-amd64.deb`, size: 10, state: "uploaded" },
      { name: "SHA256SUMS.txt", size: 10, state: "uploaded" },
    ],
  }
}
/** `releases/latest` answers v0.3.0 (the github() fake); the list adds whatever is given. */
const withList = (list: unknown[], base: Record<string, Route> = github()): Record<string, Route> => ({
  ...base,
  [e.releases]: { body: JSON.stringify(list) },
})
const RC = "0.4.0-rc.1"

const settingsSetup = (
  routes: Record<string, Route>,
  initial: UpdateSettings,
  over: Parameters<typeof setup>[1] = {},
) => {
  const saved: UpdateSettings[] = []
  const opened: string[] = []
  const r = setup(routes, {
    settings: initial,
    saveSettings: (s) => saved.push(s),
    openExternal: (url) => opened.push(url),
    ...over,
  })
  return { ...r, saved, opened }
}
const OFF: UpdateSettings = { prereleases: false, skipped: null }
const ON: UpdateSettings = { prereleases: true, skipped: null }

describe("pre-release updates", () => {
  it("off: only releases/latest is asked, a prerelease there is never offered", async () => {
    const { u, requested } = settingsSetup(withList([rel(`v${RC}`)]), OFF)
    await u.check()
    expect(u.getSnapshot()).toEqual({ status: "available", version: VERSION, prerelease: false, prereleases: false })
    expect(requested).toEqual([e.latest])

    const pre = settingsSetup(github({ release: { tag_name: `v${RC}`, prerelease: true } }), OFF)
    await pre.u.check()
    expect(pre.u.getState()).toEqual({ status: "none" })
  })

  it("on: the newest non-draft release from the list, prerelease or not", async () => {
    const { u, requested } = settingsSetup(withList([rel("v0.3.0"), rel(`v${RC}`), rel("v0.5.0", { draft: true })]), ON)
    await u.check()
    expect(u.getSnapshot()).toEqual({ status: "available", version: RC, prerelease: true, prereleases: true })
    expect(requested).toEqual([e.releases])

    const full = settingsSetup(withList([rel(`v${RC}`), rel("v0.4.0")]), ON)
    await full.u.check()
    expect(full.u.getState()).toEqual({ status: "available", version: "0.4.0", prerelease: false })
  })

  it("on: passes over the newest release when it has no file for this platform", async () => {
    const noDeb = { ...rel("v0.5.0-rc.1"), assets: [{ name: "SHA256SUMS.txt", size: 10, state: "uploaded" }] }
    const { u } = settingsSetup(withList([noDeb, rel(`v${RC}`)]), ON)
    await u.check()
    expect(u.getState()).toEqual({ status: "available", version: RC, prerelease: true })
  })

  it("running a prerelease with the setting off: stays on it, offered the next newer full release", async () => {
    const newer = settingsSetup(github(), OFF, { currentVersion: "0.3.0-rc.2" })
    await newer.u.check()
    expect(newer.u.getState()).toEqual({ status: "available", version: VERSION, prerelease: false })
    const older = settingsSetup(github(), OFF, { currentVersion: "0.3.1-rc.1" })
    await older.u.check()
    expect(older.u.getState()).toEqual({ status: "none" })
  })

  it("toggling saves, pushes the setting, and checks again at once", async () => {
    const { u, saved, states, requested } = settingsSetup(withList([rel(`v${RC}`)]), OFF)
    await u.check()
    states.length = 0
    await u.setPrereleases(true)
    expect(saved).toEqual([ON])
    expect(requested).toEqual([e.latest, e.releases])
    // The setting first (same state), then the prerelease offer.
    expect(states).toEqual([
      { status: "available", version: VERSION, prerelease: false, prereleases: true },
      { status: "available", version: RC, prerelease: true, prereleases: true },
    ])
    await u.setPrereleases(true) // no change: nothing saved, nothing asked
    expect(saved).toHaveLength(1)
    expect(requested).toHaveLength(2)
  })

  it("pushes the setting even when there is no offer (and when the check fails)", async () => {
    const { u, states, saved } = settingsSetup({ [e.latest]: { status: 404 }, [e.releases]: { status: 403 } }, OFF)
    await u.setPrereleases(true)
    expect(states).toEqual([{ status: "none", prereleases: true }])
    expect(saved).toEqual([ON])
  })

  it("turning it off withdraws a prerelease offer, even when the new check fails", async () => {
    const routes = withList([rel(`v${RC}`)])
    const { u, states } = settingsSetup(routes, ON)
    await u.check()
    expect(u.getState()).toEqual({ status: "available", version: RC, prerelease: true })
    routes[e.latest] = { status: 500 }
    await u.setPrereleases(false)
    expect(u.getSnapshot()).toEqual({ status: "none", prereleases: false })
    expect(states.at(-1)).toEqual({ status: "none", prereleases: false })
    // With a reachable GitHub, the full release is offered instead.
    routes[e.latest] = github()[e.latest]!
    await u.setPrereleases(true)
    await u.setPrereleases(false)
    expect(u.getState()).toEqual({ status: "available", version: VERSION, prerelease: false })
  })

  it("a check that started before the setting changed is discarded", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const routes = withList([rel(`v${RC}`)])
    const base = fakeHttp(routes)
    const http: HttpClient = {
      get: async (url, h, s) => {
        if (url === e.latest) await gate
        return base.http.get(url, h, s)
      },
    }
    const { u } = settingsSetup(routes, OFF, { http })
    const slow = u.check() // stuck on releases/latest
    await sleep(10)
    await u.setPrereleases(true)
    expect(u.getState()).toEqual({ status: "available", version: RC, prerelease: true })
    release()
    await slow
    expect(u.getState()).toEqual({ status: "available", version: RC, prerelease: true })
  })

  it("does not disturb a running install; the setting applies after it", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const { u, installs, requested, saved } = settingsSetup(withList([rel(`v${RC}`)]), OFF, {
      install: (req) => {
        installs.push(req)
        return Effect.promise(() => gate).pipe(Effect.flatMap(() => Effect.fail(new InstallError({ message: "cancelled" }))))
      },
    })
    await u.check()
    u.install()
    while (u.getState().status !== "installing") await sleep(5)
    await u.setPrereleases(true)
    expect(saved).toEqual([ON])
    expect(u.getSnapshot()).toEqual({ status: "installing", version: VERSION, prereleases: true })
    expect(requested).not.toContain(e.releases)
    release()
    await u.idle()
    expect(installs).toHaveLength(1)
    expect(requested).toContain(e.releases)
    expect(u.getState()).toEqual({ status: "available", version: RC, prerelease: true })
  })
})

describe("skip", () => {
  it("skips the offered version, persists it, and keeps it skipped on re-checks", async () => {
    const { u, saved, states } = settingsSetup(github(), OFF)
    await u.check()
    u.skip()
    expect(u.getSnapshot()).toEqual({ status: "skipped", version: VERSION, prereleases: false })
    expect(states.at(-1)).toEqual({ status: "skipped", version: VERSION, prereleases: false })
    expect(saved).toEqual([{ prereleases: false, skipped: VERSION }])
    await u.check()
    expect(u.getState()).toEqual({ status: "skipped", version: VERSION })
    u.install() // not from "skipped"
    await u.idle()
    expect(u.getState()).toEqual({ status: "skipped", version: VERSION })
  })

  it("stays skipped across a restart, until a different version is the newest", async () => {
    const routes = github()
    const first = settingsSetup(routes, OFF)
    await first.u.check()
    first.u.skip()
    const persisted = first.saved.at(-1)!
    first.u.shutdown()

    const second = settingsSetup(routes, persisted)
    await second.u.check()
    expect(second.u.getState()).toEqual({ status: "skipped", version: VERSION })
    expect(second.states).toEqual([{ status: "skipped", version: VERSION, prereleases: false }])

    routes[e.latest] = { body: JSON.stringify(rel("v0.4.0")) }
    await second.u.check()
    expect(second.u.getState()).toEqual({ status: "available", version: "0.4.0", prerelease: false })
  })

  it("matches the skipped version exactly (a prerelease offer in between does not clear it)", async () => {
    const { u, saved } = settingsSetup(withList([rel("v0.3.0"), rel(`v${RC}`)]), OFF)
    await u.check()
    u.skip() // 0.3.0
    await u.setPrereleases(true)
    expect(u.getState()).toEqual({ status: "available", version: RC, prerelease: true })
    await u.setPrereleases(false)
    expect(u.getState()).toEqual({ status: "skipped", version: VERSION })
    expect(saved.at(-1)).toEqual({ prereleases: false, skipped: VERSION })
  })

  it("unskip offers the skipped version again (also after a restart)", async () => {
    const { u, saved } = settingsSetup(github(), { prereleases: false, skipped: VERSION })
    await u.check()
    expect(u.getState()).toEqual({ status: "skipped", version: VERSION })
    u.unskip()
    expect(u.getState()).toEqual({ status: "available", version: VERSION, prerelease: false })
    expect(saved).toEqual([OFF])
    await u.check()
    expect(u.getState()).toEqual({ status: "available", version: VERSION, prerelease: false })
    u.unskip() // not skipped: ignored
    expect(saved).toHaveLength(1)
  })

  it("can skip a failed version, but not while nothing is offered or an install runs", async () => {
    const { u, saved } = settingsSetup(github(), OFF, { installResult: failOnce() })
    u.skip() // nothing offered
    expect(u.getState()).toEqual({ status: "none" })
    await u.check()
    u.install()
    u.skip() // downloading: ignored
    expect(u.getState().status).toBe("downloading")
    await u.idle()
    expect(u.getState().status).toBe("failed")
    expect(saved).toEqual([])
    u.skip()
    expect(u.getState()).toEqual({ status: "skipped", version: VERSION })
    expect(saved).toEqual([{ prereleases: false, skipped: VERSION }])
  })
})

describe("release notes", () => {
  it("opens the GitHub release page of the state's version, never with nothing offered", async () => {
    const { u, opened } = settingsSetup(withList([rel(`v${RC}`)]), OFF)
    u.openReleaseNotes()
    expect(opened).toEqual([])
    await u.check()
    u.openReleaseNotes()
    u.skip()
    u.openReleaseNotes()
    await u.setPrereleases(true)
    u.openReleaseNotes()
    expect(opened).toEqual([
      "https://github.com/ianwijma/clickered/releases/tag/v0.3.0",
      "https://github.com/ianwijma/clickered/releases/tag/v0.3.0",
      `https://github.com/ianwijma/clickered/releases/tag/v${RC}`,
    ])
  })
})

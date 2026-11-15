/**
 * In-app updates: check GitHub for a newer release (on startup, then every 24 h), and on
 * request download it, verify it and hand it to the OS installer (./update-install.ts).
 * State goes to the renderer as `UpdateSnapshot` (`IPC.update`): the `UpdateState` plus the
 * "Pre-release updates" setting, which the updater owns.
 *
 * User controls (persisted through `UpdaterDeps.saveSettings`, i.e. config.json):
 * - "Pre-release updates" (off by default): off, only full releases are offered (the
 *   `releases/latest` query); on, release candidates and betas too (the release list).
 *   Changing it checks again at once; turning it off withdraws a prerelease offer. A
 *   running download/install is never disturbed: the next check applies the setting.
 * - Skip: the offered version is remembered and shown as "skipped" (no notice) for as long
 *   as it is exactly the version the check finds; any other version is offered again.
 *
 * Everything that touches the outside world is injected (`UpdaterDeps`): the HTTP client,
 * the "is this a real installed copy" check, the installer and the restart, so the tests
 * never use the network or run an installer. The pure pieces live in ./update-core.ts.
 *
 * Hardening of a download:
 * - every URL, each redirect hop included, must pass `isAllowedUrl` (https, GitHub's hosts
 *   only, no credentials, default port); at most 5 redirects;
 * - the exact file name for this platform, its size as reported by GitHub (capped at
 *   `MAX_ASSET_BYTES`); a body that is larger, or ends shorter, is rejected; a stalled
 *   connection (no data for 30 s) or a hung request times out;
 * - the file goes into a fresh directory under userData (0700, the file 0600), never a
 *   shared temp dir; whatever an earlier run left there is deleted on startup;
 * - its SHA-256 must equal BOTH the release's SHA256SUMS.txt entry and the asset's
 *   `digest` from the API (when GitHub reports one); a mismatch deletes the file
 *   (`failed`/`checksum`). It is hashed again right before the installer gets it.
 */
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { chmod, mkdir, open, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { Data, Effect } from "effect"
import type { UpdateFailure, UpdateSnapshot, UpdateState } from "@shared/ipc"
import {
  checksumProblem,
  GITHUB_POLICY,
  isAllowedUrl,
  MAX_RELEASE_JSON_BYTES,
  MAX_RELEASE_LIST_JSON_BYTES,
  parseRelease,
  parseSha256Sums,
  releaseNotesUrl,
  selectRelease,
  shouldPushProgress,
  type Endpoints,
  type Offer,
  type Target,
  type UrlPolicy,
} from "./update-core"

// ---------------------------------------------------------------------------
// HTTP

export interface HttpResponse {
  readonly status: number
  /** The `Location` header of a redirect, else null. */
  readonly location: string | null
  /** `Content-Length`, when the server sent one. */
  readonly contentLength: number | null
  /** Stream the body: `onChunk` gets every chunk; resolves at the end, rejects on error or abort. */
  readonly consume: (onChunk: (chunk: Uint8Array) => void) => Promise<void>
  /** Drop the response (also stops a running `consume`). */
  readonly abort: () => void
}

export interface HttpClient {
  /** One GET. Must NOT follow redirects (they come back as 3xx with `location`). */
  readonly get: (url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<HttpResponse>
}

export interface Timeouts {
  /** Until the response headers arrive. */
  readonly headersMs: number
  /** Longest gap between two body chunks. */
  readonly idleMs: number
}

export const DEFAULT_TIMEOUTS: Timeouts = { headersMs: 30_000, idleMs: 30_000 }
const MAX_REDIRECTS = 5
const REDIRECTS = new Set([301, 302, 303, 307, 308])

class HttpError extends Error {}

/** Wait for `p`, failing after `ms` or when `signal` aborts. */
const deadline = <A>(p: Promise<A>, ms: number, what: string, signal: AbortSignal): Promise<A> =>
  new Promise<A>((resolve, reject) => {
    const t = setTimeout(() => reject(new HttpError(`${what}: timed out after ${ms} ms`)), ms)
    const onAbort = (): void => reject(new HttpError(`${what}: cancelled`))
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(resolve, reject).finally(() => {
      clearTimeout(t)
      signal.removeEventListener("abort", onAbort)
    })
  })

/** GET `url` and follow redirects, checking every hop against `policy`. Resolves with a 200. */
export const openUrl = async (
  http: HttpClient,
  url: string,
  policy: UrlPolicy,
  headers: Readonly<Record<string, string>>,
  timeouts: Timeouts,
  signal: AbortSignal,
): Promise<HttpResponse> => {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedUrl(current, policy)) throw new HttpError(`refusing to fetch ${describeUrl(current)}`)
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    let res: HttpResponse
    try {
      res = await deadline(http.get(current, headers, ctl.signal), timeouts.headersMs, describeUrl(current), signal)
    } catch (e) {
      ctl.abort()
      throw e
    } finally {
      signal.removeEventListener("abort", onAbort)
    }
    if (REDIRECTS.has(res.status)) {
      res.abort()
      if (!res.location) throw new HttpError(`HTTP ${res.status} without a Location from ${describeUrl(current)}`)
      try {
        current = new URL(res.location, current).href
      } catch {
        throw new HttpError(`bad redirect from ${describeUrl(current)}`)
      }
      continue
    }
    if (res.status !== 200) {
      res.abort()
      throw new HttpError(`HTTP ${res.status} from ${describeUrl(current)}`)
    }
    return res
  }
  throw new HttpError(`too many redirects for ${describeUrl(url)}`)
}

/** Host and path only (no query string: CDN URLs carry signed tokens). */
const describeUrl = (raw: string): string => {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return "a malformed URL"
  }
}

export interface BodyLimits {
  /** Hard cap. */
  readonly maxBytes: number
  /** The body must be exactly this long, when known. */
  readonly exactBytes: number | null
}

/** Stream a response body into `sink`, enforcing the size limits and the idle timeout. */
export const readBody = (
  res: HttpResponse,
  limits: BodyLimits,
  idleMs: number,
  signal: AbortSignal,
  sink: (chunk: Uint8Array, total: number) => void,
): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const cap = limits.exactBytes ?? limits.maxBytes
    let total = 0
    let settled = false
    let idle: ReturnType<typeof setTimeout> | null = null
    const finish = (e: Error | null): void => {
      if (settled) return
      settled = true
      if (idle) clearTimeout(idle)
      signal.removeEventListener("abort", onAbort)
      if (e) {
        res.abort()
        reject(e)
      } else resolve(total)
    }
    const arm = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => finish(new HttpError(`download stalled (no data for ${idleMs} ms)`)), idleMs)
    }
    const onAbort = (): void => finish(new HttpError("download cancelled"))
    signal.addEventListener("abort", onAbort, { once: true })
    if (res.contentLength !== null && (res.contentLength > cap || (limits.exactBytes !== null && res.contentLength !== limits.exactBytes)))
      return finish(new HttpError(`unexpected size ${res.contentLength} (expected ${cap})`))
    arm()
    res
      .consume((chunk) => {
        if (settled) return
        total += chunk.byteLength
        if (total > cap) return finish(new HttpError(`download larger than the expected ${cap} bytes`))
        arm()
        try {
          sink(chunk, total)
        } catch (e) {
          finish(e instanceof Error ? e : new Error(String(e)))
        }
      })
      .then(
        () => {
          if (limits.exactBytes !== null && total !== limits.exactBytes)
            finish(new HttpError(`download ended after ${total} of ${limits.exactBytes} bytes`))
          else finish(null)
        },
        (e: unknown) => finish(e instanceof Error ? e : new HttpError(String(e))),
      )
  })

// ---------------------------------------------------------------------------
// Files

/** userData/updates; each download gets its own fresh subdirectory. */
export const ensurePrivateDir = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

/** A fresh 0700 directory inside `root` (itself 0700). */
export const makeDownloadDir = async (root: string): Promise<string> => {
  await ensurePrivateDir(root)
  const dir = join(root, `dl-${randomBytes(8).toString("hex")}`)
  await mkdir(dir, { mode: 0o700 })
  await chmod(dir, 0o700)
  return dir
}

/**
 * Remove everything an earlier run left in `root` (downloads, installers that already ran).
 * `beforeRemove` runs first for each entry (macOS: detach a disk image a quit left
 * mounted at `<entry>/mnt`); an entry is kept when it returns false.
 */
export const cleanDownloads = async (root: string, beforeRemove?: (entry: string) => Promise<boolean>): Promise<void> => {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return
  }
  await Promise.all(
    names.map(async (n) => {
      const entry = join(root, n)
      if (beforeRemove && !(await beforeRemove(entry).catch(() => false))) return
      await rm(entry, { recursive: true, force: true }).catch(() => {})
    }),
  )
}

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256")
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")))
  })

// ---------------------------------------------------------------------------
// Errors

export class CheckError extends Data.TaggedError("CheckError")<{ readonly message: string }> {}
export class DownloadError extends Data.TaggedError("DownloadError")<{ readonly message: string }> {}
export class ChecksumError extends Data.TaggedError("ChecksumError")<{ readonly message: string }> {}
export class InstallError extends Data.TaggedError("InstallError")<{ readonly message: string }> {}

const msgOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ---------------------------------------------------------------------------
// Updater

export type Eligibility = { readonly ok: true } | { readonly ok: false; readonly why: string }

/** What the app does after the installer was started successfully. */
export type AfterInstall =
  /** Restart the app (Linux after apt, macOS after the bundle swap). */
  | { readonly kind: "relaunch" }
  /** Quit; the installer starts the new version (Windows). */
  | { readonly kind: "quit" }
  /** Could not install in place; the user has to finish it (shown as `failed`/`install`). */
  | { readonly kind: "manual"; readonly message: string }

export interface InstallRequest {
  /** Absolute path of the verified file. */
  readonly file: string
  /** Its SHA-256 (lower-case hex), as verified; the Linux installer checks it again as root. */
  readonly sha256: string
  readonly version: string
  /** The private directory the file is in (scratch space for the installer). */
  readonly dir: string
  /**
   * Run `eff` as a critical section: uninterruptible, and the app's quit waits for it
   * (`Updater.criticalDone`). For steps that must not stop halfway (the macOS bundle swap).
   */
  readonly critical: <A, E>(eff: Effect.Effect<A, E>) => Effect.Effect<A, E>
}

/** Retry delays after the 1st, 2nd, 3rd... failure; after `MAX_ATTEMPTS` attempts no more this run. */
export const RETRY_DELAYS_MS: ReadonlyArray<number> = [0, 10_000, 30_000, 120_000]
export const MAX_ATTEMPTS = 5
/** How long the install waits for a running replay (they take a second or two). */
export const BUSY_WAIT_MS = 30_000

/** Delay before attempt number `failures + 1`, or null when no attempt is left. */
export const retryDelay = (failures: number, delays: ReadonlyArray<number> = RETRY_DELAYS_MS): number | null =>
  failures >= MAX_ATTEMPTS ? null : failures === 0 ? 0 : delays[Math.min(failures, delays.length) - 1]!

/** The persisted update settings (config.json `prereleaseUpdates` / `skippedUpdate`). */
export interface UpdateSettings {
  /** "Pre-release updates": offer release candidates and betas too. */
  readonly prereleases: boolean
  /** The version the user skipped ("1.4.0", no "v"), or null. */
  readonly skipped: string | null
}

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = { prereleases: false, skipped: null }

export interface UpdaterDeps {
  readonly currentVersion: string
  readonly target: Target
  readonly endpoints: Endpoints
  readonly http: HttpClient
  /** Is this a copy that can update itself? Asked once, before the first check. */
  readonly eligible: () => Promise<Eligibility>
  /** userData/updates. */
  readonly downloadRoot: string
  /** Startup cleanup hook, see `cleanDownloads`. */
  readonly beforeClean?: (entry: string) => Promise<boolean>
  /** Run the installer (or swap the bundle). Rejects with a user-presentable message. */
  readonly install: (req: InstallRequest) => Effect.Effect<AfterInstall, InstallError | ChecksumError>
  /** Restart or quit the app as the installer asked. */
  readonly afterInstall: (a: Exclude<AfterInstall, { kind: "manual" }>) => void
  /** True while a gesture is being replayed: the install waits for it. */
  readonly isBusy?: () => boolean
  /** Every new snapshot: a state change, or only a change of the setting. */
  readonly onState: (s: UpdateSnapshot) => void
  /** The settings as saved; default `DEFAULT_UPDATE_SETTINGS`. */
  readonly settings?: UpdateSettings
  /** Persist changed settings (called with the whole new value). */
  readonly saveSettings?: (s: UpdateSettings) => void
  /** Open a URL in the default browser; only ever given `releaseNotesUrl` output. */
  readonly openExternal?: (url: string) => void
  readonly log?: (msg: string) => void
  /** Default 24 h. */
  readonly recheckMs?: number
  readonly timeouts?: Timeouts
  readonly progressEveryMs?: number
  /** Tests: override RETRY_DELAYS_MS and BUSY_WAIT_MS. */
  readonly retryDelaysMs?: ReadonlyArray<number>
  readonly busyWaitMs?: number
  readonly now?: () => number
}

export interface Updater {
  getState(): UpdateState
  /** What `IPC.getUpdate` answers: the state plus the "Pre-release updates" setting. */
  getSnapshot(): UpdateSnapshot
  /** Check now (also runs on start and every `recheckMs`). Never fails; problems are logged. */
  check(): Promise<void>
  /** Start download + verify + install. Ignored unless the status is "available" or "failed". */
  install(): void
  /** Skip the offered version (persisted). Ignored unless the status is "available" or "failed". */
  skip(): void
  /** Offer the skipped version again. Ignored unless the status is "skipped". */
  unskip(): void
  /** Open the release page of the state's version. Ignored when the status is "none". */
  openReleaseNotes(): void
  /**
   * Change "Pre-release updates": saved, pushed, and checked again right away (resolves when
   * that check is done). During a download/install only saved; the check follows it.
   */
  setPrereleases(enabled: boolean): Promise<void>
  /** Resolves when the running install attempt (if any) has settled; for tests. */
  idle(): Promise<void>
  /** Resolves once no critical install step (see `InstallRequest.critical`) is running. */
  criticalDone(): Promise<void>
  shutdown(): void
}

const NONE: UpdateState = { status: "none" }

export const startUpdater = (deps: UpdaterDeps, opts: { readonly autoCheck?: boolean } = {}): Updater => {
  const log = deps.log ?? ((m: string) => console.log(`[clickered] update: ${m}`))
  const timeouts = deps.timeouts ?? DEFAULT_TIMEOUTS
  const now = deps.now ?? Date.now
  const stop = new AbortController()
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `Clickered/${deps.currentVersion}`,
  }

  let settings: UpdateSettings = deps.settings ?? DEFAULT_UPDATE_SETTINGS
  /** Bumped on every setting change: a check started before it is discarded. */
  let settingsGen = 0
  /** The setting changed during an install: check again once it has settled. */
  let recheckAfterInstall = false
  let state: UpdateState = NONE
  let snapshotJson = JSON.stringify({ ...state, prereleases: settings.prereleases })
  let offer: Offer | null = null
  let eligibility: Promise<Eligibility> | null = null
  let running: Promise<unknown> = Promise.resolve()
  let lastProgressPush: number | null = null
  /** Failed attempts for the current offer, and when the last one ended. */
  let failures = 0
  let lastFailureAt = 0
  let pendingRetry: ReturnType<typeof setTimeout> | null = null
  let critical = 0
  let criticalWaiters: Array<() => void> = []
  const leaveCritical = (): void => {
    critical--
    if (critical > 0) return
    const w = criticalWaiters
    criticalWaiters = []
    for (const f of w) f()
  }
  const criticalSection = <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.uninterruptible(
      Effect.suspend(() => {
        critical++
        return eff.pipe(Effect.ensuring(Effect.sync(leaveCritical)))
      }),
    )

  const snapshot = (): UpdateSnapshot => ({ ...state, prereleases: settings.prereleases })
  /** Push the snapshot when it differs from the last one pushed. */
  const push = (): void => {
    const snap = snapshot()
    const j = JSON.stringify(snap)
    if (j === snapshotJson) return
    snapshotJson = j
    deps.onState(snap)
  }
  const set = (s: UpdateState): void => {
    state = s
    push()
  }
  const saveSettings = (next: UpdateSettings): void => {
    settings = next
    try {
      deps.saveSettings?.(next)
    } catch (e) {
      log(`could not save the update settings: ${msgOf(e)}`)
    }
  }
  /** How an offer shows: "skipped" when it is exactly the skipped version. */
  const offerState = (o: Offer): UpdateState =>
    o.version === settings.skipped ? { status: "skipped", version: o.version } : { status: "available", version: o.version, prerelease: o.prerelease }
  const inFlight = (): boolean => state.status === "downloading" || state.status === "verifying" || state.status === "installing"

  const run = <A>(eff: Effect.Effect<A>): Promise<A | undefined> =>
    Effect.runPromise(eff, { signal: stop.signal }).catch((e: unknown) => {
      if (!stop.signal.aborted) log(`unexpected: ${msgOf(e)}`)
      return undefined
    })

  /** Fetch a small body (JSON, SHA256SUMS.txt). */
  const fetchBytes = (url: string, limits: { maxBytes: number; exactBytes: number | null }) =>
    Effect.tryPromise({
      try: async (signal) => {
        const s = AbortSignal.any([signal, stop.signal])
        const res = await openUrl(deps.http, url, deps.endpoints.policy, headers, timeouts, s)
        const chunks: Uint8Array[] = []
        await readBody(res, limits, timeouts.idleMs, s, (c) => chunks.push(c))
        return Buffer.concat(chunks)
      },
      catch: (e) => new DownloadError({ message: msgOf(e) }),
    })

  // --- check -------------------------------------------------------------------
  const checkEff = Effect.gen(function* () {
    eligibility ??= deps.eligible().catch((e: unknown) => ({ ok: false as const, why: msgOf(e) }))
    const el = yield* Effect.promise(() => eligibility!)
    if (!el.ok) return yield* new CheckError({ message: `this copy cannot update itself: ${el.why}` })
    // Full releases only: `releases/latest`, exactly as before the setting existed. With
    // prereleases: the release list, and the highest version in it.
    const gen = settingsGen
    const pre = settings.prereleases
    const url = pre ? deps.endpoints.releases : deps.endpoints.latest
    const maxBytes = pre ? MAX_RELEASE_LIST_JSON_BYTES : MAX_RELEASE_JSON_BYTES
    const text = yield* fetchBytes(url, { maxBytes, exactBytes: null }).pipe(
      Effect.map((b) => b.toString("utf8")),
      Effect.mapError((e) => new CheckError({ message: e.message })),
    )
    const json = yield* Effect.try({ try: (): unknown => JSON.parse(text), catch: () => new CheckError({ message: "release: invalid JSON" }) })
    // The setting changed meanwhile: the check it started has the say.
    if (gen !== settingsGen) return
    if (inFlight()) return
    const parsed = pre ? selectRelease(json, deps.currentVersion, deps.target) : parseRelease(json, deps.currentVersion, deps.target)
    if (!parsed.ok) {
      offer = null
      set(NONE)
      return yield* Effect.sync(() => log(parsed.error))
    }
    const o = parsed.value
    if (offer?.version !== o.version) {
      failures = 0
      log(`version ${o.version}${o.prerelease ? " (prerelease)" : ""} is available (running ${deps.currentVersion})`)
    }
    // A failed attempt at this same version stays "failed" (its Retry), unless it was skipped.
    const keep = state.status === "failed" && state.version === o.version && o.version !== settings.skipped
    offer = o
    if (!keep) set(offerState(o))
  }).pipe(
    // A failed check never shows anything: what was offered stays offered, otherwise "none".
    Effect.catchTag("CheckError", (e) => Effect.sync(() => log(`check failed: ${e.message}`))),
  )

  // --- install -----------------------------------------------------------------
  /** Wait (bounded) until no replay is running; true if none is. */
  const waitNotBusy = Effect.gen(function* () {
    if (!deps.isBusy?.()) return true
    log("waiting for the replay to finish")
    const end = now() + (deps.busyWaitMs ?? BUSY_WAIT_MS)
    while (deps.isBusy() && now() < end) yield* Effect.sleep("20 millis")
    return !deps.isBusy()
  })

  const installEff = (o: Offer) => {
    const v = o.version
    let dir: string | null = null
    const pipeline = Effect.gen(function* () {
      dir = yield* Effect.tryPromise({
        try: () => makeDownloadDir(deps.downloadRoot),
        catch: (e) => new DownloadError({ message: `cannot create the download folder: ${msgOf(e)}` }),
      })
      const d = dir

      // 1. SHA256SUMS.txt first: no point downloading 100 MB we cannot verify.
      const sumsBytes = yield* fetchBytes(deps.endpoints.download(o.tag, o.sums.name), {
        maxBytes: o.sums.size,
        exactBytes: o.sums.size,
      })
      if (o.sums.sha256 !== null) {
        const got = createHash("sha256").update(sumsBytes).digest("hex")
        if (got !== o.sums.sha256) return yield* new ChecksumError({ message: `${o.sums.name} does not match GitHub's digest` })
      }
      const sums = parseSha256Sums(sumsBytes.toString("utf8"))
      if (!sums.ok) return yield* new ChecksumError({ message: sums.error })
      const expected = sums.value.get(o.asset.name)
      if (expected === undefined) return yield* new ChecksumError({ message: `${o.asset.name} is not in ${o.sums.name}` })
      if (o.asset.sha256 !== null && o.asset.sha256 !== expected)
        return yield* new ChecksumError({ message: `${o.sums.name} and GitHub's digest disagree about ${o.asset.name}` })

      // 2. The package, into a fresh 0600 file.
      const file = join(d, o.asset.name)
      lastProgressPush = null
      yield* Effect.tryPromise({
        try: async (signal) => {
          const s = AbortSignal.any([signal, stop.signal])
          const fh = await open(file, "wx", 0o600)
          // Writes are queued in order; readBody's sink must stay synchronous.
          let writes: Promise<unknown> = Promise.resolve()
          try {
            const res = await openUrl(deps.http, deps.endpoints.download(o.tag, o.asset.name), deps.endpoints.policy, headers, timeouts, s)
            await readBody(res, { maxBytes: o.asset.size, exactBytes: o.asset.size }, timeouts.idleMs, s, (chunk, total) => {
              const copy = Buffer.from(chunk)
              writes = writes.then(() => fh.write(copy))
              const progress = Math.min(1, total / o.asset.size)
              const t = now()
              if (shouldPushProgress(lastProgressPush, t, progress, deps.progressEveryMs)) {
                lastProgressPush = t
                set({ status: "downloading", version: v, progress })
              }
            })
            await writes
            await fh.sync()
          } finally {
            await writes.catch(() => {})
            await fh.close()
          }
        },
        catch: (e) => new DownloadError({ message: msgOf(e) }),
      })

      // 3. Verify.
      set({ status: "verifying", version: v })
      const hash = (): Effect.Effect<string, ChecksumError> =>
        Effect.tryPromise({ try: () => sha256File(file), catch: (e) => new ChecksumError({ message: `cannot read the download: ${msgOf(e)}` }) })
      const problem = checksumProblem(yield* hash(), expected, o.asset.sha256)
      if (problem !== null) return yield* new ChecksumError({ message: problem })
      log(`${o.asset.name} verified (sha256 ${expected})`)

      // 4. Install, never during a replay.
      if (!(yield* waitNotBusy))
        return yield* new InstallError({ message: "A replay kept running; try again when it is done." })
      set({ status: "installing", version: v })
      const again = yield* hash()
      if (again !== expected) return yield* new ChecksumError({ message: "the download changed after it was verified" })
      return yield* deps.install({ file, sha256: expected, version: v, dir: d, critical: criticalSection })
    })

    const fail = (reason: UpdateFailure, message: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        log(`install of ${v} failed (${reason}): ${message}`)
        if (dir !== null) {
          const d = dir
          yield* Effect.promise(() => rm(d, { recursive: true, force: true }).catch(() => {}))
        }
        failures++
        lastFailureAt = now()
        const left = retryDelay(failures, deps.retryDelaysMs) === null ? " No more attempts; restart Clickered to try again." : ""
        set({ status: "failed", version: v, reason, message: (message.slice(0, 300) + left).trim() })
      })

    return pipeline.pipe(
      Effect.flatMap((after) =>
        Effect.gen(function* () {
          if (after.kind === "manual") {
            log(after.message)
            set({ status: "failed", version: v, reason: "install", message: after.message })
            return
          }
          // The package is in place now: restart, but not in the middle of a replay.
          if (!(yield* waitNotBusy)) log("a replay is still running; restarting anyway")
          log(`installer for ${v} done; ${after.kind}`)
          deps.afterInstall(after)
        }),
      ),
      Effect.catchTags({
        DownloadError: (e) => fail("download", e.message),
        ChecksumError: (e) => fail("checksum", e.message),
        InstallError: (e) => fail("install", e.message),
      }),
      Effect.catchDefect((d) => fail("install", msgOf(d))),
    )
  }

  // --- startup -----------------------------------------------------------------
  const check = (): Promise<void> => run(checkEff).then(() => undefined)

  /** After an install attempt settled: apply a setting changed during it. */
  const afterAttempt = async (): Promise<void> => {
    if (!recheckAfterInstall || stop.signal.aborted || inFlight()) return
    recheckAfterInstall = false
    await check()
  }

  if (opts.autoCheck ?? true) {
    void (async () => {
      await cleanDownloads(deps.downloadRoot, deps.beforeClean)
      await check()
    })()
    const every = deps.recheckMs ?? 24 * 60 * 60 * 1000
    const timer = setInterval(() => void check(), every)
    timer.unref?.()
    stop.signal.addEventListener("abort", () => clearInterval(timer), { once: true })
  }

  return {
    getState: () => state,
    getSnapshot: snapshot,
    check,
    skip: () => {
      if (stop.signal.aborted || offer === null) return
      if (state.status !== "available" && state.status !== "failed") return
      const v = state.version
      log(`version ${v} skipped`)
      saveSettings({ ...settings, skipped: v })
      set({ status: "skipped", version: v })
    },
    unskip: () => {
      if (stop.signal.aborted || offer === null || state.status !== "skipped") return
      const o = offer
      log(`version ${o.version} no longer skipped`)
      saveSettings({ ...settings, skipped: null })
      set(offerState(o))
    },
    openReleaseNotes: () => {
      if (state.status === "none") return
      const url = releaseNotesUrl(state.version)
      if (url === null || !isAllowedUrl(url, GITHUB_POLICY)) return log(`no release page for ${JSON.stringify(state.version)}`)
      if (deps.openExternal) deps.openExternal(url)
      else log(`release notes: ${url}`)
    },
    setPrereleases: async (enabled) => {
      if (stop.signal.aborted || enabled === settings.prereleases) return
      log(`pre-release updates ${enabled ? "on" : "off"}`)
      settingsGen++
      saveSettings({ ...settings, prereleases: enabled })
      if (inFlight()) {
        push()
        recheckAfterInstall = true
        return
      }
      // Off: a prerelease offer goes at once, not only when (if) the check below succeeds.
      if (!enabled && offer?.prerelease) {
        offer = null
        state = NONE
      }
      push()
      await check()
    },
    install: () => {
      if (stop.signal.aborted || offer === null || pendingRetry !== null) return
      if (state.status !== "available" && state.status !== "failed") return
      // Retries back off, and stop after MAX_ATTEMPTS (each may mean a password prompt).
      const delay = retryDelay(failures, deps.retryDelaysMs)
      if (delay === null) return log("install ignored: no attempts left this run")
      const o = offer
      // Synchronously, so a second click cannot start another attempt.
      set({ status: "downloading", version: o.version, progress: 0 })
      const wait = Math.max(0, lastFailureAt + delay - now())
      if (wait === 0) {
        running = run(installEff(o)).then(afterAttempt)
        return
      }
      log(`retrying in ${Math.ceil(wait / 1000)} s`)
      running = new Promise<void>((resolve) => {
        pendingRetry = setTimeout(() => {
          pendingRetry = null
          if (stop.signal.aborted) return resolve()
          void run(installEff(o))
            .then(afterAttempt)
            .then(() => resolve())
        }, wait)
        stop.signal.addEventListener(
          "abort",
          () => {
            if (pendingRetry !== null) clearTimeout(pendingRetry)
            pendingRetry = null
            resolve()
          },
          { once: true },
        )
      })
    },
    idle: () => running.then(() => undefined),
    criticalDone: () => (critical === 0 ? Promise.resolve() : new Promise<void>((r) => criticalWaiters.push(r))),
    shutdown: () => stop.abort(),
  }
}

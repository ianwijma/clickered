/**
 * Electron glue for the updater: the HTTP client (Chromium's network stack via `net`, so
 * system proxies and certificates apply), the per-OS eligibility check and installer, and
 * the test hooks. Everything with logic in it lives in ./update*.ts and is unit tested.
 */
import { join } from "node:path"
import { app, net, shell } from "electron"
import { Effect } from "effect"
import type { UpdateState } from "@shared/ipc"
import { endpointsFor, readTestHooks, type TestHooks } from "./update-core"
import {
  cleanMacLeftovers,
  detachStaleMount,
  dryRunRunner,
  installLinux,
  installMac,
  installWindows,
  linuxEligibility,
  macBundleOf,
  macEligibility,
  nodeFs,
  nodeRunner,
  recordDryRun,
  windowsEligibility,
} from "./update-install"
import { InstallError, startUpdater, type Eligibility, type HttpClient, type HttpResponse, type Updater } from "./update"

/** One GET through `net.request`, never following redirects, no cookies or credentials. */
export const electronHttp: HttpClient = {
  get: (url, headers, signal) =>
    new Promise<HttpResponse>((resolve, reject) => {
      const req = net.request({
        url,
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        useSessionCookies: false,
        cache: "no-store",
        headers: { ...headers },
      })
      let done = false
      const onAbort = (): void => {
        req.abort()
        if (!done) {
          done = true
          reject(new Error("request cancelled"))
        }
      }
      signal.addEventListener("abort", onAbort, { once: true })
      req.on("redirect", (status, _method, redirectUrl) => {
        // Not calling followRedirect() cancels the request; the caller checks the target
        // against the allowlist and makes the next request itself.
        if (done) return
        done = true
        resolve({ status, location: redirectUrl, contentLength: null, consume: () => Promise.resolve(), abort: () => req.abort() })
        req.abort()
      })
      req.on("response", (res) => {
        if (done) return
        done = true
        // Chromium decompresses transparently; then Content-Length is the compressed size and
        // says nothing about the body (readBody still checks the real byte count).
        const enc = String(res.headers["content-encoding"] ?? "identity").toLowerCase()
        const len = enc === "identity" ? res.headers["content-length"] : undefined
        const n = Number(Array.isArray(len) ? len[0] : len)
        let aborted = false
        resolve({
          status: res.statusCode,
          location: null,
          contentLength: len !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : null,
          consume: (onChunk) =>
            new Promise<void>((ok, fail) => {
              res.on("data", (c: Buffer) => {
                if (!aborted) onChunk(c)
              })
              res.on("end", () => ok())
              res.on("error", (e: Error) => fail(e))
              res.on("aborted", () => fail(new Error("response aborted")))
              signal.addEventListener("abort", () => fail(new Error("request cancelled")), { once: true })
            }),
          abort: () => {
            aborted = true
            req.abort()
          },
        })
      })
      req.on("error", (e) => {
        if (done) return
        done = true
        reject(e)
      })
      req.end()
    }),
}

const target = () => ({
  platform: process.platform,
  arch: process.arch,
  rosetta: process.platform === "darwin" && app.runningUnderARM64Translation,
})

/** Is this a packaged, installed copy that can replace itself? (Test hook: FORCE.) */
const eligibility = async (hooks: TestHooks): Promise<Eligibility> => {
  if (hooks.force) return { ok: true }
  if (!app.isPackaged) return { ok: false, why: "not packaged (dev run)" }
  switch (process.platform) {
    case "linux":
      return linuxEligibility(process.execPath, app.getVersion(), nodeRunner, nodeFs)
    case "win32":
      return windowsEligibility(process.execPath, process.env, nodeFs)
    case "darwin":
      return macEligibility(process.execPath, nodeFs)
    default:
      return { ok: false, why: `unsupported platform ${process.platform}` }
  }
}

export interface AppUpdaterOptions {
  readonly onState: (s: UpdateState) => void
  readonly isBusy: () => boolean
  /** Restart (`relaunch`) or quit the app; index.ts owns the quit sequence. */
  readonly exit: (relaunch: boolean) => void
}

export const startAppUpdater = (opts: AppUpdaterOptions): Updater => {
  const hooks = readTestHooks(process.env, app.isPackaged)
  if (hooks.baseUrl !== null || hooks.force || hooks.dryRunLog !== null)
    console.log(`[clickered] update: test hooks active: ${JSON.stringify(hooks)}`)
  const dryRun = hooks.dryRunLog !== null
  const runner = dryRun ? dryRunRunner(hooks.dryRunLog) : nodeRunner
  // A dry run (e.g. in a container without polkit) must not fail on a missing pkexec.
  const installFs = dryRun ? { ...nodeFs, exists: async () => true } : nodeFs
  const log = (m: string): void => console.log(`[clickered] update: ${m}`)
  const bundle = process.platform === "darwin" ? macBundleOf(process.execPath) : null
  if (bundle !== null && app.isPackaged) void cleanMacLeftovers(bundle, nodeFs)

  const install =
    process.platform === "linux"
      ? installLinux({
          runner,
          fs: installFs,
          me: { uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1 },
          // Packaged: /opt/Clickered/resources/clickered-install-update (from the .deb).
          script: app.isPackaged
            ? join(process.resourcesPath, "clickered-install-update")
            : join(app.getAppPath(), "native", "linux", "clickered-install-update"),
          // Only the unpackaged dry-run hook skips the ownership checks (nothing is run then).
          checkScript: !dryRun,
        })
      : process.platform === "win32"
        ? installWindows(runner)
        : process.platform === "darwin" && bundle !== null
          ? installMac({ runner, fs: nodeFs, bundle, openPath: (p) => shell.openPath(p), log })
          : () => Effect.fail(new InstallError({ message: `cannot install on ${process.platform}` }))

  return startUpdater({
    currentVersion: app.getVersion(),
    target: target(),
    endpoints: endpointsFor(hooks),
    http: electronHttp,
    eligible: () => eligibility(hooks),
    downloadRoot: join(app.getPath("userData"), "updates"),
    ...(process.platform === "darwin" ? { beforeClean: detachStaleMount(nodeRunner, nodeFs) } : {}),
    install,
    afterInstall: (a) => {
      if (hooks.dryRunLog !== null) {
        void recordDryRun(hooks.dryRunLog, { action: a.kind }).then(() => log(`dry run: would ${a.kind}`))
        return
      }
      opts.exit(a.kind === "relaunch")
    },
    isBusy: opts.isBusy,
    onState: opts.onState,
    log,
  })
}

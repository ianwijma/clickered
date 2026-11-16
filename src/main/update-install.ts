/**
 * Per-OS halves of the updater: "is this a real installed copy?" and "install this
 * verified file". No shell anywhere: every command is an absolute binary plus an argument
 * array (`execFile` / `spawn`). Commands go through an injectable `Runner`, file system
 * changes through `InstallFs`, so the tests check the exact command sequences without
 * running anything (and the macOS swap runs on plain directories).
 *
 * - Linux: `pkexec /opt/Clickered/resources/clickered-install-update <file> <sha256>`, a
 *   root-owned script shipped in the .deb (native/linux/clickered-install-update). As root
 *   it copies the file into a fresh root-only directory, checks the copy's SHA-256 and
 *   installs the copy with `apt-get install -y`. Verifying as root closes the gap between
 *   the app's own check and the install, while the password prompt is open, in which any
 *   process of the user could replace the file in their home. The app only runs the script
 *   from that exact path, owned by root and not writable by anyone else. apt-get rather
 *   than `dpkg -i`: it resolves the package's dependencies (the .deb's `depends` list can
 *   grow between releases), where dpkg would leave a half-configured package. pkexec shows
 *   the desktop's polkit password prompt; without a running polkit agent it fails and the
 *   message says so. The install replaces /opt/Clickered under the running app, which then
 *   restarts at once.
 * - Windows: the NSIS installer runs detached with `--updated /S --force-run` (the flags
 *   electron-builder's templates read, the same electron-updater passes): silent, it waits
 *   for/closes the running app, and starts the new version when done. The app quits.
 * - macOS: no Squirrel. The dmg is attached read-only to a private mount point, the bundle
 *   is copied with `ditto` into a private staging folder beside the installed one (same
 *   volume), its bundle id, version and code signature are checked, then it is swapped in
 *   with two renames (the old bundle is moved into the staging folder and kept until the new
 *   one is in place) and the staging folder is deleted. Then the app
 *   restarts. When the location is not safe to write (translocated, read-only, not
 *   writable), the dmg is opened in Finder instead and the user drags it over.
 */
import { execFile, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { constants as fsc } from "node:fs"
import { access, appendFile, lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises"
import { basename, dirname, join, posix, win32 } from "node:path"
import { Effect } from "effect"
import { debVersionOf } from "../../scripts/deb-version.mjs"
import { BUNDLE_ID, PACKAGE_NAME, PRODUCT_NAME } from "./update-core"
import { ChecksumError, InstallError, type AfterInstall, type Eligibility, type InstallRequest } from "./update"

// ---------------------------------------------------------------------------
// Running commands

export interface RunResult {
  /** Exit code; null when killed (timeout) or not started. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface Runner {
  /** Run to completion. Never rejects: a spawn error comes back as code null + stderr. */
  run(file: string, args: ReadonlyArray<string>, opts?: { readonly timeoutMs?: number }): Promise<RunResult>
  /** Start detached (it outlives the app). Rejects if it cannot be started. */
  spawnDetached(file: string, args: ReadonlyArray<string>): Promise<void>
}

export const nodeRunner: Runner = {
  run: (file, args, opts) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { shell: false, windowsHide: true, timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null
          const code = e === null ? 0 : typeof e.code === "number" ? e.code : null
          resolve({ code, stdout, stderr: stderr || (e && code === null ? e.message : "") })
        },
      )
    }),
  spawnDetached: (file, args) =>
    new Promise((resolve, reject) => {
      const cp = spawn(file, [...args], { shell: false, detached: true, stdio: "ignore", windowsHide: true })
      cp.once("error", reject)
      cp.once("spawn", () => {
        cp.unref()
        resolve()
      })
    }),
}

/**
 * Test hook `CLICKERED_UPDATE_DRY_RUN` (unpackaged builds only, see update-core.ts): records
 * every command as a JSON line instead of running it; everything "succeeds".
 */
export const recordDryRun = (logFile: string, entry: object): Promise<void> =>
  appendFile(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 })

export const dryRunRunner = (logFile: string): Runner => {
  const rec = (file: string, args: ReadonlyArray<string>): Promise<void> => recordDryRun(logFile, { cmd: [file, ...args] })
  return {
    run: async (file, args) => {
      await rec(file, args)
      return { code: 0, stdout: "", stderr: "" }
    },
    spawnDetached: (file, args) => rec(file, args),
  }
}

/** The last meaningful stderr line (apt's "N:"/"W:" notices skipped), for messages. */
export const lastErrorLine = (stderr: string): string => {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^[NW]: /.test(l))
  return (lines.at(-1) ?? "").slice(0, 200)
}

// ---------------------------------------------------------------------------
// File system (injectable for the macOS swap tests)

export interface InstallFs {
  readonly exists: (p: string) => Promise<boolean>
  /** Resolves when `p` is writable by us. */
  readonly writable: (p: string) => Promise<boolean>
  /** True only for a real directory (not a symlink). */
  readonly isDir: (p: string) => Promise<boolean>
  readonly realpath: (p: string) => Promise<string>
  readonly rename: (from: string, to: string) => Promise<void>
  readonly rmrf: (p: string) => Promise<void>
  readonly mkdirPrivate: (p: string) => Promise<void>
  readonly readdir: (p: string) => Promise<ReadonlyArray<string>>
  /** lstat (symlinks are not followed); null when it does not exist. */
  readonly info: (p: string) => Promise<FileInfo | null>
}

export interface FileInfo {
  readonly uid: number
  readonly gid: number
  /** Permission bits incl. setuid/setgid/sticky (`mode & 0o7777`). */
  readonly mode: number
  readonly kind: "file" | "dir" | "symlink" | "other"
  /** Device id, to tell a mount point from its parent. */
  readonly dev: number
}

export const nodeFs: InstallFs = {
  exists: (p) => access(p).then(() => true, () => false),
  writable: (p) => access(p, fsc.W_OK).then(() => true, () => false),
  isDir: (p) => lstat(p).then((s) => s.isDirectory(), () => false),
  realpath: (p) => realpath(p),
  rename: (a, b) => rename(a, b),
  rmrf: (p) => rm(p, { recursive: true, force: true }),
  mkdirPrivate: (p) => mkdir(p, { mode: 0o700 }).then(() => undefined),
  readdir: (p) => readdir(p),
  info: (p) =>
    lstat(p).then(
      (s) => ({
        uid: s.uid,
        gid: s.gid,
        mode: s.mode & 0o7777,
        kind: s.isSymbolicLink() ? "symlink" : s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
        dev: s.dev,
      }),
      () => null,
    ),
}

/** `stat` (following symlinks) device id, for the mount check; null when missing. */
export const deviceOf = (p: string): Promise<number | null> => stat(p).then((s) => s.dev, () => null)

const fail = (message: string): Effect.Effect<never, InstallError> => Effect.fail(new InstallError({ message }))
const attempt = <A>(what: string, f: () => Promise<A>): Effect.Effect<A, InstallError> =>
  Effect.tryPromise({ try: f, catch: (e) => new InstallError({ message: `${what}: ${e instanceof Error ? e.message : String(e)}` }) })
const exec = (runner: Runner, file: string, args: ReadonlyArray<string>, timeoutMs?: number): Effect.Effect<RunResult> =>
  Effect.promise(() => runner.run(file, args, timeoutMs === undefined ? undefined : { timeoutMs }))

// ---------------------------------------------------------------------------
// Linux

/** Where the .deb installs the app (electron-builder: /opt/<productName>/<executableName>). */
export const LINUX_EXEC = `/opt/${PRODUCT_NAME}/${PACKAGE_NAME}`
export const PKEXEC = "/usr/bin/pkexec"
export const DPKG_QUERY = "/usr/bin/dpkg-query"
/** The root-owned install script (electron-builder.yml `linux.extraResources`). */
export const LINUX_INSTALL_SCRIPT = `/opt/${PRODUCT_NAME}/resources/clickered-install-update`
/** Its exit codes (see the script's header). */
export const SCRIPT_EXIT = { usage: 64, checksum: 65, missingTool: 66, copy: 67 } as const

const ancestors = (p: string): string[] => {
  const out: string[] = []
  // Linux-only: always POSIX, whatever the host (tests run this on Windows too).
  for (let d = posix.dirname(p); ; d = posix.dirname(d)) {
    out.push(d)
    if (d === posix.dirname(d)) return out
  }
}

/**
 * Why the install script may not be run: it must be exactly LINUX_INSTALL_SCRIPT, a regular
 * executable file owned by root and not writable by group or others, in directories that
 * are all root-owned and not group/world-writable either.
 */
export const scriptProblem = async (script: string, fs: InstallFs): Promise<string | null> => {
  if (script !== LINUX_INSTALL_SCRIPT) return `unexpected install script location ${script}`
  const f = await fs.info(script)
  if (f === null) return `${script} is missing`
  if (f.kind !== "file") return `${script} is not a regular file`
  if (f.uid !== 0) return `${script} is not owned by root`
  if ((f.mode & 0o022) !== 0) return `${script} is writable by group or others`
  if ((f.mode & 0o100) === 0) return `${script} is not executable`
  for (const d of ancestors(script)) {
    const i = await fs.info(d)
    if (i === null || i.kind !== "dir") return `${d} is not a directory`
    if (i.uid !== 0) return `${d} is not owned by root`
    if ((i.mode & 0o022) !== 0) return `${d} is writable by group or others`
  }
  return null
}

export interface Identity {
  readonly uid: number
  readonly gid: number
}

/**
 * Why the downloaded file's location is not trustworthy. The file and its two private
 * parents (`dl-*`, `updates`) must be ours and closed to group and others (we create them
 * 0600/0700). Every directory above must belong to us or root and must not be writable by
 * others, except sticky ones like /tmp; group-writable is accepted only for our own
 * user-private group (gid == uid == our primary gid, the Debian/Ubuntu default with umask
 * 002). Checked on the real path (symlinks resolved).
 */
export const downloadPathProblem = async (file: string, fs: InstallFs, me: Identity): Promise<string | null> => {
  const real = await fs.realpath(file).catch(() => null)
  if (real === null) return `${file} is missing`
  const chain = [real, ...ancestors(real)]
  for (const [i, p] of chain.entries()) {
    const f = await fs.info(p)
    if (f === null) return `${p} is missing`
    if (i === 0 ? f.kind !== "file" : f.kind !== "dir") return `${p} is not a ${i === 0 ? "file" : "directory"}`
    if (i < 3) {
      if (f.uid !== me.uid) return `${p} is not owned by you`
      if ((f.mode & 0o077) !== 0) return `${p} is accessible to group or others`
      continue
    }
    if (f.uid !== me.uid && f.uid !== 0) return `${p} belongs to another user`
    const sticky = (f.mode & 0o1000) !== 0
    if ((f.mode & 0o002) !== 0 && !sticky) return `${p} is world-writable`
    const privateGroup = f.gid === me.gid && me.gid === me.uid && f.uid === me.uid
    if ((f.mode & 0o020) !== 0 && !sticky && !privateGroup) return `${p} is group-writable`
  }
  return null
}

export interface LinuxContext {
  readonly runner: Runner
  readonly fs: InstallFs
  /** process.getuid()/getgid(). */
  readonly me: Identity
  /** The install script (LINUX_INSTALL_SCRIPT in a packaged app). */
  readonly script: string
  /** False only for the unpackaged dry-run test hook: the script is not checked (nor run). */
  readonly checkScript: boolean
}

/**
 * The version dpkg reports for an app version: "0.3.0" is packaged as "0.3.0-1", "0.3.0-rc.0"
 * as "0.3.0-0.rc.0" (scripts/deb-version.mjs, which scripts/dist.mjs hands to fpm). Packages up
 * to 0.3.0-rc.2 used electron-builder's default, every "-" turned into "~" ("0.3.0~rc.0").
 */
const debVersionMatches = (dpkgVersion: string, appVersion: string): boolean => {
  if (dpkgVersion === appVersion.replace(/-/g, "~")) return true
  try {
    return dpkgVersion === debVersionOf(appVersion)
  } catch {
    return false // not X.Y.Z[-prerelease]: never packaged by scripts/dist.mjs
  }
}

/** Running from /opt/Clickered, and dpkg has the `clickered` package installed at this version. */
export const linuxEligibility = async (
  execPath: string,
  currentVersion: string,
  runner: Runner,
  fs: InstallFs,
): Promise<Eligibility> => {
  const real = await fs.realpath(execPath).catch(() => execPath)
  if (real !== LINUX_EXEC) return { ok: false, why: `not the .deb install (running ${real})` }
  const r = await runner.run(DPKG_QUERY, ["-W", "-f=${Status}\\t${Version}\\t${Architecture}", PACKAGE_NAME])
  if (r.code !== 0) return { ok: false, why: `dpkg does not know ${PACKAGE_NAME}: ${lastErrorLine(r.stderr)}` }
  const [status, version, arch] = r.stdout.trim().split("\t")
  if (status !== "install ok installed") return { ok: false, why: `package state "${status}"` }
  if (version === undefined || !debVersionMatches(version, currentVersion)) return { ok: false, why: `dpkg has ${version}, running ${currentVersion}` }
  if (arch !== "amd64") return { ok: false, why: `package architecture ${arch}` }
  return { ok: true }
}

export const installLinux =
  (ctx: LinuxContext) =>
  (req: InstallRequest): Effect.Effect<AfterInstall, InstallError | ChecksumError> =>
    Effect.gen(function* () {
      const { runner, fs } = ctx
      if (!(yield* Effect.promise(() => fs.exists(PKEXEC))))
        return yield* fail(`${PKEXEC} not found. Install the update by hand: sudo apt install ${req.file}`)
      if (ctx.checkScript) {
        const bad = yield* Effect.promise(() => scriptProblem(ctx.script, fs))
        if (bad !== null) return yield* fail(`Refusing to run the install script: ${bad}.`)
      }
      const unsafe = yield* Effect.promise(() => downloadPathProblem(req.file, fs, ctx.me))
      if (unsafe !== null) return yield* fail(`Unsafe download location: ${unsafe}.`)
      // The prompt may stay open a long time; 30 min is only a backstop.
      const r = yield* exec(runner, PKEXEC, [ctx.script, req.file, req.sha256], 30 * 60_000)
      const why = lastErrorLine(r.stderr).replace(/^clickered-install-update: /, "")
      switch (r.code) {
        case 0:
          return { kind: "relaunch" } as const
        case 126:
          return yield* fail("The password prompt was cancelled.")
        case 127:
          return yield* fail(`Not authorized, or no polkit authentication agent is running (${why || "pkexec exit 127"}).`)
        case SCRIPT_EXIT.checksum:
          return yield* Effect.fail(new ChecksumError({ message: `Checked again as root: ${why || "checksum mismatch"}` }))
        case SCRIPT_EXIT.usage:
          return yield* fail(`The install script rejected its arguments: ${why || "bad arguments"}`)
        case SCRIPT_EXIT.missingTool:
        case SCRIPT_EXIT.copy:
          return yield* fail(`The install script failed: ${why || `exit ${r.code}`}`)
        default:
          return yield* fail(`apt-get failed (exit ${r.code ?? "killed"}): ${why || "no output"}`)
      }
    })

// ---------------------------------------------------------------------------
// Windows

/** electron-builder's NSIS uninstaller name (`Uninstall ${PRODUCT_FILENAME}.exe`), next to the exe. */
export const WIN_UNINSTALLER = `Uninstall ${PRODUCT_NAME}.exe`
export const NSIS_ARGS = ["--updated", "/S", "--force-run"] as const

/** An NSIS-installed copy: its uninstaller is next to the exe; not a portable or unpacked build. */
export const windowsEligibility = async (execPath: string, env: NodeJS.ProcessEnv, fs: InstallFs): Promise<Eligibility> => {
  if (env["PORTABLE_EXECUTABLE_DIR"]) return { ok: false, why: "portable build" }
  const dir = win32.dirname(execPath)
  if (!(await fs.exists(win32.join(dir, WIN_UNINSTALLER)))) return { ok: false, why: `no ${WIN_UNINSTALLER} in ${dir}` }
  return { ok: true }
}

export const installWindows =
  (runner: Runner) =>
  (req: InstallRequest): Effect.Effect<AfterInstall, InstallError> =>
    attempt("cannot start the installer", () => runner.spawnDetached(req.file, NSIS_ARGS)).pipe(
      Effect.as({ kind: "quit" } as const),
    )

// ---------------------------------------------------------------------------
// macOS

export const HDIUTIL = "/usr/bin/hdiutil"
export const DITTO = "/usr/bin/ditto"
export const PLISTBUDDY = "/usr/libexec/PlistBuddy"
export const CODESIGN = "/usr/bin/codesign"
const APP_DIR = `${PRODUCT_NAME}.app`
/** Staging folder beside the installed bundle: `.clickered-update-<16 hex>`. */
const STAGING = /^\.clickered-update-[0-9a-f]{16}$/

/** `/X/Clickered.app/Contents/MacOS/Clickered` → `/X/Clickered.app`, or null. */
export const macBundleOf = (execPath: string): string | null => {
  const macos = dirname(execPath)
  const contents = dirname(macos)
  const bundle = dirname(contents)
  if (basename(macos) !== "MacOS" || basename(contents) !== "Contents" || !bundle.endsWith(".app")) return null
  return bundle
}

/** Why replacing the bundle in place is not safe, or null when it is. */
export const macLocationProblem = async (bundle: string, fs: InstallFs): Promise<string | null> => {
  if (bundle.includes("/AppTranslocation/"))
    return "macOS runs this copy from a temporary, read-only location (App Translocation); move Clickered to Applications first"
  if (basename(bundle) !== APP_DIR) return `the app bundle is called ${basename(bundle)}, not ${APP_DIR}`
  if (!(await fs.isDir(bundle))) return `${bundle} is not a folder`
  const parent = dirname(bundle)
  // A read-only volume (e.g. the dmg itself) fails these too (EROFS).
  if (!(await fs.writable(parent))) return `${parent} is not writable`
  if (!(await fs.writable(bundle))) return `${bundle} is not writable`
  return null
}

export const macEligibility = async (execPath: string, fs: InstallFs): Promise<Eligibility> => {
  const bundle = macBundleOf(execPath)
  if (bundle === null) return { ok: false, why: `not running from an app bundle (${execPath})` }
  const problem = await macLocationProblem(bundle, fs)
  return problem === null ? { ok: true } : { ok: false, why: problem }
}

/**
 * Startup cleanup hook for `cleanDownloads` (macOS): a quit during an install can leave the
 * dmg attached at `<entry>/mnt`. Detach it (forced if needed); false keeps the entry when
 * it is still mounted, so nothing is deleted through a mount.
 */
export const detachStaleMount =
  (runner: Runner, fs: InstallFs, dev: (p: string) => Promise<number | null> = deviceOf) =>
  async (entry: string): Promise<boolean> => {
    const mnt = join(entry, "mnt")
    const mounted = async (): Promise<boolean> => {
      const [a, b] = await Promise.all([dev(mnt), dev(entry)])
      return a !== null && b !== null && a !== b
    }
    if ((await fs.info(mnt)) === null || !(await mounted())) return true
    const r = await runner.run(HDIUTIL, ["detach", mnt], { timeoutMs: 60_000 })
    if (r.code !== 0) await runner.run(HDIUTIL, ["detach", "-force", mnt], { timeoutMs: 60_000 })
    return !(await mounted())
  }

/** Delete staging/old bundles a crashed swap left beside the installed one. */
export const cleanMacLeftovers = async (bundle: string, fs: InstallFs): Promise<void> => {
  const parent = dirname(bundle)
  const names = await fs.readdir(parent).catch(() => [] as ReadonlyArray<string>)
  for (const n of names) if (STAGING.test(n)) await fs.rmrf(join(parent, n)).catch(() => {})
}

export interface MacContext {
  readonly runner: Runner
  readonly fs: InstallFs
  /** The installed bundle (from `macBundleOf(process.execPath)`). */
  readonly bundle: string
  /** Fallback: open the dmg in Finder (`shell.openPath`); resolves with "" or an error text. */
  readonly openPath: (p: string) => Promise<string>
  readonly log?: (m: string) => void
  /** Random suffix for staging names (tests). */
  readonly suffix?: () => string
}

const plistValue = (runner: Runner, plist: string, key: string): Effect.Effect<string> =>
  exec(runner, PLISTBUDDY, ["-c", `Print :${key}`, plist]).pipe(Effect.map((r) => (r.code === 0 ? r.stdout.trim() : "")))

export const installMac =
  (ctx: MacContext) =>
  (req: InstallRequest): Effect.Effect<AfterInstall, InstallError> =>
    Effect.gen(function* () {
      const { runner, fs, bundle } = ctx
      const log = ctx.log ?? (() => {})
      const suffix = ctx.suffix ?? (() => randomBytes(8).toString("hex"))

      const problem = yield* Effect.promise(() => macLocationProblem(bundle, fs))
      if (problem !== null) {
        const err = yield* attempt("cannot open the disk image", () => ctx.openPath(req.file))
        if (err) return yield* fail(`Cannot update in place (${problem}), and opening the disk image failed: ${err}`)
        return {
          kind: "manual",
          message: `Cannot update in place: ${problem}. The disk image was opened; drag Clickered into Applications.`,
        } as const
      }

      const parent = dirname(bundle)
      const mnt = join(req.dir, "mnt")
      yield* attempt("cannot create the mount point", () => fs.mkdirPrivate(mnt))
      const att = yield* exec(runner, HDIUTIL, ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, req.file], 5 * 60_000)
      if (att.code !== 0) return yield* fail(`hdiutil attach failed: ${lastErrorLine(att.stderr) || `exit ${att.code}`}`)

      // Staging folder on the same volume as the bundle, so the renames below are atomic.
      const staging = join(parent, `.clickered-update-${suffix()}`)
      const staged = join(staging, APP_DIR)
      const old = join(staging, `old-${APP_DIR}`)

      const swap = Effect.gen(function* () {
        const src = join(mnt, APP_DIR)
        if (!(yield* Effect.promise(() => fs.isDir(src)))) return yield* fail(`the disk image has no ${APP_DIR}`)
        yield* attempt("cannot create the staging folder", () => fs.mkdirPrivate(staging))
        const cp = yield* exec(runner, DITTO, [src, staged], 10 * 60_000)
        if (cp.code !== 0) return yield* fail(`copying the app failed: ${lastErrorLine(cp.stderr) || `exit ${cp.code}`}`)
        const plist = join(staged, "Contents", "Info.plist")
        const bid = yield* plistValue(runner, plist, "CFBundleIdentifier")
        if (bid !== BUNDLE_ID) return yield* fail(`the new app has bundle id "${bid}", expected ${BUNDLE_ID}`)
        const ver = yield* plistValue(runner, plist, "CFBundleShortVersionString")
        if (ver !== req.version) return yield* fail(`the new app is version "${ver}", expected ${req.version}`)
        const cs = yield* exec(runner, CODESIGN, ["--verify", "--deep", "--strict", staged], 5 * 60_000)
        if (cs.code !== 0) return yield* fail(`the new app's signature is invalid: ${lastErrorLine(cs.stderr) || `exit ${cs.code}`}`)

        // The swap: the old bundle stays (renamed) until the new one is in place. A critical
        // section: not interruptible, and quitting the app waits for it.
        yield* req.critical(
          Effect.gen(function* () {
            yield* attempt("cannot move the old app aside", () => fs.rename(bundle, old))
            yield* attempt("cannot move the new app into place", () => fs.rename(staged, bundle)).pipe(
              Effect.tapError(() =>
                Effect.promise(() =>
                  fs.rename(old, bundle).then(
                    () => fs.rmrf(staging),
                    () => log(`could not put ${old} back`),
                  ),
                ),
              ),
            )
          }),
        )
        yield* Effect.promise(() => fs.rmrf(staging).catch(() => log(`could not delete ${staging}`)))
        return { kind: "relaunch" } as const
      })

      const detach = Effect.gen(function* () {
        const d = yield* exec(runner, HDIUTIL, ["detach", mnt], 60_000)
        if (d.code !== 0) yield* exec(runner, HDIUTIL, ["detach", "-force", mnt], 60_000)
      })

      return yield* swap.pipe(
        // Never delete the staging folder while the old bundle may still be in it.
        Effect.tapError(() =>
          Effect.promise(async () => {
            if (!(await fs.exists(old))) await fs.rmrf(staging).catch(() => {})
          }),
        ),
        Effect.ensuring(detach),
      )
    })

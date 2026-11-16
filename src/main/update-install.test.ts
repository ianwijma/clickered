import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix, resolve } from "node:path"
import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import type { AfterInstall, ChecksumError, InstallError, InstallRequest } from "./update"
import {
  cleanMacLeftovers,
  CODESIGN,
  DITTO,
  detachStaleMount,
  downloadPathProblem,
  dryRunRunner,
  DPKG_QUERY,
  HDIUTIL,
  installLinux,
  installMac,
  installWindows,
  lastErrorLine,
  linuxEligibility,
  macBundleOf,
  macEligibility,
  macLocationProblem,
  nodeFs,
  PKEXEC,
  LINUX_INSTALL_SCRIPT,
  PLISTBUDDY,
  scriptProblem,
  windowsEligibility,
  type FileInfo,
  type InstallFs,
  type Runner,
  type RunResult,
} from "./update-install"

type Call = { kind: "run" | "spawn"; file: string; args: ReadonlyArray<string> }

const fakeRunner = (answer: (file: string, args: ReadonlyArray<string>) => Partial<RunResult> = () => ({})) => {
  const calls: Call[] = []
  const runner: Runner = {
    run: async (file, args) => {
      calls.push({ kind: "run", file, args })
      return { code: 0, stdout: "", stderr: "", ...answer(file, args) }
    },
    spawnDetached: async (file, args) => {
      calls.push({ kind: "spawn", file, args })
    },
  }
  return { runner, calls }
}

const fsWith = (over: Partial<InstallFs>): InstallFs => ({ ...nodeFs, ...over })
const allExist = fsWith({ exists: async () => true })

type Err = InstallError | ChecksumError
const run = (eff: Effect.Effect<AfterInstall, Err>) => Effect.runPromiseExit(eff)
const failure = (exit: Exit.Exit<AfterInstall, Err>): string | null => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : null)
const success = (exit: Exit.Exit<AfterInstall, Err>): AfterInstall | string =>
  Exit.isSuccess(exit) ? exit.value : `failed: ${Cause.pretty(exit.cause)}`

const SHA = "e".repeat(64)
const req = (dir: string, file = posix.join(dir, "clickered-0.3.0-amd64.deb"), version = "0.3.0"): InstallRequest => ({
  file,
  sha256: SHA,
  version,
  dir,
  critical: (eff) => Effect.uninterruptible(eff),
})

// --- a fake file tree for the ownership checks -------------------------------------

const ME = { uid: 1000, gid: 1000 }
const D = (uid: number, mode: number, gid = uid): FileInfo => ({ uid, gid, mode, kind: "dir", dev: 1 })
const F = (uid: number, mode: number, gid = uid): FileInfo => ({ uid, gid, mode, kind: "file", dev: 1 })
const DL = "/home/u/.config/clickered/updates/dl-1"
const DEB = `${DL}/clickered-0.3.0-amd64.deb`
const tree = (over: Record<string, FileInfo | null> = {}): Record<string, FileInfo | null> => ({
  "/": D(0, 0o755),
  "/opt": D(0, 0o755),
  "/opt/Clickered": D(0, 0o755),
  "/opt/Clickered/resources": D(0, 0o755),
  [LINUX_INSTALL_SCRIPT]: F(0, 0o755),
  "/home": D(0, 0o755),
  "/home/u": D(1000, 0o750),
  "/home/u/.config": D(1000, 0o700),
  "/home/u/.config/clickered": D(1000, 0o755),
  "/home/u/.config/clickered/updates": D(1000, 0o700),
  [DL]: D(1000, 0o700),
  [DEB]: F(1000, 0o600),
  ...over,
})
const treeFs = (t: Record<string, FileInfo | null>, extra: Partial<InstallFs> = {}): InstallFs =>
  fsWith({ exists: async () => true, realpath: async (p) => p, info: async (p) => t[p] ?? null, ...extra })

const linuxCtx = (runner: Runner, fs: InstallFs = treeFs(tree())) => ({
  runner,
  fs,
  me: ME,
  script: LINUX_INSTALL_SCRIPT,
  checkScript: true,
})

// ---------------------------------------------------------------------------

describe("Linux", () => {
  it("runs the root-owned install script through pkexec with the file and its hash, then relaunches", async () => {
    const { runner, calls } = fakeRunner()
    const exit = await run(installLinux(linuxCtx(runner))(req(DL)))
    expect(success(exit)).toEqual({ kind: "relaunch" })
    expect(calls).toEqual([{ kind: "run", file: PKEXEC, args: [LINUX_INSTALL_SCRIPT, DEB, SHA] }])
    expect(PKEXEC).toBe("/usr/bin/pkexec")
    expect(LINUX_INSTALL_SCRIPT).toBe("/opt/Clickered/resources/clickered-install-update")
  })

  const failsWith = async (r: Partial<RunResult>): Promise<string> => {
    const { runner } = fakeRunner(() => r)
    const exit = await run(installLinux(linuxCtx(runner))(req(DL)))
    expect(Exit.isFailure(exit)).toBe(true)
    return failure(exit) ?? ""
  }

  it("maps pkexec's and the script's exit codes to clear messages", async () => {
    expect(await failsWith({ code: 126 })).toMatch(/InstallError[\s\S]*cancelled/)
    expect(await failsWith({ code: 127, stderr: "Error executing command as another user: No authentication agent found.\n" })).toMatch(
      /polkit authentication agent.*No authentication agent found/,
    )
    expect(await failsWith({ code: 65, stderr: "clickered-install-update: checksum mismatch: expected e, got f\n" })).toMatch(
      /ChecksumError[\s\S]*Checked again as root: checksum mismatch/,
    )
    expect(await failsWith({ code: 64, stderr: "clickered-install-update: the package path must be absolute\n" })).toMatch(
      /InstallError[\s\S]*rejected its arguments: the package path must be absolute/,
    )
    expect(await failsWith({ code: 66, stderr: "clickered-install-update: apt-get not found\n" })).toMatch(/script failed: apt-get not found/)
    expect(await failsWith({ code: 67 })).toMatch(/script failed: exit 67/)
    expect(
      await failsWith({
        code: 100,
        stderr: "N: some notice\nE: Could not get lock /var/lib/dpkg/lock-frontend\n",
      }),
    ).toMatch(/apt-get failed \(exit 100\): E: Could not get lock/)
    expect(await failsWith({ code: null, stderr: "spawn ENOENT" })).toMatch(/killed/)
  })

  it("fails with instructions when pkexec is missing", async () => {
    const { runner, calls } = fakeRunner()
    const fs = treeFs(tree(), { exists: async (p) => p !== PKEXEC })
    const exit = await run(installLinux(linuxCtx(runner, fs))(req(DL)))
    expect(failure(exit)).toMatch(/pkexec not found.*sudo apt install \/home\/u/)
    expect(calls).toEqual([])
  })

  it("refuses an install script that is not root's own", async () => {
    for (const [over, why] of [
      [{ [LINUX_INSTALL_SCRIPT]: null }, /is missing/],
      [{ [LINUX_INSTALL_SCRIPT]: F(1000, 0o755) }, /not owned by root/],
      [{ [LINUX_INSTALL_SCRIPT]: F(0, 0o775) }, /writable by group or others/],
      [{ [LINUX_INSTALL_SCRIPT]: F(0, 0o757) }, /writable by group or others/],
      [{ [LINUX_INSTALL_SCRIPT]: F(0, 0o644) }, /not executable/],
      [{ [LINUX_INSTALL_SCRIPT]: { ...F(0, 0o777), kind: "symlink" } }, /not a regular file/],
      [{ "/opt/Clickered/resources": D(1000, 0o755) }, /resources is not owned by root/],
      [{ "/opt": D(0, 0o777) }, /\/opt is writable/],
    ] as const) {
      const { runner, calls } = fakeRunner()
      const exit = await run(installLinux(linuxCtx(runner, treeFs(tree(over))))(req(DL)))
      expect(failure(exit)).toMatch(/Refusing to run the install script/)
      expect(failure(exit)).toMatch(why)
      expect(calls).toEqual([])
    }
    const { runner, calls } = fakeRunner()
    const elsewhere = { ...linuxCtx(runner), script: "/home/u/clickered-install-update" }
    expect(failure(await run(installLinux(elsewhere)(req(DL))))).toMatch(/unexpected install script location/)
    expect(calls).toEqual([])
  })

  it("refuses a download location others could tamper with", async () => {
    for (const [over, why] of [
      [{ [DEB]: F(1000, 0o644) }, /accessible to group or others/],
      [{ [DEB]: F(1001, 0o600) }, /not owned by you/],
      [{ [DL]: D(1000, 0o770) }, /dl-1 is accessible/],
      [{ "/home/u/.config/clickered/updates": D(1001, 0o700) }, /updates is not owned by you/],
      [{ "/home/u/.config/clickered": D(1000, 0o757) }, /clickered is world-writable/],
      [{ "/home/u/.config": D(1000, 0o770, 100) }, /\.config is group-writable/],
      [{ "/home": D(1001, 0o755) }, /\/home belongs to another user/],
      [{ [DEB]: { ...F(1000, 0o600), kind: "symlink" } }, /not a file/],
    ] as const) {
      const { runner, calls } = fakeRunner()
      const exit = await run(installLinux(linuxCtx(runner, treeFs(tree(over))))(req(DL)))
      expect(failure(exit)).toMatch(/Unsafe download location/)
      expect(failure(exit)).toMatch(why)
      expect(calls).toEqual([])
    }
  })

  it("accepts the user-private group (umask 002) and sticky dirs like /tmp", async () => {
    expect(await downloadPathProblem(DEB, treeFs(tree({ "/home/u/.config": D(1000, 0o775) })), ME)).toBeNull()
    const t = {
      "/": D(0, 0o755),
      "/tmp": D(0, 0o1777),
      "/tmp/ud": D(1000, 0o700),
      "/tmp/ud/updates": D(1000, 0o700),
      "/tmp/ud/updates/dl-1": D(1000, 0o700),
      "/tmp/ud/updates/dl-1/x.deb": F(1000, 0o600),
    }
    expect(await downloadPathProblem("/tmp/ud/updates/dl-1/x.deb", treeFs(t), ME)).toBeNull()
    // The checks run on the real path.
    const viaLink = treeFs(tree(), { realpath: async () => DEB })
    expect(await downloadPathProblem("/x/link.deb", viaLink, ME)).toBeNull()
    expect(await scriptProblem(LINUX_INSTALL_SCRIPT, treeFs(tree()))).toBeNull()
  })

  it("skips the script checks only when told to (the unpackaged dry run)", async () => {
    const { runner, calls } = fakeRunner()
    const ctx = { ...linuxCtx(runner, treeFs(tree({ [LINUX_INSTALL_SCRIPT]: null }))), script: "/app/native/linux/x", checkScript: false }
    expect(success(await run(installLinux(ctx)(req(DL))))).toEqual({ kind: "relaunch" })
    expect(calls[0]!.args[0]).toBe("/app/native/linux/x")
  })

  it("is eligible only as the dpkg-installed /opt/Clickered at this version", async () => {
    const dpkg = (stdout: string, code = 0) => fakeRunner((f) => (f === DPKG_QUERY ? { code, stdout } : {})).runner
    const fs = fsWith({ realpath: async (p) => p })
    const good = "install ok installed\t0.2.0\tamd64"
    expect(await linuxEligibility("/opt/Clickered/clickered", "0.2.0", dpkg(good), fs)).toEqual({ ok: true })
    const { runner, calls } = fakeRunner((f) => (f === DPKG_QUERY ? { stdout: good } : {}))
    await linuxEligibility("/opt/Clickered/clickered", "0.2.0", runner, fs)
    expect(calls[0]).toEqual({ kind: "run", file: "/usr/bin/dpkg-query", args: ["-W", "-f=${Status}\\t${Version}\\t${Architecture}", "clickered"] })
    for (const [exec, out, code] of [
      ["/home/u/clickered/dist/linux-unpacked/clickered", good, 0],
      ["/opt/Clickered/clickered", "", 1],
      ["/opt/Clickered/clickered", "deinstall ok config-files\t0.2.0\tamd64", 0],
      ["/opt/Clickered/clickered", "install ok installed\t0.1.0\tamd64", 0],
      ["/opt/Clickered/clickered", "install ok installed\t0.2.0\tarm64", 0],
    ] as const)
      expect((await linuxEligibility(exec, "0.2.0", dpkg(out, code), fs)).ok).toBe(false)
    // The .deb's version (scripts/deb-version.mjs): "0.3.0-1" for 0.3.0, "0.3.0-0.rc.0" for 0.3.0-rc.0.
    for (const [deb, app] of [
      ["0.3.0-1", "0.3.0"],
      ["0.3.0-0.rc.0", "0.3.0-rc.0"],
      // Packages up to 0.3.0-rc.2: electron-builder's "-" -> "~".
      ["0.3.0~rc.0", "0.3.0-rc.0"],
    ] as const) {
      const out = `install ok installed\t${deb}\tamd64`
      expect(await linuxEligibility("/opt/Clickered/clickered", app, dpkg(out), fs)).toEqual({ ok: true })
      expect((await linuxEligibility("/opt/Clickered/clickered", "0.3.0-rc.1", dpkg(out), fs)).ok).toBe(false)
    }
    expect((await linuxEligibility("/opt/Clickered/clickered", "0.3.0", dpkg("install ok installed\t0.3.0-0.rc.0\tamd64"), fs)).ok).toBe(false)
    // /usr/bin/clickered is a symlink into /opt: resolved first.
    const viaLink = fsWith({ realpath: async () => "/opt/Clickered/clickered" })
    expect(await linuxEligibility("/usr/bin/clickered", "0.2.0", dpkg(good), viaLink)).toEqual({ ok: true })
  })
})

describe("Windows", () => {
  it("starts the NSIS installer silently and detached, then quits", async () => {
    const { runner, calls } = fakeRunner()
    const file = "C:\\Users\\u\\AppData\\Roaming\\clickered\\updates\\dl-1\\clickered-0.3.0-x64.exe"
    const exit = await run(installWindows(runner)(req("C:\\d", file)))
    expect(success(exit)).toEqual({ kind: "quit" })
    expect(calls).toEqual([{ kind: "spawn", file, args: ["--updated", "/S", "--force-run"] }])
  })

  it("reports an installer that cannot start", async () => {
    const runner: Runner = { run: async () => ({ code: 0, stdout: "", stderr: "" }), spawnDetached: () => Promise.reject(new Error("EACCES")) }
    expect(failure(await run(installWindows(runner)(req("C:\\d"))))).toMatch(/cannot start the installer: EACCES/)
  })

  it("is eligible only as an NSIS install (uninstaller next to the exe), not portable", async () => {
    const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\clickered\\Clickered.exe"
    const seen: string[] = []
    const fs = fsWith({
      exists: async (p) => {
        seen.push(p)
        return p.endsWith("Uninstall Clickered.exe")
      },
    })
    expect(await windowsEligibility(exe, {}, fs)).toEqual({ ok: true })
    expect(seen[0]).toMatch(/Uninstall Clickered\.exe$/)
    expect((await windowsEligibility(exe, { PORTABLE_EXECUTABLE_DIR: "C:\\x" }, fs)).ok).toBe(false)
    expect((await windowsEligibility(exe, {}, fsWith({ exists: async () => false }))).ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// macOS: the swap runs for real on temp dirs; hdiutil/ditto/PlistBuddy/codesign are faked.

const makeBundle = (at: string, version: string, id = "ma.wij.clickered"): void => {
  mkdirSync(join(at, "Contents", "MacOS"), { recursive: true })
  writeFileSync(join(at, "Contents", "Info.plist"), JSON.stringify({ CFBundleIdentifier: id, CFBundleShortVersionString: version }))
  writeFileSync(join(at, "Contents", "MacOS", "Clickered"), `binary ${version}`)
}

const macSetup = (o: { imageVersion?: string; imageId?: string; codesignCode?: number; attachCode?: number; dittoCode?: number } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "clickered-mac-"))
  const apps = join(root, "Applications")
  const bundle = join(apps, "Clickered.app")
  makeBundle(bundle, "0.2.0")
  const dir = join(root, "dl")
  mkdirSync(dir, { mode: 0o700 })
  const dmg = join(dir, "clickered-0.3.0-arm64.dmg")
  writeFileSync(dmg, "dmg")
  const { runner, calls } = fakeRunner((file, args) => {
    if (file === HDIUTIL && args[0] === "attach") {
      if (o.attachCode) return { code: o.attachCode, stderr: "hdiutil: attach failed - image not recognized" }
      const mnt = args[args.indexOf("-mountpoint") + 1]!
      makeBundle(join(mnt, "Clickered.app"), o.imageVersion ?? "0.3.0", o.imageId)
    }
    if (file === DITTO) {
      if (o.dittoCode) return { code: o.dittoCode, stderr: "ditto: No space left on device" }
      cpSync(args[0]!, args[1]!, { recursive: true })
    }
    if (file === PLISTBUDDY) {
      const key = args[1]!.replace("Print :", "")
      const plist = JSON.parse(readFileSync(args[2]!, "utf8")) as Record<string, string>
      return plist[key] === undefined ? { code: 1 } : { stdout: `${plist[key]}\n` }
    }
    if (file === CODESIGN && o.codesignCode) return { code: o.codesignCode, stderr: "a sealed resource is missing or invalid" }
    return {}
  })
  const opened: string[] = []
  const ctx = {
    runner,
    fs: nodeFs,
    bundle,
    openPath: async (p: string) => {
      opened.push(p)
      return ""
    },
    suffix: () => "0123456789abcdef",
  }
  return { root, apps, bundle, dir, dmg, runner, calls, ctx, opened }
}

const version = (bundle: string): string =>
  (JSON.parse(readFileSync(join(bundle, "Contents", "Info.plist"), "utf8")) as { CFBundleShortVersionString: string }).CFBundleShortVersionString

describe("macOS", () => {
  it("attaches, copies, checks, swaps, detaches, relaunches", async () => {
    const m = macSetup()
    const exit = await run(installMac(m.ctx)(req(m.dir, m.dmg)))
    expect(success(exit)).toEqual({ kind: "relaunch" })
    const mnt = join(m.dir, "mnt")
    const staged = join(m.apps, ".clickered-update-0123456789abcdef", "Clickered.app")
    expect(m.calls.map((c) => [c.file, ...c.args])).toEqual([
      [HDIUTIL, "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, m.dmg],
      [DITTO, join(mnt, "Clickered.app"), staged],
      [PLISTBUDDY, "-c", "Print :CFBundleIdentifier", join(staged, "Contents", "Info.plist")],
      [PLISTBUDDY, "-c", "Print :CFBundleShortVersionString", join(staged, "Contents", "Info.plist")],
      [CODESIGN, "--verify", "--deep", "--strict", staged],
      [HDIUTIL, "detach", mnt],
    ])
    expect(version(m.bundle)).toBe("0.3.0")
    expect(readdirSync(m.apps)).toEqual(["Clickered.app"]) // staging and the old bundle are gone
  })

  const rejects = async (o: Parameters<typeof macSetup>[0], pattern: RegExp) => {
    const m = macSetup(o)
    const exit = await run(installMac(m.ctx)(req(m.dir, m.dmg)))
    expect(failure(exit)).toMatch(pattern)
    // The installed app is untouched, nothing is left beside it, and the image is detached.
    expect(version(m.bundle)).toBe("0.2.0")
    expect(readdirSync(m.apps)).toEqual(["Clickered.app"])
    const last = m.calls.at(-1)!
    if (!o?.attachCode) expect([last.file, last.args[0]]).toEqual([HDIUTIL, "detach"])
  }

  it("refuses a bundle with the wrong id, version or signature", async () => {
    await rejects({ imageId: "com.evil.app" }, /bundle id "com.evil.app"/)
    await rejects({ imageVersion: "0.2.9" }, /version "0.2.9", expected 0.3.0/)
    await rejects({ codesignCode: 1 }, /signature is invalid: a sealed resource/)
    await rejects({ dittoCode: 1 }, /copying the app failed: ditto: No space/)
    await rejects({ attachCode: 1 }, /hdiutil attach failed/)
  })

  it("forces the detach when a plain detach fails", async () => {
    const m = macSetup()
    const base = m.ctx.runner
    const calls: string[][] = []
    const runner: Runner = {
      ...base,
      run: async (file, args, opts) => {
        calls.push([file, ...args])
        if (file === HDIUTIL && args[0] === "detach" && args[1] !== "-force") return { code: 16, stdout: "", stderr: "resource busy" }
        return base.run(file, args, opts)
      },
    }
    await run(installMac({ ...m.ctx, runner })(req(m.dir, m.dmg)))
    expect(calls.slice(-2).map((c) => c.slice(0, 3))).toEqual([
      [HDIUTIL, "detach", join(m.dir, "mnt")],
      [HDIUTIL, "detach", "-force"],
    ])
  })

  it("puts the old bundle back when the new one cannot be moved in", async () => {
    const m = macSetup()
    let n = 0
    const fs = fsWith({
      rename: async (a, b) => {
        n++
        if (n === 2) throw new Error("EXDEV")
        return nodeFs.rename(a, b)
      },
    })
    const exit = await run(installMac({ ...m.ctx, fs })(req(m.dir, m.dmg)))
    expect(failure(exit)).toMatch(/cannot move the new app into place/)
    expect(version(m.bundle)).toBe("0.2.0")
    expect(readdirSync(m.apps)).toEqual(["Clickered.app"])
  })

  it("opens the dmg instead when the location is not safe", async () => {
    const m = macSetup()
    const fs = fsWith({ writable: async (p) => p !== m.apps })
    const exit = await run(installMac({ ...m.ctx, fs })(req(m.dir, m.dmg)))
    expect(Exit.isSuccess(exit) && exit.value.kind).toBe("manual")
    expect(Exit.isSuccess(exit) && exit.value.kind === "manual" && exit.value.message).toMatch(/not writable.*disk image was opened/)
    expect(m.opened).toEqual([m.dmg])
    expect(m.calls).toEqual([])
  })

  it("finds the bundle and judges its location", async () => {
    expect(macBundleOf("/Applications/Clickered.app/Contents/MacOS/Clickered")).toBe("/Applications/Clickered.app")
    expect(macBundleOf("/usr/local/bin/clickered")).toBeNull()
    const ok = fsWith({ isDir: async () => true, writable: async () => true })
    expect(await macLocationProblem("/Applications/Clickered.app", ok)).toBeNull()
    expect(
      await macLocationProblem("/private/var/folders/x/T/AppTranslocation/ABC/d/Clickered.app", ok),
    ).toMatch(/Translocation/)
    expect(await macLocationProblem("/Applications/Clickered 2.app", ok)).toMatch(/called/)
    expect(await macLocationProblem("/Volumes/Clickered/Clickered.app", fsWith({ isDir: async () => true, writable: async () => false }))).toMatch(
      /not writable/,
    )
    expect(await macEligibility("/Applications/Clickered.app/Contents/MacOS/Clickered", ok)).toEqual({ ok: true })
    expect((await macEligibility("/x/clickered", ok)).ok).toBe(false)
  })

  it("cleans up staging folders a crashed swap left behind (and nothing else)", async () => {
    const m = macSetup()
    mkdirSync(join(m.apps, ".clickered-update-0123456789abcdef"))
    mkdirSync(join(m.apps, ".clickered-update-zz"))
    mkdirSync(join(m.apps, "Other.app"))
    await cleanMacLeftovers(m.bundle, nodeFs)
    expect(readdirSync(m.apps).sort()).toEqual([".clickered-update-zz", "Clickered.app", "Other.app"])
  })
})

describe("macOS critical section and stale mounts", () => {
  it("does both renames of the swap inside the critical section", async () => {
    const m = macSetup()
    let inside = false
    const renames: Array<[string, boolean]> = []
    const fs = fsWith({
      rename: async (a, b) => {
        renames.push([b, inside])
        return nodeFs.rename(a, b)
      },
    })
    const r: InstallRequest = {
      ...req(m.dir, m.dmg),
      critical: (eff) =>
        Effect.sync(() => {
          inside = true
        }).pipe(
          Effect.andThen(eff),
          Effect.ensuring(
            Effect.sync(() => {
              inside = false
            }),
          ),
        ),
    }
    expect(success(await run(installMac({ ...m.ctx, fs })(r)))).toEqual({ kind: "relaunch" })
    expect(renames.map(([, i]) => i)).toEqual([true, true])
  })

  it("detaches a dmg a quit left mounted before the folder is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "clickered-mnt-"))
    const entry = join(root, "dl-1")
    mkdirSync(join(entry, "mnt"), { recursive: true })
    let mounted = true
    const dev = async (p: string) => (p.endsWith("mnt") && mounted ? 2 : 1)
    const { runner, calls } = fakeRunner((_f, args) => {
      if (args[0] === "detach" && args[1] === "-force") mounted = false
      return args[1] === "-force" ? {} : { code: 16 }
    })
    expect(await detachStaleMount(runner, nodeFs, dev)(entry)).toBe(true)
    expect(calls.map((c) => [c.file, ...c.args])).toEqual([
      [HDIUTIL, "detach", join(entry, "mnt")],
      [HDIUTIL, "detach", "-force", join(entry, "mnt")],
    ])
    // Still mounted after both: keep the folder (never delete through a mount).
    mounted = true
    const stuck = fakeRunner(() => ({ code: 16 }))
    expect(await detachStaleMount(stuck.runner, nodeFs, dev)(entry)).toBe(false)
    // Not mounted, or no mnt at all: nothing to run.
    mounted = false
    const idle = fakeRunner()
    expect(await detachStaleMount(idle.runner, nodeFs, dev)(entry)).toBe(true)
    expect(await detachStaleMount(idle.runner, nodeFs, dev)(join(root, "other"))).toBe(true)
    expect(idle.calls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The shipped root-side script, run unprivileged. Its fixed PATH means no stub can be
// slipped in, so only the paths that end before apt-get (or where an unprivileged
// apt-get fails harmlessly) are tested here; e2e/install-script.e2e.test.ts runs it as
// root in the container with a real package.

const SCRIPT = resolve(import.meta.dirname, "../../native/linux/clickered-install-update")
const canRunScript =
  process.platform === "linux" && process.getuid?.() !== 0 && existsSync("/usr/bin/sha256sum") && existsSync("/bin/sh")

describe.runIf(canRunScript)("native/linux/clickered-install-update (unprivileged)", () => {
  const runScript = (...args: string[]) => {
    const r = spawnSync(SCRIPT, args, { encoding: "utf8", env: { PATH: "/nonexistent" } })
    return { code: r.status, err: r.stderr }
  }
  const leftovers = () => readdirSync("/tmp").filter((n) => n.startsWith("clickered-update."))

  it("is executable and checked into the repo as such", () => {
    expect(statSync(SCRIPT).mode & 0o755).toBe(0o755)
  })

  it("rejects bad arguments with exit 64", () => {
    const h = "a".repeat(64)
    for (const args of [
      [],
      ["/tmp/x.deb"],
      ["/tmp/x.deb", h, "extra"],
      ["tmp/x.deb", h],
      ["/tmp/x.tar", h],
      ["/tmp/a b.deb", h],
      ["/tmp/a;rm -rf x.deb", h],
      ["/tmp/../etc/x.deb", h],
      ["/tmp/./x.deb", h],
      ["/tmp/x.deb", h.toUpperCase()],
      ["/tmp/x.deb", h.slice(1)],
      ["/tmp/x.deb", `${h.slice(1)}g`],
      ["/tmp/x.deb", ""],
    ])
      expect(runScript(...args).code, JSON.stringify(args)).toBe(64)
  })

  it("rejects a file whose copy does not match the hash (exit 65), and cleans up", () => {
    const dir = mkdtempSync(join(tmpdir(), "clickered-script-"))
    const deb = join(dir, "clickered-0.3.0-amd64.deb")
    writeFileSync(deb, "not the release")
    const before = leftovers()
    const r = runScript(deb, "a".repeat(64))
    expect(r.code).toBe(65)
    expect(r.err).toMatch(/checksum mismatch: expected a{64}, got [0-9a-f]{64}/)
    expect(leftovers()).toEqual(before)
  })

  it("fails with exit 67 for a file it cannot read", () => {
    expect(runScript("/nonexistent/clickered-0.3.0-amd64.deb", "a".repeat(64)).code).toBe(67)
  })

  it.runIf(existsSync("/usr/bin/apt-get"))("hands a matching copy to apt-get (which fails without root)", () => {
    const dir = mkdtempSync(join(tmpdir(), "clickered-script-"))
    const deb = join(dir, "clickered-0.3.0-amd64.deb")
    writeFileSync(deb, "not a real package")
    const sha = createHash("sha256").update("not a real package").digest("hex")
    const r = runScript(deb, sha)
    // Past the checksum: apt-get ran and refused (no root, or not a valid archive).
    expect([64, 65, 66, 67]).not.toContain(r.code)
    expect(r.code).not.toBe(0)
    expect(r.err).not.toMatch(/checksum mismatch/)
  })
})

describe("helpers", () => {
  it("lastErrorLine skips apt notices", () => {
    expect(lastErrorLine("N: notice\nE: real problem\nW: warning\n")).toBe("E: real problem")
    expect(lastErrorLine("")).toBe("")
  })

  it("the dry-run runner records instead of running", async () => {
    const log = join(mkdtempSync(join(tmpdir(), "clickered-dry-")), "dry.log")
    const r = dryRunRunner(log)
    const exit = await run(installLinux({ ...linuxCtx(r), checkScript: false })(req(DL)))
    expect(success(exit)).toEqual({ kind: "relaunch" })
    await r.spawnDetached("C:\\x.exe", ["/S"])
    expect(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown)).toEqual([
      { cmd: [PKEXEC, LINUX_INSTALL_SCRIPT, DEB, SHA] },
      { cmd: ["C:\\x.exe", "/S"] },
    ])
    expect(existsSync(log)).toBe(true)
  })
})

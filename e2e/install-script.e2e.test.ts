/**
 * The Linux updater's root-side step, native/linux/clickered-install-update, run for real
 * as root inside the e2e container (the app runs it through pkexec). It installs a dummy
 * package built here with dpkg-deb, so nothing of the app itself is touched.
 */
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ROOT, assertSandbox } from "./support/x11"

const SCRIPT = join(ROOT, "native", "linux", "clickered-install-update")
const PKG = "clickered-e2e-dummy"

const sh = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const installed = (): string => sh("dpkg-query", ["-W", "-f=${Status} ${Version}", PKG]).out
const leftovers = (): string[] => readdirSync("/tmp").filter((n) => n.startsWith("clickered-update."))

/** A minimal package (one file under /usr/share) in a 0700 directory owned by a normal user. */
const buildDeb = (version: string): { deb: string; sha: string } => {
  const work = mkdtempSync(join(tmpdir(), "clickered-deb-"))
  const root = join(work, "pkg")
  mkdirSync(join(root, "DEBIAN"), { recursive: true })
  mkdirSync(join(root, "usr", "share", PKG), { recursive: true })
  writeFileSync(
    join(root, "DEBIAN", "control"),
    `Package: ${PKG}\nVersion: ${version}\nArchitecture: all\nMaintainer: e2e <e2e@example.invalid>\nDescription: clickered e2e dummy\n`,
  )
  writeFileSync(join(root, "usr", "share", PKG, "version"), version + "\n")
  // Like the app's download folder: private to its (non-root) owner.
  const dl = join(work, "updates", "dl-1")
  mkdirSync(dl, { recursive: true, mode: 0o700 })
  const deb = join(dl, `clickered-${version}-amd64.deb`)
  const b = sh("dpkg-deb", ["--root-owner-group", "--build", root, deb])
  if (b.code !== 0) throw new Error(`dpkg-deb failed: ${b.err}`)
  sh("chown", ["-R", "nobody:nogroup", join(work, "updates")])
  sh("chmod", ["0700", join(work, "updates"), dl])
  sh("chmod", ["0600", deb])
  return { deb, sha: createHash("sha256").update(readFileSync(deb)).digest("hex") }
}

beforeAll(() => {
  assertSandbox()
  if (process.getuid?.() !== 0) throw new Error("this suite must run as root (the e2e container does)")
})

afterAll(() => {
  sh("dpkg", ["--purge", PKG])
})

describe("install script (root, e2e container)", () => {
  it("copies, verifies and installs the package, without apt's _apt sandbox notice", () => {
    expect(sh("id", ["-u", "_apt"]).code).toBe(0) // the sandbox user exists here
    const { deb, sha } = buildDeb("1.0.0")
    const before = leftovers()
    const r = sh(SCRIPT, [deb, sha])
    expect(r.code, r.err).toBe(0)
    expect(installed()).toBe("install ok installed 1.0.0")
    expect(readFileSync(`/usr/share/${PKG}/version`, "utf8")).toBe("1.0.0\n")
    expect(r.err + r.out).not.toMatch(/unsandboxed|couldn't be accessed by user '_apt'/)
    expect(leftovers()).toEqual(before)
  })

  it("upgrades to a newer version", () => {
    const { deb, sha } = buildDeb("1.0.1")
    const r = sh(SCRIPT, [deb, sha])
    expect(r.code, r.err).toBe(0)
    expect(installed()).toBe("install ok installed 1.0.1")
  })

  it("refuses a file whose hash is not the expected one (exit 65), installing nothing", () => {
    const { deb } = buildDeb("1.0.2")
    const before = leftovers()
    const r = sh(SCRIPT, [deb, "0".repeat(64)])
    expect(r.code).toBe(65)
    expect(r.err).toMatch(/checksum mismatch/)
    expect(installed()).toBe("install ok installed 1.0.1")
    expect(leftovers()).toEqual(before)
  })

  it("rejects bad arguments (exit 64) before touching anything", () => {
    const { deb, sha } = buildDeb("1.0.3")
    for (const args of [[deb], [deb, sha.toUpperCase()], [deb.slice(1), sha], [`${deb}/../x.deb`, sha]]) {
      expect(sh(SCRIPT, args).code, JSON.stringify(args)).toBe(64)
    }
    expect(installed()).toBe("install ok installed 1.0.1")
  })

  it("ignores the caller's PATH", () => {
    // A fake apt-get earlier on PATH must not be used.
    const bin = mkdtempSync(join(tmpdir(), "clickered-bin-"))
    writeFileSync(join(bin, "apt-get"), "#!/bin/sh\necho FAKE >&2\nexit 0\n", { mode: 0o755 })
    const { deb, sha } = buildDeb("1.0.4")
    const r = spawnSync(SCRIPT, [deb, sha], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toMatch(/FAKE/)
    expect(installed()).toBe("install ok installed 1.0.4")
  })
})

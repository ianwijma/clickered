import { describe, expect, it } from "vitest"
import {
  assetNameFor,
  checksumProblem,
  compareVersions,
  endpointsFor,
  GITHUB_POLICY,
  githubEndpoints,
  isAllowedUrl,
  NO_HOOKS,
  offerableVersion,
  parseRelease,
  parseSha256Sums,
  parseVersion,
  readTestHooks,
  shouldPushProgress,
  type Target,
} from "./update-core"

const v = (s: string) => {
  const p = parseVersion(s)
  if (!p) throw new Error(`bad ${s}`)
  return p
}

describe("versions", () => {
  it("parses strict semver, with an optional leading v", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
    expect(parseVersion("v1.2.3-rc.0")).toEqual({ major: 1, minor: 2, patch: 3, pre: ["rc", "0"] })
    expect(parseVersion("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, pre: [] })
  })

  it("rejects malformed versions", () => {
    for (const bad of ["", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", "v", "vv1.2.3", " 1.2.3", "1.2.3 ", "1.2.x", "latest", "1.2.3-rc..1", "99999999999999999999.0.0", "-1.2.3"])
      expect(parseVersion(bad)).toBeNull()
  })

  it("orders by SemVer precedence", () => {
    const sorted = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.1.0", "2.0.0", "10.0.0"]
    for (let i = 0; i < sorted.length - 1; i++) {
      expect(compareVersions(v(sorted[i]!), v(sorted[i + 1]!))).toBeLessThan(0)
      expect(compareVersions(v(sorted[i + 1]!), v(sorted[i]!))).toBeGreaterThan(0)
    }
    expect(compareVersions(v("1.2.3"), v("v1.2.3+meta"))).toBe(0)
  })

  it("offers only a strictly newer stable release", () => {
    expect(offerableVersion("0.2.0", "v0.3.0")).toBe("0.3.0")
    expect(offerableVersion("0.2.0", "0.2.1")).toBe("0.2.1")
    expect(offerableVersion("0.3.0-rc.1", "v0.3.0")).toBe("0.3.0")
    expect(offerableVersion("0.2.0", "v0.2.0")).toBeNull() // equal
    expect(offerableVersion("0.3.0", "v0.2.9")).toBeNull() // downgrade
    expect(offerableVersion("0.2.0", "v0.3.0-rc.0")).toBeNull() // prerelease
    expect(offerableVersion("0.2.0", "garbage")).toBeNull()
    expect(offerableVersion("dev", "v9.0.0")).toBeNull()
  })
})

describe("assetNameFor", () => {
  const t = (platform: NodeJS.Platform, arch: string, rosetta = false): Target => ({ platform, arch, rosetta })
  it("follows the release naming scheme", () => {
    expect(assetNameFor(t("linux", "x64"), "1.2.3")).toBe("clickered-1.2.3-amd64.deb")
    expect(assetNameFor(t("darwin", "arm64"), "1.2.3")).toBe("clickered-1.2.3-arm64.dmg")
    expect(assetNameFor(t("darwin", "x64"), "1.2.3")).toBe("clickered-1.2.3-x64.dmg")
    expect(assetNameFor(t("win32", "x64"), "1.2.3")).toBe("clickered-1.2.3-x64.exe")
  })
  it("prefers arm64 under Rosetta", () => {
    expect(assetNameFor(t("darwin", "x64", true), "1.2.3")).toBe("clickered-1.2.3-arm64.dmg")
  })
  it("has nothing for other platforms and architectures", () => {
    expect(assetNameFor(t("linux", "arm64"), "1.2.3")).toBeNull()
    expect(assetNameFor(t("win32", "arm64"), "1.2.3")).toBeNull()
    expect(assetNameFor(t("win32", "ia32"), "1.2.3")).toBeNull()
    expect(assetNameFor(t("freebsd", "x64"), "1.2.3")).toBeNull()
  })
})

const HASH = "a".repeat(64)
const release = (patch: Record<string, unknown> = {}, assets?: unknown[]) => ({
  tag_name: "v0.3.0",
  draft: false,
  prerelease: false,
  assets: assets ?? [
    { name: "clickered-0.3.0-amd64.deb", size: 1000, state: "uploaded", digest: `sha256:${HASH}` },
    { name: "clickered-0.3.0-x64.exe", size: 2000, state: "uploaded", digest: null },
    { name: "SHA256SUMS.txt", size: 300, state: "uploaded" },
  ],
  ...patch,
})
const linux: Target = { platform: "linux", arch: "x64", rosetta: false }
const win: Target = { platform: "win32", arch: "x64", rosetta: false }

describe("parseRelease", () => {
  it("builds the offer for this platform", () => {
    expect(parseRelease(release(), "0.2.0", linux)).toEqual({
      ok: true,
      value: {
        version: "0.3.0",
        tag: "v0.3.0",
        asset: { name: "clickered-0.3.0-amd64.deb", size: 1000, sha256: HASH },
        sums: { name: "SHA256SUMS.txt", size: 300, sha256: null },
      },
    })
    const w = parseRelease(release(), "0.2.0", win)
    expect(w.ok && w.value.asset).toEqual({ name: "clickered-0.3.0-x64.exe", size: 2000, sha256: null })
  })

  it("offers nothing when up to date, for drafts/prereleases, or for odd tags", () => {
    expect(parseRelease(release(), "0.3.0", linux).ok).toBe(false)
    expect(parseRelease(release(), "0.4.0", linux).ok).toBe(false)
    expect(parseRelease(release({ draft: true }), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({ prerelease: true }), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({ prerelease: undefined }), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({ tag_name: "v0.3.0-rc.1" }), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({ tag_name: "v0.3.0/../../x" }), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({ tag_name: 3 }), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(null, "0.2.0", linux).ok).toBe(false)
    expect(parseRelease([], "0.2.0", linux).ok).toBe(false)
  })

  it("requires the exact asset and SHA256SUMS.txt, once each, uploaded, with a sane size", () => {
    const deb = (p: Record<string, unknown>) => ({ name: "clickered-0.3.0-amd64.deb", size: 1000, ...p })
    const sums = { name: "SHA256SUMS.txt", size: 300 }
    expect(parseRelease(release({}, [deb({})]), "0.2.0", linux).ok).toBe(false) // no sums
    expect(parseRelease(release({}, [sums]), "0.2.0", linux).ok).toBe(false) // no deb
    expect(parseRelease(release({}, [deb({ name: "Clickered-0.3.0-amd64.deb" }), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({}), deb({}), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({ state: "starter" }), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({ size: 0 }), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({ size: 10 ** 12 }), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({ size: "1000" }), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({}), { ...sums, size: 10 ** 7 }]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({ digest: "sha256:xyz" }), sums]), "0.2.0", linux).ok).toBe(false)
    expect(parseRelease(release({}, [deb({ digest: 5 }), sums]), "0.2.0", linux).ok).toBe(false)
    // Another algorithm: ignored (SHA256SUMS.txt still applies).
    const other = parseRelease(release({}, [deb({ digest: "sha512:abc" }), sums]), "0.2.0", linux)
    expect(other.ok && other.value.asset.sha256).toBeNull()
    // Upper-case digests are normalised.
    const upper = parseRelease(release({}, [deb({ digest: `sha256:${"AB".repeat(32)}` }), sums]), "0.2.0", linux)
    expect(upper.ok && upper.value.asset.sha256).toBe("ab".repeat(32))
  })
})

describe("parseSha256Sums", () => {
  const b = "b".repeat(64)
  it("parses sha256sum output (text and binary mode, CRLF)", () => {
    const r = parseSha256Sums(`${HASH}  clickered-0.3.0-amd64.deb\n${b.toUpperCase()} *clickered-0.3.0-x64.exe\r\n\n`)
    expect(r.ok && [...r.value]).toEqual([
      ["clickered-0.3.0-amd64.deb", HASH],
      ["clickered-0.3.0-x64.exe", b],
    ])
  })
  it("rejects malformed lines and conflicting duplicates", () => {
    expect(parseSha256Sums(`${HASH} clickered.deb`).ok).toBe(false) // one space
    expect(parseSha256Sums(`${HASH.slice(1)}  clickered.deb`).ok).toBe(false)
    expect(parseSha256Sums(`<html>`).ok).toBe(false)
    expect(parseSha256Sums(`${HASH}  x\n${b}  x`).ok).toBe(false)
    expect(parseSha256Sums(`${HASH}  x\n${HASH}  x`).ok).toBe(true)
  })
})

describe("checksumProblem", () => {
  const b = "b".repeat(64)
  it("requires the SHA256SUMS entry and the API digest (when present) to match", () => {
    expect(checksumProblem(HASH, HASH, HASH)).toBeNull()
    expect(checksumProblem(HASH, HASH, null)).toBeNull()
    expect(checksumProblem(HASH, undefined, HASH)).toMatch(/not listed/)
    expect(checksumProblem(HASH, b, HASH)).toMatch(/SHA256SUMS/)
    expect(checksumProblem(HASH, HASH, b)).toMatch(/digest/)
  })
})

describe("isAllowedUrl", () => {
  it("allows GitHub's release hosts over https only", () => {
    for (const ok of [
      "https://api.github.com/repos/ianwijma/clickered/releases/latest",
      "https://github.com/ianwijma/clickered/releases/download/v1.0.0/clickered-1.0.0-amd64.deb",
      "https://objects.githubusercontent.com/github-production-release-asset/1?X-Amz-Signature=abc",
      "https://release-assets.githubusercontent.com/github-production-release-asset/1?sp=r&sig=x",
    ])
      expect(isAllowedUrl(ok, GITHUB_POLICY)).toBe(true)
    for (const bad of [
      "http://github.com/ianwijma/clickered/releases/download/v1/x.deb",
      "https://github.com.evil.example/x",
      "https://evilgithub.com/x",
      "https://user:pass@github.com/x",
      "https://github.com:8443/x",
      "https://raw.githubusercontent.com/x",
      "https://127.0.0.1/x",
      "http://localhost:8123/x",
      "file:///etc/passwd",
      "ftp://github.com/x",
      "not a url",
      "",
    ])
      expect(isAllowedUrl(bad, GITHUB_POLICY)).toBe(false)
  })

  it("builds GitHub URLs with the tag and name encoded", () => {
    const e = githubEndpoints()
    expect(e.latest).toBe("https://api.github.com/repos/ianwijma/clickered/releases/latest")
    expect(e.download("v1.0.0", "SHA256SUMS.txt")).toBe(
      "https://github.com/ianwijma/clickered/releases/download/v1.0.0/SHA256SUMS.txt",
    )
    expect(e.download("v1.0.0", "a/../b")).toBe("https://github.com/ianwijma/clickered/releases/download/v1.0.0/a%2F..%2Fb")
  })
})

describe("test hooks", () => {
  const env = {
    CLICKERED_UPDATE_BASE_URL: "http://127.0.0.1:8123/",
    CLICKERED_UPDATE_FORCE: "1",
    CLICKERED_UPDATE_DRY_RUN: "/tmp/dry.log",
  }

  it("are ignored entirely by a packaged build", () => {
    expect(readTestHooks(env, true)).toEqual(NO_HOOKS)
    const e = endpointsFor(readTestHooks(env, true))
    expect(e.latest).toBe("https://api.github.com/repos/ianwijma/clickered/releases/latest")
    expect(isAllowedUrl("http://127.0.0.1:8123/x", e.policy)).toBe(false)
  })

  it("redirect everything to the test server when unpackaged", () => {
    const hooks = readTestHooks(env, false)
    expect(hooks).toEqual({ baseUrl: "http://127.0.0.1:8123", force: true, dryRunLog: "/tmp/dry.log" })
    const e = endpointsFor(hooks)
    expect(e.latest).toBe("http://127.0.0.1:8123/repos/ianwijma/clickered/releases/latest")
    expect(e.download("v1.0.0", "x.deb")).toBe("http://127.0.0.1:8123/ianwijma/clickered/releases/download/v1.0.0/x.deb")
    expect(isAllowedUrl("http://127.0.0.1:8123/anything", e.policy)).toBe(true)
    // Only that origin: not GitHub, not another port.
    expect(isAllowedUrl("http://127.0.0.1:8124/x", e.policy)).toBe(false)
    expect(isAllowedUrl("https://github.com/x", e.policy)).toBe(false)
  })

  it("ignore malformed or unset values", () => {
    expect(readTestHooks({}, false)).toEqual(NO_HOOKS)
    expect(readTestHooks({ CLICKERED_UPDATE_BASE_URL: "file:///x", CLICKERED_UPDATE_FORCE: "yes" }, false)).toEqual(NO_HOOKS)
    expect(readTestHooks({ CLICKERED_UPDATE_BASE_URL: "::" }, false)).toEqual(NO_HOOKS)
  })
})

describe("shouldPushProgress", () => {
  it("throttles, but always sends the first and the last", () => {
    expect(shouldPushProgress(null, 0, 0)).toBe(true)
    expect(shouldPushProgress(1000, 1100, 0.5)).toBe(false)
    expect(shouldPushProgress(1000, 1250, 0.5)).toBe(true)
    expect(shouldPushProgress(1000, 1001, 1)).toBe(true)
  })
})

/**
 * Pure building blocks of the in-app updater (./update.ts): version comparison, the
 * release asset for this platform, GitHub release parsing, SHA256SUMS.txt parsing, the URL
 * allowlist and the test hooks. Nothing here does I/O.
 */

// ---------------------------------------------------------------------------
// Repository and endpoints

export const REPO = "ianwijma/clickered"
/** Bundle id (electron-builder.yml `appId`), checked on the staged macOS bundle. */
export const BUNDLE_ID = "ma.wij.clickered"
/** electron-builder.yml `productName`: the macOS bundle name and the Windows uninstaller name. */
export const PRODUCT_NAME = "Clickered"
/** package.json `name`: the .deb package name and the prefix of every release file. */
export const PACKAGE_NAME = "clickered"
export const SUMS_NAME = "SHA256SUMS.txt"

/**
 * Hosts a download may touch, every redirect hop included. api.github.com answers the
 * release query; github.com serves `/releases/download/...` and redirects to the asset CDN
 * (release-assets.githubusercontent.com since 2025, objects.githubusercontent.com before).
 */
export const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  "api.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
])

export interface UrlPolicy {
  /** Exact host names (lower case) allowed over https on the default port. */
  readonly hosts: ReadonlySet<string>
  /** Test hook only (never in a packaged build): one extra origin, http allowed. */
  readonly extraOrigin: string | null
}

export const GITHUB_POLICY: UrlPolicy = { hosts: GITHUB_HOSTS, extraOrigin: null }

/** May the updater request this URL (the first request and every redirect target)? */
export const isAllowedUrl = (raw: string, policy: UrlPolicy): boolean => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.username !== "" || u.password !== "") return false
  if (policy.extraOrigin !== null && u.origin === policy.extraOrigin) return true
  return u.protocol === "https:" && u.port === "" && policy.hosts.has(u.hostname)
}

export interface Endpoints {
  /** The "latest release" query (full releases only: the "Pre-release updates" setting off). */
  readonly latest: string
  /** The release list query (the setting on: release candidates and betas too). */
  readonly releases: string
  /** Where a release file is downloaded from. */
  readonly download: (tag: string, name: string) => string
  readonly policy: UrlPolicy
}

/**
 * The release check uses the REST endpoint `GET /repos/{repo}/releases/latest` rather than
 * following the `github.com/{repo}/releases/latest` redirect: it returns exactly the newest
 * non-draft, non-prerelease release, and with it every asset's size and SHA-256 `digest`
 * (a second checksum, recorded by GitHub at upload time, next to SHA256SUMS.txt). The
 * unauthenticated limit of 60 requests per hour and IP is far above one check per start
 * and one per day; when it is hit anyway (many users behind one NAT) the check fails
 * quietly and the next one tries again.
 *
 * With "Pre-release updates" on, `GET /repos/{repo}/releases` is asked instead: the newest
 * `RELEASES_PER_PAGE` releases (newest first by creation date, drafts only ever visible to
 * the repository's collaborators), from which `selectRelease` picks the highest version.
 */
export const githubEndpoints = (): Endpoints => ({
  latest: `https://api.github.com/repos/${REPO}/releases/latest`,
  releases: `https://api.github.com/repos/${REPO}/releases?per_page=${RELEASES_PER_PAGE}`,
  download: (tag, name) =>
    `https://github.com/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
  policy: GITHUB_POLICY,
})

/** Releases read by the list query: plenty to find the newest one of each kind. */
export const RELEASES_PER_PAGE = 30

/**
 * The GitHub page of a release (its notes / changelog), built only from a valid version:
 * `https://github.com/<REPO>/releases/tag/v<version>`. Null for anything that is not one.
 * Opening it is not a download, so it is always github.com, test hooks or not.
 */
export const releaseNotesUrl = (version: string): string | null => {
  const v = version.startsWith("v") ? null : parseVersion(version)
  if (v === null) return null
  const url = `https://github.com/${REPO}/releases/tag/${encodeURIComponent(`v${formatVersion(v)}`)}`
  return isAllowedUrl(url, GITHUB_POLICY) ? url : null
}

// ---------------------------------------------------------------------------
// Versions (strict SemVer 2.0.0)

export interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Prerelease identifiers ("rc", "1"), empty for a release. */
  readonly pre: ReadonlyArray<string>
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Parse "1.2.3", "1.2.3-rc.0" (an optional leading "v" is allowed for tags); null if malformed. */
export const parseVersion = (raw: string): Version | null => {
  if (raw.length > 64) return null
  const m = SEMVER.exec(raw.startsWith("v") ? raw.slice(1) : raw)
  if (!m) return null
  const nums = [m[1], m[2], m[3]].map(Number)
  if (!nums.every(Number.isSafeInteger)) return null
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre: m[4] ? m[4].split(".") : [] }
}

const isNumeric = (s: string): boolean => /^\d+$/.test(s)

const comparePre = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): number => {
  if (a.length === 0 || b.length === 0) return a.length === 0 ? (b.length === 0 ? 0 : 1) : -1
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = isNumeric(x)
    const ny = isNumeric(y)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** SemVer precedence: negative if a < b, 0 if equal, positive if a > b. */
export const compareVersions = (a: Version, b: Version): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch || comparePre(a.pre, b.pre)

export const formatVersion = (v: Version): string =>
  `${v.major}.${v.minor}.${v.patch}${v.pre.length ? `-${v.pre.join(".")}` : ""}`

/**
 * The version to offer, or null: only a release that is strictly newer than the running
 * one, and a stable one unless `prereleases` is set. A running prerelease is offered the
 * next newer stable release either way. Malformed versions on either side never offer
 * anything.
 */
export const offerableVersion = (current: string, latestTag: string, prereleases = false): string | null => {
  const cur = parseVersion(current.startsWith("v") ? current.slice(1) : current)
  const latest = parseVersion(latestTag)
  if (!cur || !latest || (latest.pre.length > 0 && !prereleases)) return null
  return compareVersions(latest, cur) > 0 ? formatVersion(latest) : null
}

// ---------------------------------------------------------------------------
// Release assets

export interface Target {
  readonly platform: NodeJS.Platform
  readonly arch: string
  /** macOS: an x64 build running on Apple silicon under Rosetta. */
  readonly rosetta: boolean
}

/**
 * The release file for this platform, from the naming scheme in electron-builder.yml
 * (`artifactName: ${name}-${version}-${arch}.${ext}`) and scripts/release/collect-files.sh.
 * Under Rosetta the arm64 dmg is chosen: the native build is the better one to run.
 */
export const assetNameFor = (t: Target, version: string): string | null => {
  const base = `${PACKAGE_NAME}-${version}`
  switch (t.platform) {
    case "linux":
      return t.arch === "x64" ? `${base}-amd64.deb` : null
    case "darwin":
      if (t.arch === "arm64" || t.rosetta) return `${base}-arm64.dmg`
      return t.arch === "x64" ? `${base}-x64.dmg` : null
    case "win32":
      return t.arch === "x64" ? `${base}-x64.exe` : null
    default:
      return null
  }
}

/** Largest installer accepted (the packages are ~100 MB). */
export const MAX_ASSET_BYTES = 400 * 1024 * 1024
export const MAX_SUMS_BYTES = 64 * 1024
export const MAX_RELEASE_JSON_BYTES = 1024 * 1024
/** The release list (`RELEASES_PER_PAGE` releases with their notes and assets). */
export const MAX_RELEASE_LIST_JSON_BYTES = 8 * 1024 * 1024

export interface ReleaseAsset {
  readonly name: string
  readonly size: number
  /** Lower-case hex SHA-256 from the API's `digest` ("sha256:..."), when GitHub reports one. */
  readonly sha256: string | null
}

export interface Offer {
  readonly version: string
  /** A release candidate / beta (GitHub's `prerelease` flag, matching a "-rc.1" style version). */
  readonly prerelease: boolean
  readonly tag: string
  readonly asset: ReleaseAsset
  readonly sums: ReleaseAsset
}

const HEX64 = /^[0-9a-f]{64}$/
const TAG = /^v?\d+\.\d+\.\d+$/
/** A prerelease tag: "v1.2.3-rc.1" (no build metadata); `parseVersion` checks the rest. */
const PRE_TAG = /^v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

/** Thrown-free result type for the parsers. */
export type Parsed<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }
const ok = <A>(value: A): Parsed<A> => ({ ok: true, value })
const err = (error: string): Parsed<never> => ({ ok: false, error })

const parseAsset = (u: unknown, name: string, maxBytes: number): Parsed<ReleaseAsset> => {
  if (!isObj(u)) return err(`${name}: not an object`)
  const size = u["size"]
  if (!Number.isSafeInteger(size) || (size as number) <= 0 || (size as number) > maxBytes)
    return err(`${name}: bad size ${String(size)}`)
  if (u["state"] !== undefined && u["state"] !== "uploaded") return err(`${name}: not uploaded (${String(u["state"])})`)
  let sha256: string | null = null
  const digest = u["digest"]
  if (typeof digest === "string" && digest.startsWith("sha256:")) {
    sha256 = digest.slice(7).toLowerCase()
    if (!HEX64.test(sha256)) return err(`${name}: malformed digest`)
  } else if (digest !== undefined && digest !== null && typeof digest !== "string") return err(`${name}: malformed digest`)
  return ok({ name, size: size as number, sha256 })
}

/**
 * Turn one release's JSON into an offer for this platform, or explain why there is none
 * ("up to date" is an error here too: the caller only logs it).
 *
 * Drafts are never offered. `prereleases` false (the `releases/latest` answer): only a
 * release GitHub marks as a full release, with a plain "v1.2.3" tag. `prereleases` true:
 * a prerelease too, whose flag must agree with its tag ("v1.2.3-rc.1" is a prerelease,
 * "v1.2.3" is not), so a version's kind is unambiguous.
 */
export const parseRelease = (json: unknown, current: string, target: Target, prereleases = false): Parsed<Offer> => {
  if (!isObj(json)) return err("release: not an object")
  if (json["draft"] !== false) return err("release: draft")
  const pre = json["prerelease"]
  if (pre !== false && pre !== true) return err("release: no prerelease flag")
  if (pre && !prereleases) return err("release: prerelease")
  const tag = json["tag_name"]
  if (typeof tag !== "string" || !(pre ? PRE_TAG : TAG).test(tag))
    return err(`release: unexpected tag ${JSON.stringify(tag)}${pre ? " for a prerelease" : ""}`)
  const version = offerableVersion(current, tag, pre)
  if (version === null) return err(`up to date (running ${current}, latest ${tag})`)
  const name = assetNameFor(target, version)
  if (name === null) return err(`no release file for ${target.platform}/${target.arch}`)
  const assets = Array.isArray(json["assets"]) ? json["assets"] : []
  const find = (n: string): unknown[] => assets.filter((a) => isObj(a) && a["name"] === n)
  const [assetRaw, ...dupA] = find(name)
  const [sumsRaw, ...dupS] = find(SUMS_NAME)
  if (assetRaw === undefined) return err(`release ${tag} has no ${name}`)
  if (sumsRaw === undefined) return err(`release ${tag} has no ${SUMS_NAME}`)
  if (dupA.length || dupS.length) return err(`release ${tag} lists a file twice`)
  const asset = parseAsset(assetRaw, name, MAX_ASSET_BYTES)
  if (!asset.ok) return asset
  const sums = parseAsset(sumsRaw, SUMS_NAME, MAX_SUMS_BYTES)
  if (!sums.ok) return sums
  return ok({ version, prerelease: pre, tag, asset: asset.value, sums: sums.value })
}

/** Most releases `selectRelease` looks at (the query asks for `RELEASES_PER_PAGE`). */
const MAX_LISTED_RELEASES = 100

/**
 * Pick the offer from the release list (`GET /repos/{repo}/releases`, the "Pre-release
 * updates" setting on): the highest version among the releases `parseRelease` (with
 * prereleases allowed) accepts, i.e. not a draft, newer than the running version, with a
 * well-formed file for this platform and SHA256SUMS.txt. A release that fails those checks
 * is passed over, not fatal; two releases with the same version make that version
 * ambiguous and neither is offered.
 */
export const selectRelease = (json: unknown, current: string, target: Target): Parsed<Offer> => {
  if (!Array.isArray(json)) return err("releases: not a list")
  if (json.length > MAX_LISTED_RELEASES) return err(`releases: ${json.length} entries`)
  const offers: Offer[] = []
  const reasons: string[] = []
  for (const r of json) {
    const p = parseRelease(r, current, target, true)
    if (p.ok) offers.push(p.value)
    else reasons.push(p.error)
  }
  const versionOf = (o: Offer): Version => parseVersion(o.version)!
  const sorted = offers.sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
  const [best, next] = sorted
  if (best === undefined)
    return err(reasons.length === 0 ? "releases: none published" : `nothing to offer (${[...new Set(reasons)].slice(0, 3).join("; ")})`)
  if (next !== undefined && next.version === best.version) return err(`releases: ${best.version} is listed twice`)
  return ok(best)
}

/**
 * Parse `sha256sum` output (scripts/release/collect-files.sh): "<64 hex>  <name>" per line,
 * or " *<name>" in binary mode. Returns name → lower-case hex. A name listed twice with
 * different sums makes the whole file invalid.
 */
export const parseSha256Sums = (text: string): Parsed<ReadonlyMap<string, string>> => {
  const out = new Map<string, string>()
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.trim() === "") continue
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line)
    if (!m) return err(`${SUMS_NAME}: malformed line ${JSON.stringify(line.slice(0, 100))}`)
    const hash = m[1]!.toLowerCase()
    const name = m[2]!
    const prev = out.get(name)
    if (prev !== undefined && prev !== hash) return err(`${SUMS_NAME}: ${name} listed with two sums`)
    out.set(name, hash)
  }
  return ok(out)
}

/**
 * Compare the SHA-256 computed over the downloaded file with every reference there is:
 * SHA256SUMS.txt (required) and the API's digest (when present). Null when it matches.
 */
export const checksumProblem = (actual: string, fromSums: string | undefined, fromApi: string | null): string | null => {
  if (fromSums === undefined) return `not listed in ${SUMS_NAME}`
  if (actual !== fromSums) return `SHA-256 ${actual.slice(0, 12)}… does not match ${SUMS_NAME} (${fromSums.slice(0, 12)}…)`
  if (fromApi !== null && actual !== fromApi)
    return `SHA-256 ${actual.slice(0, 12)}… does not match GitHub's digest (${fromApi.slice(0, 12)}…)`
  return null
}

// ---------------------------------------------------------------------------
// Progress throttling

/** Push a `downloading` update at most every `everyMs`, plus the first and the last one. */
export const shouldPushProgress = (lastPushAt: number | null, now: number, progress: number, everyMs = 250): boolean =>
  lastPushAt === null || progress >= 1 || now - lastPushAt >= everyMs

// ---------------------------------------------------------------------------
// Test hooks

/**
 * Environment variables for tests (a Docker E2E run with no external network). They are
 * read ONLY when the app is not packaged (`app.isPackaged` false); a packaged build ignores
 * them all, so neither plain http nor another host can ever be used by a release build.
 *
 *   CLICKERED_UPDATE_BASE_URL  e.g. http://127.0.0.1:8123 — serves the release queries
 *                              (`<base>/repos/ianwijma/clickered/releases/latest`, and with
 *                              "Pre-release updates" on `<base>/repos/ianwijma/clickered/
 *                              releases?per_page=30`) and the files (`<base>/ianwijma/
 *                              clickered/releases/download/<tag>/<name>`); only that origin is
 *                              allowed (http or https), no GitHub host.
 *   CLICKERED_UPDATE_FORCE=1   treat this unpackaged copy as an installed one (skip the
 *                              "real installed copy" checks).
 *   CLICKERED_UPDATE_DRY_RUN   path of a file: every install command is appended to it as a
 *                              JSON line ({"cmd":[file,...args]}, then {"action":"relaunch"|
 *                              "quit"}) instead of being run, and the app does not restart.
 *   CLICKERED_UPDATE_OPEN_LOG  path of a file: the release notes URL (`openReleaseNotes`) is
 *                              appended to it as a line instead of being opened in a browser.
 */
export interface TestHooks {
  readonly baseUrl: string | null
  readonly force: boolean
  readonly dryRunLog: string | null
  readonly openLog: string | null
}

export const NO_HOOKS: TestHooks = { baseUrl: null, force: false, dryRunLog: null, openLog: null }

export const readTestHooks = (env: NodeJS.ProcessEnv, isPackaged: boolean): TestHooks => {
  if (isPackaged) return NO_HOOKS
  let baseUrl: string | null = null
  const raw = env["CLICKERED_UPDATE_BASE_URL"]
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol === "http:" || u.protocol === "https:") baseUrl = u.href.replace(/\/+$/, "")
    } catch {
      // ignored: a malformed base URL means no override
    }
  }
  const dry = env["CLICKERED_UPDATE_DRY_RUN"]
  const open = env["CLICKERED_UPDATE_OPEN_LOG"]
  return { baseUrl, force: env["CLICKERED_UPDATE_FORCE"] === "1", dryRunLog: dry ? dry : null, openLog: open ? open : null }
}

/** GitHub, or the test server from `CLICKERED_UPDATE_BASE_URL` (unpackaged only, see above). */
export const endpointsFor = (hooks: TestHooks): Endpoints => {
  if (hooks.baseUrl === null) return githubEndpoints()
  const base = hooks.baseUrl
  return {
    latest: `${base}/repos/${REPO}/releases/latest`,
    releases: `${base}/repos/${REPO}/releases?per_page=${RELEASES_PER_PAGE}`,
    download: (tag, name) => `${base}/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`,
    policy: { hosts: new Set(), extraOrigin: new URL(base).origin },
  }
}

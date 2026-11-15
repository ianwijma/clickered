/**
 * The chip under the pill, in the real app (built Electron bundle on Xvfb):
 * - in-app updates against a local fake "GitHub" (release JSON, package, SHA256SUMS.txt)
 *   through the unpackaged-only test hooks CLICKERED_UPDATE_BASE_URL / _FORCE / _DRY_RUN
 *   (src/main/update-core.ts), so nothing is installed and no external network is used;
 * - the macOS permission chip, with the fake helper standing in for one that waits for the
 *   Accessibility permission, and CLICKERED_OPEN_SETTINGS_LOG instead of System Settings.
 *
 * With E2E_SHOTS=<dir> it also saves screenshots of every chip state in dark and light.
 */
import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron, type ElectronApplication, type Page } from "playwright-core"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { HELPER, ROOT, assertSandbox, inA, phys, sleep, startFakeWm, waitFor, waitForPickGrab, B_FREE, type FakeWm } from "./support/x11"

const REPO = "ianwijma/clickered"
const CURRENT = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version
const NEW = "9.9.9"
const ASSET = `clickered-${NEW}-amd64.deb`
const SUMS = "SHA256SUMS.txt"
const PAYLOAD = randomBytes(3 * 1024 * 1024)
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex")

let wm: FakeWm | null = null
let app: ElectronApplication | null = null
let server: ReleaseServer | null = null

beforeAll(() => {
  assertSandbox()
  if (!existsSync(join(ROOT, "out", "main", "index.js"))) throw new Error("app not built: run `npm run build` first")
})

afterEach(async () => {
  await app?.close().catch(() => {})
  app = null
  wm?.stop()
  wm = null
  await server?.close()
  server = null
  await sleep(100)
})

// ---------------------------------------------------------------------------
// Fake GitHub

interface ReleaseConfig {
  /** Tag of the latest release; null answers the query with 404. */
  tag: string | null
  /** What SHA256SUMS.txt says about the package. */
  sums: "ok" | "wrong"
  /** Send the package shorter than announced (a broken download). */
  truncate: boolean
}

interface ReleaseServer {
  readonly url: string
  readonly cfg: ReleaseConfig
  /** Paths requested so far. */
  readonly requests: string[]
  close(): Promise<void>
}

const startReleaseServer = async (init: Partial<ReleaseConfig> = {}): Promise<ReleaseServer> => {
  const cfg: ReleaseConfig = { tag: `v${NEW}`, sums: "ok", truncate: false, ...init }
  const requests: string[] = []
  const sumsText = (): string => `${cfg.sums === "ok" ? sha256(PAYLOAD) : "0".repeat(64)}  ${ASSET}\n`
  const srv: Server = createServer((req, res) => {
    const path = req.url ?? ""
    requests.push(path)
    if (path === `/repos/${REPO}/releases/latest`) {
      if (cfg.tag === null) {
        res.writeHead(404, { "content-type": "application/json" }).end('{"message":"Not Found"}')
        return
      }
      const version = cfg.tag.replace(/^v/, "")
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          tag_name: cfg.tag,
          draft: false,
          prerelease: false,
          assets: [
            { name: `clickered-${version}-amd64.deb`, size: PAYLOAD.length, state: "uploaded" },
            { name: SUMS, size: Buffer.byteLength(sumsText()), state: "uploaded" },
          ],
        }),
      )
      return
    }
    const dl = `/${REPO}/releases/download/${encodeURIComponent(cfg.tag ?? "")}/`
    if (path === dl + SUMS) {
      res.writeHead(200, { "content-type": "text/plain" }).end(sumsText())
      return
    }
    if (path === dl + ASSET) {
      // Slowly (~3 s), so "Downloading · N%" can be seen mid-way.
      const body = cfg.truncate ? PAYLOAD.subarray(0, PAYLOAD.length / 2) : PAYLOAD
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(PAYLOAD.length) })
      let off = 0
      const step = (): void => {
        if (res.destroyed) return
        if (off >= body.length) {
          // Truncated: drop the connection before the announced length is reached.
          if (cfg.truncate) res.socket?.destroy()
          else res.end()
          return
        }
        res.write(body.subarray(off, off + 64 * 1024))
        off += 64 * 1024
        setTimeout(step, 60)
      }
      step()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r))
  const { port } = srv.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    cfg,
    requests,
    close: () =>
      new Promise<void>((r) => {
        srv.closeAllConnections()
        srv.close(() => r())
      }),
  }
}

// ---------------------------------------------------------------------------
// App

interface Launched {
  readonly page: Page
  readonly home: string
  /** userData: ~/.config/clickered */
  readonly userData: string
}

const launch = async (env: Record<string, string>): Promise<Launched> => {
  const home = mkdtempSync(join(tmpdir(), "clickered-home-"))
  const electronPath = (await import("electron")).default as unknown as string
  app = await _electron.launch({
    executablePath: electronPath,
    args: [ROOT, "--no-sandbox", "--disable-gpu"],
    cwd: ROOT,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), CLICKERED_HELPER: HELPER, ...env },
    timeout: 30_000,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
  return { page, home, userData: join(home, ".config", "clickered") }
}

const updateEnv = (srv: ReleaseServer, dryRunLog: string | null): Record<string, string> => ({
  CLICKERED_UPDATE_BASE_URL: srv.url,
  CLICKERED_UPDATE_FORCE: "1",
  ...(dryRunLog ? { CLICKERED_UPDATE_DRY_RUN: dryRunLog } : {}),
})

/** All files below `dir` (recursively), or [] when it does not exist. */
const filesUnder = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => d.name)
    : []

// (String expressions below: this file is type-checked without the DOM lib.)

/**
 * Poll a page expression until it is truthy. (Not page.waitForFunction: polling a string
 * predicate makes Playwright eval() it inside the page, which the bar's CSP forbids.)
 */
const waitInPage = async (page: Page, expr: string, ms = 5000, every = 100): Promise<void> => {
  const end = Date.now() + ms
  let last: unknown
  for (;;) {
    last = await page.evaluate(expr)
    if (last) return
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for: ${expr.trim().slice(0, 200)}`)
    await sleep(every)
  }
}

/** The text of the visible chip's active layer, or "" when no chip is shown. */
const chipText = (page: Page): Promise<string> =>
  page.evaluate(`(() => {
    const chip = document.querySelector('[aria-live="polite"]')
    if (!chip || chip.parentElement.hidden) return ""
    return chip.querySelector('[data-active]')?.textContent ?? ""
  })()`) as Promise<string>

/**
 * Wait until the chip has settled into a layout matching the approved design: centred under
 * the pill; a compact chip as wide as its content (nothing clipped), an expanded one exactly
 * as wide as the pill and 62 px tall; the pill not moved or widened by it; and the
 * transparent window resized to fit everything (nothing cut off).
 */
const waitForChipLayout = (page: Page, expanded: boolean): Promise<unknown> =>
  waitInPage(
    page,
    `(() => {
      const chip = document.querySelector('[aria-live="polite"]')
      if (!chip || chip.parentElement.hidden) return false
      const root = chip.parentElement.parentElement
      const bar = root.firstElementChild
      const layer = chip.querySelector('[data-active]')
      if (!layer || getComputedStyle(layer).opacity !== "1") return false
      const c = chip.getBoundingClientRect(), b = bar.getBoundingClientRect(), r = root.getBoundingClientRect()
      const l = layer.getBoundingClientRect()
      const near = (a, e) => Math.abs(a - e) <= 0.75
      const centred = near(c.left + c.width / 2, b.left + b.width / 2)
      const size = ${expanded}
        ? near(c.width, b.width) && near(c.height, 62)
        : near(c.height, 30) && c.width < b.width && near(c.width, l.width + 2)
      const notClipped = l.right <= c.right + 0.5 && [...layer.querySelectorAll("*")].every((e) => e.scrollWidth <= e.clientWidth + 1)
      const pillUnmoved = near(b.left - r.left, 10) && near(b.top - r.top, 10) && near(r.width, b.width + 20)
      const fits = r.right <= window.innerWidth && r.bottom <= window.innerHeight &&
        Math.abs(window.innerWidth - Math.ceil(r.width)) <= 1 && Math.abs(window.innerHeight - Math.ceil(r.height)) <= 1
      return centred && size && notClipped && pillUnmoved && fits
    })()`,
    10_000,
  )

/** Record every distinct chip text the user would have seen, from now on, in `window.__chipLog`. */
const recordChip = (page: Page): Promise<unknown> =>
  page.evaluate(`(() => {
    const log = (window.__chipLog = [])
    const chip = document.querySelector('[aria-live="polite"]')
    const snap = () => {
      const t = chip.parentElement.hidden ? "" : (chip.querySelector('[data-active]')?.textContent ?? "")
      if (log[log.length - 1] !== t) log.push(t)
    }
    snap()
    new MutationObserver(snap).observe(chip.parentElement.parentElement, { subtree: true, childList: true, characterData: true, attributes: true })
  })()`)

const chipLog = (page: Page): Promise<string[]> => page.evaluate("window.__chipLog") as Promise<string[]>

const SHOTS = process.env["E2E_SHOTS"] || null
/** E2E_SHOTS only: screenshot the bar in dark and light. */
const shot = async (page: Page, name: string): Promise<void> => {
  if (SHOTS === null) return
  mkdirSync(SHOTS, { recursive: true })
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await sleep(250)
    await page.screenshot({ path: join(SHOTS, `app-${scheme}-${name}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

/** The latest-release query was answered and the app had time to show (or not show) the chip. */
const checked = async (srv: ReleaseServer): Promise<void> => {
  await waitFor(() => srv.requests.some((p) => p.endsWith("/releases/latest")), "the update check", 20_000)
  await sleep(1500)
}

// ---------------------------------------------------------------------------

describe("chip e2e (Electron, fake release server, Xvfb)", () => {
  it("offers a newer release, then downloads, verifies and installs it (dry run)", async () => {
    server = await startReleaseServer()
    const dir = mkdtempSync(join(tmpdir(), "clickered-dry-"))
    const dry = join(dir, "install.log")
    const { page, userData } = await launch(updateEnv(server, dry))

    await page.getByText(`Update ${NEW} available`).waitFor({ timeout: 20_000 })
    await waitForChipLayout(page, false)
    await shot(page, "update-available")

    // The panel opens below the chip, and the window grows to fit both.
    await page.getByRole("button", { name: "Windows & settings" }).click()
    await waitInPage(
      page,
      `(() => {
        const chip = document.querySelector('[aria-live="polite"]').getBoundingClientRect()
        const panel = document.querySelector('[role="radiogroup"]').closest(".surface").getBoundingClientRect()
        return panel.top >= chip.bottom && panel.bottom <= window.innerHeight && panel.right <= window.innerWidth
      })()`,
      5000,
    )
    await shot(page, "panel-open-update")
    await page.getByRole("button", { name: "Windows & settings" }).click()

    await recordChip(page)
    await page.getByRole("button", { name: "Install the update" }).click()
    // Mid-download: the expanded chip with the animated logo and a partly filled bar.
    await waitInPage(
      page,
      `(() => {
        const bar = document.querySelector('[role="progressbar"]')
        const n = Number(bar?.getAttribute("aria-valuenow"))
        const fill = bar?.firstElementChild?.getBoundingClientRect().width ?? 0
        return n > 5 && n < 80 && fill > 0 && fill < bar.getBoundingClientRect().width
      })()`,
      15_000,
      50,
    )
    await waitForChipLayout(page, true)
    expect(
      await page.evaluate(`(() => {
        const svg = document.querySelector('[aria-live="polite"] [data-active] svg')
        const r = svg?.getBoundingClientRect()
        return !!r && r.width === 40 && r.height === 40 && getComputedStyle(svg.querySelector(".logo-c")).animationName
      })()`),
    ).toBe("logo-pop")
    await shot(page, "update-downloading")

    await page.getByText(`Installing ${NEW}`).waitFor({ timeout: 15_000 })
    await page.getByText("Clickered restarts by itself").waitFor()
    await waitForChipLayout(page, true)
    await shot(page, "update-installing")

    // Every step was shown, in order.
    const seen = await chipLog(page)
    const at = (re: RegExp): number => seen.findIndex((t) => re.test(t))
    expect(at(/Downloading · \d+%/), JSON.stringify(seen)).toBeGreaterThan(0)
    expect(at(/Verifying checksum…/)).toBeGreaterThan(at(/Downloading/))
    expect(at(/Clickered restarts by itself/)).toBeGreaterThan(at(/Verifying/))

    // The dry run recorded the install command for the verified file, then the restart.
    await waitFor(() => existsSync(dry) && readFileSync(dry, "utf8").includes("action"), "dry-run log", 10_000)
    const lines = readFileSync(dry, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { cmd?: string[]; action?: string })
    expect(lines).toHaveLength(2)
    // pkexec <install script> <file> <sha256>: the root-side script re-checks the hash
    // (unpackaged, the script is the repo's native/linux copy; see install-script.e2e.test.ts).
    const cmd = lines[0]!.cmd!
    expect(cmd).toHaveLength(4)
    expect(cmd[0]).toBe("/usr/bin/pkexec")
    expect(cmd[1]).toMatch(/\/native\/linux\/clickered-install-update$/)
    expect(existsSync(cmd[1]!)).toBe(true)
    expect(cmd[2]!.startsWith(join(userData, "updates") + "/")).toBe(true)
    expect(cmd[2]!.endsWith(`/${ASSET}`)).toBe(true)
    expect(sha256(readFileSync(cmd[2]!))).toBe(sha256(PAYLOAD))
    expect(cmd[3]).toBe(sha256(PAYLOAD))
    expect(lines[1]).toEqual({ action: "relaunch" })
  })

  it("a wrong checksum deletes the download and offers Retry, which then succeeds", async () => {
    server = await startReleaseServer({ sums: "wrong" })
    const dry = join(mkdtempSync(join(tmpdir(), "clickered-dry-")), "install.log")
    const { page, userData } = await launch(updateEnv(server, dry))

    await page.getByRole("button", { name: "Install the update" }).click({ timeout: 20_000 })
    await page.getByText("Update failed its checksum").waitFor({ timeout: 20_000 })
    await waitForChipLayout(page, false)
    expect(await page.getByRole("button", { name: "Retry the update" }).textContent()).toBe("Retry")
    expect(
      await page.evaluate(`document.querySelector('[aria-live="polite"] [data-active]').getAttribute("title")`),
    ).toMatch(/does not match SHA256SUMS\.txt/)
    expect(filesUnder(join(userData, "updates"))).toEqual([])
    expect(existsSync(dry)).toBe(false)
    await shot(page, "update-failed-checksum")

    server.cfg.sums = "ok"
    await page.getByRole("button", { name: "Retry the update" }).click()
    await page.getByText(`Installing ${NEW}`).waitFor({ timeout: 20_000 })
    await waitFor(() => existsSync(dry), "dry-run log", 10_000)
  })

  it("a broken download ends in the failed chip", async () => {
    server = await startReleaseServer({ truncate: true })
    const { page, userData } = await launch(updateEnv(server, join(mkdtempSync(join(tmpdir(), "clickered-dry-")), "install.log")))
    await page.getByRole("button", { name: "Install the update" }).click({ timeout: 20_000 })
    await page.getByText("Update download failed").waitFor({ timeout: 20_000 })
    await waitForChipLayout(page, false)
    await page.getByRole("button", { name: "Retry the update" }).waitFor()
    expect(filesUnder(join(userData, "updates"))).toEqual([])
    await shot(page, "update-failed-download")
  })

  it("an installer that cannot run ends in the failed chip", async () => {
    // Not a dry run: the real Linux installer path, which stops before running anything
    // because this container has no pkexec.
    if (existsSync("/usr/bin/pkexec")) throw new Error("this test needs a container without pkexec")
    server = await startReleaseServer()
    const { page } = await launch(updateEnv(server, null))
    await page.getByRole("button", { name: "Install the update" }).click({ timeout: 20_000 })
    await page.getByText("Update was not installed").waitFor({ timeout: 20_000 })
    await waitForChipLayout(page, false)
    expect(
      await page.evaluate(`document.querySelector('[aria-live="polite"] [data-active]').getAttribute("title")`),
    ).toMatch(/pkexec not found/)
    await page.getByRole("button", { name: "Retry the update" }).waitFor()
    await shot(page, "update-failed-install")
  })

  for (const [what, tag] of [
    ["the same version", `v${CURRENT}`],
    ["an older version", "v0.0.1"],
    ["no release (404)", null],
  ] as const) {
    it(`shows no chip for ${what}`, async () => {
      server = await startReleaseServer({ tag })
      const { page } = await launch(updateEnv(server, null))
      await page.getByRole("button", { name: /Grab windows/ }).waitFor({ timeout: 15_000 })
      await checked(server)
      expect(await chipText(page)).toBe("")
      expect(server.requests.filter((p) => p.includes("/download/"))).toEqual([])
    })
  }

  it("hides the chip while picking and fades it with the pill during a replay", async () => {
    wm = await startFakeWm()
    const w = wm
    server = await startReleaseServer()
    const { page } = await launch(updateEnv(server, null))
    await page.getByText(`Update ${NEW} available`).waitFor({ timeout: 20_000 })

    // Picking: no chip; it comes back after Done.
    await page.getByRole("button", { name: /Grab windows/ }).click()
    await page.getByText("Click each window…").waitFor()
    expect(await chipText(page)).toBe("")
    await shot(page, "picking-no-chip")
    await waitForPickGrab(w, inA(0.5, 0.5))
    phys.click(...inA(0.5, 0.5))
    await page.getByText("1 selected · click more").waitFor()
    expect(await chipText(page)).toBe("")
    await waitForPickGrab(w, B_FREE)
    phys.click(...B_FREE)
    await page.getByText("2 selected · click more").waitFor()
    await page.getByRole("button", { name: /Finish picking/ }).click()
    await page.getByText("2 windows").waitFor()
    await page.getByText(`Update ${NEW} available`).waitFor()
    await waitForChipLayout(page, false)

    // A long click delay keeps the replay (and the fade) going for a while.
    await page.getByRole("button", { name: "Windows & settings" }).click()
    await page.getByRole("radio", { name: "Click delay 500 milliseconds" }).click()
    await page.locator('[role="radio"][aria-checked="true"][aria-label="Click delay 500 milliseconds"]').waitFor()
    await page.getByRole("button", { name: "Windows & settings" }).click()

    // Spy on the click-through switch main flips around a replay (one window: pill and chip).
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      const calls: boolean[] = ((globalThis as { __ignore?: boolean[] }).__ignore = [])
      const orig = win.setIgnoreMouseEvents.bind(win)
      win.setIgnoreMouseEvents = (ignore, options) => {
        calls.push(ignore)
        orig(ignore, options)
      }
    })

    // Record what the chip looks like while the pill is faded for a replay.
    await page.evaluate(`(() => {
      const fades = (window.__fades = [])
      const chip = document.querySelector('[aria-live="polite"]')
      const root = chip.parentElement.parentElement
      new MutationObserver(() => {
        if (!root.hasAttribute("data-replaying")) return
        // Once the 80 ms fade-out is done, if the replay is still running: how opaque is the
        // chip in the end (its own opacity times its ancestors')?
        setTimeout(() => {
          if (!root.hasAttribute("data-replaying")) return
          let o = 1
          for (let e = chip; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity)
          fades.push({ visible: !chip.parentElement.hidden, inFadedRoot: chip.closest(".replay-fade") === root, opacity: o })
        }, 110)
      }).observe(root, { attributes: true, attributeFilter: ["data-replaying"] })
    })()`)
    await sleep(300)
    for (let i = 0; i < 6; i++) {
      w.clear()
      phys.click(...inA(0.2 + i * 0.1, 0.5))
      await waitFor(() => w.on("B", "release").length === 1, "replayed click on B", 5000)
      await sleep(400)
      const fades = (await page.evaluate("window.__fades")) as { visible: boolean; inFadedRoot: boolean; opacity: number }[]
      if (fades.length > 0) break
    }
    const fades = (await page.evaluate("window.__fades")) as { visible: boolean; inFadedRoot: boolean; opacity: number }[]
    expect(fades.length).toBeGreaterThan(0)
    for (const f of fades) {
      expect(f.visible).toBe(true)
      expect(f.inFadedRoot).toBe(true)
      expect(f.opacity).toBeLessThan(0.5)
    }
    // The window was click-through during the replay, and is clickable again after it.
    const ignore = await app!.evaluate(() => (globalThis as { __ignore?: boolean[] }).__ignore ?? [])
    expect(ignore[0]).toBe(true)
    await sleep(800)
    expect((await app!.evaluate(() => (globalThis as { __ignore?: boolean[] }).__ignore ?? [])).at(-1)).toBe(false)
    // And it comes back.
    await waitInPage(
      page,
      `Number(getComputedStyle(document.querySelector('[aria-live="polite"]').parentElement.parentElement).opacity) === 1`,
      5000,
    )
  })

  it("permission chip: missing, Open Settings, waiting, granted, gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clickered-perm-"))
    const opened = join(dir, "opened.log")
    // The fake helper (a script, so it can be CLICKERED_HELPER) waits for the "permission"
    // until the app has "opened System Settings", then becomes ready a moment later.
    const helper = join(dir, "helper.sh")
    writeFileSync(helper, `#!/bin/sh\nexec node ${JSON.stringify(join(ROOT, "src", "main", "__fixtures__", "fake-helper.mjs"))}\n`)
    chmodSync(helper, 0o755)
    const { page } = await launch({
      CLICKERED_HELPER: helper,
      CLICKERED_OPEN_SETTINGS_LOG: opened,
      FAKE_LOG: join(dir, "helper.log"),
      FAKE_STARTUP_ERROR: "Clickered needs the Accessibility permission.",
      FAKE_STARTUP_PERM: "accessibility",
      FAKE_READY_WHEN_FILE: opened,
      FAKE_READY_DELAY: "2000",
    })

    await page.getByText("macOS permission missing").waitFor({ timeout: 15_000 })
    await page.getByText("Action needed").waitFor()
    await waitForChipLayout(page, false)
    // The chip carries it: the panel does not pop open.
    expect(await page.locator('[role="radiogroup"]').first().isVisible()).toBe(false)
    await shot(page, "perm-missing")

    await recordChip(page)
    await page.getByRole("button", { name: "Open System Settings to grant the permission" }).click()
    await page.getByText("Waiting for Accessibility permission…").waitFor({ timeout: 2000 })
    await waitForChipLayout(page, false)
    await shot(page, "perm-waiting")
    await waitFor(() => existsSync(opened), "the settings URL", 5000)
    expect(readFileSync(opened, "utf8")).toBe("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility\n")

    await page.getByText("Permission granted").waitFor({ timeout: 10_000 })
    await page.getByRole("button", { name: /Grab windows/ }).waitFor()
    await shot(page, "perm-granted")
    await waitInPage(page, `document.querySelector('[aria-live="polite"]').parentElement.hidden`, 10_000)
    // The window shrinks back to the bare pill.
    await waitInPage(
      page,
      `(() => {
        const r = document.querySelector('[aria-live="polite"]').parentElement.parentElement.getBoundingClientRect()
        return Math.abs(window.innerHeight - Math.ceil(r.height)) <= 1 && r.height < 70
      })()`,
      5000,
    )
    expect(await chipLog(page)).toEqual([
      "macOS permission missingOpen Settings",
      "Waiting for Accessibility permission…",
      "Permission granted",
      "",
    ])
  })
})

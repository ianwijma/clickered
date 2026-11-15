/**
 * The whole app: built Electron bundle + real helper + fake WM on Xvfb, driven through
 * the bar UI with Playwright.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { _electron, type ElectronApplication, type Page } from "playwright-core"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { B_FREE, HELPER, ROOT, assertSandbox, inA, phys, sleep, startFakeWm, waitFor, waitForPickGrab, type FakeWm } from "./support/x11"

let wm: FakeWm
let app: ElectronApplication | null = null
let page: Page

beforeAll(() => {
  assertSandbox()
  if (!existsSync(join(ROOT, "out", "main", "index.js"))) throw new Error("app not built: run `npm run build` first")
})

beforeEach(async () => {
  wm = await startFakeWm()
  const electronPath = (await import("electron")).default as unknown as string
  app = await _electron.launch({
    executablePath: electronPath,
    args: [ROOT, "--no-sandbox", "--disable-gpu"],
    cwd: ROOT,
    // Fresh HOME = fresh userData/config.json for every test.
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "clickered-home-")), CLICKERED_HELPER: HELPER },
    timeout: 30_000,
  })
  page = await app.firstWindow()
  await page.waitForLoadState("domcontentloaded")
})

afterEach(async () => {
  await app?.close().catch(() => {})
  app = null
  wm.stop()
  await sleep(100)
})

describe("app e2e (Electron, real helper, Xvfb)", () => {
  it("grab two windows from the bar, replicate a click, pause, and quit", async () => {
    const grab = page.getByRole("button", { name: /Grab windows/ })
    await grab.waitFor({ state: "visible", timeout: 15_000 })

    // With no group the bar is at its narrowest; open the panel and check that the window is
    // resized to fit it and that the six segments of both settings rows are not clipped.
    await page.getByRole("button", { name: "Windows & settings" }).click()
    // (A string expression: this file is type-checked without the DOM lib.)
    await page.waitForFunction(
      `(() => {
        const groups = [...document.querySelectorAll('[role="radiogroup"]')]
        if (groups.length !== 2) return false
        return groups.every((group) => {
          const g = group.getBoundingClientRect()
          const p = group.closest(".surface")?.getBoundingClientRect()
          const row = group.parentElement
          const last = group.lastElementChild?.getBoundingClientRect()
          return !!p && !!row && !!last && g.width > 0 && row.scrollWidth <= row.clientWidth && g.right <= p.right &&
            last.right <= g.right && group.scrollWidth <= group.clientWidth &&
            p.right <= window.innerWidth && p.bottom <= window.innerHeight
        })
      })()`,
      undefined,
      { timeout: 5000 },
    )

    await page.getByRole("button", { name: "Windows & settings" }).click()
    await grab.click()
    await page.getByText("Click each window…").waitFor()

    // Pick A (becomes the source), then B, then finish with Done.
    await waitForPickGrab(wm, inA(0.5, 0.5))
    phys.click(...inA(0.5, 0.5))
    await page.getByText("1 selected · click more").waitFor()
    await waitForPickGrab(wm, B_FREE)
    phys.click(...B_FREE)
    await page.getByText("2 selected · click more").waitFor()
    await page.getByRole("button", { name: /Finish picking/ }).click()
    await page.getByText("2 windows").waitFor()
    expect(wm.on("A", "press")).toHaveLength(0)

    // Live: a click in A is replayed into B.
    await sleep(200)
    phys.click(...inA(0.25, 0.5))
    await waitFor(() => wm.on("B", "release").length === 1, "replayed click on B")
    expect(wm.on("A", "press")).toHaveLength(1)

    // Paused via the bar toggle: nothing is replayed.
    const toggle = page.getByRole("switch", { name: /Replicating clicks/ })
    await toggle.click()
    await page.getByRole("switch", { name: /Paused/ }).waitFor()
    phys.click(...inA(0.75, 0.5))
    await sleep(500)
    expect(wm.on("A", "press")).toHaveLength(2)
    expect(wm.on("B", "press")).toHaveLength(1)

    // Settings panel: the click offset is a radio group (Off by default); removed settings are gone.
    await page.getByRole("button", { name: "Windows & settings" }).click()
    const offsets = page.getByRole("radiogroup", { name: "Click offset" }).getByRole("radio")
    expect(await offsets.allTextContents()).toEqual(["Off", "1", "5", "10", "15", "20"])
    expect(await page.getByRole("radio", { name: /Click offset off/ }).getAttribute("aria-checked")).toBe("true")
    await page.getByRole("radio", { name: "Click offset 10 pixels" }).click()
    await page.locator('[role="radio"][aria-checked="true"][aria-label="Click offset 10 pixels"]').waitFor()
    // The click delay row sits right below it, same control, in milliseconds.
    const delays = page.getByRole("radiogroup", { name: "Click delay" }).getByRole("radio")
    expect(await delays.allTextContents()).toEqual(["Off", "50", "100", "200", "300", "500"])
    expect(await page.getByRole("radio", { name: /Click delay off/ }).getAttribute("aria-checked")).toBe("true")
    await page.getByRole("radio", { name: "Click delay 100 milliseconds" }).click()
    await page.locator('[role="radio"][aria-checked="true"][aria-label="Click delay 100 milliseconds"]').waitFor()
    expect(
      await page.evaluate(`(() => {
        const [o, d] = [...document.querySelectorAll('[role="radiogroup"]')].map((g) => g.parentElement)
        return o?.nextElementSibling === d
      })()`),
    ).toBe(true)
    // Background clicks (experimental) sits right below Click delay.
    expect(
      await page.evaluate(`(() => {
        const d = document.querySelector('[role="radiogroup"][aria-label="Click delay"]')?.parentElement
        return d?.nextElementSibling?.textContent?.includes("Background clicks") === true
      })()`),
    ).toBe(true)
    expect(await page.getByText("Replicate typing").count()).toBe(0)
    expect(await page.getByText("Drag speed").count()).toBe(0)
    // Quit from the panel: the app exits.
    const closed = new Promise<void>((r) => app!.process().once("exit", () => r()))
    // The app can exit before Playwright finishes the click, which rejects with "Target page,
    // context or browser has been closed". That's the outcome we want; `closed` is the assertion.
    await page
      .getByRole("button", { name: "Quit Clickered" })
      .click()
      .catch((e: unknown) => {
        if (!/has been closed/.test(String(e))) throw e
      })
    await closed
    app = null
  })

  it("has an experimental Background clicks switch that toggles and persists", async () => {
    await page.getByRole("button", { name: "Windows & settings" }).waitFor({ state: "visible", timeout: 15_000 })
    await page.getByRole("button", { name: "Windows & settings" }).click()
    const sw = page.getByRole("switch", { name: /Click target windows without moving your mouse/ })
    await sw.waitFor({ state: "visible" })
    expect(await page.getByText("Experimental", { exact: true }).count()).toBe(1)
    expect(await sw.getAttribute("aria-checked")).toBe("false")
    await sw.click()
    await page.locator('[role="switch"][aria-checked="true"][aria-label^="Click target windows"]').waitFor()
    // The config is saved a moment after the change.
    const userData = await app!.evaluate(({ app: a }) => a.getPath("userData"))
    const saved = (): unknown => {
      try {
        return (JSON.parse(readFileSync(join(userData, "config.json"), "utf8")) as { backgroundClicks?: unknown }).backgroundClicks
      } catch {
        return undefined
      }
    }
    await waitFor(() => saved() === true, "backgroundClicks saved as true", 5000)
    await sw.click()
    await page.locator('[role="switch"][aria-checked="false"][aria-label^="Click target windows"]').waitFor()
    await waitFor(() => saved() === false, "backgroundClicks saved as false", 5000)
  })
})

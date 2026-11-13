/**
 * The whole app: built Electron bundle + real helper + fake WM on Xvfb, driven through
 * the bar UI with Playwright.
 */
import { existsSync, mkdtempSync } from "node:fs"
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

    // Quit from the panel: the app exits.
    const closed = new Promise<void>((r) => app!.process().once("exit", () => r()))
    await page.getByRole("button", { name: "Windows & settings" }).click()
    // The app can exit before Playwright finishes the click, which rejects with "Target page,
    // context or browser has been closed". That's the outcome we want; `closed` is the assertion.
    await page
      .getByRole("button", { name: "Quit clickered" })
      .click()
      .catch((e: unknown) => {
        if (!/has been closed/.test(String(e))) throw e
      })
    await closed
    app = null
  })
})

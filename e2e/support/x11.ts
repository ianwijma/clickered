/**
 * Shared fixtures for the E2E suites. These drive a real X server, so they refuse to run
 * anywhere but the throwaway Xvfb inside the e2e Docker image (`npm run test:e2e`).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"

export const ROOT = resolve(import.meta.dirname, "..", "..")
export const HELPER = process.env["HELPER"] ?? join(ROOT, "resources", "clickered-helper")
const PHYSINPUT = process.env["PHYSINPUT"] ?? "/usr/local/bin/physinput"

/** The private Xvfb display that e2e/run.sh starts inside the container. */
export const E2E_DISPLAY = ":99"

/** Throws unless we are inside the e2e container on its private Xvfb. */
export const assertSandbox = (): void => {
  if (process.env["CLICKERED_E2E"] !== "1" || process.env["DISPLAY"] !== E2E_DISPLAY || !existsSync("/.dockerenv")) {
    throw new Error(
      "E2E tests inject real input into an X server. Run them with `npm run test:e2e` (Docker + Xvfb), not on your desktop.",
    )
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const waitFor = async (pred: () => boolean, what = "condition", ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

// ---------------------------------------------------------------------------
// Input

/**
 * "Physical" input: events from the Xvfb's own mouse/keyboard devices, which the helper
 * records (unlike XTEST input from xdotool, which it ignores as its own).
 */
export const phys = {
  move: (x: number, y: number) => execFileSync(PHYSINPUT, ["m", String(x), String(y)]),
  button: (b: number, down: boolean) => execFileSync(PHYSINPUT, ["b", String(b), down ? "1" : "0"]),
  key: (code: number, down: boolean) => execFileSync(PHYSINPUT, ["k", String(code), down ? "1" : "0"]),
  click(x: number, y: number, b = 1) {
    this.move(x, y)
    this.button(b, true)
    this.button(b, false)
  },
  /** Press at `from`, move through `steps` evenly spaced points to `to` over `ms`, release. */
  async drag(from: [number, number], to: [number, number], steps = 10, ms = 200) {
    this.move(...from)
    this.button(1, true)
    for (let i = 1; i <= steps; i++) {
      await sleep(ms / steps)
      this.move(Math.round(from[0] + ((to[0] - from[0]) * i) / steps), Math.round(from[1] + ((to[1] - from[1]) * i) / steps))
    }
    this.button(1, false)
  },
}

/** XTEST input (what the helper treats as its own injection). */
export const xdotool = (...args: string[]): string => execFileSync("xdotool", args, { encoding: "utf8" })

export const pointer = (): { x: number; y: number } => {
  const out = xdotool("getmouselocation", "--shell")
  const get = (k: string) => Number(/^(\w+)=(\d+)$/m.exec(out.split("\n").find((l) => l.startsWith(`${k}=`)) ?? "")?.[2])
  return { x: get("X"), y: get("Y") }
}

// ---------------------------------------------------------------------------
// Fake window manager (native/test/fakewm.py)

/** A pointer/key event as seen by one of the fake WM's test windows. */
export interface WmEvent {
  readonly ev: "press" | "release" | "motion" | "kpress" | "krelease" | "activate"
  /** "A", "A.child", "B", "C" */
  readonly win: string
  readonly detail?: number
  /** Window-relative position. */
  readonly x?: number
  readonly y?: number
  readonly rx?: number
  readonly ry?: number
}

export interface FakeWm {
  /** A: 640x408+0+0 with a 632x374+4+30 child (content rect). B: 400x300+650+0. C: 300x200+700+50, covers B. */
  readonly ids: { readonly A: number; readonly Achild: number; readonly B: number; readonly C: number }
  readonly events: WmEvent[]
  /** Events received by one window (a top-level and its children: "A" matches "A.child"). */
  readonly on: (win: string, ev?: WmEvent["ev"]) => WmEvent[]
  readonly clear: () => void
  readonly stop: () => void
}

export const startFakeWm = (): Promise<FakeWm> =>
  new Promise((resolveWm, reject) => {
    const proc: ChildProcess = spawn("python3", [join(ROOT, "native", "test", "fakewm.py")], {
      stdio: ["ignore", "pipe", "inherit"],
    })
    const events: WmEvent[] = []
    let ready = false
    const timer = setTimeout(() => reject(new Error("fake WM did not start")), 5000)
    proc.on("exit", (code) => {
      if (!ready) reject(new Error(`fake WM exited with ${code}`))
    })
    createInterface({ input: proc.stdout! }).on("line", (line) => {
      const msg = JSON.parse(line) as Record<string, unknown>
      if (msg["ready"]) {
        ready = true
        clearTimeout(timer)
        const ids = msg as unknown as FakeWm["ids"]
        resolveWm({
          ids: { A: ids.A, Achild: ids.Achild, B: ids.B, C: ids.C },
          events,
          on: (win, ev) => events.filter((e) => (e.win === win || e.win.startsWith(`${win}.`)) && (!ev || e.ev === ev)),
          clear: () => void events.splice(0),
          stop: () => void proc.kill("SIGKILL"),
        })
      } else events.push(msg as unknown as WmEvent)
    })
  })

/** Root coordinates of a fraction of A's content rect / B's window. */
export const inA = (fx: number, fy: number): [number, number] => [Math.round(4 + fx * 632), Math.round(30 + fy * 374)]
export const inB = (fx: number, fy: number): [number, number] => [Math.round(650 + fx * 400), Math.round(fy * 300)]
/** A point in B that neither C nor the Clickered bar (top centre) covers. */
export const B_FREE: [number, number] = [1030, 280]

/**
 * Wait until the helper's pick grab is active. The grab only selects button events, so
 * while it is held the fake WM's windows stop receiving pointer motion: nudge the pointer
 * around `at` until a move produces no motion event. (The protocol has no "grabbed" ack.)
 */
export const waitForPickGrab = async (wm: FakeWm, at: [number, number], ms = 5000): Promise<void> => {
  const end = Date.now() + ms
  for (let i = 0; Date.now() < end; i++) {
    const before = wm.on("A", "motion").length + wm.on("B", "motion").length + wm.on("C", "motion").length
    xdotool("mousemove", String(at[0] + (i % 2)), String(at[1]))
    await sleep(100)
    const after = wm.on("A", "motion").length + wm.on("B", "motion").length + wm.on("C", "motion").length
    if (after === before) return
  }
  throw new Error("timed out waiting for the pick grab")
}

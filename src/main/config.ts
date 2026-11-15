/**
 * Persistent settings: `<userData>/config.json`.
 * Loading is tolerant (any problem -> defaults, field by field); saving is debounced
 * and atomic (write temp file, rename).
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Data, Effect } from "effect"
import { DEFAULT_TIMING, snapClickDelay, snapClickOffset, type Timing } from "./script"

export interface BarPosition {
  readonly x: number
  readonly y: number
}

export interface Config {
  readonly groupClass: string | null
  readonly groupLabel: string | null
  /** Click offset radius in pixels (one of `CLICK_OFFSETS`). */
  readonly clickOffset: number
  /** Maximum random pause in ms before each target window (one of `CLICK_DELAYS`). */
  readonly clickDelay: number
  /** Experimental: click without moving the user's pointer. Only `true` enables it. */
  readonly backgroundClicks: boolean
  readonly hotkey: string
  readonly bar: BarPosition | null
  /** Overrides for individual timing constants (unknown/invalid keys are ignored). */
  readonly timing: Partial<Timing>
}

export const DEFAULT_HOTKEY = "Control+`"

export const DEFAULT_CONFIG: Config = {
  groupClass: null,
  groupLabel: null,
  clickOffset: 0,
  clickDelay: 0,
  backgroundClicks: false,
  hotkey: DEFAULT_HOTKEY,
  bar: null,
  timing: {},
}

export class ConfigReadError extends Data.TaggedError("ConfigReadError")<{ readonly message: string }> {}

const isObj = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const str = (u: unknown): string | null => (typeof u === "string" && u.length > 0 ? u : null)
const finite = (u: unknown): number | null => (typeof u === "number" && Number.isFinite(u) ? u : null)

/**
 * Turn arbitrary parsed JSON into a valid Config, keeping every field that is valid.
 * Fields this version no longer has (e.g. `replicateKeys`, `dragSpeed`, the old key
 * timing constants) are silently dropped.
 */
export const sanitizeConfig = (raw: unknown): Config => {
  if (!isObj(raw)) return DEFAULT_CONFIG
  const groupClass = str(raw["groupClass"])
  const bar = isObj(raw["bar"]) ? raw["bar"] : null
  const bx = bar ? finite(bar["x"]) : null
  const by = bar ? finite(bar["y"]) : null
  const timing: Partial<Record<keyof Timing, number>> = {}
  const rawTiming = raw["timing"]
  if (isObj(rawTiming)) {
    for (const key of Object.keys(DEFAULT_TIMING) as Array<keyof Timing>) {
      const v = finite(rawTiming[key])
      if (v !== null && v >= 0) timing[key] = v
    }
  }
  return {
    groupClass,
    groupLabel: groupClass ? str(raw["groupLabel"]) : null,
    clickOffset: snapClickOffset(raw["clickOffset"]),
    clickDelay: snapClickDelay(raw["clickDelay"]),
    backgroundClicks: raw["backgroundClicks"] === true,
    hotkey: str(raw["hotkey"]) ?? DEFAULT_HOTKEY,
    bar: bx !== null && by !== null ? { x: Math.round(bx), y: Math.round(by) } : null,
    timing,
  }
}

export const timingOf = (c: Config): Timing => ({ ...DEFAULT_TIMING, ...c.timing })

/** Load the config; never fails (logs and falls back to defaults). */
export const loadConfig = (path: string): Effect.Effect<Config> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (e) => new ConfigReadError({ message: String(e) }),
  }).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => sanitizeConfig(JSON.parse(text)),
        catch: (e) => new ConfigReadError({ message: `invalid JSON: ${String(e)}` }),
      }),
    ),
    Effect.tapError((e) =>
      e.message.includes("ENOENT") ? Effect.void : Effect.logWarning(`config: ${e.message}; using defaults`),
    ),
    Effect.orElseSucceed(() => DEFAULT_CONFIG),
  )

/** Holds the current config in memory and writes it back (debounced). */
export class ConfigStore {
  private current: Config
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly path: string,
    initial: Config,
    private readonly debounceMs = 400,
  ) {
    this.current = initial
  }

  get(): Config {
    return this.current
  }

  update(patch: Partial<Config>): void {
    const next = { ...this.current, ...patch }
    if (JSON.stringify(next) === JSON.stringify(this.current)) return
    this.current = next
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  /** Write now if a save is pending (also called on quit). */
  flush(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.current, null, 2) + "\n", "utf8")
      renameSync(tmp, this.path)
    } catch (e) {
      console.warn(`[clickered] config: save failed: ${String(e)}`)
    }
  }
}

import type { AppState, UpdateFailure, UpdateState } from "@shared/ipc"

const KEY_NAMES: Record<string, string> = {
  Control: "Ctrl",
  Ctrl: "Ctrl",
  CommandOrControl: "Ctrl",
  CmdOrCtrl: "Ctrl",
  Command: "Cmd",
  Cmd: "Cmd",
  Option: "Alt",
  Meta: "Super",
  Escape: "Esc",
  Return: "Enter",
  Plus: "+",
  Space: "Space",
}

/** "Control+`" -> "Ctrl `" */
export function formatHotkey(accelerator: string): string {
  if (!accelerator) return ""
  return accelerator
    .split("+")
    .filter((k) => k.length > 0)
    .map((k) => KEY_NAMES[k] ?? k)
    .join(" ")
}

/** "4 windows" when all are included, "3 of 4" when some are excluded. */
export function countText(state: AppState): string {
  const total = state.windows.length
  const included = state.windows.filter((w) => w.included).length
  if (included === total) return `${total} ${total === 1 ? "window" : "windows"}`
  return `${included} of ${total}`
}

export function groupName(state: AppState): string {
  return state.groupLabel ?? state.groupClass ?? "app"
}

/** Label of one click-offset choice: "Off" for 0, else the pixel count. */
export function clickOffsetLabel(px: number): string {
  return px === 0 ? "Off" : String(px)
}

/** Label of one click-delay choice: "Off" for 0, else the millisecond count. */
export function clickDelayLabel(ms: number): string {
  return ms === 0 ? "Off" : String(ms)
}

// ---------------------------------------------------------------------------
// The chip under the pill: at most one of a permission notice or an update notice.

/** Local state of the macOS permission chip (main only reports "ok" | "missing"). */
export type PermissionPhase = "idle" | "waiting" | "granted"

/**
 * Next permission phase after a state snapshot. `prev` is the previous snapshot's permission
 * (null before the first one). "missing" -> "ok" shows the "granted" confirmation, whether or
 * not the user clicked the chip; the caller moves "granted" on to "idle" after a moment.
 */
export function permissionPhaseAfter(
  phase: PermissionPhase,
  prev: AppState["permission"] | null,
  next: AppState["permission"],
): PermissionPhase {
  if (next === "missing") return phase === "granted" ? "idle" : phase
  if (phase === "granted") return "granted"
  return prev === "missing" || phase === "waiting" ? "granted" : "idle"
}

export type ChipView =
  | { readonly kind: "none" }
  | { readonly kind: "permission-missing" | "permission-waiting" | "permission-granted"; readonly text: string }
  | {
      readonly kind: "update-available"
      readonly text: string
      readonly version: string
      readonly prerelease: boolean
    }
  | { readonly kind: "update-failed"; readonly text: string; readonly version: string; readonly message: string }
  /** `progress` is a whole percent, or null while it cannot be measured (indeterminate bar). */
  | {
      readonly kind: "update-progress"
      readonly title: string
      readonly sub: string
      readonly progress: number | null
    }

/** Downloaded fraction (0..1) as a whole percent, clamped to 0..100; garbage counts as 0. */
export function progressPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0
  return Math.min(100, Math.max(0, Math.round(fraction * 100)))
}

export function updateFailureText(reason: UpdateFailure): string {
  switch (reason) {
    case "checksum":
      return "Update failed its checksum"
    case "download":
      return "Update download failed"
    case "install":
      return "Update was not installed"
  }
}

/** What the chip shows. Permission beats update; nothing while picking windows. */
export function chipView(update: UpdateState, state: AppState | null, phase: PermissionPhase): ChipView {
  if (state?.picking) return { kind: "none" }
  if (phase === "granted") return { kind: "permission-granted", text: "Permission granted" }
  if (state?.permission === "missing") {
    return phase === "waiting"
      ? { kind: "permission-waiting", text: "Waiting for Accessibility permission…" }
      : { kind: "permission-missing", text: "macOS permission missing" }
  }
  switch (update.status) {
    case "none":
    case "skipped":
      return { kind: "none" }
    case "available":
      return {
        kind: "update-available",
        text: `Update ${update.version}`,
        version: update.version,
        prerelease: update.prerelease,
      }
    case "downloading": {
      const pct = progressPercent(update.progress)
      return { kind: "update-progress", title: `Updating to ${update.version}`, sub: `Downloading · ${pct}%`, progress: pct }
    }
    case "verifying":
      return {
        kind: "update-progress",
        title: `Updating to ${update.version}`,
        sub: "Verifying checksum…",
        progress: null,
      }
    case "installing":
      return {
        kind: "update-progress",
        title: `Installing ${update.version}`,
        sub: "Clickered restarts by itself",
        progress: null,
      }
    case "failed":
      return {
        kind: "update-failed",
        text: updateFailureText(update.reason),
        version: update.version,
        message: update.message,
      }
  }
}

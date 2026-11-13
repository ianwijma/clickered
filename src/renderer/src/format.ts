import type { AppState } from "@shared/ipc"

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

export const DRAG_SPEEDS = [1, 1.5, 2, 3] as const

export function nearestSpeed(speed: number): number {
  let best: number = DRAG_SPEEDS[0]
  for (const s of DRAG_SPEEDS) if (Math.abs(s - speed) < Math.abs(best - speed)) best = s
  return best
}

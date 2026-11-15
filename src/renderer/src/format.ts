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

/** Label of one click-offset choice: "Off" for 0, else the pixel count. */
export function clickOffsetLabel(px: number): string {
  return px === 0 ? "Off" : String(px)
}

/** Label of one click-delay choice: "Off" for 0, else the millisecond count. */
export function clickDelayLabel(ms: number): string {
  return ms === 0 ? "Off" : String(ms)
}

/**
 * Contract between the Electron main process and the renderer (the bar UI).
 * Main owns all state and pushes a full `AppState` snapshot on every change.
 */
import type { WindowId } from "./protocol"

export interface GroupWindow {
  readonly id: WindowId
  /** 1-based label, ordered left-to-right then top-to-bottom on screen. */
  readonly index: number
  readonly title: string
  /** Whether clicks are replicated from/to this window. */
  readonly included: boolean
  /** True for the window that is currently the click source (pinned, or last used in auto mode). */
  readonly isMaster: boolean
}

export interface AppState {
  /** Master on/off switch for replication (the toggle). */
  readonly enabled: boolean
  readonly helper: "starting" | "ready" | "error"
  readonly helperError: string | null
  /** True while the user is clicking windows to add to / remove from the group. */
  readonly picking: boolean
  /** Non-null when a group exists (at least one picked window is open), else null. */
  readonly groupClass: string | null
  /** A short human label for the group (window title of a member), or null. */
  readonly groupLabel: string | null
  /** The picked windows that are still open, in `index` order. Updates live while picking. */
  readonly windows: ReadonlyArray<GroupWindow>
  /** "auto": whichever included window you click in is the source. "pinned": only `masterId`. */
  readonly masterMode: "auto" | "pinned"
  readonly masterId: WindowId | null
  /** Optional keyboard replication. */
  readonly replicateKeys: boolean
  /** Drag replay speed multiplier (1 = original timing). */
  readonly dragSpeed: number
  /** Global toggle hotkey as an Electron accelerator, e.g. "Control+`". */
  readonly hotkey: string
  /** True while a gesture is being replayed into the other windows. */
  readonly busy: boolean
}

/** Exposed on `window.clickered` by the preload script. */
export interface ClickeredApi {
  /** Current snapshot (call once on startup). */
  getState(): Promise<AppState>
  /** Subscribe to snapshots. Returns an unsubscribe function. */
  onState(listener: (state: AppState) => void): () => void
  setEnabled(enabled: boolean): void
  /** Start picking: every window clicked is toggled in/out of the group until `cancelPick`. */
  startPick(): void
  /** Finish picking ("Done"). The windows picked so far stay in the group. */
  cancelPick(): void
  /** Forget the group entirely. */
  clearGroup(): void
  setIncluded(id: WindowId, included: boolean): void
  /** Pin a master window, or null to return to auto mode. */
  setMaster(id: WindowId | null): void
  setReplicateKeys(on: boolean): void
  setDragSpeed(speed: number): void
  /** Renderer reports the pixel size its content needs; main resizes the frameless window. */
  setSize(width: number, height: number): void
  quit(): void
}

export const IPC = {
  getState: "clickered:get-state",
  state: "clickered:state",
  command: "clickered:command",
} as const

/** Everything except getState/onState travels as one of these over `IPC.command`. */
export type IpcCommand =
  | { readonly c: "setEnabled"; readonly enabled: boolean }
  | { readonly c: "startPick" }
  | { readonly c: "cancelPick" }
  | { readonly c: "clearGroup" }
  | { readonly c: "setIncluded"; readonly id: WindowId; readonly included: boolean }
  | { readonly c: "setMaster"; readonly id: WindowId | null }
  | { readonly c: "setReplicateKeys"; readonly on: boolean }
  | { readonly c: "setDragSpeed"; readonly speed: number }
  | { readonly c: "setSize"; readonly width: number; readonly height: number }
  | { readonly c: "quit" }

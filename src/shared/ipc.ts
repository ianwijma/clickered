/**
 * Contract between the Electron main process and the renderer (the bar UI).
 * Main owns all state and pushes a full `AppState` snapshot on every change.
 */
import type { WindowId } from "./protocol"

/** Allowed click-offset radii in pixels, in UI order. 0 = off (the default), 20 = the maximum. */
export const CLICK_OFFSETS = [0, 1, 5, 10, 15, 20] as const

/** Allowed maximum click delays in milliseconds, in UI order. 0 = off (the default), 500 = the maximum. */
export const CLICK_DELAYS = [0, 50, 100, 200, 300, 500] as const

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
  /**
   * With helper "error": why it stopped. With helper "starting": an `error` the helper sent
   * before `ready`, which the user has to act on (e.g. a missing macOS permission); cleared
   * by `ready`.
   */
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
  /** Radius in pixels of the random offset each target window's replayed gesture is shifted
   *  by (one of `CLICK_OFFSETS`; 0 = off, every target gets exactly the same spot). */
  readonly clickOffset: number
  /** Maximum random pause in ms before replaying into each target window (one of
   *  `CLICK_DELAYS`; 0 = off, targets are replayed back to back). */
  readonly clickDelay: number
  /** Global toggle hotkey as an Electron accelerator, e.g. "Control+`". */
  readonly hotkey: string
  /** True while a gesture is being replayed into the other windows. */
  readonly busy: boolean
  /**
   * "missing" while the helper is waiting for an OS permission the user has to grant
   * (macOS Accessibility); "ok" otherwise, and always "ok" on Linux and Windows. The bar
   * shows a chip with a button that opens the right settings page (`openPermissionSettings`).
   */
  readonly permission: "ok" | "missing"
}

/** Why an update could not be installed. */
export type UpdateFailure = "checksum" | "download" | "install"

/**
 * In-app update state, pushed on `IPC.update` separately from `AppState`. Main checks for a
 * newer release on startup; the bar shows a chip under the pill for every status but "none".
 */
export type UpdateState =
  /** Nothing to show: not checked yet, up to date, the check failed, or this copy of the
   *  app cannot update itself (dev run, not installed from a release package). */
  | { readonly status: "none" }
  /** A newer release exists; `installUpdate` starts it. `version` has no leading "v". */
  | { readonly status: "available"; readonly version: string }
  /** `progress` is the downloaded fraction, 0..1. */
  | { readonly status: "downloading"; readonly version: string; readonly progress: number }
  /** The download is complete and its SHA-256 checksum is being checked. */
  | { readonly status: "verifying"; readonly version: string }
  /** The verified package is being installed; the app restarts by itself afterwards. */
  | { readonly status: "installing"; readonly version: string }
  /** `installUpdate` retries from the start. `message` is a short technical detail (tooltip). */
  | { readonly status: "failed"; readonly version: string; readonly reason: UpdateFailure; readonly message: string }

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
  /** Set the click offset radius in pixels (snapped to the nearest of `CLICK_OFFSETS`). */
  setClickOffset(px: number): void
  /** Set the maximum click delay in ms (snapped to the nearest of `CLICK_DELAYS`). */
  setClickDelay(ms: number): void
  /** Renderer reports the pixel size its content needs; main resizes the frameless window. */
  setSize(width: number, height: number): void
  /** Current update snapshot (call once on startup). */
  getUpdate(): Promise<UpdateState>
  /** Subscribe to update snapshots. Returns an unsubscribe function. */
  onUpdate(listener: (update: UpdateState) => void): () => void
  /** Download, verify and install the available update (also the "Retry" after a failure).
   *  Ignored unless the status is "available" or "failed". */
  installUpdate(): void
  /** Open the OS settings page where the missing permission is granted (macOS: Privacy &
   *  Security > Accessibility). Ignored when `permission` is "ok". */
  openPermissionSettings(): void
  quit(): void
}

export const IPC = {
  getState: "clickered:get-state",
  state: "clickered:state",
  command: "clickered:command",
  getUpdate: "clickered:get-update",
  update: "clickered:update",
} as const

/** Everything except getState/onState travels as one of these over `IPC.command`. */
export type IpcCommand =
  | { readonly c: "setEnabled"; readonly enabled: boolean }
  | { readonly c: "startPick" }
  | { readonly c: "cancelPick" }
  | { readonly c: "clearGroup" }
  | { readonly c: "setIncluded"; readonly id: WindowId; readonly included: boolean }
  | { readonly c: "setMaster"; readonly id: WindowId | null }
  | { readonly c: "setClickOffset"; readonly px: number }
  | { readonly c: "setClickDelay"; readonly ms: number }
  | { readonly c: "setSize"; readonly width: number; readonly height: number }
  | { readonly c: "installUpdate" }
  | { readonly c: "openPermissionSettings" }
  | { readonly c: "quit" }

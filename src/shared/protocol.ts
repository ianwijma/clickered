/**
 * Wire protocol between the Electron main process and the native helper
 * (`resources/clickered-helper`, `clickered-helper.exe` on Windows; one per OS, same
 * protocol). Full prose spec: docs/PROTOCOL.md, per-platform differences in its
 * "Platforms" section.
 *
 * helper -> host : one JSON object per line on stdout (types below)
 * host -> helper : one text command per line on stdin (see `HelperCommand`)
 */

/**
 * 32-bit id of a top-level client window: an X11 window (from _NET_CLIENT_LIST), a
 * macOS CGWindowID, or a Windows HWND.
 */
export type WindowId = number

/** Protocol version the host speaks; the helper announces its own in `ready`. */
export const PROTOCOL_VERSION = 2

export interface HelperWindow {
  readonly id: WindowId
  readonly title: string
  /** WM_CLASS class part, e.g. "steam_app_3050953929". Used for grouping. */
  readonly cls: string
  readonly pid: number
  /** Content rect in root coordinates (window minus client-side title bar when detectable). */
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly mapped: boolean
}

export type HelperMessage =
  | { readonly t: "ready"; readonly version: number }
  | { readonly t: "windows"; readonly active: WindowId; readonly list: ReadonlyArray<HelperWindow> }
  | {
      /** Physical (non-XTEST) mouse button transition. */
      readonly t: "btn"
      readonly down: boolean
      /** X button number: 1 left, 2 middle, 3 right, 4/5 wheel up/down, 6/7 wheel left/right. */
      readonly button: number
      /** Client window under the pointer at press time (0 = none). For releases and for
       *  presses while another button is held: the window of the gesture's first press. */
      readonly win: WindowId
      /** Pointer position as a fraction of `win`'s content rect (may leave 0..1 during drags). */
      readonly fx: number
      readonly fy: number
      /** Pointer position in root pixels. */
      readonly x: number
      readonly y: number
      /** Milliseconds, monotonic. */
      readonly time: number
    }
  | {
      /** Pointer motion; only sent while at least one physical button is held. Throttled. */
      readonly t: "motion"
      readonly win: WindowId
      readonly fx: number
      readonly fy: number
      readonly x: number
      readonly y: number
      readonly time: number
    }
  /** Physical Escape press (panic key). Always sent; the helper has already aborted any running seq. */
  | { readonly t: "esc"; readonly time: number }
  | { readonly t: "picked"; readonly win: WindowId }
  | { readonly t: "done"; readonly id: number; readonly ok: boolean }
  | { readonly t: "error"; readonly msg: string }

/** One step of a replay sequence. Serialised by `encodeOp`. */
export type SeqOp =
  /** Activate + raise window and wait until it is the active window (bounded wait). */
  | { readonly op: "f"; readonly win: WindowId }
  /** Warp pointer to a fraction of the window's content rect, making sure that window is
   *  the one under the pointer there (raising it if it is covered). */
  | { readonly op: "m"; readonly win: WindowId; readonly fx: number; readonly fy: number }
  /** Button down / up. */
  | { readonly op: "d"; readonly button: number }
  | { readonly op: "u"; readonly button: number }
  /** Sleep, milliseconds. */
  | { readonly op: "s"; readonly ms: number }
  /** Warp pointer to absolute root coordinates. */
  | { readonly op: "w"; readonly x: number; readonly y: number }

export type HelperCommand =
  | { readonly c: "list" }
  | { readonly c: "pick" }
  | { readonly c: "pickcancel" }
  | { readonly c: "seq"; readonly id: number; readonly ops: ReadonlyArray<SeqOp> }
  | { readonly c: "abort" }

const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(5))

export const encodeOp = (o: SeqOp): string => {
  switch (o.op) {
    case "f":
      return `f ${o.win}`
    case "m":
      return `m ${o.win} ${num(o.fx)} ${num(o.fy)}`
    case "d":
    case "u":
      return `${o.op} ${o.button}`
    case "s":
      return `s ${Math.max(0, Math.round(o.ms))}`
    case "w":
      return `w ${Math.round(o.x)} ${Math.round(o.y)}`
  }
}

/** Serialise a command to the single line (without trailing newline) the helper expects. */
export const encodeCommand = (cmd: HelperCommand): string => {
  switch (cmd.c) {
    case "list":
    case "pick":
    case "pickcancel":
    case "abort":
      return cmd.c
    case "seq":
      return `seq ${cmd.id} ${cmd.ops.map(encodeOp).join(";")}`
  }
}

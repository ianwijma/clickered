/**
 * Runtime validation of renderer → main IPC commands. The preload is typed, but anything
 * arriving over IPC is untrusted, so every field is checked before it reaches the engine.
 */
import type { IpcCommand } from "@shared/ipc"

const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isWinId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0

/** Returns the command if it is well-formed, otherwise null. */
export const parseCommand = (u: unknown): IpcCommand | null => {
  if (typeof u !== "object" || u === null) return null
  const o = u as Record<string, unknown>
  switch (o["c"]) {
    case "setEnabled":
      return isBool(o["enabled"]) ? { c: "setEnabled", enabled: o["enabled"] } : null
    case "startPick":
    case "cancelPick":
    case "clearGroup":
    case "quit":
      return { c: o["c"] }
    case "setIncluded":
      return isWinId(o["id"]) && isBool(o["included"]) ? { c: "setIncluded", id: o["id"], included: o["included"] } : null
    case "setMaster":
      return o["id"] === null || isWinId(o["id"]) ? { c: "setMaster", id: o["id"] } : null
    case "setClickOffset":
      return isNum(o["px"]) ? { c: "setClickOffset", px: o["px"] } : null
    case "setClickDelay":
      return isNum(o["ms"]) ? { c: "setClickDelay", ms: o["ms"] } : null
    case "setBackgroundClicks":
      return isBool(o["on"]) ? { c: "setBackgroundClicks", on: o["on"] } : null
    case "setSize":
      return isNum(o["width"]) && isNum(o["height"]) ? { c: "setSize", width: o["width"], height: o["height"] } : null
    default:
      return null
  }
}

import { describe, expect, it } from "vitest"
import { parseCommand } from "./command"

describe("parseCommand", () => {
  it("accepts well-formed commands", () => {
    expect(parseCommand({ c: "setEnabled", enabled: true })).toEqual({ c: "setEnabled", enabled: true })
    expect(parseCommand({ c: "quit" })).toEqual({ c: "quit" })
    expect(parseCommand({ c: "setIncluded", id: 42, included: false })).toEqual({ c: "setIncluded", id: 42, included: false })
    expect(parseCommand({ c: "setMaster", id: null })).toEqual({ c: "setMaster", id: null })
    expect(parseCommand({ c: "setSize", width: 400, height: 60 })).toEqual({ c: "setSize", width: 400, height: 60 })
    expect(parseCommand({ c: "setClickOffset", px: 5 })).toEqual({ c: "setClickOffset", px: 5 })
    expect(parseCommand({ c: "setClickDelay", ms: 100 })).toEqual({ c: "setClickDelay", ms: 100 })
    expect(parseCommand({ c: "installUpdate" })).toEqual({ c: "installUpdate" })
    expect(parseCommand({ c: "openPermissionSettings" })).toEqual({ c: "openPermissionSettings" })
  })

  it("drops every payload of the update and permission commands", () => {
    // Nothing from the renderer may choose what is downloaded or which page is opened.
    expect(parseCommand({ c: "installUpdate", url: "https://evil.example/x.deb", version: "9.9.9" })).toEqual({ c: "installUpdate" })
    expect(parseCommand({ c: "openPermissionSettings", url: "file:///etc/passwd" })).toEqual({ c: "openPermissionSettings" })
  })

  it("drops extra fields", () => {
    expect(parseCommand({ c: "startPick", extra: 1 })).toEqual({ c: "startPick" })
  })

  it("rejects unknown commands and malformed payloads", () => {
    for (const bad of [
      null,
      "quit",
      {},
      { c: "rm -rf" },
      { c: "setEnabled", enabled: "false" },
      { c: "setReplicateKeys", on: true }, // removed
      { c: "setDragSpeed", speed: 2 }, // removed
      { c: "setIncluded", id: -1, included: true },
      { c: "setIncluded", id: 1.5, included: true },
      { c: "setMaster" },
      { c: "setClickOffset", px: Number.NaN },
      { c: "setClickOffset", px: "5" },
      { c: "setClickDelay", ms: Number.NaN },
      { c: "setClickDelay", ms: "100" },
      { c: "setClickDelay", px: 100 },
      { c: "setSize", width: Infinity, height: 10 },
      { c: "InstallUpdate" },
      { c: "installupdate" },
      { c: ["installUpdate"] },
      { c: "openPermissionSettings ", url: "x" },
    ]) {
      expect(parseCommand(bad)).toBeNull()
    }
  })
})

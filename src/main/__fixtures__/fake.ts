import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HelperSpawnOptions } from "../helper"

const FAKE = join(import.meta.dirname, "fake-helper.mjs")

/** Spawn options for the fake helper (run with the current node) plus a reader for its stdin log. */
export const fakeHelper = (env: Record<string, string> = {}): { opts: HelperSpawnOptions; log: () => string[] } => {
  const dir = mkdtempSync(join(tmpdir(), "clickered-test-"))
  const logFile = join(dir, "stdin.log")
  return {
    opts: { command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_LOG: logFile, ...env }, killAfterMs: 300 },
    log: () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []),
  }
}


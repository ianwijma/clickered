#!/usr/bin/env node
// `npm run build:helper`: builds the native input helper for the host OS.
//
//   Linux (X11) -> native/Makefile      -> resources/clickered-helper
//   macOS       -> native/mac/Makefile  -> resources/clickered-helper (universal)
//   Windows     -> native/win/Makefile  -> resources/clickered-helper.exe
//
// Extra arguments are passed to make (e.g. `npm run build:helper -- CC=clang`).
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

const TARGETS = {
  linux: {
    dir: "native",
    make: ["make"],
    compilers: [process.env.CC || "cc"],
    hint: "Install a C compiler, make, pkg-config and the X11 headers, e.g.\n  sudo apt install build-essential pkg-config libx11-dev libxi-dev libxtst-dev",
  },
  darwin: {
    dir: "native/mac",
    make: ["make"],
    compilers: [process.env.CC || "clang"],
    hint: "Install the Xcode command line tools:\n  xcode-select --install",
  },
  win32: {
    dir: "native/win",
    // Git for Windows / MSYS2 / Chocolatey ship `make`; plain MinGW-w64 ships `mingw32-make`.
    make: ["make", "mingw32-make"],
    compilers: process.env.CC ? [process.env.CC] : ["x86_64-w64-mingw32-gcc", "gcc"],
    hint:
      "Install MinGW-w64 (gcc) and GNU make and put them on PATH, e.g. with MSYS2\n" +
      "(pacman -S mingw-w64-x86_64-gcc make) or Chocolatey (choco install mingw make).\n" +
      "GitHub's windows-latest runner has both preinstalled. See native/win/README.md.",
  },
}

const target = TARGETS[process.platform]
if (!target) {
  console.error(`build:helper: no native helper for platform "${process.platform}" (supported: linux, darwin, win32).`)
  process.exit(1)
}

/** First of `names` that runs with `--version`, or null. */
const findTool = (names) =>
  names.find((n) => {
    const r = spawnSync(n, ["--version"], { stdio: "ignore", shell: false })
    return !r.error && r.status === 0
  }) ?? null

const fail = (what) => {
  console.error(`build:helper: ${what} not found on PATH (building the ${process.platform} helper in ${target.dir}/).`)
  console.error(target.hint)
  process.exit(1)
}

const make = findTool(target.make)
if (!make) fail(`make (${target.make.join(" or ")})`)
if (!findTool(target.compilers)) fail(`a C compiler (${target.compilers.join(" or ")})`)

const args = ["-C", join(root, target.dir), ...process.argv.slice(2)]
console.log(`build:helper: ${make} ${args.join(" ")}`)
const r = spawnSync(make, args, { stdio: "inherit", shell: false })
if (r.error) {
  console.error(`build:helper: could not run ${make}: ${r.error.message}`)
  process.exit(1)
}
if (r.status !== 0) {
  console.error(`build:helper: building the ${process.platform} helper failed (${make} exited with ${r.status ?? r.signal}).`)
  process.exit(r.status || 1)
}

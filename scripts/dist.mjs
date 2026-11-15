#!/usr/bin/env node
// `npm run dist` (after `npm run build`): packages the app for the host OS with
// electron-builder (electron-builder.yml) into dist/.
//
//   Linux   -> clickered-X.Y.Z-amd64.deb
//   macOS   -> clickered-X.Y.Z-arm64.dmg and clickered-X.Y.Z-x64.dmg
//   Windows -> clickered-X.Y.Z-x64.exe (NSIS installer)
//
// Signing is picked up from electron-builder's standard environment variables:
//   macOS:   CSC_LINK + CSC_KEY_PASSWORD (a "Developer ID Application" .p12), or an
//            identity already in the keychain (CSC_NAME). Notarization runs when
//            APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, or
//            APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER, are set.
//   Windows: CSC_LINK / WIN_CSC_LINK + CSC_KEY_PASSWORD / WIN_CSC_KEY_PASSWORD.
// Without them the build is unsigned. On macOS it is then ad-hoc signed instead
// (every Mach-O in the bundle, the helper included), because an arm64 binary
// without any signature does not run at all.
//
// Flags: --dir  only build the unpacked app (dist/<platform>-unpacked), no installer.
import { build, Platform } from "electron-builder"

const dirOnly = process.argv.includes("--dir")

const PLATFORMS = { linux: Platform.LINUX, darwin: Platform.MAC, win32: Platform.WINDOWS }
const platform = PLATFORMS[process.platform]
if (!platform) {
  console.error(`dist: cannot package on "${process.platform}" (supported: linux, darwin, win32).`)
  process.exit(1)
}

/** @type {import("electron-builder").Configuration} */
const overrides = {}
const has = (...names) => names.some((n) => (process.env[n] ?? "").trim() !== "")

if (process.platform === "darwin" && !has("CSC_LINK", "CSC_NAME")) {
  console.log("dist: no Developer ID certificate (CSC_LINK / CSC_NAME): ad-hoc signing, no notarization.")
  overrides.mac = {
    identity: "-",
    // The hardened runtime with an ad-hoc signature needs extra entitlements and
    // buys nothing without notarization.
    hardenedRuntime: false,
    notarize: false,
  }
}
if (process.platform === "win32" && !has("CSC_LINK", "WIN_CSC_LINK")) {
  console.log("dist: no code signing certificate (CSC_LINK / WIN_CSC_LINK): the installer is unsigned.")
}

const targets = dirOnly ? platform.createTarget("dir") : platform.createTarget()

build({ targets, config: overrides, publish: "never" }).then(
  (files) => {
    for (const f of files) console.log(`dist: ${f}`)
  },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)

import type { ClickeredApi } from "@shared/ipc"

declare global {
  /** package.json version, injected by electron.vite.config.ts. */
  const __APP_VERSION__: string

  interface Window {
    readonly clickered: ClickeredApi
  }
}
export {}

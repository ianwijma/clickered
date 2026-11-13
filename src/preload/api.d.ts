import type { ClickeredApi } from "@shared/ipc"

declare global {
  interface Window {
    readonly clickered: ClickeredApi
  }
}
export {}

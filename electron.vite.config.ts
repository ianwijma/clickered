import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "electron-vite"

const alias = { "@shared": resolve(__dirname, "src/shared") }

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: { resolve: { alias }, plugins: [tailwindcss()] },
})

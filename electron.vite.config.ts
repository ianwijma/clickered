import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "electron-vite"
import pkg from "./package.json"

const alias = { "@shared": resolve(__dirname, "src/shared") }

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: {
    resolve: { alias },
    plugins: [tailwindcss()],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  },
})

import { resolve } from "node:path"
import { defineConfig } from "vitest/config"

// E2E suites: run only inside the Docker image (`npm run test:e2e`). They share one X
// server, so files and tests run strictly one at a time.
export default defineConfig({
  resolve: { alias: { "@shared": resolve(import.meta.dirname, "src/shared") } },
  test: {
    include: ["e2e/**/*.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

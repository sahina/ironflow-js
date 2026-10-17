import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'eval/test/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    coverage: { provider: 'v8', include: ['src/**'], thresholds: { lines: 80 } }
  }
})

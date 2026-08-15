import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // jsdom has no indexedDB; the setup file supplies fake-indexeddb so the
    // offline write queue (ADR 0052) is testable at all. See vitest.setup.ts.
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      // Tests use inline implementations to avoid complex ConnectRPC/protobuf imports
      // Coverage thresholds are disabled as we're testing behavior patterns
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        'src/gen/**',
        'examples/**',
        'vitest.config.ts',
        'vitest.setup.ts',
      ],
      // Package-wide thresholds stay off (see above), but src/queue owns
      // persisted user data — a write that goes missing there is unrecoverable,
      // so it gets a floor. Scoped so the existing ~12k lines need no retrofit.
      thresholds: {
        'src/queue/**': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // The SDK falls back to IRONFLOW_API_KEY (#1672), so a contributor shell
    // that exports it would add an Authorization header to every exact-header
    // assertion in the package. Neutralise it for the whole suite.
    env: { IRONFLOW_API_KEY: '' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      // Exclude main source files that use inline implementations in tests
      // (to avoid complex protobuf/ConnectRPC import issues)
      // Only internal/ files are tested directly
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        'src/gen/**',
        'src/index.ts',
        'src/serve.ts',
        'src/step.ts',
        'src/worker.ts',
        'src/worker-streaming.ts',
        'src/types.ts',
        'vitest.config.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },
})

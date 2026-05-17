import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
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

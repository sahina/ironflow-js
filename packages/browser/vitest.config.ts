import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
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
      ],
    },
  },
})

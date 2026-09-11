import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 90,
        branches: 90,
      },
    },
  },
})

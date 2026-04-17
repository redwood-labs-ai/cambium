import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'packages/**/tests/**/*.test.ts'],
  },
})

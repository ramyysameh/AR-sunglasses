import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // DB-backed tests share one SQLite dev file; run serially to avoid write races
    fileParallelism: false,
  },
})

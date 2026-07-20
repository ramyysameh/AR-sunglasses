import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // DB-backed tests share one database; run serially to avoid write races.
    fileParallelism: false,
    // Load .env into the tests. Since the datasource moved to env("DATABASE_URL"),
    // the DB-backed suites cannot run without it, and requiring every caller to
    // prefix the command is a trap. The empty prefix loads all keys, not just
    // VITE_-prefixed ones.
    env: loadEnv(mode ?? 'test', process.cwd(), ''),
  },
}))

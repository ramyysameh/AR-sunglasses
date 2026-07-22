import { defineConfig } from 'vitest/config'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => ({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // DB-backed tests share one database; run serially to avoid write races.
    fileParallelism: false,
    // DB-backed tests make 10+ sequential round trips to a remote Neon
    // instance; the first also pays Prisma engine spin-up and connection
    // setup. The 5s default straddles that, and a timed-out test is not
    // cancelled -- its in-flight writes leak into the next test's assertions.
    testTimeout: 30000,
    // Load .env into the tests. Since the datasource moved to env("DATABASE_URL"),
    // the DB-backed suites cannot run without it, and requiring every caller to
    // prefix the command is a trap. The empty prefix loads all keys, not just
    // VITE_-prefixed ones.
    env: loadEnv(mode ?? 'test', process.cwd(), ''),
  },
}))

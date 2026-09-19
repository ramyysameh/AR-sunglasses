import { describe, it, expect } from 'vitest'
import { withConnectionLimit, DEFAULT_CONNECTION_LIMIT } from '../app/db.server.js'

// The production failure this guards: DATABASE_URL pins connection_limit=1, so
// concurrent storefront requests on one warm lambda queued behind a single
// socket and timed out after pool_timeout (10s) with
// PrismaClientInitializationError.
describe('withConnectionLimit', () => {
  it('replaces an existing limit rather than appending a second copy', () => {
    const out = withConnectionLimit(
      'postgresql://u:p@host/db?sslmode=require&connection_limit=1&pgbouncer=true',
      5,
    )
    expect(out).toContain('connection_limit=5')
    expect(out.match(/connection_limit=/g)).toHaveLength(1)
    expect(out).not.toContain('connection_limit=1')
  })

  it('keeps every other parameter intact', () => {
    const out = withConnectionLimit(
      'postgresql://u:p@host/db?sslmode=require&connection_limit=1&pgbouncer=true&connect_timeout=15',
      5,
    )
    const params = new URLSearchParams(out.slice(out.indexOf('?') + 1))
    expect(params.get('sslmode')).toBe('require')
    expect(params.get('pgbouncer')).toBe('true')
    expect(params.get('connect_timeout')).toBe('15')
  })

  it('adds the parameter when the url has no query string', () => {
    expect(withConnectionLimit('postgresql://u:p@host/db', 5))
      .toBe('postgresql://u:p@host/db?connection_limit=5')
  })

  it('copies the credential portion through byte for byte', () => {
    // Round-tripping the whole URL through the URL parser can re-encode a
    // password and break authentication, so only the query string is rebuilt.
    const url = 'postgresql://user:p%40ss%2Fword!@ep-cool-1.eu-central-1.aws.neon.tech/neondb?connection_limit=1'
    const out = withConnectionLimit(url, 5)
    expect(out.startsWith('postgresql://user:p%40ss%2Fword!@ep-cool-1.eu-central-1.aws.neon.tech/neondb?')).toBe(true)
  })

  it('defaults to the exported limit, which is above one', () => {
    expect(withConnectionLimit('postgresql://u:p@host/db')).toContain(
      `connection_limit=${DEFAULT_CONNECTION_LIMIT}`,
    )
    expect(DEFAULT_CONNECTION_LIMIT).toBeGreaterThan(1)
  })

  it('passes through a missing or empty url instead of producing a broken one', () => {
    expect(withConnectionLimit(undefined)).toBeUndefined()
    expect(withConnectionLimit('')).toBe('')
  })
})

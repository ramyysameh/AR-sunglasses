import { describe, it, expect, vi } from 'vitest'

vi.mock('../app/db.server.js', () => ({
  default: {
    productMapping: { findUnique: async () => null },
    // The billing gate runs before the config lookup; an ACTIVE row lets the
    // 404 path be reached so these CORS assertions still exercise it.
    shopSubscription: { findUnique: async () => ({ status: 'ACTIVE', graceEndsAt: null }) },
  },
}))

const { loader } = await import('../app/routes/api.tryon-config.jsx')

describe('GET /api/tryon-config', () => {
  // Locks an exit criterion that is otherwise enforced only by review: a future
  // refactor copying the old header block would silently reopen these to every
  // origin on the web.
  it('sends no CORS header on a 400', async () => {
    const res = await loader({ request: new Request('https://app.test/api/tryon-config') })
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('sends no CORS header on a 404', async () => {
    const res = await loader({
      request: new Request(
        'https://app.test/api/tryon-config?shop=s.myshopify.com&productId=gid%3A%2F%2Fshopify%2FProduct%2F1',
      ),
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  // A transient database failure must not reach the shopper as a 500, and must
  // not be reported as 404 either: 404 tells the engine "this product has no
  // try-on", which is a different and permanent-sounding claim. Observed in
  // production as PrismaClientInitializationError "Timed out fetching a new
  // connection from the connection pool (connection limit: 1)" -- the runtime
  // pool is deliberately one connection, so concurrency plus a cold database
  // is enough to trigger it.
  it.each([
    ['the subscription lookup', 'shopSubscription'],
    ['the config lookup', 'productMapping'],
  ])('answers 503, not 500 or 404, when %s cannot reach the database', async (_case, failing) => {
    const poolTimeout = () => {
      throw Object.assign(
        new Error('Timed out fetching a new connection from the connection pool.'),
        { name: 'PrismaClientInitializationError' },
      )
    }
    vi.doMock('../app/db.server.js', () => ({
      default: {
        productMapping: {
          findUnique: failing === 'productMapping' ? poolTimeout : async () => null,
        },
        shopSubscription: {
          findUnique: failing === 'shopSubscription'
            ? poolTimeout
            : async () => ({ status: 'ACTIVE', graceEndsAt: null }),
        },
      },
    }))
    vi.resetModules()
    const mod = await import('../app/routes/api.tryon-config.jsx')
    const res = await mod.loader({
      request: new Request(
        'https://app.test/api/tryon-config?shop=s.myshopify.com&productId=gid%3A%2F%2Fshopify%2FProduct%2F1',
      ),
    })

    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe('5')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()

    // Restore the file-level mock's behavior rather than doUnmock'ing: unmocking
    // drops the hoisted vi.mock entirely, which would hand the next test the
    // real db.server and a live connection attempt.
    vi.doMock('../app/db.server.js', () => ({
      default: {
        productMapping: { findUnique: async () => null },
        shopSubscription: { findUnique: async () => ({ status: 'ACTIVE', graceEndsAt: null }) },
      },
    }))
    vi.resetModules()
  })

  it('does not record proof of life for preview traffic', async () => {
    const seen = []
    vi.doMock('../app/tryonConfig.server.js', async (orig) => ({
      ...(await orig()),
      recordTryonSeen: async (_p, shop, productId) => { seen.push([shop, productId]); return true },
    }))
    vi.resetModules()
    const mod = await import('../app/routes/api.tryon-config.jsx')
    await mod.loader({
      request: new Request(
        'https://app.test/api/tryon-config?shop=s.myshopify.com&productId=gid%3A%2F%2Fshopify%2FProduct%2F1&src=preview',
      ),
    })
    expect(seen).toHaveLength(0)
    vi.doUnmock('../app/tryonConfig.server.js')
    vi.resetModules()
  })
})

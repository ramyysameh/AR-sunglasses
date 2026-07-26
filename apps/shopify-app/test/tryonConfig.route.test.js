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
})

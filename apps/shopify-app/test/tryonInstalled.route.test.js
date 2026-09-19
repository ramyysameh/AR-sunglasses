import { describe, it, expect, vi } from 'vitest'

const calls = { find: [], update: [] }

vi.mock('../app/db.server.js', () => ({
  default: {
    productMapping: {
      findUnique: async ({ where }) => {
        calls.find.push(where)
        if (where.shop_productId?.shop === 'missing.myshopify.com') return null
        if (where.shop_productId?.shop === 'throws.myshopify.com') {
          throw Object.assign(new Error('pool timeout'), { name: 'PrismaClientInitializationError' })
        }
        if (where.shop_productId?.shop === 'recent.myshopify.com') {
          return { id: 'm1', blockSeenAt: new Date() }
        }
        return { id: 'm1', blockSeenAt: null }
      },
      update: async (args) => { calls.update.push(args); return {} },
    },
  },
}))

const { loader } = await import('../app/routes/api.tryon-installed.jsx')

function call(shop, productId = 'gid://shopify/Product/1') {
  const url = `https://app.test/api/tryon-installed?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}`
  return loader({ request: new Request(url) })
}

describe('GET /api/tryon-installed', () => {
  it('records the block and answers 204 with no body', async () => {
    calls.update.length = 0
    const res = await call('s.myshopify.com')

    expect(res.status).toBe(204)
    expect(calls.update).toHaveLength(1)
    expect(calls.update[0].data.blockSeenAt).toBeInstanceOf(Date)
  })

  it('rejects a call missing shop or productId', async () => {
    expect((await loader({ request: new Request('https://app.test/api/tryon-installed') })).status).toBe(400)
    expect((await loader({
      request: new Request('https://app.test/api/tryon-installed?shop=s.myshopify.com'),
    })).status).toBe(400)
  })

  it('writes nothing for an unmapped product but still answers 204', async () => {
    calls.update.length = 0
    const res = await call('missing.myshopify.com')

    expect(res.status).toBe(204)
    expect(calls.update).toHaveLength(0)
  })

  it('throttles repeat product views instead of writing on every one', async () => {
    // This fires on every storefront product-page render; a write per view
    // would make a shopper's page load a database write.
    calls.update.length = 0
    const res = await call('recent.myshopify.com')

    expect(res.status).toBe(204)
    expect(calls.update).toHaveLength(0)
  })

  it('never surfaces a database failure onto the product page', async () => {
    // Bookkeeping must not break a shopper's page, and there is nothing to
    // retry: the next product view records it.
    const res = await call('throws.myshopify.com')

    expect(res.status).toBe(204)
  })

  it('sends no CORS header, matching the config route', async () => {
    const res = await call('s.myshopify.com')
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

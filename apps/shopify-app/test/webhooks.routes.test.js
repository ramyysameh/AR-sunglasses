import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  webhookResult: null,
  webhookError: null,
  purgeCalls: [],
  purgeError: null,
}))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    webhook: async () => {
      if (hoisted.webhookError) throw hoisted.webhookError
      return hoisted.webhookResult
    },
  },
}))

vi.mock('../app/webhooks.server.js', () => ({
  purgeShopData: async (_prisma, shop) => {
    if (hoisted.purgeError) throw hoisted.purgeError
    hoisted.purgeCalls.push(shop)
    return { storageRefs: 1, mappings: 1, assets: 1, sessions: 1 }
  },
}))

vi.mock('../app/db.server.js', () => ({ default: {} }))

const shopRedact = await import('../app/routes/webhooks.shop.redact.jsx')

beforeEach(() => {
  hoisted.webhookResult = null
  hoisted.webhookError = null
  hoisted.purgeCalls = []
  hoisted.purgeError = null
})

const request = () => new Request('https://app.test/webhooks/shop/redact', { method: 'POST' })

describe('shop/redact route', () => {
  it('purges the shop and returns 200', async () => {
    hoisted.webhookResult = { shop: 'acme.myshopify.com', topic: 'SHOP_REDACT', payload: {} }

    const response = await shopRedact.action({ request: request() })

    expect(response.status).toBe(200)
    expect(hoisted.purgeCalls).toEqual(['acme.myshopify.com'])
  })

  it('does not purge when HMAC verification rejects', async () => {
    // authenticate.webhook throws a Response on bad HMAC, before the handler
    // body runs. Nothing may be deleted on an unverified request.
    hoisted.webhookError = new Response('Unauthorized', { status: 401 })

    await expect(shopRedact.action({ request: request() })).rejects.toBeInstanceOf(Response)
    expect(hoisted.purgeCalls).toEqual([])
  })

  it('propagates a purge failure so Shopify retries instead of seeing a false success', async () => {
    hoisted.webhookResult = { shop: 'acme.myshopify.com', topic: 'SHOP_REDACT', payload: {} }
    hoisted.purgeError = new Error('denied')

    // Must reject, not resolve. A 200 on a failed purge would tell Shopify the
    // data was erased when it was not.
    await expect(shopRedact.action({ request: request() })).rejects.toThrow('denied')
  })
})

describe('customers compliance routes', () => {
  it.each([
    ['webhooks.customers.data_request.jsx', 'CUSTOMERS_DATA_REQUEST'],
    ['webhooks.customers.redact.jsx', 'CUSTOMERS_REDACT'],
  ])('%s acknowledges with 200 and purges nothing', async (file, topic) => {
    hoisted.webhookResult = { shop: 'acme.myshopify.com', topic, payload: {} }
    const mod = await import(`../app/routes/${file}`)

    const response = await mod.action({
      request: new Request('https://app.test/webhooks', { method: 'POST' }),
    })

    expect(response.status).toBe(200)
    // The app stores no shopper data, so these must never touch shop data.
    expect(hoisted.purgeCalls).toEqual([])
  })

  it.each([
    'webhooks.customers.data_request.jsx',
    'webhooks.customers.redact.jsx',
  ])('%s rejects an unverified request', async (file) => {
    hoisted.webhookError = new Response('Unauthorized', { status: 401 })
    const mod = await import(`../app/routes/${file}`)

    await expect(
      mod.action({ request: new Request('https://app.test/webhooks', { method: 'POST' }) }),
    ).rejects.toBeInstanceOf(Response)
  })
})

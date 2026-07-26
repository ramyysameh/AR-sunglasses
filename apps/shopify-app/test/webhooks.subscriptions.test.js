import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `sub-wh-${tag}.myshopify.com`

// Stub the Shopify webhook authentication: return a parsed, "verified" payload.
const hoisted = vi.hoisted(() => ({ shop: '', payload: null }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    webhook: async () => ({
      topic: 'APP_SUBSCRIPTIONS_UPDATE',
      shop: hoisted.shop,
      payload: hoisted.payload,
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/webhooks.app.subscriptions_update.jsx')
const { getShopSubscription } = await import('../app/billing.server.js')

afterAll(async () => {
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app_subscriptions/update webhook', () => {
  it('persists an ACTIVE subscription from the payload', async () => {
    hoisted.shop = shop
    hoisted.payload = { app_subscription: { name: 'Starter', status: 'ACTIVE' } }

    const res = await action({ request: new Request('https://x/webhooks/app/subscriptions_update', { method: 'POST' }) })
    expect(res.status).toBe(200)

    const row = await getShopSubscription(prisma, shop)
    expect(row.planName).toBe('Starter')
    expect(row.status).toBe('ACTIVE')
    expect(row.graceEndsAt).toBeNull()
  })

  it('records a lapse with a grace window', async () => {
    hoisted.shop = shop
    hoisted.payload = { app_subscription: { name: 'Starter', status: 'CANCELLED' } }

    await action({ request: new Request('https://x/webhooks/app/subscriptions_update', { method: 'POST' }) })

    const row = await getShopSubscription(prisma, shop)
    expect(row.status).toBe('CANCELLED')
    expect(row.graceEndsAt).not.toBeNull()
  })
})

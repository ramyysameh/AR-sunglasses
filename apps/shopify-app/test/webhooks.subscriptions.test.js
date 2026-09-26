import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `sub-wh-${tag}.myshopify.com`

// Stub the Shopify webhook authentication: return a parsed, "verified" payload.
const hoisted = vi.hoisted(() => ({ shop: '', payload: null, admin: undefined }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    webhook: async () => ({
      topic: 'APP_SUBSCRIPTIONS_UPDATE',
      shop: hoisted.shop,
      payload: hoisted.payload,
      admin: hoisted.admin,
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

describe('app_subscriptions/update storefront access', () => {
  const post = () => action({ request: new Request('https://x/webhooks/app/subscriptions_update', { method: 'POST' }) })
  function recordingAdmin({ failWrites = false } = {}) {
    const calls = []
    return {
      calls,
      graphql: async (query, opts) => {
        calls.push({ query, variables: opts?.variables })
        if (query.includes('currentAppInstallation')) {
          return new Response(JSON.stringify({ data: { currentAppInstallation: { id: 'gid://shopify/AppInstallation/1' } } }))
        }
        if (failWrites) throw new Error('Shopify unavailable')
        const field = query.includes('metafieldsDelete') ? 'metafieldsDelete' : 'metafieldsSet'
        return new Response(JSON.stringify({ data: { [field]: { userErrors: [] } } }))
      },
    }
  }

  it('publishes the grace end on lapse and clears it on reactivation', async () => {
    hoisted.shop = shop
    hoisted.admin = recordingAdmin()
    hoisted.payload = { app_subscription: { name: 'Starter', status: 'FROZEN' } }
    await post()

    const row = await getShopSubscription(prisma, shop)
    const set = hoisted.admin.calls.find((call) => call.query.includes('metafieldsSet'))
    expect(set.variables.metafields[0]).toMatchObject({ key: 'serve_until', value: row.graceEndsAt.toISOString() })

    hoisted.admin = recordingAdmin()
    hoisted.payload = { app_subscription: { name: 'Starter', status: 'ACTIVE' } }
    await post()
    expect(hoisted.admin.calls.some((call) => call.query.includes('metafieldsDelete'))).toBe(true)
  })

  it('still records the subscription when the storefront sync fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.shop = shop
    hoisted.admin = recordingAdmin({ failWrites: true })
    hoisted.payload = { app_subscription: { name: 'Growth', status: 'ACTIVE' } }

    const res = await post()
    expect(res.status).toBe(200)
    expect((await getShopSubscription(prisma, shop)).planName).toBe('Growth')
    expect(consoleError).toHaveBeenCalledWith('storefront access sync failed', expect.any(Error))
    consoleError.mockRestore()
    hoisted.admin = undefined
  })
})

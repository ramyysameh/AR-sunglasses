import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const prisma = (await import('../app/db.server.js')).default
const { getShopSubscription, applySubscriptionUpdate } = await import(
  '../app/billing.server.js'
)

const tag = randomUUID().slice(0, 8)
const shop = `sub-${tag}.myshopify.com`

afterAll(async () => {
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('ShopSubscription persistence', () => {
  it('returns null before any subscription exists', async () => {
    expect(await getShopSubscription(prisma, shop)).toBeNull()
  })

  it('records an ACTIVE subscription with no grace', async () => {
    const now = new Date('2026-07-26T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'ACTIVE' }, now)

    const row = await getShopSubscription(prisma, shop)
    expect(row.planName).toBe('Growth')
    expect(row.status).toBe('ACTIVE')
    expect(row.graceEndsAt).toBeNull()
  })

  it('stamps a grace window on the first lapse and preserves it on repeat', async () => {
    const t0 = new Date('2026-07-26T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'ACTIVE' }, t0)

    const lapse = new Date('2026-07-27T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'CANCELLED' }, lapse)
    const first = await getShopSubscription(prisma, shop)
    const expected = new Date(lapse.getTime() + 7 * 24 * 3600 * 1000)
    expect(first.graceEndsAt.getTime()).toBe(expected.getTime())

    // A later non-ACTIVE update must NOT push the deadline out.
    const later = new Date('2026-07-28T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'FROZEN' }, later)
    const second = await getShopSubscription(prisma, shop)
    expect(second.graceEndsAt.getTime()).toBe(expected.getTime())
    expect(second.status).toBe('FROZEN')
  })

  it('clears grace when a subscription becomes ACTIVE again', async () => {
    const lapse = new Date('2026-07-27T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'CANCELLED' }, lapse)
    const active = new Date('2026-07-29T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Pro', status: 'ACTIVE' }, active)

    const row = await getShopSubscription(prisma, shop)
    expect(row.status).toBe('ACTIVE')
    expect(row.planName).toBe('Pro')
    expect(row.graceEndsAt).toBeNull()
  })
})

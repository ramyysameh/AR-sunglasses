import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `unmap-${tag}.myshopify.com`
const hoisted = vi.hoisted(() => ({ plan: 'Pro' }))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: hoisted.plan ? [{ name: hoisted.plan, status: 'ACTIVE' }] : [] } },
        })),
      },
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/app.models.jsx')

function unmapForm(productId) {
  const fd = new FormData()
  fd.set('intent', 'unmap')
  fd.set('productId', productId)
  return new Request('https://x/app/models', { method: 'POST', body: fd })
}

beforeEach(async () => { await prisma.productMapping.deleteMany({ where: { shop } }) })
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('unmap action', () => {
  it('deletes the mapping for the given product', async () => {
    hoisted.plan = 'Pro'
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
    const productId = `gid://shopify/Product/${tag}-a`
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId: asset.id } })

    const res = await action({ request: unmapForm(productId) })
    expect(res.unmapped).toBe(true)
    expect(await prisma.productMapping.count({ where: { shop, productId } })).toBe(0)
  })

  it('is blocked without an active subscription', async () => {
    hoisted.plan = null
    const res = await action({ request: unmapForm(`gid://shopify/Product/${tag}-b`) })
    expect(res.error).toMatch(/no active subscription/i)
  })
})

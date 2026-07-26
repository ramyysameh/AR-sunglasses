import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `limit-${tag}.myshopify.com`

const hoisted = vi.hoisted(() => ({ plan: 'Starter' }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: { graphql: async () => new Response() },
    }),
  },
}))
// getActivePlanName is exercised for real elsewhere; here stub it to the tier
// under test so the test controls the limit without a live API call.
vi.mock('../app/billing.server.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getActivePlanName: async () => hoisted.plan }
})

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/app.models.jsx')

async function seedAsset() {
  const a = await prisma.modelAsset.create({
    data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: { version: 'eyewear-v1' } },
  })
  return a.id
}
function mapForm(productId, modelAssetId) {
  const fd = new FormData()
  fd.set('intent', 'map')
  fd.set('productId', productId)
  fd.set('modelAssetId', modelAssetId)
  return new Request('https://x/app/models', { method: 'POST', body: fd })
}

// Each case controls its own mapping count, so clear mappings first. Assets
// persist (harmless, referenced by id) and are removed in afterAll.
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
})

afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('map action tier limit', () => {
  it('blocks a NEW product once the Starter cap (10) is reached', async () => {
    hoisted.plan = 'Starter'
    const assetId = await seedAsset()
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await action({ request: mapForm(`gid://shopify/Product/${tag}-NEW`, assetId) })
    expect(res.error).toMatch(/limit/i)
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(10)
  })

  it('allows RE-mapping an already-mapped product at the cap', async () => {
    hoisted.plan = 'Starter'
    const assetId = await seedAsset()
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await action({ request: mapForm(`gid://shopify/Product/${tag}-0`, assetId) })
    expect(res.mapped).toBe(true)
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(10)
  })

  it('allows a new product on Pro (unlimited)', async () => {
    hoisted.plan = 'Pro'
    const assetId = await seedAsset()
    const res = await action({ request: mapForm(`gid://shopify/Product/${tag}-pro`, assetId) })
    expect(res.mapped).toBe(true)
  })
})

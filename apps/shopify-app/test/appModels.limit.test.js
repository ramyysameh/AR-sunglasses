import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `limit-${tag}.myshopify.com`

const hoisted = vi.hoisted(() => ({ plan: 'Starter' }))
// Fake the Admin GraphQL response itself (rather than mocking
// getActivePlanName) so that the loader and action -- which both call
// getActivePlanName via an in-module reference, not through the mocked
// export -- see the same plan the fake admin reports.
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () =>
          new Response(
            JSON.stringify({
              data: {
                currentAppInstallation: {
                  activeSubscriptions: hoisted.plan
                    ? [{ name: hoisted.plan, status: 'ACTIVE' }]
                    : [],
                },
              },
            }),
          ),
      },
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { action, loader } = await import('../app/routes/app.models.jsx')

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

  // Regression: the map action used to only check the plan inside the
  // NEW-product branch, so a shop with no subscription at all could still
  // remap an already-mapped product for free. The guard must fire first,
  // for every intent, before the existing/new-mapping split.
  it('blocks even a RE-map when there is no active subscription', async () => {
    hoisted.plan = null
    const assetId = await seedAsset()
    await prisma.productMapping.create({
      data: { shop, productId: `gid://shopify/Product/${tag}-existing`, modelAssetId: assetId },
    })
    const res = await action({
      request: mapForm(`gid://shopify/Product/${tag}-existing`, assetId),
    })
    expect(res.error).toMatch(/no active subscription/i)
  })
})

describe('models loader subscription gate', () => {
  it('does NOT redirect and returns empty data when there is no active subscription', async () => {
    hoisted.plan = null
    // Throwing redirect('/app') here looped forever (/app/models -> /app ->
    // /app...), rendering a dead, control-less page. The app.jsx layout owns
    // the no-subscription screen, so this loader must resolve without a
    // redirect and must do no gated DB work.
    const result = await loader({ request: new Request('https://x/app/models') })
    expect(result).toEqual({ assets: [], mappings: [] })
  })

  it('loads normally with an active subscription', async () => {
    hoisted.plan = 'Starter'
    const result = await loader({ request: new Request('https://x/app/models') })
    expect(result).toHaveProperty('assets')
    expect(result).toHaveProperty('mappings')
  })
})

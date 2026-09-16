import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `home-${tag}.myshopify.com`
const billingState = vi.hoisted(() => ({ lookups: 0 }))
const productsState = vi.hoisted(() => ({ products: new Map() }))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => {
          billingState.lookups += 1
          return new Response(JSON.stringify({
            data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
          }))
        },
      },
    }),
  },
}))
vi.mock('../app/tryonMetafield.server.js', () => ({
  publishMappings: async () => {},
}))
vi.mock('../app/products.server.js', () => ({ fetchProductsByIds: async () => productsState.products }))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app._index.jsx')

beforeEach(async () => {
  billingState.lookups = 0
  productsState.products = new Map()
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app._index workspace loader', () => {
  it('performs one billing lookup for an active-plan request', async () => {
    await loader({ request: new Request('https://x/app') })
    expect(billingState.lookups).toBe(1)
  })

  it('returns assets, enriched mappings, and counts for the shop', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
    await prisma.productMapping.create({ data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app') })
    expect(result).toMatchObject({
      assets: [{ id: asset.id }],
      mappings: [{ product: null, modelAsset: { id: asset.id }, status: 'add-to-theme' }],
      counts: { all: 1, live: 0, needsAttention: 1 },
    })
  })

  it('reports plan usage and a theme link', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/u.glb`, fitMetadata: {} } })
    await prisma.productMapping.create({ data: { shop, productId: `gid://shopify/Product/${tag}-u`, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app') })
    expect(result.usage).toMatchObject({ used: 1, unlimited: true })
    expect(result.themeUrl).toContain('addAppBlockId')
  })

  it('returns the exact product theme URL for contextual recovery', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/theme.glb`, fitMetadata: {} } })
    const productId = `gid://shopify/Product/${tag}-theme`
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId: asset.id } })
    productsState.products = new Map([[productId, { id: productId, title: 'Lumen', handle: 'lumen' }]])

    const result = await loader({ request: new Request('https://x/app') })
    expect(result.mappings[0].themeUrl).toBe(
      `https://${shop}/admin/themes/current/editor?previewPath=%2Fproducts%2Flumen&addAppBlockId=be1db9d64c7c617dcd67f6add58f4824%2Ftryon_button&target=mainSection`,
    )
  })

  it('counts a product as live only once it has been seen working', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/l.glb`, fitMetadata: {} } })
    const pid = `gid://shopify/Product/${tag}-l`
    await prisma.productMapping.create({ data: { shop, productId: pid, modelAssetId: asset.id } })
    expect((await loader({ request: new Request('https://x/app') })).counts.live).toBe(0)

    await prisma.productMapping.update({
      where: { shop_productId: { shop, productId: pid } },
      data: { lastSeenLiveAt: new Date() },
    })
    expect((await loader({ request: new Request('https://x/app') })).counts.live).toBe(1)
  })
})

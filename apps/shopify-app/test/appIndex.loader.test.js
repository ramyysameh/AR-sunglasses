import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `home-${tag}.myshopify.com`

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
        })),
      },
    }),
  },
}))
vi.mock('../app/tryonMetafield.server.js', () => ({
  publishMappings: async () => {},
}))
vi.mock('../app/products.server.js', () => ({ fetchProductsByIds: async () => new Map() }))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app._index.jsx')

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app._index workspace loader', () => {
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

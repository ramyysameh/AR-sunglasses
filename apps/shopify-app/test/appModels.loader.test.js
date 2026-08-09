import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `loader-${tag}.myshopify.com`
const productGid = `gid://shopify/Product/${tag}`

// Admin mock: active subscription + product lookup response.
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async (query) => {
          if (String(query).includes('activeSubscriptions') || String(query).includes('currentAppInstallation')) {
            return new Response(JSON.stringify({
              data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
            }))
          }
          return new Response(JSON.stringify({
            data: { nodes: [{ id: productGid, title: 'Wayfarer', featuredImage: { url: 'https://cdn/w.jpg', altText: 'Wayfarer' } }] },
          }))
        },
      },
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app.models.jsx')

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app.models loader product enrichment', () => {
  it('attaches resolved product details to each mapping', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: { version: 'eyewear-v1' }, status: 'ready' },
    })
    await prisma.productMapping.create({ data: { shop, productId: productGid, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app/models') })
    const mapping = result.mappings.find((m) => m.productId === productGid)
    expect(mapping.product).toEqual({
      id: productGid,
      title: 'Wayfarer',
      imageUrl: 'https://cdn/w.jpg',
      imageAlt: 'Wayfarer',
    })
  })
})

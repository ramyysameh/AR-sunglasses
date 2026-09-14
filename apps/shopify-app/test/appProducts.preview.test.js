import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `prev-${tag}.myshopify.com`

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
  publishMapping: async () => {},
  unpublishMapping: async () => {},
}))
vi.mock('../app/products.server.js', () => ({ fetchProductsByIds: async () => new Map() }))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app.products.jsx')

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  await prisma.productMapping.create({
    data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: asset.id },
  })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('products preview', () => {
  it('points the preview at this product, marked as preview traffic', async () => {
    const { mappings } = await loader({ request: new Request('https://x/app/products') })
    const url = new URL(mappings[0].previewUrl)
    expect(url.searchParams.get('productId')).toBe(`gid://shopify/Product/${tag}`)
    expect(url.searchParams.get('src')).toBe('preview')
  })
})

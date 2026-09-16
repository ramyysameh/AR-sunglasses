import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `prod-${tag}.myshopify.com`

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
// Metafield sync and product enrichment are Shopify round trips; the loader
// treats both as best-effort and this route's own logic is what is under test.
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
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('app.products loader', () => {
  it('attaches a merchant-facing status to each mapping', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/a.glb`, fitMetadata: {}, status: 'ready', confidence: 0.9 },
    })
    await prisma.productMapping.create({
      data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: asset.id },
    })

    const result = await loader({ request: new Request('https://x/app/products') })
    expect(result.mappings).toHaveLength(1)
    expect(result.mappings[0]).toMatchObject({
      status: 'add-to-theme',
      merchantStatus: { id: 'not_on_theme' },
    })
  })

})

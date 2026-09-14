import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
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

  // A preview convenience must never take down the primary page: with neither
  // env var set, ENGINE_URL's last resort has to still be an absolute URL, and
  // any failure to build one must be swallowed per-row, not thrown.
  describe('with no engine URL configured', () => {
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('still returns mappings instead of throwing', async () => {
      vi.stubEnv('TRYON_ENGINE_URL', '')
      vi.stubEnv('SHOPIFY_APP_URL', '')
      const { mappings } = await loader({ request: new Request('https://x/app/products') })
      expect(mappings).toHaveLength(1)
      expect(() => new URL(mappings[0].previewUrl)).not.toThrow()
    })
  })
})

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `map-${tag}.myshopify.com`
const admin = {
  graphql: async () => new Response(JSON.stringify({
    data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Starter', status: 'ACTIVE' }] } },
  })),
}

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin,
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
const { handleProductAction } = await import('../app/productActions.server.js')

const post = (fields) =>
  handleProductAction({
    request: new Request('https://x/app/products', { method: 'POST', body: new URLSearchParams(fields) }),
    admin,
    shop,
  })

let assetId
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  assetId = asset.id
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('app.products map action', () => {
  // mapProductToModel throws on a cross-shop asset. Unhandled, that reaches the
  // merchant as a raw framework error page instead of the modal's banner.
  it('reports an error instead of throwing on a model from another shop', async () => {
    const other = await prisma.modelAsset.create({
      data: { shop: `other-${tag}.myshopify.com`, storageRef: `${tag}/o.glb`, fitMetadata: {} },
    })
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}-x`, modelAssetId: other.id })
    expect(res.error).toBeTruthy()
    expect(res.error).not.toMatch(/belong/i)
    await prisma.modelAsset.deleteMany({ where: { shop: `other-${tag}.myshopify.com` } })
  })

  it('maps a product to a model', async () => {
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}`, modelAssetId: assetId })
    expect(res).toMatchObject({ mapped: true })
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(1)
  })

  it('enforces the plan cap for a new product', async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}-new`, modelAssetId: assetId })
    expect(res.error).toMatch(/limit/i)
  })

  // Grandfathering: re-pointing an existing product at a different model is not
  // a new product and must work even at the cap.
  it('allows re-mapping an existing product at the cap', async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}-0`, modelAssetId: assetId })
    expect(res).toMatchObject({ mapped: true })
  })

})

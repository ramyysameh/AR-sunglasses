import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `resilience-${tag}.myshopify.com`
const productGid = `gid://shopify/Product/${tag}`

// Admin mock: active subscription + product lookup can fail or return partial results
vi.mock('../app/shopify.server.js', () => {
  const state = { throwOnProducts: false, includeProduct: true }
  return {
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
            // Products query
            if (state.throwOnProducts) {
              throw new Error('GraphQL rate limit: too many requests')
            }
            if (state.includeProduct) {
              return new Response(JSON.stringify({
                data: { nodes: [{ id: productGid, title: 'Wayfarer', featuredImage: { url: 'https://cdn/w.jpg', altText: 'Wayfarer' } }] },
              }))
            }
            // Empty result (product not found / deleted)
            return new Response(JSON.stringify({
              data: { nodes: [] },
            }))
          },
        },
      }),
    },
    __testState: state,
  }
})

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app.models.jsx')
const shopifyServer = await import('../app/shopify.server.js')
const state = shopifyServer.__testState

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  state.throwOnProducts = false
  state.includeProduct = true
})

afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app.models loader resilience (fallback and error handling)', () => {
  it('sets product to null when product lookup returns empty (deleted product)', async () => {
    state.includeProduct = false
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: { version: 'eyewear-v1' }, status: 'ready' },
    })
    await prisma.productMapping.create({ data: { shop, productId: productGid, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app/models') })
    const mapping = result.mappings.find((m) => m.productId === productGid)
    expect(mapping.product).toBeNull()
  })

  it('returns assets and mappings with product:null when product GraphQL query throws', async () => {
    state.throwOnProducts = true
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: { version: 'eyewear-v1' }, status: 'ready' },
    })
    await prisma.productMapping.create({ data: { shop, productId: productGid, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app/models') })
    // Loader does not throw; it gracefully degrades
    expect(result).toHaveProperty('assets')
    expect(result).toHaveProperty('mappings')
    expect(result.assets).toHaveLength(1)
    const mapping = result.mappings.find((m) => m.productId === productGid)
    expect(mapping.product).toBeNull()
  })
})

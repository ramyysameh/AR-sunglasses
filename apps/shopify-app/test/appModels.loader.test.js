import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `loader-${tag}.myshopify.com`
const productGid = `gid://shopify/Product/${tag}`

// Mutable so both the subscribed and unsubscribed branches of the loader can
// be exercised from the same mock -- see billing.server.js's
// getActivePlanName, which treats an empty activeSubscriptions array (or no
// ACTIVE entry in it) as "no active plan".
const subscriptionState = vi.hoisted(() => ({ active: true }))

// Admin mock: active subscription (by default) + product lookup response.
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async (query) => {
          if (String(query).includes('activeSubscriptions') || String(query).includes('currentAppInstallation')) {
            return new Response(JSON.stringify({
              data: {
                currentAppInstallation: {
                  activeSubscriptions: subscriptionState.active ? [{ name: 'Pro', status: 'ACTIVE' }] : [],
                },
              },
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
  subscriptionState.active = true
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
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].mappingCount).toBe(1)
    expect(result.mappings).toBeUndefined()
  })
})

// The Models review modal (app.models.jsx's ReviewFitModal, via
// ModelFitReview) needs a theme-editor URL to offer its "Open theme editor"
// action, on both loader branches -- a merchant on the free/no-plan screen
// must not silently lose that action just because this route can still be
// reached without a subscription (app.jsx owns the redirect gate, not this
// loader; see the "must NOT redirect" comment in app.models.jsx).
describe('app.models loader themeUrl', () => {
  it('returns a theme editor URL on the subscribed branch', async () => {
    subscriptionState.active = true
    const result = await loader({ request: new Request('https://x/app/models') })

    // Subscribed branch: assets is a real (possibly empty) query result, not
    // the unsubscribed branch's hardcoded [] -- distinguished here by
    // asserting the shape (an array) rather than its length, since this
    // test's beforeEach clears the shop's models and doesn't reseed one.
    expect(Array.isArray(result.assets)).toBe(true)
    expect(typeof result.themeUrl).toBe('string')
    const url = new URL(result.themeUrl)
    expect(url.host).toBe('admin.shopify.com')
    expect(url.searchParams.get('addAppBlockId')).toMatch(/\/tryon_button$/)
  })

  it('returns the same theme editor URL on the unsubscribed branch, alongside empty assets', async () => {
    subscriptionState.active = false
    const result = await loader({ request: new Request('https://x/app/models') })

    expect(result.assets).toEqual([])
    expect(typeof result.themeUrl).toBe('string')
    const url = new URL(result.themeUrl)
    expect(url.host).toBe('admin.shopify.com')
    expect(url.searchParams.get('addAppBlockId')).toMatch(/\/tryon_button$/)
  })
})

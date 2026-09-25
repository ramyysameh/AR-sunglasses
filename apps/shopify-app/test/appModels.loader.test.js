import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `loader-${tag}.myshopify.com`
const productGid = `gid://shopify/Product/${tag}`

// Mutable so both the subscribed and unsubscribed branches of the loader can
// be exercised from the same mock -- see billing.server.js's
// getActivePlanName, which treats an empty activeSubscriptions array (or no
// ACTIVE entry in it) as "no active plan".
const subscriptionState = vi.hoisted(() => ({ active: true, plan: 'Pro' }))

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
                  activeSubscriptions: subscriptionState.active ? [{ name: subscriptionState.plan, status: 'ACTIVE' }] : [],
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
  subscriptionState.plan = 'Pro'
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
  it('returns a theme editor URL on the subscribed branch, alongside the real assets that exist', async () => {
    subscriptionState.active = true
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/themeurl-sub.glb`, fitMetadata: { version: 'eyewear-v1' }, status: 'ready' },
    })

    const result = await loader({ request: new Request('https://x/app/models') })

    // Pinned by data, not just "an array" (which [] also satisfies, and
    // would make this indistinguishable from the unsubscribed branch below
    // if the mock's `active` flag were ever wired wrong): the subscribed
    // branch must return the asset that actually exists for this shop.
    expect(result.assets.map((a) => a.id)).toEqual([asset.id])
    expect(typeof result.themeUrl).toBe('string')
    const url = new URL(result.themeUrl)
    // Host is the shop's own admin, not admin.shopify.com: upstream's theme
    // deep-link work moved themeEditorUrl (adminLinks.server.js) to
    // https://{shop}/admin/themes/current/editor. What this test guards is
    // unchanged -- the loader hands the review modal a usable theme-editor
    // URL carrying the canonical app-block id -- so only the host moves.
    expect(url.host).toBe(shop)
    expect(url.searchParams.get('addAppBlockId')).toMatch(/\/tryon_button$/)
  })

  it('returns the same theme editor URL on the unsubscribed branch, even though a model asset exists for the shop', async () => {
    subscriptionState.active = false
    // Seeded so an empty result here can only come from the unsubscribed
    // short-circuit actually running, not from a coincidentally-unseeded
    // beforeEach producing the same []. Without this, "assets equals []"
    // would be true for the wrong reason too.
    await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/themeurl-unsub.glb`, fitMetadata: { version: 'eyewear-v1' }, status: 'ready' },
    })

    const result = await loader({ request: new Request('https://x/app/models') })

    expect(result.assets).toEqual([])
    expect(typeof result.themeUrl).toBe('string')
    const url = new URL(result.themeUrl)
    // Same host change as the subscribed branch above.
    expect(url.host).toBe(shop)
    expect(url.searchParams.get('addAppBlockId')).toMatch(/\/tryon_button$/)
  })
})

// Important-3 fix: the loader must fold confidence into needsReview, the
// same single-sourced predicate (tryonStatus.server.js's needsFitReview)
// Products' productStatus uses -- a status:'ready', low-confidence asset has
// to read as "needs review" here too, or Help's "open Models and use Review
// fit" guidance (app.additional.jsx) walks a merchant into a dead end.
describe('app.models loader needsReview', () => {
  it('flags a status:"ready" asset with low confidence as needing review', async () => {
    const asset = await prisma.modelAsset.create({
      data: {
        shop,
        storageRef: `${tag}/low-confidence.glb`,
        fitMetadata: { version: 'eyewear-v1' },
        status: 'ready',
        confidence: 0.4,
      },
    })

    const result = await loader({ request: new Request('https://x/app/models') })
    const found = result.assets.find((a) => a.id === asset.id)

    expect(found).toBeTruthy()
    expect(found.needsReview).toBe(true)
  })

  it('does not flag a status:"ready" asset with high confidence', async () => {
    const asset = await prisma.modelAsset.create({
      data: {
        shop,
        storageRef: `${tag}/high-confidence.glb`,
        fitMetadata: { version: 'eyewear-v1' },
        status: 'ready',
        confidence: 0.9,
      },
    })

    const result = await loader({ request: new Request('https://x/app/models') })
    const found = result.assets.find((a) => a.id === asset.id)

    expect(found).toBeTruthy()
    expect(found.needsReview).toBe(false)
  })
})

describe('app.models loader plan limit', () => {
  it('reports the limit so Models can offer an upgrade instead of a failing Add try-on', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/limit.glb`, fitMetadata: { version: 'eyewear-v1' }, status: 'ready' },
    })
    const mapTo = (count) => prisma.productMapping.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        shop,
        productId: `gid://shopify/Product/${tag}${index}`,
        modelAssetId: asset.id,
      })),
    })

    subscriptionState.plan = 'Starter'
    await mapTo(9)
    let result = await loader({ request: new Request('https://x/app/models') })
    expect(result.atLimit).toBe(false)

    await prisma.productMapping.create({ data: { shop, productId: `gid://shopify/Product/${tag}last`, modelAssetId: asset.id } })
    result = await loader({ request: new Request('https://x/app/models') })
    expect(result.atLimit).toBe(true)
    expect(typeof result.pricingUrl).toBe('string')

    subscriptionState.plan = 'Pro'
    result = await loader({ request: new Request('https://x/app/models') })
    expect(result).toMatchObject({ atLimit: false, pricingUrl: null })
  })
})

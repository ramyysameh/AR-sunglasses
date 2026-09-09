import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

// The storefront gate: the theme block renders only where the app-owned
// metafield exists, so these assert that mapping publishes it, unmapping
// removes it, and a failure in either direction reaches the merchant instead of
// showing a success toast over a product page that stays wrong.
const tag = randomUUID().slice(0, 8)
const shop = `mfgate-${tag}.myshopify.com`

const hoisted = vi.hoisted(() => ({
  plan: 'Pro',
  setErrors: [],
  deleteErrors: [],
  calls: [],
}))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async (query, opts) => {
          hoisted.calls.push({ query, variables: opts?.variables })
          if (query.includes('metafieldsSet')) {
            return new Response(
              JSON.stringify({ data: { metafieldsSet: { userErrors: hoisted.setErrors } } }),
            )
          }
          if (query.includes('metafieldsDelete')) {
            return new Response(
              JSON.stringify({ data: { metafieldsDelete: { userErrors: hoisted.deleteErrors } } }),
            )
          }
          return new Response(
            JSON.stringify({
              data: {
                currentAppInstallation: {
                  activeSubscriptions: hoisted.plan
                    ? [{ name: hoisted.plan, status: 'ACTIVE' }]
                    : [],
                },
              },
            }),
          )
        },
      },
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { action, loader } = await import('../app/routes/app.models.jsx')

const productId = `gid://shopify/Product/${tag}`

function form(intent, fields) {
  const fd = new FormData()
  fd.set('intent', intent)
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return new Request('https://x/app/models', { method: 'POST', body: fd })
}

async function seedAsset() {
  const a = await prisma.modelAsset.create({
    data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: { version: 'eyewear-v1' } },
  })
  return a.id
}

function metafieldCalls(name) {
  return hoisted.calls.filter((c) => c.query.includes(name))
}

beforeEach(async () => {
  hoisted.plan = 'Pro'
  hoisted.setErrors = []
  hoisted.deleteErrors = []
  hoisted.calls = []
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('map action', () => {
  it('publishes the try-on metafield for the mapped product', async () => {
    const modelAssetId = await seedAsset()
    const res = await action({ request: form('map', { productId, modelAssetId }) })

    expect(res.mapped).toBe(true)
    const sets = metafieldCalls('metafieldsSet')
    expect(sets).toHaveLength(1)
    expect(sets[0].variables.metafields).toEqual([
      {
        ownerId: productId,
        namespace: '$app:tryon',
        key: 'enabled',
        type: 'boolean',
        value: 'true',
      },
    ])
  })

  // The mapping is the source of truth and commits first, so it stands; but the
  // merchant must not be told "Product mapped" when the product page won't show it.
  it('reports an error, keeping the mapping, when the metafield write fails', async () => {
    const modelAssetId = await seedAsset()
    hoisted.setErrors = [{ message: 'Throttled' }]

    const res = await action({ request: form('map', { productId, modelAssetId }) })

    expect(res.mapped).toBeUndefined()
    expect(res.error).toMatch(/storefront/i)
    expect(await prisma.productMapping.count({ where: { shop, productId } })).toBe(1)
  })
})

describe('unmap action', () => {
  it('deletes the try-on metafield for the product', async () => {
    const modelAssetId = await seedAsset()
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId } })

    const res = await action({ request: form('unmap', { productId }) })

    expect(res.unmapped).toBe(true)
    const deletes = metafieldCalls('metafieldsDelete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0].variables.metafields).toEqual([
      { ownerId: productId, namespace: '$app:tryon', key: 'enabled' },
    ])
  })

  it('still succeeds when the metafield is already gone', async () => {
    const modelAssetId = await seedAsset()
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId } })
    hoisted.deleteErrors = [{ message: 'Metafield does not exist.' }]

    const res = await action({ request: form('unmap', { productId }) })
    expect(res.unmapped).toBe(true)
  })

  // A metafield left behind keeps a button on the page that now opens to a 404.
  it('reports an error when the metafield delete genuinely fails', async () => {
    const modelAssetId = await seedAsset()
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId } })
    hoisted.deleteErrors = [{ message: 'Throttled' }]

    const res = await action({ request: form('unmap', { productId }) })
    expect(res.unmapped).toBeUndefined()
    expect(res.error).toMatch(/storefront/i)
  })
})

describe('loader backfill', () => {
  // Mappings made before this gate existed have no metafield and would go dark
  // on deploy. The Models page republishes them.
  it('republishes the metafield for every existing mapping', async () => {
    const modelAssetId = await seedAsset()
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId } })
    hoisted.calls = []

    await loader({ request: new Request('https://x/app/models') })

    const sets = metafieldCalls('metafieldsSet')
    expect(sets).toHaveLength(1)
    expect(sets[0].variables.metafields[0].ownerId).toBe(productId)
  })

  it('survives a metafield failure without breaking the page', async () => {
    const modelAssetId = await seedAsset()
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId } })
    hoisted.setErrors = [{ message: 'Throttled' }]

    const data = await loader({ request: new Request('https://x/app/models') })
    expect(data.mappings).toHaveLength(1)
  })

  it('makes no metafield call for a shop with no mappings', async () => {
    await loader({ request: new Request('https://x/app/models') })
    expect(metafieldCalls('metafieldsSet')).toHaveLength(0)
  })
})

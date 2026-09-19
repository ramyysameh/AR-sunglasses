import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `unmap-${tag}.myshopify.com`
const hoisted = vi.hoisted(() => ({ plan: 'Pro', unpublishError: null }))
const admin = {
  graphql: async (query) => {
    if (query.includes('UnpublishTryon')) {
      return new Response(JSON.stringify({
        data: {
          metafieldsDelete: {
            userErrors: hoisted.unpublishError
              ? [{ field: ['metafields'], message: hoisted.unpublishError }]
              : [],
          },
        },
      }))
    }
    return new Response(JSON.stringify({
      data: { currentAppInstallation: { activeSubscriptions: hoisted.plan ? [{ name: hoisted.plan, status: 'ACTIVE' }] : [] } },
    }))
  },
}

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin,
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { handleProductAction } = await import('../app/productActions.server.js')

function unmapForm(productId) {
  const fd = new FormData()
  fd.set('intent', 'unmap')
  fd.set('productId', productId)
  return new Request('https://x/app/products', { method: 'POST', body: fd })
}

const unmap = (productId) => handleProductAction({ request: unmapForm(productId), admin, shop })

beforeEach(async () => {
  hoisted.plan = 'Pro'
  hoisted.unpublishError = null
  await prisma.productMapping.deleteMany({ where: { shop } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('unmap action', () => {
  it('deletes the mapping for the given product', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
    const productId = `gid://shopify/Product/${tag}-a`
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId: asset.id } })

    const res = await unmap(productId)
    expect(res.unmapped).toBe(true)
    expect(await prisma.productMapping.count({ where: { shop, productId } })).toBe(0)
  })

  it('keeps the mapping when storefront unpublishing fails so removal can be retried', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/retry.glb`, fitMetadata: {} } })
    const productId = `gid://shopify/Product/${tag}-retry`
    await prisma.productMapping.create({ data: { shop, productId, modelAssetId: asset.id } })
    hoisted.unpublishError = 'Shopify is temporarily unavailable'

    const res = await unmap(productId)

    expect(res.error).toMatch(/couldn't be removed/i)
    expect(await prisma.productMapping.count({ where: { shop, productId } })).toBe(1)
  })

  it('is blocked without an active subscription', async () => {
    hoisted.plan = null
    const res = await unmap(`gid://shopify/Product/${tag}-b`)
    expect(res.error).toMatch(/no active subscription/i)
  })
})

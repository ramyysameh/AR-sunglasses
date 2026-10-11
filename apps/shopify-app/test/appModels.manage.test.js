import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `mng-${tag}.myshopify.com`

// Answers the billing check; metafield mutations get `metafieldResult`.
const gql = vi.hoisted(() => ({ calls: [], metafieldResult: null }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async (query, opts) => {
          if (/metafields(Set|Delete)/.test(query)) {
            gql.calls.push({ query, variables: opts?.variables })
            return new Response(JSON.stringify(gql.metafieldResult ?? { data: {} }))
          }
          return new Response(JSON.stringify({
            data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
          }))
        },
      },
    }),
  },
}))
vi.mock('../app/storage.server.js', () => ({ deleteModelGlb: async () => {} }))

const prisma = (await import('../app/db.server.js')).default
const { action, loader } = await import('../app/routes/app.models.jsx')

const post = (fields) =>
  action({ request: new Request('https://x/app/models', { method: 'POST', body: new URLSearchParams(fields) }) })

let assetId
beforeEach(async () => {
  gql.calls = []
  gql.metafieldResult = null
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  assetId = asset.id
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('models rename', () => {
  it('stores a merchant-supplied label', async () => {
    expect(await post({ intent: 'rename', modelAssetId: assetId, label: 'Pelmo black' })).toMatchObject({ renamed: true })
    expect((await prisma.modelAsset.findUnique({ where: { id: assetId } })).label).toBe('Pelmo black')
  })


  it('refuses a model from another shop', async () => {
    const other = await prisma.modelAsset.create({
      data: { shop: `other-${tag}.myshopify.com`, storageRef: `${tag}/o.glb`, fitMetadata: {} },
    })
    expect((await post({ intent: 'rename', modelAssetId: other.id, label: 'nope' })).error).toBeTruthy()
    expect((await prisma.modelAsset.findUnique({ where: { id: other.id } })).label).toBeNull()
    await prisma.modelAsset.delete({ where: { id: other.id } })
  })
})

describe('models delete', () => {
  it('deletes an unused model', async () => {
    expect(await post({ intent: 'delete', modelAssetId: assetId })).toMatchObject({ deleted: true })
    expect(await prisma.modelAsset.findUnique({ where: { id: assetId } })).toBeNull()
  })

  it('deletes a model that products use, removing try-on from them first', async () => {
    const productIds = [`gid://shopify/Product/${tag}1`, `gid://shopify/Product/${tag}2`]
    for (const productId of productIds) {
      await prisma.productMapping.create({ data: { shop, productId, modelAssetId: assetId } })
    }

    expect(await post({ intent: 'delete', modelAssetId: assetId })).toMatchObject({ deleted: true })

    expect(gql.calls).toHaveLength(1)
    expect(gql.calls[0].query).toMatch(/metafieldsDelete/)
    expect(gql.calls[0].variables.metafields.map((m) => m.ownerId).sort()).toEqual(productIds.sort())
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(0)
    expect(await prisma.modelAsset.findUnique({ where: { id: assetId } })).toBeNull()
  })

  it('changes nothing when the storefront unpublish fails', async () => {
    await prisma.productMapping.create({
      data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: assetId },
    })
    gql.metafieldResult = { data: { metafieldsDelete: { userErrors: [{ message: 'Throttled' }] } } }

    const res = await post({ intent: 'delete', modelAssetId: assetId })

    expect(res.error).toMatch(/Nothing was changed/)
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(1)
    expect(await prisma.modelAsset.findUnique({ where: { id: assetId } })).not.toBeNull()
  })

  it('refuses a model from another shop', async () => {
    const other = await prisma.modelAsset.create({
      data: { shop: `other-${tag}.myshopify.com`, storageRef: `${tag}/d.glb`, fitMetadata: {} },
    })
    expect(await post({ intent: 'delete', modelAssetId: other.id })).toEqual({ error: 'That model no longer exists.' })
    expect(await prisma.modelAsset.findUnique({ where: { id: other.id } })).not.toBeNull()
    await prisma.modelAsset.delete({ where: { id: other.id } })
  })
})

describe('models mark fit reviewed', () => {
  it('clears Needs fit review for the model', async () => {
    await prisma.modelAsset.update({ where: { id: assetId }, data: { status: 'needs_manual' } })
    expect((await loader({ request: new Request('https://x/app/models') })).assets[0].needsReview).toBe(true)

    expect(await post({ intent: 'mark-fit-reviewed', modelAssetId: assetId })).toEqual({ fitReviewed: true })

    expect((await prisma.modelAsset.findUnique({ where: { id: assetId } })).fitReviewedAt).toBeInstanceOf(Date)
    expect((await loader({ request: new Request('https://x/app/models') })).assets[0].needsReview).toBe(false)
  })

  it('refuses a model from another shop and leaves it flagged', async () => {
    const other = await prisma.modelAsset.create({
      data: { shop: `other-${tag}.myshopify.com`, storageRef: `${tag}/r.glb`, fitMetadata: {}, status: 'needs_manual' },
    })
    expect(await post({ intent: 'mark-fit-reviewed', modelAssetId: other.id }))
      .toEqual({ error: 'That model no longer exists.' })
    expect((await prisma.modelAsset.findUnique({ where: { id: other.id } })).fitReviewedAt).toBeNull()
    await prisma.modelAsset.delete({ where: { id: other.id } })
  })
})

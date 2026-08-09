import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `home-${tag}.myshopify.com`

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

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app._index.jsx')

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app._index loader counts', () => {
  it('returns model and mapping counts for the shop', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
    await prisma.productMapping.create({ data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app') })
    expect(result).toMatchObject({ modelCount: 1, mappingCount: 1 })
  })
})

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const hoisted = vi.hoisted(() => ({ sent: [], nextError: null }))

vi.mock('@aws-sdk/client-s3', () => {
  class FakeClient {
    async send(command) {
      hoisted.sent.push(command)
      if (hoisted.nextError) throw hoisted.nextError
      return null
    }
  }
  class PutObjectCommand { constructor(i) { this.input = i; this.type = 'Put' } }
  class GetObjectCommand { constructor(i) { this.input = i; this.type = 'Get' } }
  class DeleteObjectCommand { constructor(i) { this.input = i; this.type = 'Delete' } }
  return { S3Client: FakeClient, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
})

process.env.S3_BUCKET = 'models-bucket'

const prisma = (await import('../app/db.server.js')).default
const { purgeShopData } = await import('../app/webhooks.server.js')

// Unique per run: these tests DELETE, and a predictable domain could collide
// with real data in the shared Neon instance.
const tag = randomUUID().slice(0, 8)
const shopA = `purge-a-${tag}.myshopify.com`
const shopB = `purge-b-${tag}.myshopify.com`

async function seed(shop, refs) {
  const assets = []
  for (const ref of refs) {
    assets.push(
      await prisma.modelAsset.create({
        data: { shop, storageRef: ref, fitMetadata: { version: 'eyewear-v1' } },
      }),
    )
  }
  await prisma.productMapping.create({
    data: { shop, productId: `gid://shopify/Product/${shop}`, modelAssetId: assets[0].id },
  })
  await prisma.session.create({
    data: { id: `sess-${shop}`, shop, state: 'x', accessToken: 't' },
  })
  return assets
}

async function counts(shop) {
  return {
    assets: await prisma.modelAsset.count({ where: { shop } }),
    mappings: await prisma.productMapping.count({ where: { shop } }),
    sessions: await prisma.session.count({ where: { shop } }),
  }
}

beforeEach(async () => {
  hoisted.sent = []
  hoisted.nextError = null
  for (const s of [shopA, shopB]) {
    await prisma.productMapping.deleteMany({ where: { shop: s } })
    await prisma.modelAsset.deleteMany({ where: { shop: s } })
    await prisma.session.deleteMany({ where: { shop: s } })
  }
})

afterAll(async () => {
  for (const s of [shopA, shopB]) {
    await prisma.productMapping.deleteMany({ where: { shop: s } })
    await prisma.modelAsset.deleteMany({ where: { shop: s } })
    await prisma.session.deleteMany({ where: { shop: s } })
  }
})

describe('purgeShopData', () => {
  it('deletes every row for the shop, foreign key order included', async () => {
    await seed(shopA, [`${tag}/a1.glb`, `${tag}/a2.glb`])

    const result = await purgeShopData(prisma, shopA)

    expect(await counts(shopA)).toEqual({ assets: 0, mappings: 0, sessions: 0 })
    expect(result.assets).toBe(2)
    expect(result.mappings).toBe(1)
    expect(result.sessions).toBe(1)
  })

  it('leaves other shops completely untouched', async () => {
    await seed(shopA, [`${tag}/a1.glb`])
    await seed(shopB, [`${tag}/b1.glb`])

    await purgeShopData(prisma, shopA)

    expect(await counts(shopB)).toEqual({ assets: 1, mappings: 1, sessions: 1 })
    const deletedKeys = hoisted.sent.map((c) => c.input.Key)
    expect(deletedKeys).toEqual([`${tag}/a1.glb`])
  })

  it('deletes every storage ref belonging to the shop', async () => {
    await seed(shopA, [`${tag}/a1.glb`, `${tag}/a2.glb`, `${tag}/a3.glb`])

    await purgeShopData(prisma, shopA)

    expect(hoisted.sent.map((c) => c.input.Key).sort()).toEqual([
      `${tag}/a1.glb`, `${tag}/a2.glb`, `${tag}/a3.glb`,
    ])
  })

  it('is idempotent — a second purge succeeds', async () => {
    await seed(shopA, [`${tag}/a1.glb`])
    await purgeShopData(prisma, shopA)
    await expect(purgeShopData(prisma, shopA)).resolves.toBeTruthy()
  })

  it('aborts before deleting any row when storage fails', async () => {
    await seed(shopA, [`${tag}/a1.glb`])
    hoisted.nextError = Object.assign(new Error('denied'), { name: 'AccessDenied' })

    await expect(purgeShopData(prisma, shopA)).rejects.toThrow('denied')

    // Rows intact, so Shopify's retry recomputes the same object list.
    expect(await counts(shopA)).toEqual({ assets: 1, mappings: 1, sessions: 1 })
  })

  // D7. Prisma DROPS undefined filters: deleteMany({where:{shop: undefined}})
  // becomes deleteMany({}) and wipes every tenant. Empty string is a REAL
  // filter matching nothing, so it is harmless — only undefined is fatal.
  // Both must throw, but this test is only meaningful because shopB is seeded:
  // "deleted nothing" is trivially true against an empty table.
  it.each([undefined, null, '', 0, 123, {}])(
    'refuses to purge with invalid shop %p, deleting nothing',
    async (bad) => {
      await seed(shopB, [`${tag}/b1.glb`])

      await expect(purgeShopData(prisma, bad)).rejects.toThrow(TypeError)

      expect(await counts(shopB)).toEqual({ assets: 1, mappings: 1, sessions: 1 })
      expect(hoisted.sent).toHaveLength(0)
    },
  )
})

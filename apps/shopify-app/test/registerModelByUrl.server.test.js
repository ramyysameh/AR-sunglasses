import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import prisma from '../app/db.server.js'

// Storage is object-backed (R2) in production; stub it with an in-memory store so
// this test exercises fetch→calibrate→store→persist without real object storage.
const storage = vi.hoisted(() => ({ objects: new Map() }))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (ref, bytes) => {
    storage.objects.set(ref, Buffer.from(bytes))
  },
  readModelGlb: async (ref) => storage.objects.get(ref) ?? null,
  deleteModelGlb: async (ref) => {
    storage.objects.delete(ref)
  },
}))

const { registerModelByUrl } = await import('../app/models.server.js')

const URL_A = 'https://cdn.shopify.com/s/files/1/0001/registerModelByUrl-a.glb'
const URL_B = 'https://cdn.shopify.com/s/files/1/0001/registerModelByUrl-b.glb'
const SHOP = 'block-attr-test.myshopify.com'

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

async function taggedGlbBytes() {
  const doc = buildDoc(GOOD, {
    AR_bridge: { x: 0, y: 0.024, z: 0.02 },
    AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
    AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
  })
  return new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc)
}

function stubFetchReturning(bytes) {
  const spy = vi.fn(async () => new Response(bytes, { status: 200 }))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterAll(async () => {
  vi.unstubAllGlobals()
  storage.objects.clear()
  // Scoped to this file's fixture shop only: this runs against a live shared
  // database, so a filter that could match rows we did not create is unsafe.
  await prisma.modelAsset.deleteMany({ where: { shop: SHOP } })
})

describe('registerModelByUrl', () => {
  it('fetches, calibrates, stores, and persists a ModelAsset keyed by sourceUrl', async () => {
    const bytes = await taggedGlbBytes()
    const fetchSpy = stubFetchReturning(bytes)

    const res = await registerModelByUrl(prisma, URL_A, SHOP)

    expect(res.modelUrl).toMatch(/^\/models\/.+\.glb$/)
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const asset = await prisma.modelAsset.findFirst({ where: { sourceUrl: URL_A } })
    expect(asset).not.toBeNull()
    expect(asset.shop).toBe(SHOP)
    const stored = storage.objects.get(asset.storageRef)
    expect(stored).toBeDefined()
    expect(stored.length).toBeGreaterThan(0)
  })

  it('dedupes on the second call for the same URL (no re-fetch, one asset)', async () => {
    const bytes = await taggedGlbBytes()
    const fetchSpy = stubFetchReturning(bytes)

    const first = await registerModelByUrl(prisma, URL_B, SHOP)
    const second = await registerModelByUrl(prisma, URL_B, SHOP)

    expect(second.modelUrl).toBe(first.modelUrl)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const count = await prisma.modelAsset.count({ where: { sourceUrl: URL_B } })
    expect(count).toBe(1)
  })
})

describe('registerModelByUrl shop attribution', () => {
  // The suite above already left a (SHOP, URL_A) row behind (afterAll cleans up
  // once, at file end). These tests assert exact counts for SHOP/URL_A, so they
  // need a clean slate rather than inheriting that state.
  beforeAll(async () => {
    await prisma.modelAsset.deleteMany({ where: { shop: SHOP } })
  })

  it('refuses to register without a valid shop, so no unattributable row is created', async () => {
    // An unattributed row can never be erased by shop/redact. Rejecting is the
    // only safe outcome.
    for (const bad of [undefined, null, '', 'not-a-shop', 123]) {
      await expect(registerModelByUrl(prisma, URL_A, bad)).rejects.toThrow(TypeError)
    }
    expect(await prisma.modelAsset.count({ where: { sourceUrl: URL_A } })).toBe(0)
  })

  it('purgeShopData erases a block-registered model', async () => {
    const bytes = await taggedGlbBytes()
    stubFetchReturning(bytes)
    await registerModelByUrl(prisma, URL_A, SHOP)
    expect(await prisma.modelAsset.count({ where: { shop: SHOP } })).toBe(1)

    const { purgeShopData } = await import('../app/webhooks.server.js')
    await purgeShopData(prisma, SHOP)

    // The whole point of this task.
    expect(await prisma.modelAsset.count({ where: { shop: SHOP } })).toBe(0)
  })
})

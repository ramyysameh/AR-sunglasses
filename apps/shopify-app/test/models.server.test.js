import { describe, it, expect, afterAll, vi } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import prisma from '../app/db.server.js'

// Storage is object-backed (R2) in production; stub it with an in-memory store so
// this test exercises calibrate→store→persist without reaching real object storage.
const storage = vi.hoisted(() => ({ objects: new Map() }))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (ref, bytes) => {
    storage.objects.set(ref, Buffer.from(bytes))
  },
  readModelGlb: async (ref) => storage.objects.get(ref) ?? null,
}))

const { saveCalibratedModel } = await import('../app/models.server.js')

const shop = 'upload-test.myshopify.com'

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

afterAll(async () => {
  storage.objects.clear()
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('saveCalibratedModel', () => {
  it('calibrates a tagged GLB, stores the normalized file, and persists a ready ModelAsset', async () => {
    const res = await saveCalibratedModel(prisma, shop, await taggedGlbBytes())
    expect(res.status).toBe('pass')
    expect(res.source).toBe('tagged')
    expect(res.needsManual).toBe(false)

    const asset = await prisma.modelAsset.findUnique({ where: { id: res.assetId } })
    expect(asset.shop).toBe(shop)
    expect(asset.status).toBe('ready')
    expect(asset.fitMetadata.version).toBe('eyewear-v1')

    const stored = storage.objects.get(asset.storageRef)
    expect(stored).toBeDefined()
    expect(stored.length).toBeGreaterThan(0)
  })
})

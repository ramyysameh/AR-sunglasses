import { describe, it, expect, afterAll, vi } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import prisma from '../app/db.server.js'

const storage = vi.hoisted(() => ({ objects: new Map(), deleted: [] }))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (ref, bytes) => { storage.objects.set(ref, Buffer.from(bytes)) },
  readModelGlb: async (ref) => storage.objects.get(ref) ?? null,
  deleteModelGlb: async (ref) => { storage.deleted.push(ref); storage.objects.delete(ref) },
}))

const { finalizeUpload } = await import('../app/models.server.js')
const { MAX_GLB_BYTES } = await import('../app/remoteGlb.server.js')

const shop = 'finalize-test.myshopify.com'
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
  storage.objects.clear(); storage.deleted.length = 0
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('finalizeUpload', () => {
  it('reads the temp object, deletes it, calibrates, and persists a ready asset', async () => {
    const ref = 'uploads/11111111-1111-4111-8111-111111111111.glb'
    storage.objects.set(ref, Buffer.from(await taggedGlbBytes()))

    const res = await finalizeUpload(prisma, shop, ref, 'hat.glb')
    expect(res.status).toBe('pass')
    expect(storage.deleted).toContain(ref)          // temp buffer removed
    expect(storage.objects.has(ref)).toBe(false)

    const asset = await prisma.modelAsset.findUnique({ where: { id: res.assetId } })
    expect(asset.shop).toBe(shop)
    expect(asset.filename).toBe('hat.glb')
    expect(asset.storageRef).not.toBe(ref)          // permanent model has its own key
  })

  it('rejects a key outside the uploads/ prefix', async () => {
    await expect(finalizeUpload(prisma, shop, 'models/evil.glb', null))
      .rejects.toThrow(/invalid upload key/i)
  })

  it('errors when the temp object is missing/expired', async () => {
    await expect(finalizeUpload(prisma, shop, 'uploads/22222222-2222-4222-8222-222222222222.glb', null))
      .rejects.toThrow(/expired/i)
  })

  it('rejects and cleans up an oversize upload', async () => {
    const ref = 'uploads/33333333-3333-4333-8333-333333333333.glb'
    storage.objects.set(ref, Buffer.alloc(MAX_GLB_BYTES + 1))
    await expect(finalizeUpload(prisma, shop, ref, null)).rejects.toThrow(/exceeds/i)
    expect(storage.deleted).toContain(ref)
  })
})

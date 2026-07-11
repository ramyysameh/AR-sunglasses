import { describe, it, expect, afterAll, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import prisma from '../app/db.server.js'
import { registerModelByUrl } from '../app/models.server.js'
import { resolveStoragePath } from '../app/storage.server.js'

const URL_A = 'https://cdn.shopify.com/s/files/1/0001/registerModelByUrl-a.glb'
const URL_B = 'https://cdn.shopify.com/s/files/1/0001/registerModelByUrl-b.glb'

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
  const assets = await prisma.modelAsset.findMany({ where: { sourceUrl: { in: [URL_A, URL_B] } } })
  for (const a of assets) await rm(resolveStoragePath(a.storageRef), { force: true })
  await prisma.modelAsset.deleteMany({ where: { sourceUrl: { in: [URL_A, URL_B] } } })
})

describe('registerModelByUrl', () => {
  it('fetches, calibrates, stores, and persists a ModelAsset keyed by sourceUrl', async () => {
    const bytes = await taggedGlbBytes()
    const fetchSpy = stubFetchReturning(bytes)

    const res = await registerModelByUrl(prisma, URL_A)

    expect(res.modelUrl).toMatch(/^\/models\/.+\.glb$/)
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const asset = await prisma.modelAsset.findFirst({ where: { sourceUrl: URL_A } })
    expect(asset).not.toBeNull()
    expect(asset.shop).toBe('__block__')
    const stored = await readFile(resolveStoragePath(asset.storageRef))
    expect(stored.length).toBeGreaterThan(0)
  })

  it('dedupes on the second call for the same URL (no re-fetch, one asset)', async () => {
    const bytes = await taggedGlbBytes()
    const fetchSpy = stubFetchReturning(bytes)

    const first = await registerModelByUrl(prisma, URL_B)
    const second = await registerModelByUrl(prisma, URL_B)

    expect(second.modelUrl).toBe(first.modelUrl)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const count = await prisma.modelAsset.count({ where: { sourceUrl: URL_B } })
    expect(count).toBe(1)
  })
})

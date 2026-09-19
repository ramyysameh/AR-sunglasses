import { describe, it, expect } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import { calibrateUpload } from '../app/calibration.server.js'

async function glbBytes(doc) {
  return new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc)
}

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('calibrateUpload', () => {
  it('calibrates a tagged GLB and returns fit-metadata (no manual)', async () => {
    const doc = buildDoc(GOOD, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const res = await calibrateUpload(await glbBytes(doc))
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(res.fitMetadata.provenance.source).toBe('tagged')
    expect(res.needsManual).toBe(false)
    expect(res.storedGlb).toBeInstanceOf(Uint8Array)
  })
})

describe('calibrateUpload byte fidelity', () => {
  it("returns the caller's bytes untouched", async () => {
    const bytes = await glbBytes(buildDoc(GOOD))
    const res = await calibrateUpload(bytes)
    expect(res.storedGlb).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(res.storedGlb).equals(Buffer.from(bytes))).toBe(true)
  })

  it('measures a rotated node without rewriting anything', async () => {
    // A node carrying rotation is exactly the case the old bake corrupted:
    // POSITION was transformed, NORMAL was left stale. Nothing may be rewritten.
    const doc = buildDoc(GOOD)
    doc.getRoot().listNodes()[0].setRotation([0, 1, 0, 0]) // 180 deg about Y
    const bytes = await glbBytes(doc)
    const res = await calibrateUpload(bytes)
    expect(Buffer.from(res.storedGlb).equals(Buffer.from(bytes))).toBe(true)
  })

  it('reports modelScale 1 for a model already in metres', async () => {
    const res = await calibrateUpload(await glbBytes(buildDoc(GOOD)))
    expect(res.fitMetadata.modelScale).toBe(1)
  })
})

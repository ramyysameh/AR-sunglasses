import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { getBounds } from '@gltf-transform/functions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import { composeFitPreview } from '../app/fitPreview.server.js'
import { calibrateUpload } from '../app/calibration.server.js'

const head = await readFile(new URL('../public/mock-head.glb', import.meta.url))
const frames = await readFile(new URL('../test-fixtures/tagged-sample.glb', import.meta.url))

async function glbBytes(doc) {
  return new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc)
}

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

// The real shape stored in ModelAsset.fitMetadata, read from a live row.
const fitMetadata = {
  version: 'eyewear-v1',
  bridgeAnchor: { x: 0, y: 0, z: 0.005297675263136625 },
  leftHinge: { x: -0.0725, y: -0.007025, z: 0.000036 },
  rightHinge: { x: 0.0725, y: -0.007025, z: 0.000036 },
  frameWidthMeters: 0.1450000107288361,
  frontFramePlaneZ: 0.005297675263136625,
}

describe('composeFitPreview', () => {
  it('returns a valid GLB containing both meshes', async () => {
    const out = await composeFitPreview(head, frames, fitMetadata)
    // glTF binary magic
    expect(new TextDecoder().decode(out.slice(0, 4))).toBe('glTF')
    expect(out.byteLength).toBeGreaterThan(head.byteLength)
  })

  it('keeps the frames large enough to inspect against the reference head', async () => {
    const out = await composeFitPreview(head, frames, fitMetadata)
    const doc = await new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).readBinary(out)
    const scene = doc.getRoot().getDefaultScene()
    const frameNode = scene.listChildren().find((node) => node.getName() === 'frameNode')
    const headNode = scene.listChildren().find((node) => node.getMesh() && node !== frameNode)
    const headBounds = getBounds(headNode)
    const frameBounds = getBounds(frameNode)
    const headWidth = headBounds.max[0] - headBounds.min[0]
    const frameWidth = frameBounds.max[0] - frameBounds.min[0]

    expect(frameWidth / headWidth).toBeGreaterThan(0.3)
  })

  it('round-trips a GLB written by the calibration pipeline IO without throwing', async () => {
    const doc = buildDoc(GOOD, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const { normalizedGlb, fitMetadata: calibratedFitMetadata } = await calibrateUpload(await glbBytes(doc))

    await expect(composeFitPreview(head, normalizedGlb, calibratedFitMetadata)).resolves.toBeInstanceOf(Uint8Array)
  })

})

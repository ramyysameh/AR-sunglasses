import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { composeFitPreview } from '../app/fitPreview.server.js'

const head = await readFile(new URL('../public/mock-head.glb', import.meta.url))
const frames = await readFile(new URL('../test-fixtures/tagged-sample.glb', import.meta.url))

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
    expect(Buffer.from(out.slice(0, 4)).toString()).toBe('glTF')
    expect(out.byteLength).toBeGreaterThan(head.byteLength)
  })

})

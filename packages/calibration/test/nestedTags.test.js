import { describe, it, expect } from 'vitest'
import { Document } from '@gltf-transform/core'
import { normalizeModel } from '../src/normalizer.js'
import { calibrate } from '../src/calibrator.js'
import { MODELING_SPEC } from '../src/spec.js'

// The layout Create with AI emits (trimesh / pygltflib): every mesh AND the AR_*
// anchor tags are children of one non-mesh root node, here "world". The engine
// re-origins the UNMODIFIED file to its bounding-box centre and places the frame
// by bridgeAnchor - modelBoundsCenter, so that difference must equal the real one
// in the raw file whatever the normalizer did to measure it.
function nestedDoc({ unit = 1 } = {}) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  // Frame front 145 mm wide, top at y=+21 mm, bottom at -31 mm; temples back to -155 mm.
  const positions = [
    -0.0725, 0.021, 0.003, 0.0725, 0.021, 0.003, 0, -0.031, 0.003,
    -0.0725, 0.014, -0.155, 0.0725, 0.014, -0.155, 0, -0.031, -0.008,
  ].map((v) => v * unit)
  const accessor = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer)
  const mesh = doc.createMesh('Frame').addPrimitive(doc.createPrimitive().setAttribute('POSITION', accessor))
  const world = doc.createNode('world')
  world.addChild(doc.createNode('Frame').setMesh(mesh))
  const tag = (name, x, y, z) => world.addChild(doc.createNode(name).setTranslation([x * unit, y * unit, z * unit]))
  tag('AR_bridge', 0, 0.0088, -0.0027)
  tag('AR_hinge_L', -0.0707, 0.0089, -0.0078)
  tag('AR_hinge_R', 0.0707, 0.0089, -0.0078)
  doc.createScene().addChild(world)
  // Raw bounding-box centre y = (0.021 + -0.031) / 2 = -0.005
  return { doc, rawBridgeAboveCentre: (0.0088 - -0.005) * unit }
}

function calibrateLikeServer(doc) {
  const { doc: measured, scale } = normalizeModel(doc, MODELING_SPEC)
  return { ...calibrate(measured, MODELING_SPEC, { modelScale: scale }), scale }
}

describe('anchor tags nested under a non-mesh root node', () => {
  it('keeps bridgeAnchor in the same frame as modelBoundsCenter after the recenter', () => {
    const { doc, rawBridgeAboveCentre } = nestedDoc()
    const { fitMetadata, source } = calibrateLikeServer(doc)
    expect(source).toBe('tagged')
    // Was 34.8 mm (anchor read unshifted, bounds shifted by the 21 mm frame top) -> frame drawn 21 mm low.
    expect(fitMetadata.bridgeAnchor.y - fitMetadata.modelBoundsCenter.y).toBeCloseTo(rawBridgeAboveCentre, 5)
    expect(fitMetadata.bridgeAnchor.x - fitMetadata.modelBoundsCenter.x).toBeCloseTo(0, 5)
  })

  it('keeps hinges level with the bridge offset (same frame as the geometry)', () => {
    const { doc } = nestedDoc()
    const { fitMetadata } = calibrateLikeServer(doc)
    expect(fitMetadata.leftHinge.y - fitMetadata.bridgeAnchor.y).toBeCloseTo(0.0001, 5)
    expect(fitMetadata.rightHinge.x - fitMetadata.leftHinge.x).toBeCloseTo(0.1414, 5)
  })

  it('scales nested tags with the geometry for a model authored in non-metre units', () => {
    const { doc } = nestedDoc({ unit: 20 }) // ~2.9 units wide: triggers the rescale
    const { fitMetadata, scale } = calibrateLikeServer(doc)
    expect(scale).not.toBe(1)
    // In metres after the rescale, and still in the bounds' frame.
    expect(fitMetadata.rightHinge.x - fitMetadata.leftHinge.x).toBeGreaterThan(0.1)
    expect(fitMetadata.rightHinge.x - fitMetadata.leftHinge.x).toBeLessThan(0.16)
    expect(fitMetadata.bridgeAnchor.y - fitMetadata.modelBoundsCenter.y).toBeCloseTo((0.0088 - -0.005) * 20 * scale, 5)
  })
})

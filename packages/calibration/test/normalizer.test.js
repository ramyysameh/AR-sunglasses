import { describe, it, expect } from 'vitest'
import { normalizeModel } from '../src/normalizer.js'
import { mergedPositions } from '../src/glbAccess.js'
import { computeBounds } from '../src/geometry.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

// Frame whose bridge sits at x=0.1 (off-origin) — normalizer should recenter it.
const offset = [
  0.031, 0, 0.02, 0.169, 0, 0.02, 0.1, 0.02, 0.02,
  0.031, 0, -0.13, 0.169, 0, -0.13, 0.1, -0.02, 0.02,
]

describe('normalizeModel', () => {
  it('recenters the front-slab X-center to x=0', () => {
    const { doc, transforms } = normalizeModel(buildDoc(offset), MODELING_SPEC)
    const b = computeBounds(mergedPositions(doc))
    expect(b.center.x).toBeCloseTo(0, 4)
    expect(transforms).toContain('recenter')
  })

  it('bakes a translated node transform into vertices (world-space) before recentering', () => {
    const doc = buildDoc([
      -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
      -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
    ])
    doc.getRoot().listNodes().find((n) => n.getMesh()).setTranslation([0.5, 0, 0])
    const { doc: normalized, transforms } = normalizeModel(doc, MODELING_SPEC)
    const meshNode = normalized.getRoot().listNodes().find((n) => n.getMesh())
    expect(meshNode.getTranslation()[0]).toBeCloseTo(0, 5)
    expect(computeBounds(mergedPositions(normalized)).center.x).toBeCloseTo(0, 4)
    expect(transforms).toContain('flatten')
  })

  it('rescales a non-metre-scale model (and its anchor tags) to a real-world frame width', () => {
    // Raw Blender-scene export: front frame ~3.3 units wide, tag at model scale.
    const large = [
      -1.65, 0, 0.48, 1.65, 0, 0.48, 0, 0.58, 0.48,
      -1.65, 0, -3.1, 1.65, 0, -3.1, 0, -0.48, 0.48,
    ]
    const { doc, transforms } = normalizeModel(
      buildDoc(large, { AR_hinge_L: { x: -1.7, y: 0, z: 0 } }),
      MODELING_SPEC,
    )
    expect(transforms).toContain('rescale')
    // Front frame is now real-world size (~0.145 m), not ~3.3 units.
    const b = computeBounds(mergedPositions(doc))
    expect(b.max.x - b.min.x).toBeGreaterThan(0.1)
    expect(b.max.x - b.min.x).toBeLessThan(0.2)
    // The anchor tag scaled down with the geometry (was -1.7 units → ~-0.075 m).
    const tag = doc.getRoot().listNodes().find((n) => n.getName() === 'AR_hinge_L')
    expect(Math.abs(tag.getTranslation()[0])).toBeLessThan(0.15)
    expect(Math.abs(tag.getTranslation()[0])).toBeGreaterThan(0.03)
  })

  it('leaves a model already in real-world metres unscaled', () => {
    const real = [
      -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
      -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
    ]
    const { transforms } = normalizeModel(buildDoc(real), MODELING_SPEC)
    expect(transforms).not.toContain('rescale')
  })
})

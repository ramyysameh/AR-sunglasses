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
})

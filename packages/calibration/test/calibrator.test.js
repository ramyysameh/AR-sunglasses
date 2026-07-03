import { describe, it, expect } from 'vitest'
import { calibrate } from '../src/calibrator.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('calibrate', () => {
  it('uses tags when present (exact, no confidence needed)', () => {
    const doc = buildDoc(goodFrame, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const res = calibrate(doc, MODELING_SPEC)
    expect(res.source).toBe('tagged')
    expect(res.confidence).toBeNull()
    expect(res.needsManual).toBe(false)
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(res.fitMetadata.bridgeAnchor).toEqual({ x: 0, y: 0.024, z: 0.02 })
  })

  it('falls back to geometry with a confidence report when untagged', () => {
    const res = calibrate(buildDoc(goodFrame), MODELING_SPEC)
    expect(res.source).toBe('geometric')
    expect(res.confidence.overall).toBeGreaterThan(0)
    expect(res.confidence.breakdown).toHaveProperty('symmetry')
    expect(typeof res.needsManual).toBe('boolean')
    expect(res.fitMetadata.provenance.source).toBe('geometric')
  })
})

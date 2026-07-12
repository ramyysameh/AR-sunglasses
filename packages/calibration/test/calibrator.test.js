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

  it('keeps the default scale band for a model already sized near real-world meters', () => {
    const res = calibrate(buildDoc(goodFrame), MODELING_SPEC)
    // goodFrame is ~0.138 m wide (real eyewear scale) -> natural fit ~1.
    expect(res.fitMetadata.scaleLimits).toEqual({ min: 0.85, max: 1.15 })
  })

  it('scales the scale band down for a large-coordinate model so the fit is not clamped huge', () => {
    // A raw Blender-scene export is ~3.3 units wide, not real meters. The fit
    // solver clamps scale = faceWidth / frameWidthMeters to these ABSOLUTE
    // bounds, so the band must shrink with the model or the model renders many
    // times too large (the bug the block-GLB flow surfaced with gripz-pelmo).
    const largeFrame = goodFrame.map((v) => v * 24) // ~3.3-unit-wide frame
    const res = calibrate(buildDoc(largeFrame), MODELING_SPEC)
    const { scaleLimits, frameWidthMeters } = res.fitMetadata
    expect(frameWidthMeters).toBeGreaterThan(2)
    const naturalFit = 0.14 / frameWidthMeters // tiny (~0.042) for a ~3.3-unit model
    // The natural fit must sit comfortably INSIDE the band (not clamped up toward
    // the old ~0.85 floor), with headroom above for per-device tracker variance.
    expect(scaleLimits.min).toBeGreaterThan(0)
    expect(scaleLimits.min).toBeLessThan(naturalFit)
    expect(scaleLimits.max).toBeGreaterThan(naturalFit * 2)
    expect(scaleLimits.max).toBeLessThan(0.85) // not the normalized-model band
  })
})

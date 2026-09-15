import { describe, it, expect } from 'vitest'
import { calibrate } from '../src/calibrator.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'
import { buildFrameDoc } from './helpers/buildFrame.js'

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
    // Wide enough to admit a broad face plus camera variance, not a tight
    // +/-15% that clamps legitimate fits -- see DEFAULT_SCALE_LIMITS.
    expect(res.fitMetadata.scaleLimits).toEqual({ min: 0.6, max: 1.6 })
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
    expect(scaleLimits.max).toBeLessThan(0.6) // not the normalized-model band
  })
})

describe('calibrate scale + bounds reporting', () => {
  const GEOM = [
    -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
    -0.069, -0.04, -0.13, 0.069, -0.04, -0.13, 0, -0.02, 0.02,
  ]

  it('defaults modelScale to 1 when the caller passes nothing', () => {
    const { fitMetadata } = calibrate(buildDoc(GEOM), MODELING_SPEC)
    expect(fitMetadata.modelScale).toBe(1)
  })

  it('records the modelScale the caller measured', () => {
    const { fitMetadata } = calibrate(buildDoc(GEOM), MODELING_SPEC, { modelScale: 0.0483 })
    expect(fitMetadata.modelScale).toBeCloseTo(0.0483, 6)
  })

  it('records the bounding-box centre of the measured geometry', () => {
    const { fitMetadata } = calibrate(buildDoc(GEOM), MODELING_SPEC)
    // x spans -0.069..0.069, y spans -0.04..0.024, z spans -0.13..0.02
    expect(fitMetadata.modelBoundsCenter.x).toBeCloseTo(0, 6)
    expect(fitMetadata.modelBoundsCenter.y).toBeCloseTo(-0.008, 6)
    expect(fitMetadata.modelBoundsCenter.z).toBeCloseTo(-0.055, 6)
  })
})

describe('calibrate provenance', () => {
  it('records per-anchor sources on the geometric path', () => {
    const result = calibrate(buildFrameDoc(), MODELING_SPEC)
    expect(result.fitMetadata.provenance.source).toBe('geometric')
    expect(result.fitMetadata.provenance.anchorSources.bridge).toBe('detected')
    expect(result.fitMetadata.provenance.anchorSources.leftHinge).toBe('detected')
    expect(result.fitMetadata.provenance.anchorSources.rightHinge).toBe('detected')
  })

  it('leaves the tagged path untouched', () => {
    const tagged = buildFrameDoc({}, {
      AR_bridge: { x: 0, y: -0.012, z: -0.004 },
      AR_hinge_L: { x: -0.066, y: -0.010, z: -0.012 },
      AR_hinge_R: { x: 0.066, y: -0.010, z: -0.012 },
    })
    const result = calibrate(tagged, MODELING_SPEC)
    expect(result.source).toBe('tagged')
    expect(result.confidence).toBe(null)
    expect(result.needsManual).toBe(false)
    expect(result.fitMetadata.provenance.anchorSources).toBeUndefined()
  })
})

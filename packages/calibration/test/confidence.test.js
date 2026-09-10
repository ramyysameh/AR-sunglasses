import { describe, it, expect } from 'vitest'
import { scoreConfidence, isConfident } from '../src/confidence.js'
import { MODELING_SPEC } from '../src/spec.js'

const goodSignals = {
  symmetryDeviation: 0.02,
  templeDetectionCertainty: 0.9,
  frameWidthMeters: 0.145,
  orientationConfidence: 0.95,
  scaleSanity: 0.9,
  bandSharpness: 30,
}

describe('scoreConfidence', () => {
  it('scores a clean model as confident with a full breakdown', () => {
    const { overall, breakdown } = scoreConfidence(goodSignals, MODELING_SPEC)
    expect(breakdown.symmetry).toBeGreaterThan(0.8)
    expect(breakdown.frameWidth).toBeGreaterThan(0.9)
    expect(breakdown.sharpness).toBeGreaterThan(0.8)
    expect(overall).toBeGreaterThan(0.6)
    expect(isConfident(overall)).toBe(true)
  })

  it('does NOT let branding asymmetry alone fail a model', () => {
    // Larsson's decals produced symmetryDeviation 0.155 and, under the old
    // weighted-min, an overall score of exactly 0.000 on a model whose anchors
    // are recoverable to within 1.8mm.
    const decals = { ...goodSignals, symmetryDeviation: 0.155 }
    const { breakdown, overall } = scoreConfidence(decals, MODELING_SPEC)
    expect(breakdown.symmetry).toBe(0)
    expect(overall).toBeGreaterThan(0.6)
    expect(isConfident(overall)).toBe(true)
  })

  it('lets a mis-oriented model veto the score outright', () => {
    const rotated = { ...goodSignals, orientationConfidence: 0.2 }
    const { overall } = scoreConfidence(rotated, MODELING_SPEC)
    expect(overall).toBeLessThanOrEqual(0.2)
    expect(isConfident(overall)).toBe(false)
  })

  it('does not penalise a correctly-oriented frame whose temples flare wider', () => {
    // GRIPZ scores orientationConfidence 0.70 because its temples are wider
    // than its front. That is a normal wraparound frame, not a rotated one, and
    // 0.70 must stay clear of the 0.6 threshold.
    const flared = { ...goodSignals, orientationConfidence: 0.7 }
    expect(isConfident(scoreConfidence(flared, MODELING_SPEC).overall)).toBe(true)
  })

  it('drags the score down when the front band could not be found', () => {
    const noBand = { ...goodSignals, bandSharpness: 0 }
    const { breakdown, overall } = scoreConfidence(noBand, MODELING_SPEC)
    expect(breakdown.sharpness).toBe(0)
    expect(overall).toBeLessThan(scoreConfidence(goodSignals, MODELING_SPEC).overall)
  })

  it('saturates sharpness low enough that a real cliff always clears it', () => {
    // Measured cliffs: 100 (Larsson) and 5.1 (GRIPZ). Both are genuine, and
    // both must score full marks -- GRIPZ's anchors land within 1.0mm.
    expect(scoreConfidence({ ...goodSignals, bandSharpness: 5.1 }, MODELING_SPEC).breakdown.sharpness).toBe(1)
    expect(scoreConfidence({ ...goodSignals, bandSharpness: 100 }, MODELING_SPEC).breakdown.sharpness).toBe(1)
  })

  it('stays finite for a degenerate frame-width range (minW === maxW)', () => {
    const spec = { frameWidthRangeM: [0.13, 0.13] }
    const { breakdown, overall } = scoreConfidence(
      { ...goodSignals, frameWidthMeters: 0.13 }, spec,
    )
    expect(Number.isFinite(breakdown.frameWidth)).toBe(true)
    expect(Number.isFinite(overall)).toBe(true)
  })

  it('treats a missing bandSharpness signal as unmeasured, not as zero-confidence', () => {
    const { overall } = scoreConfidence({ ...goodSignals, bandSharpness: undefined }, MODELING_SPEC)
    expect(Number.isFinite(overall)).toBe(true)
    expect(isConfident(overall)).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { scoreConfidence, isConfident } from '../src/confidence.js'
import { MODELING_SPEC } from '../src/spec.js'

const goodSignals = {
  symmetryDeviation: 0.02,
  templeDetectionCertainty: 0.9,
  frameWidthMeters: 0.145,
  orientationConfidence: 0.95,
  scaleSanity: 0.9,
}

describe('scoreConfidence', () => {
  it('scores a clean model as confident with a full breakdown', () => {
    const { overall, breakdown } = scoreConfidence(goodSignals, MODELING_SPEC)
    expect(breakdown.symmetry).toBeGreaterThan(0.8)
    expect(breakdown.frameWidth).toBeGreaterThan(0.9)
    expect(overall).toBeGreaterThan(0.6)
    expect(isConfident(overall)).toBe(true)
  })

  it('lets one bad sub-signal cap the overall score (weighted-min)', () => {
    const bad = { ...goodSignals, symmetryDeviation: 0.5 }
    const { overall, breakdown } = scoreConfidence(bad, MODELING_SPEC)
    expect(breakdown.symmetry).toBeLessThan(0.5)
    expect(overall).toBeLessThan(0.6)
    expect(isConfident(overall)).toBe(false)
  })

  it('stays finite for a degenerate frame-width range (minW === maxW)', () => {
    const spec = { frameWidthRangeM: [0.13, 0.13] }
    const { breakdown, overall } = scoreConfidence({ symmetryDeviation: 0.02, templeDetectionCertainty: 0.9, frameWidthMeters: 0.13, orientationConfidence: 0.9, scaleSanity: 0.9 }, spec)
    expect(Number.isFinite(breakdown.frameWidth)).toBe(true)
    expect(Number.isFinite(overall)).toBe(true)
  })
})

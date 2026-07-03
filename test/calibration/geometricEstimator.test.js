import { describe, it, expect } from 'vitest'
import { estimateAnchors } from '../../src/calibration/geometricEstimator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('estimateAnchors', () => {
  it('derives anchors and named signals from geometry', () => {
    const { anchors, signals } = estimateAnchors(buildDoc(goodFrame), MODELING_SPEC)
    expect(anchors.bridge.x).toBeCloseTo(0, 2)
    expect(anchors.bridge.y).toBeCloseTo(0.024, 2)
    expect(anchors.rightHinge.x).toBeGreaterThan(0)
    expect(signals.frameWidthMeters).toBeCloseTo(0.138, 3)
    expect(signals.symmetryDeviation).toBeLessThan(0.1)
    expect(signals.templeDetectionCertainty).toBeGreaterThan(0.5)
    expect(signals.scaleSanity).toBeGreaterThan(0.5)
    expect(signals.orientationConfidence).toBeGreaterThan(0.5)
  })
})

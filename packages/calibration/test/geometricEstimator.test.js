import { describe, it, expect } from 'vitest'
import { estimateAnchors } from '../src/geometricEstimator.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('estimateAnchors', () => {
  it('derives anchors and named signals from geometry', () => {
    const { anchors, signals } = estimateAnchors(buildDoc(goodFrame), MODELING_SPEC)
    expect(anchors.bridge.x).toBeCloseTo(0, 2)
    // The saddle -- the UNDERSIDE of the bridge at y = -0.02 -- not the top rim
    // at y = +0.024. A frame rests on the face at the former.
    expect(anchors.bridge.y).toBeCloseTo(-0.02, 2)
    expect(anchors.rightHinge.x).toBeGreaterThan(0)
    expect(signals.frameWidthMeters).toBeCloseTo(0.138, 3)
    expect(signals.symmetryDeviation).toBeLessThan(0.1)
    expect(signals.templeDetectionCertainty).toBeGreaterThan(0.5)
    expect(signals.scaleSanity).toBeGreaterThan(0.5)
    expect(signals.orientationConfidence).toBeGreaterThan(0.5)
  })

  it('scores orientation low for a mis-oriented (taller-than-wide) model', () => {
    // taller in Y than wide in X — wrong canonical orientation, must be flagged
    const misOriented = new Float32Array([
      -0.02, -0.069, 0.02, 0.02, -0.069, 0.02, 0, 0.069, 0.02,
      -0.02, -0.069, -0.13, 0.02, 0.069, -0.13,
    ])
    const { signals } = estimateAnchors(buildDoc(misOriented), MODELING_SPEC)
    expect(signals.orientationConfidence).toBeLessThan(0.6)
  })
})

describe('nose saddle', () => {
  it('takes the lowest central vertex, not the highest', () => {
    const { anchors } = estimateAnchors(buildDoc(goodFrame), MODELING_SPEC)
    expect(anchors.bridge.y).toBeCloseTo(-0.02, 3)
  })

  it('ignores the lenses when finding the centreline low point', () => {
    // Lens bottoms hang well below the bridge. Searching the whole front slab
    // instead of the central column would pick one of them and anchor the
    // frame by its lens rim.
    const withLowLenses = [
      -0.069, -0.05, 0.02, -0.03, -0.05, 0.02, -0.05, 0.01, 0.02,
      0.069, -0.05, 0.02, 0.03, -0.05, 0.02, 0.05, 0.01, 0.02,
      // bridge: a thin central span sitting ABOVE the lens bottoms
      -0.004, -0.012, 0.02, 0.004, -0.012, 0.02, 0, 0.004, 0.02,
      -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.012, 0.02,
    ]
    const { anchors } = estimateAnchors(buildDoc(withLowLenses), MODELING_SPEC)
    expect(anchors.bridge.y).toBeCloseTo(-0.012, 3)
  })

  it('falls back to the top rim when nothing sits on the centreline', () => {
    // Not real eyewear, but the fallback must not produce NaN.
    const split = [
      -0.069, 0, 0.02, -0.03, 0.024, 0.02, -0.05, -0.02, 0.02,
      0.069, 0, 0.02, 0.03, 0.024, 0.02, 0.05, -0.02, 0.02,
      -0.069, 0, -0.13, 0.069, 0, -0.13, 0.05, -0.02, 0.02,
    ]
    const { anchors } = estimateAnchors(buildDoc(split), MODELING_SPEC)
    expect(Number.isFinite(anchors.bridge.y)).toBe(true)
    expect(anchors.bridge.y).toBeCloseTo(0.024, 3)
  })
})

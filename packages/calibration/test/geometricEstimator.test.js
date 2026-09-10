import { describe, it, expect } from 'vitest'
import { estimateAnchors } from '../src/geometricEstimator.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'
import { buildFrameDoc, buildFramePositions, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('estimateAnchors', () => {
  it('places the bridge at the vertical centre of the bridge bar', () => {
    const { anchors } = estimateAnchors(buildFrameDoc(), MODELING_SPEC)
    const expectedY = -(FRAME_DEFAULTS.bridgeBarTop + FRAME_DEFAULTS.bridgeBarBottom) / 2
    expect(anchors.bridge.x).toBeCloseTo(0, 3)
    expect(anchors.bridge.y).toBeCloseTo(expectedY, 3)
    expect(anchors.bridge.z).toBeLessThan(0)
  })

  it('places hinges at the rear edge of the front band, not the temple tips', () => {
    const { anchors } = estimateAnchors(buildFrameDoc(), MODELING_SPEC)
    expect(anchors.rightHinge.z).toBeGreaterThan(-FRAME_DEFAULTS.frontDepth - 0.003)
    expect(anchors.rightHinge.z).toBeLessThan(0)
    expect(anchors.rightHinge.x).toBeGreaterThan(0)
    expect(anchors.leftHinge.x).toBeCloseTo(-anchors.rightHinge.x, 3)
    // Nowhere near the -150mm temple tips the old estimator drifted toward.
    expect(anchors.rightHinge.z).toBeGreaterThan(-0.05)
  })

  it('reports band sharpness and per-anchor sources', () => {
    const { signals, anchorSources } = estimateAnchors(buildFrameDoc(), MODELING_SPEC)
    expect(signals.bandSharpness).toBeGreaterThan(10)
    expect(anchorSources.bridge).toBe('detected')
    expect(anchorSources.leftHinge).toBe('detected')
    expect(anchorSources.rightHinge).toBe('detected')
  })

  it('ignores temple flare when placing hinges', () => {
    // Temples flaring wider than the front must not drag the hinges outward.
    const { anchors } = estimateAnchors(
      buildDoc(buildFramePositions({ hingeXRatio: 1.3 })), MODELING_SPEC,
    )
    expect(anchors.rightHinge.x).toBeLessThan(FRAME_DEFAULTS.frameWidth / 2)
    expect(anchors.rightHinge.x).toBeGreaterThan(0.05)
  })

  it('falls back to the prior when the bridge column is missing', () => {
    // A rimless-style front with nothing at x ~ 0 to measure.
    const pos = buildFramePositions()
    const kept = []
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i]) > 0.02) kept.push(pos[i], pos[i + 1], pos[i + 2])
    }
    const { anchorSources, anchors } = estimateAnchors(
      buildDoc(new Float32Array(kept)), MODELING_SPEC,
    )
    expect(anchorSources.bridge).toBe('prior')
    expect(Number.isFinite(anchors.bridge.y)).toBe(true)
    expect(anchors.bridge.y).toBeLessThan(0)
  })

  it('scores orientation low for a mis-oriented (taller-than-wide) model', () => {
    const misOriented = new Float32Array([
      -0.02, -0.069, 0.02, 0.02, -0.069, 0.02, 0, 0.069, 0.02,
      -0.02, -0.069, -0.13, 0.02, 0.069, -0.13,
    ])
    const { signals } = estimateAnchors(buildDoc(misOriented), MODELING_SPEC)
    expect(signals.orientationConfidence).toBeLessThan(0.6)
  })
})

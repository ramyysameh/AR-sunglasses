import { describe, it, expect } from 'vitest'
import { measureFrontWidth, measureSymmetryDeviation } from '../src/geometry.js'
import { segmentFrontFrame } from '../src/frontFrame.js'
import { buildFramePositions, isInFrontBand, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('measureFrontWidth (band-aware)', () => {
  it('ignores temple flare wider than the frame front', () => {
    const flared = buildFramePositions({ hingeXRatio: 1.3 })
    expect(measureFrontWidth(flared)).toBeCloseTo(FRAME_DEFAULTS.frameWidth, 3)
  })

  it('accepts a precomputed band without re-segmenting', () => {
    const pos = buildFramePositions()
    const band = segmentFrontFrame(pos)
    expect(measureFrontWidth(pos, band)).toBeCloseTo(measureFrontWidth(pos), 6)
  })
})

describe('measureSymmetryDeviation (band-aware)', () => {
  it('ignores asymmetry that lives behind the front band', () => {
    // A dense one-sided rear blob -- branding on one temple, the thing that
    // scored 0.155 on Larsson and zeroed its confidence. Sized so that a
    // whole-model measurement CANNOT pass, making this a real regression test
    // rather than one the old implementation would also satisfy.
    const pos = Array.from(buildFramePositions())
    for (let i = 0; i < 600; i += 1) {
      pos.push(0.05 + (i % 20) * 0.0005, -0.01, -0.05 - Math.floor(i / 20) * 0.002)
    }
    const withBranding = new Float32Array(pos)

    // Sanity: the same cloud measured over the whole model is badly asymmetric.
    const wholeModel = segmentFrontFrame(withBranding)
    expect(measureSymmetryDeviation(withBranding, { frontZMin: -Infinity })).toBeGreaterThan(0.15)

    // Measured on the band, the rear branding is invisible.
    expect(measureSymmetryDeviation(withBranding, wholeModel)).toBeLessThan(0.05)
    expect(measureSymmetryDeviation(withBranding)).toBeLessThan(0.05)
  })

  it('still detects asymmetry inside the front band', () => {
    const pos = buildFramePositions()
    const kept = []
    for (let i = 0; i < pos.length; i += 3) {
      const isFrontRightHalf = isInFrontBand(pos[i + 2]) && pos[i] > 0.02
      if (!isFrontRightHalf) kept.push(pos[i], pos[i + 1], pos[i + 2])
    }
    expect(measureSymmetryDeviation(new Float32Array(kept))).toBeGreaterThan(0.1)
  })
})

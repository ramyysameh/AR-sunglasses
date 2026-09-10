import { describe, it, expect } from 'vitest'
import { segmentFrontFrame } from '../src/frontFrame.js'
import { buildFramePositions, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('segmentFrontFrame', () => {
  it('finds the rear edge of the dense front band', () => {
    const band = segmentFrontFrame(buildFramePositions())
    expect(band.frontZMax).toBeCloseTo(0, 4)
    expect(band.frontZMin).toBeGreaterThan(-FRAME_DEFAULTS.frontDepth - 0.002)
    expect(band.frontZMin).toBeLessThan(-FRAME_DEFAULTS.frontDepth + 0.002)
    expect(band.sharpness).toBeGreaterThan(10)
  })

  it('measures half-width from the band, excluding temple flare', () => {
    // Temples flare wider than the front frame; the band must ignore them.
    const flared = buildFramePositions({ hingeXRatio: 1.3 })
    const band = segmentFrontFrame(flared)
    expect(band.halfWidth).toBeCloseTo(FRAME_DEFAULTS.frameWidth / 2, 3)
  })

  it('falls back to a clamped proportional depth when there is no cliff', () => {
    // A uniformly dense block, sampled finer than the 1mm bin size so every
    // bin is populated: no density collapse anywhere to find.
    const solid = []
    const Z_STEPS = 300
    for (let zi = 0; zi <= Z_STEPS; zi += 1) {
      for (let xi = 0; xi <= 60; xi += 1) {
        const x = -0.073 + (0.146 * xi) / 60
        const z = -(0.15 * zi) / Z_STEPS
        solid.push(x, 0, z)
        solid.push(x, -0.04, z)
      }
    }
    const band = segmentFrontFrame(new Float32Array(solid))
    expect(band.sharpness).toBe(0)
    expect(band.frontZMin).toBeLessThan(0)
    expect(band.frontZMin).toBeGreaterThanOrEqual(-0.025)
  })

  it('is not fooled by a frame tessellated coarser than the bin size', () => {
    // Faces spaced 2.5mm apart leave empty 1mm bins INSIDE the front band. A
    // single empty bin must not read as the rear edge, or the band collapses
    // to nothing on any low-poly model.
    const coarse = []
    for (let zi = 0; zi <= 6; zi += 1) {
      for (let xi = 0; xi <= 60; xi += 1) {
        const x = -0.073 + (0.146 * xi) / 60
        const z = -0.0025 * zi
        coarse.push(x, 0, z)
        coarse.push(x, -0.04, z)
      }
    }
    // Sparse temples beyond the front band -- the real cliff.
    for (let ti = 1; ti <= 40; ti += 1) {
      coarse.push(-0.066, -0.01, -0.015 - ti * 0.003)
      coarse.push(0.066, -0.01, -0.015 - ti * 0.003)
    }
    const band = segmentFrontFrame(new Float32Array(coarse))
    expect(band.frontZMin).toBeLessThan(-0.010)
    expect(band.halfWidth).toBeCloseTo(0.073, 3)
  })

  it('returns a degenerate band for empty input rather than throwing', () => {
    const band = segmentFrontFrame(new Float32Array([]))
    expect(Number.isFinite(band.frontZMin)).toBe(true)
    expect(Number.isFinite(band.halfWidth)).toBe(true)
    expect(band.sharpness).toBe(0)
  })
})

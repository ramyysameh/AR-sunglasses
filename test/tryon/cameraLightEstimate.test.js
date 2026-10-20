import { describe, it, expect } from 'vitest'
import {
  LightEstimateSmoother,
  estimateCameraLight,
  resolveLightEstimateEnabled,
} from '../../src/core/cameraLightEstimate.js'

const W = 32
const H = 18

/** Uniform frame; `center` optionally paints the middle third a different colour (a face). */
function frame([r, g, b], center = null) {
  const px = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const inCenter = center && x > W / 3 && x < (2 * W) / 3 && y > H / 4 && y < (3 * H) / 4
      const c = inCenter ? center : [r, g, b]
      const i = (y * W + x) * 4
      px[i] = c[0]
      px[i + 1] = c[1]
      px[i + 2] = c[2]
      px[i + 3] = 255
    }
  }
  return px
}

// sRGB 118 is linear ~0.18, middle grey.
const GREY = [118, 118, 118]

describe('estimateCameraLight', () => {
  it('leaves a middle-grey room alone', () => {
    const e = estimateCameraLight(frame(GREY), W, H)
    expect(e.intensity).toBeCloseTo(1, 1)
    expect(e.color.r).toBeCloseTo(1, 2)
    expect(e.color.g).toBeCloseTo(1, 2)
    expect(e.color.b).toBeCloseTo(1, 2)
  })

  it('dims in a dark room, but never below the floor', () => {
    const dim = estimateCameraLight(frame([50, 50, 50]), W, H)
    expect(dim.intensity).toBeLessThan(0.85)
    expect(dim.intensity).toBeGreaterThanOrEqual(0.6)
    const nearBlack = estimateCameraLight(frame([3, 3, 3]), W, H)
    expect(nearBlack.intensity).toBeCloseTo(0.6)
  })

  it('brightens a bright room only up to the cap', () => {
    expect(estimateCameraLight(frame([250, 250, 250]), W, H).intensity).toBeCloseTo(1.15)
  })

  it('keeps a warm cast warm, but bounded', () => {
    const e = estimateCameraLight(frame([200, 120, 60]), W, H)
    expect(e.color.r).toBeGreaterThan(e.color.b)
    // maxCast 0.12 x castBlend 0.5 => at most +/-6% per channel.
    for (const c of [e.color.r, e.color.g, e.color.b]) {
      expect(c).toBeGreaterThanOrEqual(0.94 - 1e-9)
      expect(c).toBeLessThanOrEqual(1.06 + 1e-9)
    }
  })

  it('weights the face in the middle less than the room around it', () => {
    const skin = [224, 150, 120]
    const faceOnGrey = estimateCameraLight(frame(GREY, skin), W, H)
    const allSkin = estimateCameraLight(frame(skin), W, H)
    expect(faceOnGrey.color.r - faceOnGrey.color.b).toBeLessThan(allSkin.color.r - allSkin.color.b)
  })

  it('returns null for unusable input', () => {
    expect(estimateCameraLight(null, W, H)).toBeNull()
    expect(estimateCameraLight(frame([0, 0, 0]), W, H)).toBeNull()
    expect(estimateCameraLight(new Uint8ClampedArray(8), W, H)).toBeNull()
  })
})

describe('LightEstimateSmoother', () => {
  const sample = (intensity) => ({ intensity, color: { r: 1, g: 1, b: 1 } })

  it('seeds on the first sample, then eases by elapsed time', () => {
    const s = new LightEstimateSmoother(1000)
    expect(s.push(sample(1), 0).intensity).toBe(1)
    const after100 = s.push(sample(0.6), 100).intensity
    expect(after100).toBeLessThan(1)
    expect(after100).toBeGreaterThan(0.9)
  })

  it('does not depend on the sampling rate', () => {
    const coarse = new LightEstimateSmoother(1000)
    coarse.push(sample(1), 0)
    coarse.push(sample(0.6), 1000)
    const fine = new LightEstimateSmoother(1000)
    fine.push(sample(1), 0)
    for (let t = 100; t <= 1000; t += 100) fine.push(sample(0.6), t)
    expect(fine.value.intensity).toBeCloseTo(coarse.value.intensity, 6)
  })

  it('ignores missing samples', () => {
    const s = new LightEstimateSmoother()
    s.push(sample(0.8), 0)
    expect(s.push(null, 500).intensity).toBe(0.8)
  })
})

describe('resolveLightEstimateEnabled', () => {
  it('is on unless ?lightest=0', () => {
    expect(resolveLightEstimateEnabled('')).toBe(true)
    expect(resolveLightEstimateEnabled('?lightest=0')).toBe(false)
  })
})

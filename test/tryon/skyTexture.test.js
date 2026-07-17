import { describe, it, expect } from 'vitest'
import { createSkyPixels } from '../../src/core/skyTexture.js'

const WIDTH = 128
const HEIGHT = 64

function luminanceAt(pixels, x, y, width = WIDTH) {
  const i = (y * width + x) * 4
  return 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
}

function brightestPixel(pixels, width = WIDTH, height = HEIGHT) {
  let best = { x: 0, y: 0, lum: -Infinity }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const lum = luminanceAt(pixels, x, y, width)
      if (lum > best.lum) best = { x, y, lum }
    }
  }
  return best
}

describe('createSkyPixels', () => {
  it('returns an RGBA buffer of the requested size with opaque alpha', () => {
    const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT })
    expect(pixels).toBeInstanceOf(Float32Array)
    expect(pixels.length).toBe(WIDTH * HEIGHT * 4)
    for (let i = 3; i < pixels.length; i += 4) {
      expect(pixels[i]).toBe(1)
    }
  })

  it('puts the sun at the requested azimuth and elevation', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 35,
      sunElevationDeg: 28,
    })
    const { x, y } = brightestPixel(pixels)
    const azimuth = ((x + 0.5) / WIDTH) * 360 - 180
    const elevation = 90 - ((y + 0.5) / HEIGHT) * 180
    // One pixel spans ~2.8deg, so allow a pixel of slack in each axis.
    expect(Math.abs(azimuth - 35)).toBeLessThan(3)
    expect(Math.abs(elevation - 28)).toBeLessThan(3)
  })

  it('emits linear radiance above 1.0 for a bright sun (no gamma, no clamp)', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunIntensity: 14,
    })
    expect(brightestPixel(pixels).lum).toBeGreaterThan(1)
  })

  it('falls off smoothly from the sun centre instead of hard-clipping', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 0,
      sunElevationDeg: 0,
      sunSizeDeg: 20,
    })
    // Azimuth 0 / elevation 0 sits mid-row, mid-column. Walk outward along the row.
    const y = Math.floor(HEIGHT / 2)
    const centreX = Math.floor(WIDTH / 2)
    let previous = Infinity
    for (let step = 0; step < 8; step++) {
      const lum = luminanceAt(pixels, centreX + step, y)
      expect(lum).toBeLessThan(previous)
      previous = lum
    }
  })

  it('gradates monotonically from the sky top down to the horizon', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 35,
      sunElevationDeg: 28,
    })
    // Sample the column opposite the sun so the disc cannot contaminate it.
    const x = Math.floor(((-145 + 180) / 360) * WIDTH)
    let previous = -Infinity
    for (let y = 0; y < HEIGHT / 2; y++) {
      const lum = luminanceAt(pixels, x, y)
      expect(lum).toBeGreaterThan(previous)
      previous = lum
    }
  })
})

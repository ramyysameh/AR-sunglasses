import { describe, it, expect } from 'vitest'
import { STUDIO_PANELS, createStudioPixels } from '../../src/core/studioTexture.js'

const W = 128
const H = 64
const DEG = Math.PI / 180

/**
 * Decode a texel the way THREE does, NOT the way the generator wrote it.
 *
 * This is the whole point of the test: three's `equirectUv` is
 *   u = atan2(dir.z, dir.x) / (2*PI) + 0.5,  v = asin(dir.y) / PI + 0.5
 * and DataTexture sets flipY = false, so row 0 is dir.y = -1. Checking the
 * generator against its own formulas would pass happily with the sky upside
 * down, which is exactly how the sun once ended up below the lens.
 */
function sample(pixels, direction, width = W, height = H) {
  const [x, y, z] = direction
  const u = Math.atan2(z, x) / (2 * Math.PI) + 0.5
  const v = Math.asin(Math.max(Math.min(y, 1), -1)) / Math.PI + 0.5
  const px = Math.min(width - 1, Math.max(0, Math.round(u * width - 0.5)))
  const py = Math.min(height - 1, Math.max(0, Math.round(v * height - 0.5)))
  const i = (py * width + px) * 4
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]]
}

function directionFromAngles(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * DEG
  const el = elevationDeg * DEG
  return [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)]
}

const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b

describe('createStudioPixels', () => {
  const pixels = createStudioPixels({ width: W, height: H })

  it('emits one finite linear RGBA texel per pixel, opaque', () => {
    expect(pixels).toHaveLength(W * H * 4)
    expect([...pixels].every(Number.isFinite)).toBe(true)
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(1)
  })

  it('puts each panel where it was authored, decoded THREE\'s way', () => {
    // Catches the upside-down and mirrored encodings that a self-consistent
    // test cannot: those put the key light under the chin, or sweep the
    // highlight the wrong way as the head turns.
    for (const panel of STUDIO_PANELS) {
      const onPanel = luminance(sample(pixels, directionFromAngles(panel.azimuthDeg, panel.elevationDeg)))
      const opposite = luminance(sample(pixels, directionFromAngles(panel.azimuthDeg + 180, -panel.elevationDeg)))
      expect(onPanel).toBeGreaterThan(opposite)
    }
  })

  it('keeps the key brighter than the fill, so they do not read as a pair', () => {
    const [key, fill] = STUDIO_PANELS
    const keyL = luminance(sample(pixels, directionFromAngles(key.azimuthDeg, key.elevationDeg)))
    const fillL = luminance(sample(pixels, directionFromAngles(fill.azimuthDeg, fill.elevationDeg)))
    expect(keyL).toBeGreaterThan(fillL)
  })

  it('lights the elevation-0 ring, which is the only part a lens can reflect', () => {
    // A near-flat lens facing the camera reflects along elevation 0 at every
    // head yaw. Panels placed above that ring are invisible in the lens no
    // matter how bright, which is what made an earlier sun unreachable.
    let brightest = 0
    for (let az = -180; az < 180; az += 5) {
      brightest = Math.max(brightest, luminance(sample(pixels, directionFromAngles(az, 0))))
    }
    expect(brightest).toBeGreaterThan(1)
  })

  it('leaves the surround dark, so the panels are what gets reflected', () => {
    // Straight down-behind, away from every panel and the floor bounce's peak.
    const dark = luminance(sample(pixels, directionFromAngles(-120, -30)))
    expect(dark).toBeLessThan(0.5)
  })

  it('gives panels soft edges rather than a hard step', () => {
    // A hard edge aliases into a jagged band sweeping across the frame.
    const key = STUDIO_PANELS[0]
    const inside = luminance(sample(pixels, directionFromAngles(key.azimuthDeg, key.elevationDeg)))
    const edge = luminance(sample(pixels, directionFromAngles(key.azimuthDeg + key.halfWidthDeg + key.softDeg / 2, key.elevationDeg)))
    const outside = luminance(sample(pixels, directionFromAngles(key.azimuthDeg + key.halfWidthDeg + key.softDeg * 2, key.elevationDeg)))
    expect(edge).toBeLessThan(inside)
    expect(edge).toBeGreaterThan(outside)
  })

  it('is brighter above than below, so the frame is lit like a studio', () => {
    let above = 0
    let below = 0
    for (let az = -180; az < 180; az += 10) {
      above += luminance(sample(pixels, directionFromAngles(az, 60)))
      below += luminance(sample(pixels, directionFromAngles(az, -60)))
    }
    expect(above).toBeGreaterThan(below)
  })

  it('wraps in azimuth without a seam at the +/-180 join', () => {
    const left = luminance(sample(pixels, directionFromAngles(-179, 10)))
    const right = luminance(sample(pixels, directionFromAngles(179, 10)))
    expect(Math.abs(left - right)).toBeLessThan(0.5)
  })

  it('honours a custom size', () => {
    const small = createStudioPixels({ width: 32, height: 16 })
    expect(small).toHaveLength(32 * 16 * 4)
  })
})

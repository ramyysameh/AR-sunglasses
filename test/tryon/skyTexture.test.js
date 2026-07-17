import { describe, it, expect } from 'vitest'
import { createSkyPixels } from '../../src/core/skyTexture.js'

const WIDTH = 128
const HEIGHT = 64
const DEG = Math.PI / 180

function luminanceAt(pixels, x, y, width = WIDTH) {
  const i = (y * width + x) * 4
  return 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]
}

function rgbAt(pixels, x, y, width = WIDTH) {
  const i = (y * width + x) * 4
  return [pixels[i], pixels[i + 1], pixels[i + 2]]
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

/**
 * The world direction three samples a given texel for.
 *
 * This is the INVERSE of three's `equirectUv` (ShaderChunk/common.glsl.js):
 *   u = atan(dir.z, dir.x) / (2*PI) + 0.5
 *   v = asin(dir.y) / PI + 0.5
 * combined with `DataTexture.flipY = false`, so data row 0 is v = 0.
 *
 * Deliberately NOT the producer's own formulas: decoding with the encoder's
 * maths only proves self-consistency and passes even when the convention does
 * not match three's — which is exactly how the negated-elevation bug survived.
 */
function directionThreeSamplesTexel(x, y, width = WIDTH, height = HEIGHT) {
  const u = (x + 0.5) / width
  const v = (y + 0.5) / height
  const phi = (u - 0.5) * 2 * Math.PI // atan2(dir.z, dir.x)
  const theta = (v - 0.5) * Math.PI // asin(dir.y)
  const cosTheta = Math.cos(theta)
  return [Math.cos(phi) * cosTheta, Math.sin(theta), Math.sin(phi) * cosTheta]
}

/** The documented author-facing az/el -> world vector definition. */
function expectedSunDirection(azimuthDeg, elevationDeg) {
  const az = azimuthDeg * DEG
  const el = elevationDeg * DEG
  const cosEl = Math.cos(el)
  return [Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl]
}

/** Data row three samples for a given dir.y, via v = asin(dir.y)/PI + 0.5. */
function rowForDirY(dirY, height = HEIGHT) {
  const v = Math.asin(Math.min(Math.max(dirY, -1), 1)) / Math.PI + 0.5
  return Math.min(Math.max(Math.floor(v * height), 0), height - 1)
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
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

  it('puts the sun in the world direction three will sample it from', () => {
    const sunAzimuthDeg = 35
    const sunElevationDeg = 28
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg,
      sunElevationDeg,
    })
    const { x, y } = brightestPixel(pixels)
    const actual = directionThreeSamplesTexel(x, y)
    const expected = expectedSunDirection(sunAzimuthDeg, sunElevationDeg)
    // One texel spans ~2.8deg, so the brightest texel centre can sit up to
    // ~1.4deg off in each axis. 3deg leaves a texel of slack and still fails
    // hard on a negated elevation or a mirrored azimuth.
    expect(dot(actual, expected)).toBeGreaterThan(Math.cos(3 * DEG))
  })

  it('samples sky when looking up and ground when looking down', () => {
    const pixels = createSkyPixels({
      width: WIDTH,
      height: HEIGHT,
      sunAzimuthDeg: 35,
      sunElevationDeg: 28,
    })
    // Sample a column far from the sun so the disc cannot contaminate it. Columns map to
    // phi = atan2(dir.z, dir.x) = (u - 0.5) * 360, so this is phi = -145deg; the sun sits at
    // phi = 90 - 35 = 55deg, ~160deg away and well outside the 9deg disc.
    const x = Math.floor(((-145 + 180) / 360) * WIDTH)
    const up = rgbAt(pixels, x, rowForDirY(1))
    const down = rgbAt(pixels, x, rowForDirY(-1))

    // Straight up is SKY_TOP: brighter and markedly bluer than GROUND.
    expect(luminanceAt(pixels, x, rowForDirY(1))).toBeGreaterThan(
      luminanceAt(pixels, x, rowForDirY(-1)),
    )
    expect(up[2]).toBeGreaterThan(down[2])
    // Blue dominates red in the sky; the ground is neutral-to-warm.
    expect(up[2]).toBeGreaterThan(up[0])
    expect(down[2]).toBeLessThan(down[0])
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
      // Deliberately off-axis: an azimuth of 0 lands exactly on a texel
      // boundary, leaving two equidistant texels tied for brightest and a
      // spurious flat step in the walk below.
      sunAzimuthDeg: 35,
      sunElevationDeg: 0,
      sunSizeDeg: 20,
    })
    // Walk outward along the sun's own row, away from the disc centre.
    const { x: centreX, y } = brightestPixel(pixels)
    let previous = Infinity
    for (let step = 0; step < 8; step++) {
      const lum = luminanceAt(pixels, (centreX + step) % WIDTH, y)
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
    // Sample a column far from the sun so the disc cannot contaminate it. Columns map to
    // phi = atan2(dir.z, dir.x) = (u - 0.5) * 360, so this is phi = -145deg; the sun sits at
    // phi = 90 - 35 = 55deg, ~160deg away and well outside the 9deg disc.
    const x = Math.floor(((-145 + 180) / 360) * WIDTH)
    // Walk the true sky hemisphere: from the top row downward, stopping at the
    // horizon. The bound comes from the elevation formula, not a magic HEIGHT/2.
    let previous = -Infinity
    let rowsWalked = 0
    for (let y = HEIGHT - 1; y >= 0; y--) {
      const elevation = ((y + 0.5) / HEIGHT - 0.5) * 180
      if (elevation < 0) break
      const lum = luminanceAt(pixels, x, y)
      expect(lum).toBeGreaterThan(previous)
      previous = lum
      rowsWalked++
    }
    expect(rowsWalked).toBe(HEIGHT / 2)
  })
})

/**
 * The texel three samples for a given world direction — the FORWARD `equirectUv`
 * (the inverse of `directionThreeSamplesTexel` above), with `flipY = false`.
 */
function texelThreeSamplesFor(direction) {
  const u = Math.atan2(direction[2], direction[0]) / (2 * Math.PI) + 0.5
  const v = Math.asin(Math.min(Math.max(direction[1], -1), 1)) / Math.PI + 0.5
  return {
    x: Math.min(WIDTH - 1, Math.max(0, Math.floor(u * WIDTH))),
    y: Math.min(HEIGHT - 1, Math.max(0, Math.floor(v * HEIGHT))),
  }
}

/**
 * What a lens actually reflects, as a function of head yaw.
 *
 * A lens is near-flat and faces the camera, so with view direction (0,0,-1) and
 * normal (sin t, 0, cos t) for head yaw t:
 *   R = reflect(I, N) = I - 2(I·N)N = (sin 2t, 0, cos 2t)
 * Elevation of R is pinned at 0 for ANY yaw; only azimuth moves, at 2x the turn.
 */
function lensReflectsAtYaw(yawDeg) {
  const t = yawDeg * DEG
  return [Math.sin(2 * t), 0, Math.cos(2 * t)]
}

describe('what a lens can actually reflect', () => {
  // This is the test that the original design lacked. The spec assumed "env map is
  // world-fixed + glasses rotate => the glint sweeps", which is only half true: yaw
  // sweeps azimuth but pins elevation at 0. The sun was baked at elevation 28, off
  // that ring, so it was never reflected at any angle — while a near-white horizon
  // band washed the lens uniformly. Measured on the shipped build: luminance 0.783
  // at every yaw from -40 to +40, with the sun (13.11) never sampled.
  const yawSweep = [-40, -30, -20, -17.5, -10, 0, 10, 17.5, 20, 30, 40]

  function lumAcrossYaw(pixels) {
    return yawSweep.map((yaw) => {
      const { x, y } = texelThreeSamplesFor(lensReflectsAtYaw(yaw))
      return luminanceAt(pixels, x, y)
    })
  }

  it('reaches the sun somewhere in a normal head turn', () => {
    const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT })
    const peak = Math.max(...lumAcrossYaw(pixels))
    // The sun is ~14 linear; anything near the sky baseline means it is off-ring
    // and unreachable, which is the bug this pins.
    expect(peak).toBeGreaterThan(1)
  })

  it('does not wash the lens white when the sun is not in view', () => {
    const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT })
    const floor = Math.min(...lumAcrossYaw(pixels))
    // The old horizon band sat at 0.783 (near-white) and produced the "lenses are
    // so white" report. The sky the lens sees must be dim.
    expect(floor).toBeLessThan(0.15)
  })

  it('varies across the turn — a glint, not a constant wash', () => {
    const pixels = createSkyPixels({ width: WIDTH, height: HEIGHT })
    const lums = lumAcrossYaw(pixels)
    const ratio = Math.max(...lums) / Math.min(...lums)
    // The shipped build had ratio 1.0 — identical luminance at every angle, i.e.
    // no sweep whatsoever.
    expect(ratio).toBeGreaterThan(20)
  })
})

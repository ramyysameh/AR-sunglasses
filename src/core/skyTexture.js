/**
 * Procedural sky for lens reflections: a vertical gradient with a sun disc,
 * as raw equirectangular pixels.
 *
 * Values are LINEAR radiance, never gamma-encoded — PMREMGenerator expects
 * linear input, so sunIntensity is a linear multiplier and may exceed 1.
 *
 * Deliberately no canvas and no DOM: pure pixel math, so it runs in Node.
 *
 * PIXEL MAPPING — do not "simplify" this back to a plain (90 - y*180) form.
 * The texel loop must decode with the exact inverse of three's `equirectUv`
 * (renderers/shaders/ShaderChunk/common.glsl.js), which PMREMGenerator calls
 * as `equirectUv(outputDirection)`:
 *
 *   u = atan(dir.z, dir.x) / (2*PI) + 0.5
 *   v = asin(dir.y) / PI + 0.5
 *
 * and `DataTexture` sets `flipY = false` (textures/DataTexture.js), so data
 * row 0 is v = 0, i.e. dir.y = -1 — straight DOWN, not up. Encoding row 0 as
 * "up" negates elevation (blue sky renders below the lens, sunElevationDeg 28
 * lands at -27°) and encoding u as az/360+0.5 mirrors azimuth about 45°, so
 * ?sunaz sweeps the glint the wrong way. Both are invisible to any test that
 * decodes with these same formulas rather than three's.
 *
 * `directionFromAngles` below is the separate author-facing az/el -> world
 * vector definition and is intentionally NOT this convention: it is what
 * sunAzimuthDeg / sunElevationDeg mean to a human, and the sun vector uses it.
 */

// Linear radiance. Horizon is the bright band; sky darkens upward, ground
// darkens downward.
const SKY_TOP = [0.10, 0.22, 0.48]
const HORIZON = [0.72, 0.80, 0.92]
const GROUND = [0.09, 0.08, 0.07]

const DEG = Math.PI / 180

function directionFromAngles(azimuthDeg, elevationDeg) {
  const azimuth = azimuthDeg * DEG
  const elevation = elevationDeg * DEG
  const cosElevation = Math.cos(elevation)
  return [
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
    Math.cos(azimuth) * cosElevation,
  ]
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

export function createSkyPixels({
  width = 128,
  height = 64,
  sunAzimuthDeg = 35,
  sunElevationDeg = 28,
  sunSizeDeg = 9,
  sunIntensity = 14,
} = {}) {
  const pixels = new Float32Array(width * height * 4)
  const sun = directionFromAngles(sunAzimuthDeg, sunElevationDeg)

  for (let y = 0; y < height; y++) {
    // v = 0 -> dir.y = -1 (down); v = 1 -> dir.y = +1 (up). See PIXEL MAPPING.
    const v = (y + 0.5) / height
    const elevation = (v - 0.5) * 180
    const gradientT = Math.abs(elevation) / 90
    const target = elevation >= 0 ? SKY_TOP : GROUND
    const r = HORIZON[0] + (target[0] - HORIZON[0]) * gradientT
    const g = HORIZON[1] + (target[1] - HORIZON[1]) * gradientT
    const b = HORIZON[2] + (target[2] - HORIZON[2]) * gradientT

    const theta = elevation * DEG
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)

    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width
      const phi = (u - 0.5) * 2 * Math.PI // three: atan2(dir.z, dir.x)
      const direction = [Math.cos(phi) * cosTheta, sinTheta, Math.sin(phi) * cosTheta]

      const cosAngle = direction[0] * sun[0] + direction[1] * sun[1] + direction[2] * sun[2]
      const angleDeg = Math.acos(Math.min(Math.max(cosAngle, -1), 1)) / DEG
      // 1 at the sun centre, 0 at its edge. Squared so the core stays hot but
      // the rim blooms instead of hard-clipping into an aliased dot.
      const falloff = smoothstep(sunSizeDeg, 0, angleDeg)
      const sunAdd = sunIntensity * falloff * falloff

      const i = (y * width + x) * 4
      pixels[i] = r + sunAdd
      pixels[i + 1] = g + sunAdd
      pixels[i + 2] = b + sunAdd
      pixels[i + 3] = 1
    }
  }

  return pixels
}

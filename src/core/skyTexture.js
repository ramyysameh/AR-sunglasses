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

// Linear radiance, deliberately DIM. A lens is near-flat and faces the camera, so
// its reflected ray sits on the elevation-0 ring (see the sun-elevation note below)
// — it samples the horizon band and almost nothing else. A bright horizon therefore
// does not read as "sky", it washes the whole lens white at every head angle. Keep
// these low so the sun is the only bright thing the lens can find: measured, a lens
// reflected the old horizon at luminance 0.783 (near-white) uniformly across a
// +/-40deg yaw sweep. Horizon stays the brightest of the three so the gradient still
// reads as sky-above / ground-below where curvature does sample off-ring.
const SKY_TOP = [0.03, 0.05, 0.12]
const HORIZON = [0.08, 0.10, 0.14]
// Warm, not neutral grey: a neutral ground blends toward the blue-ish horizon and
// ends up faintly blue, which reads as sky in the wrong hemisphere.
const GROUND = [0.03, 0.025, 0.018]

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
  // Near the horizon ON PURPOSE. Reflecting off a near-flat lens facing the camera,
  // the reflected ray is R = reflect((0,0,-1), N); for head yaw t the normal is
  // (sin t, 0, cos t), giving R = (sin 2t, 0, cos 2t) — elevation pinned at 0 for ANY
  // yaw, azimuth sweeping at 2x the head turn. A sun above that ring can never be
  // reflected: at elevation 28 it was invisible at every angle while the horizon
  // washed the lens white. Keep this small so the sun sits on the ring the lens
  // actually sees; ?sunel overrides.
  sunElevationDeg = 5,
  // Wide enough that lens curvature and pantoscopic tilt (which nudge the reflected
  // ray off the elevation-0 ring) still land inside the disc.
  sunSizeDeg = 12,
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

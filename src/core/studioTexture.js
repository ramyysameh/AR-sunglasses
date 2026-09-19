/**
 * Procedural studio environment for reflections: dark surround with a few soft
 * panels, as raw equirectangular pixels.
 *
 * The alternative to skyTexture.js, and it exists because eyewear is shot in a
 * studio, not outdoors: what makes a frame read as glossy is a BAND of light
 * sweeping along the bevel as the head turns, not a single sun dot.
 *
 * Values are LINEAR radiance, never gamma-encoded -- PMREMGenerator expects
 * linear input, so intensities may exceed 1. No canvas and no DOM, so it runs
 * in Node and can be tested.
 *
 * PIXEL MAPPING -- the same inverse of three's `equirectUv` that skyTexture.js
 * documents at length. Row 0 is dir.y = -1 (straight DOWN), and u maps to
 * atan2(dir.z, dir.x). Encoding either the other way up puts the key light under
 * the chin and sweeps the highlight the wrong way as the head turns, and no test
 * that decodes with its own formulas can see it.
 *
 * PANEL ELEVATIONS -- deliberately low. Reflecting off a near-flat lens facing
 * the camera, the reflected ray is R = reflect((0,0,-1), N); for head yaw t the
 * normal is (sin t, 0, cos t), giving R = (sin 2t, 0, cos 2t): elevation pinned
 * at 0 for ANY yaw, azimuth sweeping at twice the head turn. A panel above that
 * ring is invisible in the lens at every angle. The key and fill therefore sit
 * near the horizon where the lens can find them; the overhead strip is for the
 * FRAME, whose bevels face every which way and do sample off-ring.
 */

const DEG = Math.PI / 180

/** Near-black, faintly cool: a studio's unlit surround, not a void. */
const SURROUND = [0.012, 0.013, 0.016]

/**
 * The panels, in the order a photographer would set them.
 *
 * `halfWidthDeg`/`halfHeightDeg` are the panel's angular half-extents, and
 * `softDeg` how far the edge takes to fall off -- a real softbox has a diffuser,
 * so the edge is soft but still straight, which is what distinguishes it from
 * skyTexture's round sun.
 */
const PANELS = [
  // Key: large, camera-left, just above the lens ring so it catches both.
  { azimuthDeg: -42, elevationDeg: 8, halfWidthDeg: 26, halfHeightDeg: 18, softDeg: 9, intensity: 11 },
  // Fill: opposite side, dimmer and smaller, so the two do not read as a pair of
  // identical blobs when the head turns through them.
  { azimuthDeg: 55, elevationDeg: 2, halfWidthDeg: 20, halfHeightDeg: 14, softDeg: 8, intensity: 4.2 },
  // Rim: behind and high, for the edge light along the top of the frame.
  { azimuthDeg: 158, elevationDeg: 34, halfWidthDeg: 22, halfHeightDeg: 14, softDeg: 10, intensity: 5 },
  // Overhead strip: broad and weak. Gives the upper bevels a sheen without
  // putting anything bright on the elevation-0 ring the lens sees.
  { azimuthDeg: 0, elevationDeg: 68, halfWidthDeg: 90, halfHeightDeg: 16, softDeg: 14, intensity: 2.2 },
]

/** Dim bounce off the floor, so the underside of the frame is not dead black. */
const FLOOR_BOUNCE = { elevationDeg: -90, spreadDeg: 55, intensity: 0.5 }

function smoothstep(edge0, edge1, x) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

/** Shortest signed distance between two azimuths, in degrees. */
function azimuthDelta(a, b) {
  let d = a - b
  while (d > 180) d -= 360
  while (d < -180) d += 360
  return d
}

/**
 * How much of a panel covers this direction: 1 inside, 0 outside, soft between.
 *
 * Separable in azimuth and elevation, which is what gives a softbox its straight
 * edges and squared-off corners. Azimuth extent is divided by cos(elevation) so
 * a panel keeps its apparent width as it rises rather than wrapping around the
 * pole into a band.
 */
function panelCoverage(panel, azimuthDeg, elevationDeg) {
  const cos = Math.max(Math.cos(elevationDeg * DEG), 0.15)
  const dAz = Math.abs(azimuthDelta(azimuthDeg, panel.azimuthDeg)) * cos
  const dEl = Math.abs(elevationDeg - panel.elevationDeg)
  const across = smoothstep(panel.halfWidthDeg + panel.softDeg, panel.halfWidthDeg, dAz)
  const down = smoothstep(panel.halfHeightDeg + panel.softDeg, panel.halfHeightDeg, dEl)
  return across * down
}

/**
 * @param {{width?: number, height?: number, panels?: Array, surround?: number[]}} options
 * @returns {Float32Array} RGBA linear radiance, width * height * 4
 */
export function createStudioPixels({
  width = 128,
  height = 64,
  panels = PANELS,
  surround = SURROUND,
} = {}) {
  const pixels = new Float32Array(width * height * 4)

  for (let y = 0; y < height; y += 1) {
    // v = 0 -> dir.y = -1 (down); v = 1 -> dir.y = +1 (up). See PIXEL MAPPING.
    const v = (y + 0.5) / height
    const elevationDeg = (v - 0.5) * 180

    const bounce = FLOOR_BOUNCE.intensity *
      smoothstep(FLOOR_BOUNCE.elevationDeg + FLOOR_BOUNCE.spreadDeg, FLOOR_BOUNCE.elevationDeg, elevationDeg)

    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width
      // three: u = atan2(dir.z, dir.x) / (2*PI) + 0.5
      const azimuthDeg = (u - 0.5) * 360

      let light = bounce
      for (const panel of panels) {
        light += panel.intensity * panelCoverage(panel, azimuthDeg, elevationDeg)
      }

      const i = (y * width + x) * 4
      pixels[i] = surround[0] + light
      pixels[i + 1] = surround[1] + light
      pixels[i + 2] = surround[2] + light
      pixels[i + 3] = 1
    }
  }

  return pixels
}

export { PANELS as STUDIO_PANELS, SURROUND as STUDIO_SURROUND }

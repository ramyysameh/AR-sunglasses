import { buildDoc } from './buildDoc.js'

// A procedural eyewear-shaped point cloud, dense enough to have a Z-density
// profile. Real frames are a dense front slab with two sparse arms trailing
// back; the cliff between the two is what segmentFrontFrame keys on. The
// six-vertex fixtures in build-fixtures.mjs cannot exercise that at all.
export const FRAME_DEFAULTS = Object.freeze({
  frameWidth: 0.146,
  frontDepth: 0.012,
  frontHeight: 0.042,
  bridgeHalfWidth: 0.003,
  bridgeBarTop: 0.007,
  bridgeBarBottom: 0.017,
  hingeXRatio: 0.905,
  hingeY: -0.010,
  templeLength: 0.150,
  bandSteps: 12,
  templeSteps: 40,
})

// Positions are stored as float32, so the rearmost band row lands a hair
// BELOW the float64 -frontDepth it was computed from. A raw `z >= -frontDepth`
// boundary test therefore drops that entire row. Tests classifying vertices by
// band membership must go through this.
const BAND_EPSILON = 1e-6

export function isInFrontBand(z, frontDepth = FRAME_DEFAULTS.frontDepth) {
  return z >= -frontDepth - BAND_EPSILON
}

export function buildFramePositions(options = {}) {
  const o = { ...FRAME_DEFAULTS, ...options }
  const half = o.frameWidth / 2
  const out = []
  const push = (x, y, z) => out.push(x, y, z)

  // Front band: a dense grid over X and Z. Two vertices per (x, z) column --
  // the top and bottom edges of the frame at that x. Inside the bridge column
  // those edges are the bridge bar instead of the lens opening.
  const X_STEPS = 80
  for (let zi = 0; zi <= o.bandSteps; zi += 1) {
    const z = -(o.frontDepth * zi) / o.bandSteps
    for (let xi = 0; xi <= X_STEPS; xi += 1) {
      const x = -half + (o.frameWidth * xi) / X_STEPS
      if (Math.abs(x) <= o.bridgeHalfWidth) {
        push(x, -o.bridgeBarTop, z)
        push(x, -o.bridgeBarBottom, z)
      } else {
        push(x, 0, z)
        push(x, -o.frontHeight, z)
      }
    }
  }

  // Temples: two sparse arms running rearward from the hinge, one vertex per
  // step per side -- deliberately ~100x sparser than the band.
  const hingeX = half * o.hingeXRatio
  for (let ti = 1; ti <= o.templeSteps; ti += 1) {
    const z = -o.frontDepth - ((o.templeLength - o.frontDepth) * ti) / o.templeSteps
    push(-hingeX, o.hingeY, z)
    push(hingeX, o.hingeY, z)
  }

  return new Float32Array(out)
}

export function buildFrameDoc(options = {}, tags = {}) {
  return buildDoc(buildFramePositions(options), tags)
}

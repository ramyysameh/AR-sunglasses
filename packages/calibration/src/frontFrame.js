import { computeBounds } from './geometry.js'

// Vertices are binned by Z at a fixed real-world resolution rather than as a
// fraction of the model's Z extent: the feature being detected (the rear edge
// of the frame front) sits at a fixed millimetre depth, so a fraction-of-extent
// bin would change size with temple length -- the exact bug this replaces.
const BIN_METERS = 0.001
const MAX_BINS = 400
// A bin holding less than this share of the band's running median density is
// the cliff. The reference models collapse by 15x and 49x, so there is a wide
// margin; a tighter ratio would start firing on ordinary tessellation noise.
const CLIFF_RATIO = 0.25
// Require a few bins of band first, so a sparse leading edge (an antireflective
// coating shell, a decal plane sitting proud of the lens) cannot be mistaken
// for the whole front frame.
const MIN_BAND_BINS = 3
const MAX_SHARPNESS = 100
// A cliff must be SUSTAINED, not a one-bin hole. A frame tessellated more
// coarsely than the bin size leaves empty bins inside its own front band, and
// a single empty bin would otherwise read as the rear edge and truncate the
// band to nothing. Temples run sparse for their whole length, so a real cliff
// stays collapsed across this many bins.
const CLIFF_LOOKAHEAD_BINS = 4

// No-cliff fallback: frames whose temples blend continuously into the front
// (rimless, heavy wraparound) have no density collapse to find.
const FALLBACK_DEPTH_RATIO = 0.09
const MIN_FALLBACK_DEPTH = 0.006
const MAX_FALLBACK_DEPTH = 0.025

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function halfWidthOfBand(positions, frontZMin) {
  let halfWidth = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZMin) {
      halfWidth = Math.max(halfWidth, Math.abs(positions[i]))
    }
  }
  return halfWidth
}

export function segmentFrontFrame(positions) {
  if (positions.length === 0) {
    return { frontZMin: 0, frontZMax: 0, halfWidth: 0, sharpness: 0 }
  }

  const bounds = computeBounds(positions)
  const zRange = bounds.max.z - bounds.min.z
  const frontZMax = bounds.max.z

  // A model with no measurable depth cannot be segmented; treat the whole thing
  // as the band rather than dividing by zero.
  if (!(zRange > 0)) {
    return {
      frontZMin: bounds.min.z,
      frontZMax,
      halfWidth: halfWidthOfBand(positions, bounds.min.z),
      sharpness: 0,
    }
  }

  const binCount = Math.min(MAX_BINS, Math.max(1, Math.ceil(zRange / BIN_METERS)))
  const binSize = zRange / binCount
  const counts = new Array(binCount).fill(0)
  for (let i = 0; i < positions.length; i += 3) {
    const depth = frontZMax - positions[i + 2]
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor(depth / binSize)))
    counts[bin] += 1
  }

  for (let bin = MIN_BAND_BINS; bin < binCount; bin += 1) {
    const bandMedian = median(counts.slice(0, bin))
    if (bandMedian <= 0) continue
    const threshold = CLIFF_RATIO * bandMedian
    if (counts[bin] >= threshold) continue

    // Confirm the collapse holds. Averaging the window rather than requiring
    // every bin to be sparse keeps a lone dense bin -- a screw head, a hinge
    // barrel sitting just behind the frame -- from masking a genuine cliff.
    const windowEnd = Math.min(binCount, bin + CLIFF_LOOKAHEAD_BINS)
    let windowSum = 0
    for (let k = bin; k < windowEnd; k += 1) windowSum += counts[k]
    if (windowSum / (windowEnd - bin) >= threshold) continue

    const frontZMin = frontZMax - bin * binSize
    const sharpness = counts[bin] > 0
      ? Math.min(MAX_SHARPNESS, bandMedian / counts[bin])
      : MAX_SHARPNESS
    return { frontZMin, frontZMax, halfWidth: halfWidthOfBand(positions, frontZMin), sharpness }
  }

  const fallbackDepth = clamp(
    FALLBACK_DEPTH_RATIO * bounds.size.x,
    MIN_FALLBACK_DEPTH,
    MAX_FALLBACK_DEPTH,
  )
  const frontZMin = Math.max(bounds.min.z, frontZMax - fallbackDepth)
  return { frontZMin, frontZMax, halfWidth: halfWidthOfBand(positions, frontZMin), sharpness: 0 }
}

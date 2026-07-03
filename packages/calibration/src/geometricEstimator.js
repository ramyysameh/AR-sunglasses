import { mergedPositions } from './glbAccess.js'
import {
  computeBounds,
  measureSymmetryDeviation,
  measureFrontWidth,
  detectTemples,
} from './geometry.js'

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

export function estimateAnchors(doc, spec) {
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const width = measureFrontWidth(positions)
  const temples = detectTemples(positions)
  const symmetryDeviation = measureSymmetryDeviation(positions)

  // bridge = top-center of the front slab
  const frontZThreshold = bounds.max.z - (bounds.max.z - bounds.min.z) * 0.25
  let topY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZThreshold && positions[i + 1] > topY) topY = positions[i + 1]
  }
  const bridge = { x: 0, y: topY, z: bounds.max.z }

  // scaleSanity: 1 when width is mid-range, decaying outside the human range.
  const [minW, maxW] = spec.frameWidthRangeM
  const mid = (minW + maxW) / 2
  const scaleSanity = clamp01(1 - Math.abs(width - mid) / (mid))

  // Eyewear canonical orientation: wider in X than tall in Y, and the widest X-span
  // sits at the front slab (+Z) with temples trailing to −Z. A model rotated onto the
  // wrong axis (taller than wide) scores low so it is flagged for manual review.
  const widerThanTall = bounds.size.x > bounds.size.y ? 0.5 : 0
  const frontIsWidest = width >= bounds.size.x * 0.9 ? 0.5 : 0.2
  const orientationConfidence = clamp01(widerThanTall + frontIsWidest)

  return {
    anchors: { bridge, leftHinge: temples.leftHinge, rightHinge: temples.rightHinge },
    signals: {
      symmetryDeviation,
      templeDetectionCertainty: temples.certainty,
      frameWidthMeters: width,
      orientationConfidence,
      scaleSanity,
    },
  }
}

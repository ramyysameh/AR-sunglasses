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

  // orientationConfidence: front slab should sit toward +z and be wider (x) than
  // deep (z). Reward that shape.
  const orientationConfidence = clamp01(
    (bounds.max.z > Math.abs(bounds.min.z) ? 0.5 : 0.3) +
      (bounds.size.x > bounds.size.z ? 0.5 : 0.3)
  )

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

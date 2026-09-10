import { mergedPositions } from './glbAccess.js'
import {
  computeBounds,
  measureSymmetryDeviation,
  measureFrontWidth,
  detectTemples,
} from './geometry.js'
import { segmentFrontFrame } from './frontFrame.js'
import {
  canonicalAnchors,
  applyPrior,
  HINGE_X_RATIO,
  HINGE_Y_INSET_RATIO,
  HINGE_Z_INSET_RATIO,
} from './anchorPrior.js'

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// The bridge column: the narrow strip of front-band geometry at x ~ 0. 2% of
// frame width is ~3mm on a 146mm frame -- wide enough to catch a real bridge
// bar, narrow enough to exclude the lens openings either side of it.
const BRIDGE_COLUMN_RATIO = 0.02

// Half-width of the slab sampled around the hinge X, for the hinge Y.
const HINGE_COLUMN_RATIO = 0.02

// Vertical and depth extent of the front band within a column of X.
function columnExtent(positions, band, xCentre, xHalfSpan) {
  let yLo = Infinity
  let yHi = -Infinity
  let zRear = Infinity
  let zFront = -Infinity
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < band.frontZMin) continue
    if (Math.abs(positions[i] - xCentre) > xHalfSpan) continue
    count += 1
    yLo = Math.min(yLo, positions[i + 1])
    yHi = Math.max(yHi, positions[i + 1])
    zRear = Math.min(zRear, positions[i + 2])
    zFront = Math.max(zFront, positions[i + 2])
  }
  if (count === 0) return null
  return { yLo, yHi, yMid: (yLo + yHi) / 2, zRear, zFront, zMid: (zRear + zFront) / 2, count }
}

export function estimateAnchors(doc, spec) {
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const band = segmentFrontFrame(positions)
  const width = measureFrontWidth(positions, band)
  const temples = detectTemples(positions)
  const symmetryDeviation = measureSymmetryDeviation(positions, band)

  const prior = canonicalAnchors(width, band)

  // Bridge: the vertical centre of the bridge-bar column, at the column's own
  // depth midpoint. That depth rule is not a fitted constant -- it reproduces
  // both hand-placed bridge anchors exactly.
  const bridgeColumn = columnExtent(positions, band, 0, BRIDGE_COLUMN_RATIO * width)
  const detectedBridge = bridgeColumn
    ? { x: 0, y: bridgeColumn.yMid, z: bridgeColumn.zMid }
    : null

  // Hinges: X inset from the band's outer edge, Z just inside the density
  // cliff, Y a fixed inset below the TOP of the hinge column. The column's
  // midpoint is deliberately not used -- it swings 6-14mm with the sampling
  // span, while the top-inset holds steady.
  const hingeX = band.halfWidth * HINGE_X_RATIO
  const hingeZ = band.frontZMin + HINGE_Z_INSET_RATIO * width
  const hingeSpan = HINGE_COLUMN_RATIO * width
  const rightColumn = columnExtent(positions, band, hingeX, hingeSpan)
  const leftColumn = columnExtent(positions, band, -hingeX, hingeSpan)
  const hingeYFrom = (column) => column.yHi - HINGE_Y_INSET_RATIO * width
  const detectedRight = rightColumn
    ? { x: hingeX, y: hingeYFrom(rightColumn), z: hingeZ }
    : null
  const detectedLeft = leftColumn
    ? { x: -hingeX, y: hingeYFrom(leftColumn), z: hingeZ }
    : null

  const bridge = applyPrior(detectedBridge, prior.bridge, width)
  const rightHinge = applyPrior(detectedRight, prior.rightHinge, width)
  const leftHinge = applyPrior(detectedLeft, prior.leftHinge, width)

  // scaleSanity: 1 when width is mid-range, decaying outside the human range.
  const [minW, maxW] = spec.frameWidthRangeM
  const mid = (minW + maxW) / 2
  const scaleSanity = clamp01(1 - Math.abs(width - mid) / mid)

  // Eyewear canonical orientation: wider in X than tall in Y, and the widest
  // X-span sits at the front slab (+Z) with temples trailing to -Z. A model
  // rotated onto the wrong axis (taller than wide) scores low so it is flagged.
  const widerThanTall = bounds.size.x > bounds.size.y ? 0.5 : 0
  const frontIsWidest = width >= bounds.size.x * 0.9 ? 0.5 : 0.2
  const orientationConfidence = clamp01(widerThanTall + frontIsWidest)

  return {
    anchors: {
      bridge: bridge.anchor,
      leftHinge: leftHinge.anchor,
      rightHinge: rightHinge.anchor,
    },
    anchorSources: {
      bridge: bridge.source,
      leftHinge: leftHinge.source,
      rightHinge: rightHinge.source,
    },
    signals: {
      symmetryDeviation,
      templeDetectionCertainty: temples.certainty,
      frameWidthMeters: width,
      orientationConfidence,
      scaleSanity,
      bandSharpness: band.sharpness,
    },
  }
}

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

/**
 * Half-width of the central column searched for the nose saddle, as a fraction
 * of the frame's front width -- ~3.6 mm on a 145 mm frame.
 *
 * Deliberately narrow. Widening it does not degrade gracefully: on a frame whose
 * front is one continuous curved surface (no flat-bottomed bridge), the lowest
 * point in the column slides down the lens as the column grows, with no plateau
 * to stop at. Measured lowest-central-vertex by half-width, in mm:
 *
 *   half-width   3.0    4.0    6.0    7.3    9.0   12.0
 *   Larsson    -15.9  -16.6  -19.7  -23.9  -28.8  -36.6   <- never settles
 *   Willow      -9.9  -10.0  -10.5  -10.9  -23.8  -28.3   <- lens rim at 9.0
 *   GRIPZ      -16.7  -16.7  -17.4  -17.9  -20.0  -26.4
 *   gripzpelmo -17.3  -17.6  -18.7  -20.7  -24.7  -32.5
 *
 * Every model agrees within ~1 mm between 3 and 4 mm and lands in the upper
 * third of the frame front, which is where a nose bridge is. Beyond that they
 * diverge, so the narrow end is the only defensible choice.
 */
const SADDLE_HALF_WIDTH_RATIO = 0.025
const SADDLE_MIN_HALF_WIDTH_M = 0.003

/**
 * Widening steps, applied only when the previous one found NO geometry at all.
 * A frame built with two separate bridge arms and a gap on the centreline has
 * nothing to measure at 3.6 mm; that is rare enough to be worth a fallback and
 * common enough not to be worth guessing about.
 */
const SADDLE_WIDENING = [1, 2, 3.5]

/** Vertices within this of the lowest central point count as "on the saddle". */
const SADDLE_BAND_M = 0.002

/**
 * The nose saddle: the underside of the bridge, between the lenses. This is the
 * point a frame actually rests on, and the point the fit solver pins to the
 * face.
 *
 * The anchor this replaces was `bounds.max.y` of the front slab -- the TOP RIM
 * of the frame. Measured against the real saddle on four real models it sat
 * 10.5, 17.4, 18.7 and 19.7 mm too high, roughly half the frame height every
 * time, because a frame's top rim and its nose bridge are simply different
 * parts of the object.
 *
 * y is the lowest point of the central column. z is then the REARMOST vertex
 * within SADDLE_BAND_M of that low point: a nose touches the back of the
 * bridge, not the front face of the lenses (which is what bounds.max.z gave).
 *
 * Returns null when the frame has no geometry near the centreline at all, so
 * the caller can fall back rather than invent a point.
 */
function findNoseSaddle(positions, frontZThreshold, width) {
  const base = Math.max(SADDLE_MIN_HALF_WIDTH_M, width * SADDLE_HALF_WIDTH_RATIO)

  let halfWidth = base
  let lowestY = Infinity
  for (const step of SADDLE_WIDENING) {
    halfWidth = base * step
    lowestY = Infinity
    for (let i = 0; i < positions.length; i += 3) {
      if (Math.abs(positions[i]) > halfWidth) continue
      if (positions[i + 2] < frontZThreshold) continue
      if (positions[i + 1] < lowestY) lowestY = positions[i + 1]
    }
    if (Number.isFinite(lowestY)) break
  }
  if (!Number.isFinite(lowestY)) return null

  let rearmostZ = Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (Math.abs(positions[i]) > halfWidth) continue
    if (positions[i + 2] < frontZThreshold) continue
    if (positions[i + 1] > lowestY + SADDLE_BAND_M) continue
    if (positions[i + 2] < rearmostZ) rearmostZ = positions[i + 2]
  }

  return { x: 0, y: lowestY, z: rearmostZ }
}

export function estimateAnchors(doc, spec) {
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const width = measureFrontWidth(positions)
  const temples = detectTemples(positions)
  const symmetryDeviation = measureSymmetryDeviation(positions)

  const frontZThreshold = bounds.max.z - (bounds.max.z - bounds.min.z) * 0.25

  // bridge = the nose saddle, where the frame rests on the face. Falls back to
  // the top-centre of the front slab only when the frame has no geometry on its
  // centreline, which no real eyewear does.
  let topY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZThreshold && positions[i + 1] > topY) topY = positions[i + 1]
  }
  const bridge = findNoseSaddle(positions, frontZThreshold, width) ?? { x: 0, y: topY, z: bounds.max.z }

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

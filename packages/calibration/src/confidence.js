export const CONFIDENCE_THRESHOLD = 0.6

export const CONFIDENCE_WEIGHTS = {
  symmetry: 1.0,
  temple: 1.0,
  frameWidth: 1.0,
  orientation: 0.8,
  scale: 0.8,
  sharpness: 1.0,
}

// A density cliff steeper than this is as good as it gets. Measured cliffs on
// the reference models are 100x and 5.1x -- both genuine, and the shallower one
// still yields anchors within 1.0mm, so the bar for "a real cliff" sits low.
const SHARPNESS_SATURATION = 4

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// Convert each raw signal into a 0-1 sub-score where 1 = good.
function subScores(signals, spec) {
  const [minW, maxW] = spec.frameWidthRangeM
  // An absent sharpness signal means "not measured" (an older caller), not
  // "no cliff found" -- which is reported as an explicit 0.
  const sharpness = Number.isFinite(signals.bandSharpness)
    ? clamp01(signals.bandSharpness / SHARPNESS_SATURATION)
    : 1
  return {
    symmetry: clamp01(1 - signals.symmetryDeviation / 0.15),
    temple: clamp01(signals.templeDetectionCertainty),
    frameWidth: clamp01(1 - Math.max(0, minW - signals.frameWidthMeters, signals.frameWidthMeters - maxW) / ((maxW - minW) || 1)),
    orientation: clamp01(signals.orientationConfidence),
    scale: clamp01(signals.scaleSanity),
    sharpness,
  }
}

export function scoreConfidence(signals, spec) {
  const breakdown = subScores(signals, spec)

  // Weighted MEAN, not weighted min. Under the old min any single weak signal
  // zeroed the total, and two of these signals go weak on perfectly good
  // frames: branding decals weaken symmetry (a reference model scored exactly
  // 0.000), and temples flaring wider than the front weaken orientation.
  let weighted = 0
  let totalWeight = 0
  for (const key of Object.keys(breakdown)) {
    const weight = CONFIDENCE_WEIGHTS[key] ?? 1
    weighted += breakdown[key] * weight
    totalWeight += weight
  }
  const mean = totalWeight > 0 ? weighted / totalWeight : 0

  // Orientation keeps veto power: a model rotated onto the wrong axis
  // invalidates every other measurement, so no average should rescue it. A
  // correctly-oriented frame always scores at least 0.7 here (0.5 for being
  // wider than tall, plus 0.2), so the veto only bites the genuinely rotated.
  const overall = Math.min(mean, breakdown.orientation)
  return { overall, breakdown }
}

export function isConfident(overall) {
  return overall >= CONFIDENCE_THRESHOLD
}

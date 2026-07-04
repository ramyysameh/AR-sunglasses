export const CONFIDENCE_THRESHOLD = 0.6

export const CONFIDENCE_WEIGHTS = {
  symmetry: 1.0,
  temple: 1.0,
  frameWidth: 1.0,
  orientation: 0.8,
  scale: 0.8,
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// Convert each raw signal into a 0–1 sub-score where 1 = good.
function subScores(signals, spec) {
  const [minW, maxW] = spec.frameWidthRangeM
  return {
    symmetry: clamp01(1 - signals.symmetryDeviation / 0.15),
    temple: clamp01(signals.templeDetectionCertainty),
    frameWidth: clamp01(1 - Math.max(0, minW - signals.frameWidthMeters, signals.frameWidthMeters - maxW) / ((maxW - minW) || 1)),
    orientation: clamp01(signals.orientationConfidence),
    scale: clamp01(signals.scaleSanity),
  }
}

export function scoreConfidence(signals, spec) {
  const breakdown = subScores(signals, spec)
  // weighted-min: the lowest weighted sub-score dominates, so one bad signal caps
  // the whole thing — fail-safe and easy to explain.
  let overall = 1
  for (const key of Object.keys(breakdown)) {
    const weighted = breakdown[key] * (CONFIDENCE_WEIGHTS[key] ?? 1)
    overall = Math.min(overall, weighted)
  }
  return { overall, breakdown }
}

export function isConfident(overall) {
  return overall >= CONFIDENCE_THRESHOLD
}

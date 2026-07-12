import { readTags } from './tagReader.js'
import { estimateAnchors } from './geometricEstimator.js'
import { scoreConfidence, isConfident } from './confidence.js'
import { mergedPositions } from './glbAccess.js'
import { computeBounds, measureFrontWidth } from './geometry.js'
import { createFitMetadata } from './fitMetadata.js'

const DEFAULT_SCALE_LIMITS = { min: 0.85, max: 1.15 }

// Any real eyewear frame is well under half a metre wide. A measured frame width
// above this means the model was authored in a large coordinate space (e.g. a raw
// Blender-scene export ~3 units wide) rather than real-world metres.
const REAL_METERS_MAX_WIDTH = 0.5
// Canonical adult frame width (~145 mm) used as the reference for the natural fit.
const CANONICAL_FRAME_WIDTH_M = 0.14

// How far the render scale may swing below/above the natural fit for a
// large-coordinate model. scaleLimits are ABSOLUTE bounds the fit solver clamps
// the render scale to (scale = clamp(faceWidth / frameWidthMeters, min, max)).
// The solver derives scale from the MEASURED face width, whose world units vary
// widely by camera — a webcam and a phone report very different spans for the
// same face — so the band is deliberately wide: it only rejects extreme
// outliers, mirroring the hand-tuned built-in config for such a model
// (~{0.001, 0.5}). A tight band re-clamps the fit and mis-sizes it per device.
const LARGE_MODEL_SCALE_SPAN = { min: 0.1, max: 8 }

// For a model sized near real metres the natural fit is ~1, so the default ±15%
// band holds. For a large-coordinate model (e.g. a raw Blender-scene export ~3
// units wide) the natural fit is tiny; centre a wide band on it so the solver
// can size the model to the face instead of clamping it huge or small.
function scaleLimitsFor(width) {
  if (!(width > REAL_METERS_MAX_WIDTH)) {
    return DEFAULT_SCALE_LIMITS
  }
  const natural = CANONICAL_FRAME_WIDTH_M / width
  return { min: natural * LARGE_MODEL_SCALE_SPAN.min, max: natural * LARGE_MODEL_SCALE_SPAN.max }
}

function buildRecord(doc, anchors, width, provenance) {
  const bounds = computeBounds(mergedPositions(doc))
  return createFitMetadata({
    frameWidthMeters: width,
    bridgeAnchor: anchors.bridge,
    leftHinge: anchors.leftHinge,
    rightHinge: anchors.rightHinge,
    frontFramePlaneZ: bounds.max.z,
    lensCenterOffset: { x: 0, y: anchors.bridge.y * 0.5, z: 0 },
    scaleLimits: scaleLimitsFor(width),
    provenance,
  })
}

export function calibrate(doc, spec) {
  const tags = readTags(doc, spec)
  const width = measureFrontWidth(mergedPositions(doc))

  if (tags.found) {
    const fitMetadata = buildRecord(doc, tags.anchors, width, { source: 'tagged', confidence: null })
    return { fitMetadata, confidence: null, source: 'tagged', needsManual: false }
  }

  const { anchors, signals } = estimateAnchors(doc, spec)
  const confidence = scoreConfidence(signals, spec)
  const fitMetadata = buildRecord(doc, anchors, signals.frameWidthMeters, {
    source: 'geometric',
    confidence,
  })
  return {
    fitMetadata,
    confidence,
    source: 'geometric',
    needsManual: !isConfident(confidence.overall),
  }
}

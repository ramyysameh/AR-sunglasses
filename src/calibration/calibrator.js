import { readTags } from './tagReader.js'
import { estimateAnchors } from './geometricEstimator.js'
import { scoreConfidence, isConfident } from './confidence.js'
import { mergedPositions } from './glbAccess.js'
import { computeBounds, measureFrontWidth } from './geometry.js'
import { createFitMetadata } from './fitMetadata.js'

const DEFAULT_SCALE_LIMITS = { min: 0.85, max: 1.15 }

function buildRecord(doc, anchors, width, provenance) {
  const bounds = computeBounds(mergedPositions(doc))
  return createFitMetadata({
    frameWidthMeters: width,
    bridgeAnchor: anchors.bridge,
    leftHinge: anchors.leftHinge,
    rightHinge: anchors.rightHinge,
    frontFramePlaneZ: bounds.max.z,
    lensCenterOffset: { x: 0, y: anchors.bridge.y * 0.5, z: 0 },
    scaleLimits: DEFAULT_SCALE_LIMITS,
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

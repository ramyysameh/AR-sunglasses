import { FIT_PROFILE_VERSION } from './spec.js'

export const REQUIRED_FIELDS = [
  'frameWidthMeters',
  'bridgeAnchor',
  'leftHinge',
  'rightHinge',
  'frontFramePlaneZ',
  'lensCenterOffset',
  'scaleLimits',
  'modelScale',
  'modelBoundsCenter',
  'provenance',
]

export function createFitMetadata(fields) {
  if (typeof fields !== 'object' || fields === null) {
    throw new Error('createFitMetadata requires a fields object')
  }

  const missing = REQUIRED_FIELDS.filter((key) => fields[key] === undefined)
  if (missing.length) {
    throw new Error(`fit-metadata missing required fields: ${missing.join(', ')}`)
  }

  return {
    version: FIT_PROFILE_VERSION,
    frameWidthMeters: fields.frameWidthMeters,
    bridgeAnchor: fields.bridgeAnchor,
    leftHinge: fields.leftHinge,
    rightHinge: fields.rightHinge,
    frontFramePlaneZ: fields.frontFramePlaneZ,
    lensCenterOffset: fields.lensCenterOffset,
    scaleLimits: fields.scaleLimits,
    // Uniform factor the ENGINE must apply to the served file. The stored GLB is
    // the merchant's original, so any rescale the measurement pass needed lives
    // here as a number instead of as rewritten vertex data.
    modelScale: fields.modelScale,
    // Centre of the measured bounding box. The engine's loader re-origins every
    // model from its own bounds, so an anchor has to be expressed relative to
    // this to land in the same frame as the geometry the solver moves. See
    // fitMetadataAdapter.
    modelBoundsCenter: fields.modelBoundsCenter,
    provenance: fields.provenance,
  }
}

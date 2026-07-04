import { FIT_PROFILE_VERSION } from './spec.js'

export const REQUIRED_FIELDS = [
  'frameWidthMeters',
  'bridgeAnchor',
  'leftHinge',
  'rightHinge',
  'frontFramePlaneZ',
  'lensCenterOffset',
  'scaleLimits',
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
    provenance: fields.provenance,
  }
}

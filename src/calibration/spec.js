export const FIT_PROFILE_VERSION = 'eyewear-v1'

export const MODELING_SPEC = Object.freeze({
  units: 'meters',
  upAxis: 'y',
  frontAxis: '+z',
  symmetryAxis: 'x',
  tagNames: Object.freeze({
    bridge: 'AR_bridge',
    hingeL: 'AR_hinge_L',
    hingeR: 'AR_hinge_R',
  }),
  frameWidthRangeM: Object.freeze([0.12, 0.15]),
  maxTriangles: 150000,
})

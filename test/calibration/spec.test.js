import { describe, it, expect } from 'vitest'
import { MODELING_SPEC, FIT_PROFILE_VERSION } from '../../src/calibration/spec.js'

describe('MODELING_SPEC', () => {
  it('pins the canonical conventions', () => {
    expect(FIT_PROFILE_VERSION).toBe('eyewear-v1')
    expect(MODELING_SPEC.units).toBe('meters')
    expect(MODELING_SPEC.upAxis).toBe('y')
    expect(MODELING_SPEC.frontAxis).toBe('+z')
    expect(MODELING_SPEC.symmetryAxis).toBe('x')
    expect(MODELING_SPEC.tagNames).toEqual({
      bridge: 'AR_bridge',
      hingeL: 'AR_hinge_L',
      hingeR: 'AR_hinge_R',
    })
    expect(MODELING_SPEC.frameWidthRangeM).toEqual([0.12, 0.15])
    expect(MODELING_SPEC.maxTriangles).toBe(150000)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(MODELING_SPEC)).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { validateModel } from '../../src/calibration/validator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.02, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('validateModel', () => {
  it('passes a plausible frame', () => {
    const res = validateModel(buildDoc(goodFrame), MODELING_SPEC)
    expect(res.status).toBe('pass')
    expect(res.issues).toEqual([])
  })

  it('fails an empty document', () => {
    const res = validateModel(buildDoc([]), MODELING_SPEC)
    expect(res.status).toBe('fail')
    expect(res.issues.some((i) => i.code === 'NO_GEOMETRY')).toBe(true)
  })

  it('warns when the frame width is outside the human range', () => {
    const tooWide = goodFrame.map((v, i) => (i % 3 === 0 ? v * 4 : v))
    const res = validateModel(buildDoc(tooWide), MODELING_SPEC)
    expect(res.status).toBe('warn')
    expect(res.issues.some((i) => i.code === 'WIDTH_OUT_OF_RANGE')).toBe(true)
  })
})

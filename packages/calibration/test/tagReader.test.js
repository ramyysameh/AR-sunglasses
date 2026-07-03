import { describe, it, expect } from 'vitest'
import { readTags } from '../src/tagReader.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const frame = [-0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.02, 0.02]

describe('readTags', () => {
  it('reads all three anchor tags when present', () => {
    const doc = buildDoc(frame, {
      AR_bridge: { x: 0, y: 0.01, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const res = readTags(doc, MODELING_SPEC)
    expect(res.found).toBe(true)
    expect(res.anchors.bridge).toEqual({ x: 0, y: 0.01, z: 0.02 })
    expect(res.anchors.rightHinge.x).toBeCloseTo(0.069, 4)
  })

  it('reports not-found when tags are missing', () => {
    const res = readTags(buildDoc(frame), MODELING_SPEC)
    expect(res.found).toBe(false)
    expect(res.anchors).toBeNull()
  })

  it('reports not-found when only some tags are present', () => {
    const doc = buildDoc(frame, { AR_bridge: { x: 0, y: 0.01, z: 0.02 } })
    const res = readTags(doc, MODELING_SPEC)
    expect(res.found).toBe(false)
    expect(res.anchors).toBeNull()
  })
})

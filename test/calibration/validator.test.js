import { describe, it, expect } from 'vitest'
import { Document } from '@gltf-transform/core'
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

  it('warns when the model exceeds the poly budget', () => {
    const doc = new Document()
    const buffer = doc.createBuffer()
    const pos = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([-0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02]))
      .setBuffer(buffer)
    const indexData = new Uint32Array(450003) // 150001 triangles > 150000 budget
    for (let i = 0; i < indexData.length; i++) indexData[i] = i % 3
    const idx = doc.createAccessor().setType('SCALAR').setArray(indexData).setBuffer(buffer)
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setIndices(idx)
    const mesh = doc.createMesh('big').addPrimitive(prim)
    doc.createScene().addChild(doc.createNode('n').setMesh(mesh))
    const res = validateModel(doc, MODELING_SPEC)
    expect(res.status).toBe('warn')
    expect(res.issues.some((i) => i.code === 'OVER_POLY_BUDGET')).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { computeBounds, measureSymmetryDeviation } from '../../src/calibration/geometry.js'

// A tiny symmetric box: corners mirrored across x=0
const symmetric = new Float32Array([
  -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
])

describe('computeBounds', () => {
  it('returns min/max/size/center', () => {
    const b = computeBounds(symmetric)
    expect(b.min).toEqual({ x: -1, y: -1, z: -1 })
    expect(b.max).toEqual({ x: 1, y: 1, z: 1 })
    expect(b.size).toEqual({ x: 2, y: 2, z: 2 })
    expect(b.center).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('measureSymmetryDeviation', () => {
  it('is ~0 for a symmetric mesh', () => {
    expect(measureSymmetryDeviation(symmetric)).toBeCloseTo(0, 5)
  })

  it('grows when the mesh is shifted off the x=0 plane', () => {
    const shifted = symmetric.map((v, i) => (i % 3 === 0 ? v + 0.5 : v))
    expect(measureSymmetryDeviation(shifted)).toBeGreaterThan(0.1)
  })

  it('detects a centered-but-asymmetric mesh (no mirror counterpart)', () => {
    // center.x = 0 (min -1, max +1), but (1,1,0) has no mirror at (-1,1,0)
    const asymmetricCentered = new Float32Array([-1, 0, 0, 1, 0, 0, 1, 1, 0])
    expect(measureSymmetryDeviation(asymmetricCentered)).toBeGreaterThan(0.1)
  })
})

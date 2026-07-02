import { describe, it, expect } from 'vitest'
import { measureFrontWidth, detectTemples } from '../../src/calibration/geometry.js'

// Front slab near z=+0.02 spanning x in [-0.069, 0.069], plus two temple points
// running back to z=-0.13 at the outer x.
const frame = new Float32Array([
  -0.069, 0, 0.02, 0.069, 0, 0.02, // front outer corners
  0, 0.02, 0.02, 0, -0.02, 0.02, // bridge/top + bottom center
  -0.069, 0, -0.13, 0.069, 0, -0.13, // temple tips (rear)
])

describe('measureFrontWidth', () => {
  it('measures the front-slab X extent', () => {
    expect(measureFrontWidth(frame)).toBeCloseTo(0.138, 3)
  })
})

describe('detectTemples', () => {
  it('finds hinge points at the outer front, with high certainty', () => {
    const t = detectTemples(frame)
    expect(t.leftHinge.x).toBeLessThan(0)
    expect(t.rightHinge.x).toBeGreaterThan(0)
    expect(Math.abs(t.rightHinge.x)).toBeCloseTo(0.069, 2)
    expect(t.certainty).toBeGreaterThan(0.5)
  })

  it('reports low certainty when there are no rearward arms', () => {
    const flat = new Float32Array([
      -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.02, 0.02, 0, -0.02, 0.02,
    ])
    expect(detectTemples(flat).certainty).toBeLessThan(0.5)
  })
})

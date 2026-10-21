import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { repinSaddle } from '../../src/fit/FaceFitSolver.js'

// The aviator's own nose saddle, model units: 16 mm above the model origin.
const PIVOT = new THREE.Vector3(0, 0.0164, -0.0017)

/** Where the frame's saddle actually lands when drawn at `scale`. */
function saddleAt(position, quaternion, scale) {
  return PIVOT.clone().multiplyScalar(scale).applyQuaternion(quaternion).add(position)
}

/** What the solver does: pin the saddle on the anchor at the scale it solved. */
function solvedPosition(anchor, quaternion, solvedScale) {
  return anchor.clone().sub(PIVOT.clone().multiplyScalar(solvedScale).applyQuaternion(quaternion))
}

const turned = new THREE.Quaternion().setFromEuler(new THREE.Euler(
  THREE.MathUtils.degToRad(5), THREE.MathUtils.degToRad(42), 0, 'YXZ',
))
const anchor = new THREE.Vector3(0.01, 0.02, -0.5)

describe('repinSaddle', () => {
  it('reproduces the bug it fixes: drawn larger than solved, the saddle rides up', () => {
    // The solver's size shrinks through a turn (projected temple span), while
    // the render loop holds the frontal size -- here 0.85 solved, 1.1 drawn.
    const position = solvedPosition(anchor, turned, 0.85)
    const drawn = saddleAt(position, turned, 1.1)
    expect(drawn.y - anchor.y).toBeGreaterThan(0.003)
  })

  it('keeps the saddle on the anchor at the scale the frame is drawn at', () => {
    for (const [solved, shown] of [[0.85, 1.1], [1.2, 1.0], [1, 1]]) {
      const position = repinSaddle(solvedPosition(anchor, turned, solved), PIVOT, solved, shown, turned)
      const saddle = saddleAt(position, turned, shown)
      expect(saddle.distanceTo(anchor)).toBeLessThan(1e-9)
    }
  })

  it('changes nothing when the drawn scale is the solved one', () => {
    const position = solvedPosition(anchor, turned, 1.05)
    const before = position.clone()
    repinSaddle(position, PIVOT, 1.05, 1.05, turned)
    expect(position.distanceTo(before)).toBe(0)
  })

  it('leaves the position alone when there is no saddle or no usable scale', () => {
    const position = new THREE.Vector3(1, 2, 3)
    repinSaddle(position, null, 0.9, 1.1, turned)
    repinSaddle(position, PIVOT, NaN, 1.1, turned)
    repinSaddle(position, PIVOT, 0.9, undefined, turned)
    expect(position.toArray()).toEqual([1, 2, 3])
  })
})

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { OneEuroFilter } from '../../src/filters/OneEuroFilter.js'
import { QuaternionFilter } from '../../src/filters/QuaternionFilter.js'

describe('tracking filter velocity', () => {
  it('does not invent velocity while settling toward a held scalar sample', () => {
    const filter = new OneEuroFilter({ minCutoff: 0.5, beta: 1, dCutoff: 1 })
    filter.filter(0, 0)
    filter.filter(1, 16)
    const derivativeAfterStep = filter.dx.value
    filter.filter(1, 32)
    expect(filter.dx.value).toBeLessThan(derivativeAfterStep)
  })

  it('does not treat quaternion residual error as fresh angular motion', () => {
    const filter = new QuaternionFilter({ minCutoff: 0.5, beta: 1, dCutoff: 1 })
    const start = new THREE.Quaternion()
    const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.5)
    filter.filter(start, 0)
    filter.filter(target, 16)
    const velocityAfterStep = filter.angularVelocityFilter.dx.value
    filter.filter(target, 32)
    expect(filter.angularVelocityFilter.dx.value).toBeLessThan(velocityAfterStep)
  })
})

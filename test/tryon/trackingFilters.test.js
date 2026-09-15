import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { OneEuroFilter } from '../../src/filters/OneEuroFilter.js'
import { QuaternionFilter } from '../../src/filters/QuaternionFilter.js'
import { RenderLoop } from '../../src/core/RenderLoop.js'
import { depthFollowGain } from '../../src/fit/FaceFitSolver.js'

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

describe('moving-pose latency', () => {
  it('uses high-bandwidth filtering during deliberate motion', () => {
    const loop = Object.create(RenderLoop.prototype)
    const positionParams = []
    const rotationParams = []
    loop.positionFilter = { setParams: (value) => positionParams.push(value) }
    loop.rotationFilter = { setParams: (value) => rotationParams.push(value) }
    loop.lastRawPosition = new THREE.Vector3()
    loop.lastRawQuat = new THREE.Quaternion()
    loop.lastRawTimestamp = 0
    loop.motionLevel = 0
    loop._updateAdaptiveFilters(
      new THREE.Vector3(0.03, 0, 0),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.15),
      33,
    )
    expect(positionParams.at(-1).minCutoff).toBeGreaterThanOrEqual(18)
    expect(rotationParams.at(-1).minCutoff).toBeGreaterThanOrEqual(18)
  })

  it('opens the filter for a normal-speed head turn, not only a fast snap', () => {
    const loop = Object.create(RenderLoop.prototype)
    let rotationParams
    loop.positionFilter = { setParams() {} }
    loop.rotationFilter = { setParams: (value) => { rotationParams = value } }
    loop.lastRawPosition = new THREE.Vector3()
    loop.lastRawQuat = new THREE.Quaternion()
    loop.lastRawTimestamp = 0
    loop.motionLevel = 0
    // 0.2 rad/s is a gentle turn. It previously yielded a ~1 Hz cutoff and
    // visibly dragged; it should now leave the heavy rest filter decisively.
    loop._updateAdaptiveFilters(
      new THREE.Vector3(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.0066),
      33,
    )
    expect(rotationParams.minCutoff).toBeGreaterThan(7)
  })

  it('predicts translation by time and keeps the lead bounded', () => {
    const loop = Object.create(RenderLoop.prototype)
    loop.motionLevel = 1
    expect(loop._predictPosition(new THREE.Vector3(0, 0, 0), 0).x).toBe(0)
    const predicted = loop._predictPosition(new THREE.Vector3(0.01, 0, 0), 16)
    expect(predicted.x).toBeGreaterThan(0.02)
    expect(predicted.x).toBeLessThanOrEqual(0.045)
  })
})

describe('depth response', () => {
  it('damps off-axis landmark noise but follows real approach motion', () => {
    expect(depthFollowGain(false, 0.012, 1)).toBeCloseTo(0.02)
    expect(depthFollowGain(false, 0.08, 1)).toBeCloseTo(0.22)
    expect(depthFollowGain(true, 0.012, 1)).toBeCloseTo(0.35)
  })

  it('holds an unreliable iris estimate at extreme yaw', () => {
    expect(depthFollowGain(false, 0.08, 0)).toBe(0)
  })
})

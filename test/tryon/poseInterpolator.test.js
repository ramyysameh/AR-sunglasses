import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { PoseInterpolator } from '../../src/tracking/PoseInterpolator.js'

describe('PoseInterpolator', () => {
  it('splits a 30 Hz camera-frame translation across 60 Hz renders', () => {
    const pose = new PoseInterpolator()
    const identity = new THREE.Quaternion()
    pose.push(new THREE.Vector3(0, 0, 0), identity, 0, 1000 / 30)
    pose.push(new THREE.Vector3(1, 0, 0), identity, 1000 / 30, 1000 / 30)

    expect(pose.sample(1000 / 30).position.x).toBeCloseTo(0.5)
    expect(pose.sample(50).position.x).toBeCloseTo(1)
  })

  it('uses spherical interpolation for rotation and resets cleanly', () => {
    const pose = new PoseInterpolator()
    const identity = new THREE.Quaternion()
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    pose.push(new THREE.Vector3(), identity, 0, 1000 / 30)
    pose.push(new THREE.Vector3(), turned, 1000 / 30, 1000 / 30)

    const halfway = new THREE.Euler().setFromQuaternion(pose.sample(1000 / 30).quaternion, 'YXZ')
    expect(halfway.y).toBeCloseTo(Math.PI / 4)
    pose.reset()
    expect(pose.sample(100)).toBeNull()
  })
})

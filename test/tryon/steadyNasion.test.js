import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { SteadyNasion } from '../../src/fit/steadyNasion.js'
import { FaceFitSolver } from '../../src/fit/FaceFitSolver.js'

describe('FaceFitSolver nasion corrector', () => {
  // Proven on the CG bust only; on real faces it moves the frame the other way,
  // with no truth to say which is right. It must stay opt-in until there is.
  it('is off unless asked for', () => {
    expect(new FaceFitSolver()._steadyNasion).toBeNull()
    expect(new FaceFitSolver({ steadyNasion: true })._steadyNasion).toBeInstanceOf(SteadyNasion)
  })
})

// A rigid head, head-local metres: eye corners either side, nasion between and
// ahead of them. Values are plausible, not anatomical.
const CORNERS = [[-0.045, 0, -0.012], [-0.012, 0, -0.004], [0.012, 0, -0.004], [0.045, 0, -0.012]]
const NASION = [0, 0.006, 0.004]
const ORIGIN = new THREE.Vector3(0.01, -0.02, -0.5)

const quat = (yawDeg, pitchDeg = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(
  THREE.MathUtils.degToRad(pitchDeg), THREE.MathUtils.degToRad(yawDeg), 0, 'YXZ',
))
const place = (p, q) => new THREE.Vector3(...p).applyQuaternion(q).add(ORIGIN)
const head = (q) => ({ nasion: place(NASION, q), corners: CORNERS.map((c) => place(c, q)) })

describe('SteadyNasion', () => {
  it('passes the landmark through until it has learned the offset', () => {
    const steady = new SteadyNasion()
    const q = quat(30)
    const { nasion, corners } = head(q)
    expect(steady.update(nasion, corners, q, false).distanceTo(nasion)).toBe(0)
  })

  it('removes the landmark’s upward bias through a turn, once the correction settles', () => {
    const steady = new SteadyNasion()
    const front = quat(0, 5)
    steady.update(head(front).nasion, head(front).corners, front, true)

    // On a turn, MediaPipe reports the nasion 2 mm too high along the head's up
    // axis (measured on the probe reel); the eye corners stay put.
    for (const yaw of [15, 30, -42]) {
      const q = quat(yaw, 5)
      const truth = head(q)
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
      const reported = truth.nasion.clone().addScaledVector(up, 0.002)
      let estimate
      for (let i = 0; i < 200; i += 1) estimate = steady.update(reported, truth.corners, q, false)
      expect(estimate.distanceTo(truth.nasion)).toBeLessThan(1e-6)
    }
  })

  it('corrects only along the head’s up axis: sideways stays the landmark’s own', () => {
    const steady = new SteadyNasion()
    const front = quat(0)
    steady.update(head(front).nasion, head(front).corners, front, true)
    const q = quat(25)
    const truth = head(q)
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    const reported = truth.nasion.clone().addScaledVector(side, 0.0015)
    let estimate
    for (let i = 0; i < 200; i += 1) estimate = steady.update(reported, truth.corners, q, false)
    expect(estimate.distanceTo(reported)).toBeLessThan(1e-6)
  })

  it('damps a one-frame spike instead of passing it to the frame', () => {
    const steady = new SteadyNasion()
    const q = quat(0)
    const { nasion, corners } = head(q)
    steady.update(nasion, corners, q, true)
    for (let i = 0; i < 50; i += 1) steady.update(nasion, corners, q, false)
    // The landmark jumps 3 mm for one frame; the corners do not.
    const spike = nasion.clone().add(new THREE.Vector3(0, 0.003, 0))
    const out = steady.update(spike, corners, q, false)
    // The correction moves 10% of the way back toward the corners in one frame.
    expect(out.y - nasion.y).toBeCloseTo(0.003 * 0.9, 6)
  })

  it('averages frontal samples, so one noisy frame cannot set the offset', () => {
    const steady = new SteadyNasion()
    const q = quat(0)
    const { nasion, corners } = head(q)
    steady.update(nasion.clone().add(new THREE.Vector3(0, 0.004, 0)), corners, q, true)
    for (let i = 0; i < 39; i += 1) steady.update(nasion, corners, q, true)
    // 1 frame of 4 mm in 40: the learned offset is off by 0.1 mm.
    expect(steady.offset.y - (NASION[1] - 0)).toBeCloseTo(0.0001, 6)
  })

  it('learns only from frontal frames', () => {
    const steady = new SteadyNasion()
    const turned = quat(35)
    const { nasion, corners } = head(turned)
    steady.update(nasion.clone().add(new THREE.Vector3(0, 0.01, 0)), corners, turned, false)
    expect(steady.offset).toBeNull()
  })

  it('falls back to the landmark when an eye corner is missing', () => {
    const steady = new SteadyNasion()
    const q = quat(0)
    const { nasion, corners } = head(q)
    steady.update(nasion, corners, q, true)
    const partial = [corners[0], null, corners[2], corners[3]]
    const reported = nasion.clone().add(new THREE.Vector3(0, 0.002, 0))
    expect(steady.update(reported, partial, q, false).distanceTo(reported)).toBe(0)
  })

  it('relearns after reset (a new face)', () => {
    const steady = new SteadyNasion()
    const q = quat(0)
    const { nasion, corners } = head(q)
    steady.update(nasion, corners, q, true)
    steady.reset()
    expect(steady.offset).toBeNull()
  })
})

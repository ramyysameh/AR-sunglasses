import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  PROFILE_GUARD_DEFAULTS,
  ProfileGuard,
  landmarkTrust,
  profileSignals,
  resolveProfileGuardEnabled,
} from '../../src/tracking/profileGuard.js'
import { expRotation, intrinsicsFromFov } from '../../src/tracking/headPoseSolver.js'
import { RIGID_FACE_POINTS } from '../../src/tracking/rigidFaceModel.js'
import { RenderLoop } from '../../src/core/RenderLoop.js'

const K = intrinsicsFromFov(1280, 720, 40)
const FRAME_MS = 1000 / 30

/** Canonical rigid points plus the two cheek contour points the signals read. */
function synthFace(yawDeg, { scramble = false } = {}) {
  const R = expRotation([0, (yawDeg * Math.PI) / 180, 0])
  const T = [0, 0, 0.55]
  const points = [
    ...RIGID_FACE_POINTS.map((p) => ({ index: p.index, position: p.position })),
    { index: 234, position: [-0.0766, 0.0067, -0.0244] },
    { index: 454, position: [0.0766, 0.0067, -0.0244] },
  ]
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  for (const [i, p] of points.entries()) {
    const m = [p.position[0], -p.position[1], -p.position[2]]
    const q = [0, 1, 2].map((r) => R[r * 3] * m[0] + R[r * 3 + 1] * m[1] + R[r * 3 + 2] * m[2] + T[r])
    const jitter = scramble && i % 2 ? 0.02 * ((i % 5) - 2) : 0
    landmarks[p.index] = { x: (K.fx * (q[0] / q[2]) + K.cx) / K.width + jitter, y: (K.fy * (q[1] / q[2]) + K.cy) / K.height - jitter, z: 0 }
  }
  return landmarks
}

describe('profileSignals', () => {
  it('reads a frontal face as fully trustworthy', () => {
    const s = profileSignals(synthFace(0), K)
    expect(s.eyeRatio).toBeGreaterThan(0.95)
    expect(s.rigidRms).toBeLessThan(0.005)
    expect(s.noseOffset).toBeCloseTo(0.5, 2)
    expect(landmarkTrust(s)).toBe(1)
  })

  it('sees the far eye foreshorten as the head turns toward profile', () => {
    const quarter = profileSignals(synthFace(30), K)
    const near = profileSignals(synthFace(65), K)
    expect(quarter.eyeRatio).toBeGreaterThan(PROFILE_GUARD_DEFAULTS.eyeRatioShow)
    expect(near.eyeRatio).toBeLessThan(PROFILE_GUARD_DEFAULTS.eyeRatioHide)
    expect(landmarkTrust(near)).toBe(0)
  })

  it('flags a landmark layout no rigid head can produce, even with level eyes', () => {
    const s = profileSignals(synthFace(0, { scramble: true }), K)
    expect(s.rigidRms).toBeGreaterThan(PROFILE_GUARD_DEFAULTS.rmsHide)
    expect(landmarkTrust(s)).toBe(0)
  })
})

describe('landmarkTrust', () => {
  it('ramps between the hide and show thresholds and takes the weaker signal', () => {
    expect(landmarkTrust({ eyeRatio: 0.9, rigidRms: 0.02 })).toBe(1)
    expect(landmarkTrust({ eyeRatio: 0.5, rigidRms: 0.02 })).toBe(0)
    expect(landmarkTrust({ eyeRatio: 0.9, rigidRms: 0.06 })).toBe(0)
    const mid = landmarkTrust({ eyeRatio: 0.605, rigidRms: 0.02 })
    expect(mid).toBeGreaterThan(0.2)
    expect(mid).toBeLessThan(0.8)
  })

  it('does not veto on missing signals', () => {
    expect(landmarkTrust(null)).toBe(1)
    expect(landmarkTrust({ eyeRatio: NaN, rigidRms: NaN })).toBe(1)
  })
})

describe('ProfileGuard', () => {
  const good = { eyeRatio: 0.95, rigidRms: 0.02 }
  const bad = { eyeRatio: 0.4, rigidRms: 0.05 }

  it('fades out within the fade-out time once the landmarks go bad', () => {
    const guard = new ProfileGuard()
    let t = 0
    guard.updateFromSignals(good, t)
    let frames = 0
    while (guard.updateFromSignals(bad, (t += FRAME_MS)) > 0) frames += 1
    expect(frames * FRAME_MS).toBeLessThanOrEqual(PROFILE_GUARD_DEFAULTS.fadeOutMs)
  })

  it('comes back only after a hold, then over the fade-in time', () => {
    const guard = new ProfileGuard()
    let t = 0
    guard.updateFromSignals(bad, t)
    for (let i = 0; i < 10; i += 1) guard.updateFromSignals(bad, (t += FRAME_MS))
    expect(guard.opacity).toBe(0)
    const start = t
    guard.updateFromSignals(good, (t += FRAME_MS))
    guard.updateFromSignals(good, (t += FRAME_MS))
    expect(guard.opacity).toBe(0) // still holding
    while (guard.updateFromSignals(good, (t += FRAME_MS)) < 1) { /* fading in */ }
    const total = t - start
    expect(total).toBeGreaterThanOrEqual(PROFILE_GUARD_DEFAULTS.holdMs + PROFILE_GUARD_DEFAULTS.fadeInMs - FRAME_MS)
    expect(total).toBeLessThan(PROFILE_GUARD_DEFAULTS.holdMs + PROFILE_GUARD_DEFAULTS.fadeInMs + 3 * FRAME_MS)
  })

  it('does not flicker on a single bad frame in a good run', () => {
    const guard = new ProfileGuard()
    let t = 0
    for (let i = 0; i < 5; i += 1) guard.updateFromSignals(good, (t += FRAME_MS))
    guard.updateFromSignals(bad, (t += FRAME_MS))
    // One frame of fade-out is a dip, not a disappearance.
    expect(guard.opacity).toBeGreaterThan(0.6)
  })

  it('is opt-in from the URL', () => {
    expect(resolveProfileGuardEnabled('')).toBe(false)
    expect(resolveProfileGuardEnabled('?profileguard=0')).toBe(false)
    expect(resolveProfileGuardEnabled('?profileguard=1')).toBe(true)
  })
})

describe('RenderLoop guard opacity', () => {
  it('scales authored opacity, hides near zero, and restores exactly', () => {
    const loop = new RenderLoop({ profileGuard: null })
    const lens = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4 })
    const frame = new THREE.MeshBasicMaterial({ transparent: false, opacity: 1 })
    loop._baseOpacity = new Map([
      [lens, { opacity: 0.4, transparent: true }],
      [frame, { opacity: 1, transparent: false }],
    ])
    loop._appliedGuardOpacity = 1

    expect(loop._applyGuardOpacity(0.5)).toBe(true)
    expect(lens.opacity).toBeCloseTo(0.2)
    expect(frame.opacity).toBeCloseTo(0.5)
    expect(frame.transparent).toBe(true)

    expect(loop._applyGuardOpacity(0.01)).toBe(false)

    expect(loop._applyGuardOpacity(1)).toBe(true)
    expect(lens.opacity).toBe(0.4)
    expect(frame.opacity).toBe(1)
    expect(frame.transparent).toBe(false)
  })
})

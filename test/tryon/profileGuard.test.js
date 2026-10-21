import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  PROFILE_GUARD_DEFAULTS,
  ProfileGuard,
  faceOverrun,
  landmarkTrust,
  matrixYawDeg,
  profileSignals,
  resolveProfileGuardEnabled,
} from '../../src/tracking/profileGuard.js'
import { expRotation, intrinsicsFromFov, poseToFacialMatrix } from '../../src/tracking/headPoseSolver.js'
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

  it('records the eye ratio but does not hide on it', () => {
    // A collapsed face's layout looks like an honest ~32 degree one, so the
    // layout alone cannot tell them apart (FINDINGS.md section 9).
    const near = profileSignals(synthFace(65), K)
    expect(near.eyeRatio).toBeLessThan(0.55)
    expect(landmarkTrust(near)).toBe(1)
  })

  it("reads MediaPipe's own yaw from its matrix, either way round", () => {
    for (const yaw of [-60, -30, 0, 20, 45]) {
      const matrix = poseToFacialMatrix({ rotation: expRotation([0, (yaw * Math.PI) / 180, 0]), translation: [0, 0, 0.5] })
      expect(matrixYawDeg(matrix)).toBeCloseTo(Math.abs(yaw), 1)
    }
    const pitched = poseToFacialMatrix({ rotation: expRotation([(25 * Math.PI) / 180, 0, 0]), translation: [0, 0, 0.5] })
    expect(matrixYawDeg(pitched)).toBeLessThan(0.5)
  })
})

/**
 * A 200 px frame with an elliptical face (oval landmarks on its outline, nose
 * pointing to +x) and skin painted wherever the TRUE face is. extendRight
 * widens the painted face past the landmark oval on the nose side, which is
 * what collapsed landmarks look like against the image.
 */
function synthFrame({ extendRight = 0, background = [128, 128, 128], shiftX = 0 } = {}) {
  const W = 200
  const H = 200
  const cx = 100 + shiftX
  const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
    152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]
  const lm = Array.from({ length: 478 }, () => ({ x: cx / W, y: 0.5 }))
  OVAL.forEach((index, k) => {
    const t = (2 * Math.PI * k) / OVAL.length
    lm[index] = { x: (cx + 40 * Math.sin(t)) / W, y: (100 - 60 * Math.cos(t)) / H }
  })
  lm[234] = { x: (cx - 40) / W, y: 0.5 }
  lm[454] = { x: (cx + 40) / W, y: 0.5 }
  lm[1] = { x: (cx + 15) / W, y: 105 / H }
  lm[168] = { x: (cx + 5) / W, y: 80 / H }
  lm[5] = { x: (cx + 10) / W, y: 95 / H }
  lm[0] = { x: (cx + 8) / W, y: 125 / H }
  for (const i of [6, 197, 195]) lm[i] = { x: (cx + 2) / W, y: 88 / H }
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const rx = x >= cx ? 40 + extendRight : 40
      const inside = ((x - cx) / rx) ** 2 + ((y - 100) / 60) ** 2 <= 1
      const c = inside ? [200, 140, 110] : background
      data.set([...c, 255], (y * W + x) * 4)
    }
  }
  return { landmarks: lm, frame: { width: W, height: H, data } }
}

describe('faceOverrun', () => {
  it('reads ~0 when the landmark hull ends at the silhouette', () => {
    const { landmarks, frame } = synthFrame()
    expect(faceOverrun(landmarks, frame)).toBeLessThan(PROFILE_GUARD_DEFAULTS.overrunShow)
  })

  it('reads the face carrying on past the hull, in face heights', () => {
    const { landmarks, frame } = synthFrame({ extendRight: 24 }) // 24 px of a 120 px face
    const v = faceOverrun(landmarks, frame)
    expect(v).toBeGreaterThan(PROFILE_GUARD_DEFAULTS.overrunHide)
    expect(v).toBeLessThan(0.3)
    expect(landmarkTrust({ overrun: v })).toBe(0)
  })

  it('does not read a skin-coloured background as overrun', () => {
    const { landmarks, frame } = synthFrame({ background: [205, 142, 112] })
    expect(faceOverrun(landmarks, frame)).toBeNaN()
  })

  it('reads landmarks placed past the edge of the picture by how far past', () => {
    const { landmarks, frame } = synthFrame({ shiftX: 85 }) // hull 26 px past the right edge at the cheek
    const v = faceOverrun(landmarks, frame)
    expect(v).toBeGreaterThan(PROFILE_GUARD_DEFAULTS.overrunHide)
    expect(v).toBeLessThan(0.25)
  })

  it('does not hide a cheek that merely reaches the edge', () => {
    for (const shiftX of [56, 58, 60, 62]) {
      const { landmarks, frame } = synthFrame({ shiftX })
      expect(landmarkTrust({ overrun: faceOverrun(landmarks, frame) })).toBe(1)
    }
  })
})

describe('landmarkTrust', () => {
  it('lets an ordinary +/-45 degree turn through and hides past ~50', () => {
    expect(landmarkTrust({ yawDeg: 41, overrun: 0.01, eyeRatio: 0.4 })).toBe(1)
    expect(landmarkTrust({ yawDeg: 60, overrun: 0.01 })).toBe(0)
    const mid = landmarkTrust({ yawDeg: 48 })
    expect(mid).toBeGreaterThan(0.2)
    expect(mid).toBeLessThan(0.8)
  })

  it('takes the weaker signal', () => {
    expect(landmarkTrust({ yawDeg: 20, overrun: 0.3 })).toBe(0)
  })

  it('does not veto on missing signals', () => {
    expect(landmarkTrust(null)).toBe(1)
    expect(landmarkTrust({ yawDeg: NaN, overrun: NaN })).toBe(1)
  })
})

describe('ProfileGuard', () => {
  const good = { yawDeg: 20, overrun: 0.01 }
  const bad = { yawDeg: 70, overrun: 0.3 }

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

  it('reads the frame only once the face is turned', () => {
    const reads = []
    const { landmarks, frame } = synthFrame({ extendRight: 24 })
    const guard = new ProfileGuard({ sampler: { read: (source) => (reads.push(source), frame) } })
    guard.update(synthFace(0), K, null, 0, 'video')
    expect(reads).toHaveLength(0)
    // Give the synthetic face a foreshortened far eye, as a turned face has.
    landmarks[33] = { x: 0.40, y: 0.45 }
    landmarks[133] = { x: 0.46, y: 0.45 }
    landmarks[362] = { x: 0.54, y: 0.45 }
    landmarks[263] = { x: 0.57, y: 0.45 }
    guard.update(landmarks, K, null, FRAME_MS, 'video')
    expect(reads).toEqual(['video'])
    expect(guard.lastSignals.overrun).toBeGreaterThan(PROFILE_GUARD_DEFAULTS.overrunHide)
  })

  it('is on by default and off with ?profileguard=0', () => {
    expect(resolveProfileGuardEnabled('')).toBe(true)
    expect(resolveProfileGuardEnabled('?profileguard=1')).toBe(true)
    expect(resolveProfileGuardEnabled('?profileguard=0')).toBe(false)
  })
})

describe('overrun thresholds on real faces', () => {
  it('keeps an honest 3/4 face whose nose side reads up to 0.087', () => {
    // real-turn-kling, face well inside the picture against a warm sunset:
    // 0.05-0.087 there faded the frame to 63% and back, a visible pulse.
    expect(landmarkTrust({ yawDeg: 40, overrun: 0.087 })).toBe(1)
  })

  it('still hides a face half out of the picture (0.14 and up)', () => {
    // real-turn-hf-portrait 98-102 and 245-254 read 0.13-0.21.
    expect(landmarkTrust({ yawDeg: 45, overrun: 0.14 })).toBe(0)
  })
})

describe('RenderLoop detection dropouts', () => {
  const loopWithGlasses = () => {
    const loop = new RenderLoop({ profileGuard: null })
    loop.glassesRoot = new THREE.Group()
    loop.glassesRoot.visible = true
    loop.lastTrackingTimestamp = 1000
    return loop
  }

  it('holds the glasses through a detection miss of a frame or two', () => {
    // Alternate-frame misses as the face reaches the edge of the picture made
    // the glasses blink on and off at full opacity (real-turn-hf-portrait 240-244).
    const loop = loopWithGlasses()
    loop._hideTrackedObjects(1000 + 2 * FRAME_MS)
    expect(loop.glassesRoot.visible).toBe(true)
  })

  it('hides them once the face has really gone', () => {
    const loop = loopWithGlasses()
    loop._hideTrackedObjects(1000 + 200)
    expect(loop.glassesRoot.visible).toBe(false)
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

  // The temple arms get NEW materials after the opacities are captured: the
  // near-arm clip clones them (so clipping cannot cut a lens sharing the same
  // material) and so does its behind-the-ear remainder. Left out of the fade,
  // the guard hid the glasses and left a bare arm hanging from the ear -- seen
  // on a real ~65 degree turn at guard opacity 0.03.
  it('fades materials created after the opacities were captured, and restores them', () => {
    const loop = new RenderLoop({ profileGuard: null })
    const root = new THREE.Group()
    const front = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    const arm = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    root.add(front, arm)
    loop.glassesRoot = root
    loop._baseOpacity = new Map([[front.material, { opacity: 1, transparent: false }], [arm.material, { opacity: 1, transparent: false }]])
    loop._appliedGuardOpacity = 1

    arm.material = arm.material.clone() // what applyNearArmClip does on the first frame
    const behind = new THREE.Mesh(arm.geometry, arm.material.clone()) // its remainder
    root.add(behind)

    expect(loop._applyGuardOpacity(0.01)).toBe(false)
    expect(arm.material.opacity).toBeCloseTo(0.01)
    expect(behind.material.opacity).toBeCloseTo(0.01)

    loop._applyGuardOpacity(1)
    expect(arm.material.opacity).toBe(1)
    expect(behind.material.opacity).toBe(1)
    expect(arm.material.transparent).toBe(false)
  })
})

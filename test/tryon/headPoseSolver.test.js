import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  HeadPoseSolver,
  expRotation,
  facialMatrixToPose,
  intrinsicsFromFov,
  poseToFacialMatrix,
  rotationAngle,
  solveHeadPose,
} from '../../src/tracking/headPoseSolver.js'
import { RIGID_FACE_POINTS } from '../../src/tracking/rigidFaceModel.js'

const DEG = Math.PI / 180
const K = intrinsicsFromFov(1280, 720, 30)

function mul(a, b) {
  const out = []
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])
  }
  return out
}

/** Head rotation in solver axes (y down, z forward): yaw about y, then pitch, then roll. */
function headRotation({ yaw = 0, pitch = 0, roll = 0 }) {
  return mul(mul(expRotation([0, yaw * DEG, 0]), expRotation([pitch * DEG, 0, 0])), expRotation([0, 0, roll * DEG]))
}

/** Projects the rigid model at a known pose into a full 478-landmark array. */
function synthLandmarks(rotation, translation, { noisePx = 0, seed = 1, corrupt = {} } = {}) {
  let s = seed
  const rand = () => {
    s = (s * 16807) % 2147483647
    return s / 2147483647
  }
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  for (const p of RIGID_FACE_POINTS) {
    const m = [p.position[0], -p.position[1], -p.position[2]]
    const q = [
      rotation[0] * m[0] + rotation[1] * m[1] + rotation[2] * m[2] + translation[0],
      rotation[3] * m[0] + rotation[4] * m[1] + rotation[5] * m[2] + translation[1],
      rotation[6] * m[0] + rotation[7] * m[1] + rotation[8] * m[2] + translation[2],
    ]
    const offset = corrupt[p.index] ?? [0, 0]
    const u = K.fx * (q[0] / q[2]) + K.cx + noisePx * gauss() + offset[0]
    const v = K.fy * (q[1] / q[2]) + K.cy + noisePx * gauss() + offset[1]
    landmarks[p.index] = { x: u / K.width, y: v / K.height, z: 0 }
  }
  return landmarks
}

const T = [0.012, -0.02, 0.55]

describe('solveHeadPose', () => {
  it('recovers an exact pose from a frontal start, out to a 3/4 turn with pitch and roll', () => {
    for (const pose of [
      { yaw: 0 },
      { yaw: 45 },
      { yaw: -45, pitch: 15 },
      { pitch: -25 },
      { pitch: 25, roll: 12 },
      { yaw: 30, pitch: -20, roll: -15 },
    ]) {
      const R = headRotation(pose)
      const result = solveHeadPose(synthLandmarks(R, T), K)
      expect(result, JSON.stringify(pose)).not.toBeNull()
      expect(rotationAngle(result.rotation, R) / DEG, JSON.stringify(pose)).toBeLessThan(0.05)
      for (let i = 0; i < 3; i += 1) expect(Math.abs(result.translation[i] - T[i])).toBeLessThan(0.0005)
      expect(result.rms).toBeLessThan(0.05)
    }
  })

  it('stays within a degree under 1 px of landmark noise', () => {
    const R = headRotation({ yaw: 40, pitch: -15, roll: 5 })
    let worst = 0
    for (let seed = 1; seed <= 10; seed += 1) {
      const result = solveHeadPose(synthLandmarks(R, T, { noisePx: 1, seed }), K)
      worst = Math.max(worst, rotationAngle(result.rotation, R) / DEG)
    }
    expect(worst).toBeLessThan(1)
  })

  it('shrugs off a few grossly misplaced landmarks (Huber)', () => {
    const R = headRotation({ yaw: 25, pitch: 10 })
    const corrupt = { 117: [45, -30], 69: [-40, 25], 98: [30, 30] }
    const robust = solveHeadPose(synthLandmarks(R, T, { corrupt }), K)
    expect(rotationAngle(robust.rotation, R) / DEG).toBeLessThan(1.5)
  })

  it('ignores a far-side landmark the face has turned away from', () => {
    // At 70 degrees the far cheekbone faces away from the camera; the network
    // would be guessing it. Moving it must not move the solve.
    const R = headRotation({ yaw: 70 })
    // The points whose surface faces away from the camera at this pose.
    const away = RIGID_FACE_POINTS.filter((p) => {
      const n = [p.normal[0], -p.normal[1], -p.normal[2]]
      const m = [p.position[0], -p.position[1], -p.position[2]]
      const rn = [0, 1, 2].map((r) => R[r * 3] * n[0] + R[r * 3 + 1] * n[1] + R[r * 3 + 2] * n[2])
      const X = [0, 1, 2].map((r) => R[r * 3] * m[0] + R[r * 3 + 1] * m[1] + R[r * 3 + 2] * m[2] + T[r])
      return -(rn[0] * X[0] + rn[1] * X[1] + rn[2] * X[2]) < 0
    })
    expect(away.length).toBeGreaterThan(0)
    const init = { rotation: headRotation({ yaw: 60 }), translation: T }
    const clean = solveHeadPose(synthLandmarks(R, T), K, { init })
    const corrupt = Object.fromEntries(away.map((p) => [p.index, [60, -20]]))
    const moved = solveHeadPose(synthLandmarks(R, T, { corrupt }), K, { init })
    expect(rotationAngle(moved.rotation, clean.rotation) / DEG).toBeLessThan(0.1)
  })

  it('refuses inputs that do not contain a face', () => {
    expect(solveHeadPose([], K)).toBeNull()
    const flat = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
    expect(solveHeadPose(flat, K)).toBeNull()
  })
})

describe('facial matrix convention', () => {
  it('maps a frontal pose to an identity rotation looking down -z in centimetres', () => {
    const m = poseToFacialMatrix({ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0.01, 0.02, 0.6] })
    const matrix = new THREE.Matrix4().fromArray(m)
    const p = new THREE.Vector3()
    const q = new THREE.Quaternion()
    const s = new THREE.Vector3()
    matrix.decompose(p, q, s)
    expect(q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6)
    expect(p.x).toBeCloseTo(1, 5)
    expect(p.y).toBeCloseTo(-2, 5)
    expect(p.z).toBeCloseTo(-60, 5)
  })

  it('round-trips through the MediaPipe matrix layout, scale tolerated', () => {
    const pose = { rotation: headRotation({ yaw: 33, pitch: -12, roll: 7 }), translation: [-0.03, 0.01, 0.48] }
    const m = poseToFacialMatrix(pose)
    const scaled = Float32Array.from(m.map((v, i) => (i < 12 && i % 4 !== 3 ? v * 1.07 : v)))
    const back = facialMatrixToPose(scaled)
    expect(rotationAngle(back.rotation, pose.rotation) / DEG).toBeLessThan(1e-3)
    back.translation.forEach((v, i) => expect(v).toBeCloseTo(pose.translation[i], 5))
  })

  it('turns the same way MediaPipe does: positive solver yaw is a three.js yaw of the opposite sign', () => {
    // Solver y points down, three.js y up, so a rotation about +y in one is a
    // rotation about -y in the other.
    const m = poseToFacialMatrix({ rotation: headRotation({ yaw: 20 }), translation: [0, 0, 0.5] })
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().fromArray(m))
    const e = new THREE.Euler().setFromQuaternion(q, 'YXZ')
    expect(e.y / DEG).toBeCloseTo(-20, 4)
  })
})

/** A face that is NOT the canonical one: wider eyes, longer nose, flatter cheeks. */
function otherFace(p) {
  const [x, y, z] = [p.position[0], -p.position[1], -p.position[2]]
  return [x * 1.08, y * (y > 0 ? 1.12 : 0.95), z * 0.85]
}

function synthOther(rotation, translation) {
  const landmarks = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }))
  for (const p of RIGID_FACE_POINTS) {
    const m = otherFace(p)
    const q = [0, 1, 2].map((r) => rotation[r * 3] * m[0] + rotation[r * 3 + 1] * m[1] + rotation[r * 3 + 2] * m[2] + translation[r])
    // MediaPipe-style z: depth relative to the head, in image-width units.
    const z = ((q[2] - translation[2]) * K.fx) / (translation[2] * K.width)
    landmarks[p.index] = { x: (K.fx * (q[0] / q[2]) + K.cx) / K.width, y: (K.fy * (q[1] / q[2]) + K.cy) / K.height, z }
  }
  return landmarks
}

describe('personalisation', () => {
  it('reports MediaPipe until the frontal scan has built the wearer model, then PnP', () => {
    const solver = new HeadPoseSolver({ userModel: { frames: 5 } })
    const mp = poseToFacialMatrix({ rotation: headRotation({}), translation: T })
    for (let i = 0; i < 4; i += 1) expect(solver.solve(synthOther(headRotation({}), T), K, mp).source).toBe('mediapipe')
    solver.solve(synthOther(headRotation({}), T), K, mp)
    expect(solver.model).not.toBeNull()
    expect(solver.solve(synthOther(headRotation({ yaw: 10 }), T), K, mp).source).toBe('pnp')
  })

  it('removes the shape-mismatch error the canonical face makes off-frontal (landmark depth)', () => {
    const solver = new HeadPoseSolver({ userModel: { frames: 5 } })
    const mp = poseToFacialMatrix({ rotation: headRotation({}), translation: T })
    for (let i = 0; i < 5; i += 1) solver.solve(synthOther(headRotation({}), T), K, mp)
    for (const pose of [{ yaw: 45 }, { yaw: -40, pitch: 15 }, { pitch: -25 }]) {
      const R = headRotation(pose)
      const truthMp = poseToFacialMatrix({ rotation: R, translation: T })
      const personal = facialMatrixToPose(solver.solve(synthOther(R, T), K, truthMp).matrix).rotation
      // With the face's own depth the model is this face. Not exact: the depth
      // scale is taken from the canonical fit's distance, which the shape
      // mismatch skews a little.
      expect(rotationAngle(personal, R) / DEG, JSON.stringify(pose)).toBeLessThan(1.5)
    }
  })

  it('with canonical depth, still beats the canonical face where the shape differs across the face', () => {
    const solver = new HeadPoseSolver({ userModel: { frames: 5, depth: 'canonical' } })
    const mp = poseToFacialMatrix({ rotation: headRotation({}), translation: T })
    for (let i = 0; i < 5; i += 1) solver.solve(synthOther(headRotation({}), T), K, mp)
    for (const pose of [{ yaw: 45 }, { yaw: -40, pitch: 15 }, { pitch: -25 }]) {
      const R = headRotation(pose)
      const truthMp = poseToFacialMatrix({ rotation: R, translation: T })
      const personal = facialMatrixToPose(solver.solve(synthOther(R, T), K, truthMp).matrix).rotation
      const canonical = solveHeadPose(synthOther(R, T), K, { init: { rotation: R, translation: T } }).rotation
      // The fake face's depth is 15% shallower than canonical, which a frontal
      // scan cannot see: off-frontal turns improve, but pitch can get WORSE,
      // because real x/y over canonical depth is no longer a consistent face.
      // This is why landmark depth is the default.
      if (pose.yaw) expect(rotationAngle(personal, R)).toBeLessThan(rotationAngle(canonical, R))
      expect(rotationAngle(personal, R) / DEG, JSON.stringify(pose)).toBeLessThan(5)
    }
  })

  it('keeps the seated orientation MediaPipe reports', () => {
    const solver = new HeadPoseSolver({ userModel: { frames: 5, depth: 'canonical' } })
    // MediaPipe says the seated head is pitched 6 degrees; the personal model is
    // anchored to that, so a seated frame still comes out at 6.
    const seated = headRotation({ pitch: 6 })
    const mp = poseToFacialMatrix({ rotation: seated, translation: T })
    for (let i = 0; i < 5; i += 1) solver.solve(synthOther(headRotation({}), T), K, mp)
    const out = solver.solve(synthOther(headRotation({}), T), K, mp)
    expect(out.source).toBe('pnp')
    expect(rotationAngle(facialMatrixToPose(out.matrix).rotation, seated) / DEG).toBeLessThan(0.1)
  })
})

describe('HeadPoseSolver', () => {
  it('uses PnP when the fit is good and warm-starts the next frame', () => {
    const solver = new HeadPoseSolver({ personalize: false })
    const R = headRotation({ yaw: 30 })
    const mp = poseToFacialMatrix({ rotation: headRotation({ yaw: 20 }), translation: T })
    const first = solver.solve(synthLandmarks(R, T), K, mp)
    expect(first.source).toBe('pnp')
    expect(rotationAngle(facialMatrixToPose(first.matrix).rotation, R) / DEG).toBeLessThan(0.05)
    const second = solver.solve(synthLandmarks(headRotation({ yaw: 33 }), T), K, null)
    expect(second.source).toBe('pnp')
    expect(second.solve.iterations).toBeLessThanOrEqual(6)
  })

  it('falls back to the MediaPipe matrix when there is nothing to fit', () => {
    const solver = new HeadPoseSolver({ personalize: false })
    const mp = poseToFacialMatrix({ rotation: headRotation({ yaw: 10 }), translation: T })
    const out = solver.solve([], K, mp)
    expect(out.source).toBe('mediapipe')
    expect(out.matrix).toBe(mp)
  })

  it('falls back when PnP lands far from the network estimate', () => {
    const solver = new HeadPoseSolver({ maxDisagreementDeg: 5, personalize: false })
    const R = headRotation({ yaw: 30 })
    const mp = poseToFacialMatrix({ rotation: headRotation({ yaw: -10 }), translation: T })
    const out = solver.solve(synthLandmarks(R, T), K, mp)
    expect(out.source).toBe('mediapipe')
  })

  it('falls back when the reprojection error says the fit is not a face', () => {
    const solver = new HeadPoseSolver({ personalize: false })
    const R = headRotation({})
    // Scramble half the points: no rigid pose explains them.
    const corrupt = Object.fromEntries(RIGID_FACE_POINTS.filter((_, i) => i % 2).map((p, i) => [p.index, [((i * 37) % 90) - 45, ((i * 53) % 90) - 45]]))
    const mp = poseToFacialMatrix({ rotation: R, translation: T })
    const out = solver.solve(synthLandmarks(R, T, { corrupt }), K, mp)
    expect(out.source).toBe('mediapipe')
  })
})

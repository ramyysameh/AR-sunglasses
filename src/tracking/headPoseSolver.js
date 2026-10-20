/**
 * Rigid-landmark PnP head pose.
 *
 * MediaPipe's facialTransformationMatrixes come from a Procrustes fit of the
 * network's 3D landmarks, whose depth (z) is the network's own guess and which
 * are unprojected through a fixed internal camera rather than the real one. Both
 * errors grow off-frontal: on a realistic head-turn feed the frame slid off the
 * face at ~45 degrees of yaw and rode onto the forehead with the chin up.
 *
 * This solves the pose from the 2D landmark positions alone -- the part of the
 * network's output that is actually observed -- by fitting a fixed 3D model of
 * rigid facial points (rigidFaceModel.js) through a pinhole camera built from
 * the video's own size and field of view. It minimises reprojection error in
 * pixels with Levenberg-Marquardt over six parameters (rotation increment as an
 * axis-angle, translation), reweighting every iteration by:
 *
 *  - the point's trust (bone vs. skin that a smile moves; see the generator),
 *  - whether its surface faces the camera at the current estimate: a landmark on
 *    a surface turning away is hallucinated by the network, not seen, and is
 *    faded out before it reaches the silhouette,
 *  - a Huber loss, so one badly placed landmark cannot drag the fit.
 *
 * Coordinates: the solve runs in an OpenCV-style camera (x right, y DOWN, z
 * forward, metres). The model's canonical axes have y up and z toward the
 * camera, so a model point enters the camera as S*p with S = diag(1, -1, -1).
 * poseToFacialMatrix converts the result into MediaPipe's own matrix
 * convention, so it is a drop-in replacement for facialTransformationMatrixes.
 */
import { RIGID_FACE_POINTS } from './rigidFaceModel.js'

const DEG = Math.PI / 180

/** Outer canthus to outer canthus on the canonical face (33 <-> 263), metres. */
const CANTHUS_SPAN_M = 0.0889

export const PNP_DEFAULTS = Object.freeze({
  maxIterations: 20,
  // Huber threshold as a fraction of the outer-canthus span in pixels: ~4 px on
  // a typical webcam face. Below it a residual is treated as noise (quadratic).
  huberFraction: 0.045,
  // Facing-camera cosine at which a point is fully trusted / fully dropped.
  visibleCos: 0.35,
  hiddenCos: 0.02,
  // A fit whose RMS reprojection error exceeds this fraction of the canthus
  // span did not converge onto a face and is rejected.
  maxRmsFraction: 0.08,
  minPoints: 8,
})

// ---------------------------------------------------------------------------
// Small 3x3 helpers. Matrices are row-major arrays of 9.

function mul3(a, b) {
  const out = new Array(9)
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

function apply3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

function transpose3(m) {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
}

/** Rodrigues: axis-angle vector -> rotation matrix. */
export function expRotation(w) {
  const theta = Math.hypot(w[0], w[1], w[2])
  if (theta < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1]
  const [x, y, z] = [w[0] / theta, w[1] / theta, w[2] / theta]
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const C = 1 - c
  return [
    c + x * x * C, x * y * C - z * s, x * z * C + y * s,
    y * x * C + z * s, c + y * y * C, y * z * C - x * s,
    z * x * C - y * s, z * y * C + x * s, c + z * z * C,
  ]
}

/** Angle between two rotation matrices, radians. */
export function rotationAngle(a, b) {
  const r = mul3(transpose3(a), b)
  const cos = (r[0] + r[4] + r[8] - 1) / 2
  return Math.acos(Math.min(1, Math.max(-1, cos)))
}

/** Gram-Schmidt the rows back onto SO(3) (inputs here are already near it). */
function orthonormalize(m) {
  const a = [m[0], m[1], m[2]]
  const la = Math.hypot(...a)
  const x = a.map((v) => v / la)
  const b = [m[3], m[4], m[5]]
  const d = x[0] * b[0] + x[1] * b[1] + x[2] * b[2]
  const yRaw = [b[0] - d * x[0], b[1] - d * x[1], b[2] - d * x[2]]
  const ly = Math.hypot(...yRaw)
  const y = yRaw.map((v) => v / ly)
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
  return [...x, ...y, ...z]
}

/** Solves the 6x6 system A x = b by Gaussian elimination with partial pivoting. */
function solve6(A, b) {
  const n = 6
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col += 1) {
    let pivot = col
    for (let r = col + 1; r < n; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r
    }
    if (Math.abs(M[pivot][col]) < 1e-18) return null
    if (pivot !== col) [M[pivot], M[col]] = [M[col], M[pivot]]
    for (let r = col + 1; r < n; r += 1) {
      const f = M[r][col] / M[col][col]
      if (f === 0) continue
      for (let c = col; c <= n; c += 1) M[r][c] -= f * M[col][c]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = M[r][n]
    for (let c = r + 1; c < n; c += 1) s -= M[r][c] * x[c]
    x[r] = s / M[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// Camera and conventions

/**
 * Pinhole intrinsics for a video frame from its vertical field of view, in the
 * video's own pixels (not the display box -- the crop is a viewing choice).
 */
export function intrinsicsFromFov(width, height, vfovDeg) {
  const f = (height * 0.5) / Math.tan(vfovDeg * DEG * 0.5)
  return { fx: f, fy: f, cx: width * 0.5, cy: height * 0.5, width, height }
}

/** Canonical (y up, z toward camera) -> solver camera axes (y down, z forward). */
function toSolverAxes(v) {
  return [v[0], -v[1], -v[2]]
}

/** The canonical rigid model in solver axes. */
export const CANONICAL_MODEL = Object.freeze(RIGID_FACE_POINTS.map((p) => ({
  index: p.index,
  weight: p.weight,
  position: toSolverAxes(p.position),
  normal: toSolverAxes(p.normal),
})))

/**
 * Pose -> a 4x4 in MediaPipe's facialTransformationMatrixes convention: it maps
 * canonical-face points (centimetres, y up, z toward camera) into a camera
 * looking down -z with y up, in centimetres. Column-major, like the original.
 */
export function poseToFacialMatrix({ rotation: R, translation: t }) {
  // S R S with S = diag(1, -1, -1): flip the sign of every entry that mixes the
  // x axis with y or z.
  const m = [
    R[0], -R[1], -R[2],
    -R[3], R[4], R[5],
    -R[6], R[7], R[8],
  ]
  const tx = t[0] * 100
  const ty = -t[1] * 100
  const tz = -t[2] * 100
  return Float32Array.from([
    m[0], m[3], m[6], 0,
    m[1], m[4], m[7], 0,
    m[2], m[5], m[8], 0,
    tx, ty, tz, 1,
  ])
}

/** Inverse of poseToFacialMatrix; tolerates a uniform scale in the input. */
export function facialMatrixToPose(data) {
  if (!data || data.length < 16) return null
  const cols = [
    [data[0], data[1], data[2]],
    [data[4], data[5], data[6]],
    [data[8], data[9], data[10]],
  ].map((c) => {
    const l = Math.hypot(...c) || 1
    return c.map((v) => v / l)
  })
  const m = [
    cols[0][0], cols[1][0], cols[2][0],
    cols[0][1], cols[1][1], cols[2][1],
    cols[0][2], cols[1][2], cols[2][2],
  ]
  const R = orthonormalize([
    m[0], -m[1], -m[2],
    -m[3], m[4], m[5],
    -m[6], m[7], m[8],
  ])
  const t = [data[12] / 100, -data[13] / 100, -data[14] / 100]
  if (![...R, ...t].every(Number.isFinite)) return null
  return { rotation: R, translation: t }
}

// ---------------------------------------------------------------------------
// The solve

function observations(landmarks, K, model) {
  const obs = []
  for (const point of model) {
    const lm = landmarks?.[point.index]
    if (!lm || !Number.isFinite(lm.x) || !Number.isFinite(lm.y)) continue
    obs.push({ ...point, u: lm.x * K.width, v: lm.y * K.height })
  }
  return obs
}

/**
 * A starting pose when there is no previous frame and no MediaPipe matrix:
 * frontal, at the depth the canthus span implies, under the nasion.
 */
function initialPose(landmarks, K, model) {
  const a = landmarks?.[33]
  const b = landmarks?.[263]
  const n = landmarks?.[168]
  if (!a || !b || !n) return null
  const span = Math.hypot((a.x - b.x) * K.width, (a.y - b.y) * K.height)
  if (!(span > 1)) return null
  const z = (K.fx * CANTHUS_SPAN_M) / span
  const nasion = (model.find((p) => p.index === 168) ?? model[0]).position
  return {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [
      ((n.x * K.width - K.cx) / K.fx) * z - nasion[0],
      ((n.y * K.height - K.cy) / K.fy) * z - nasion[1],
      z - nasion[2],
    ],
  }
}

/**
 * Per-point weights at a pose: trust x facing-camera x Huber. Returned with the
 * per-point camera positions so the caller does not recompute them.
 */
function weigh(obs, R, t, K, opts, huberPx) {
  return obs.map((o) => {
    const q = apply3(R, o.position)
    const X = [q[0] + t[0], q[1] + t[1], q[2] + t[2]]
    if (!(X[2] > 1e-3)) return { q, X, w: 0, fit: 0, r: [0, 0] }
    const u = K.fx * (X[0] / X[2]) + K.cx
    const v = K.fy * (X[1] / X[2]) + K.cy
    const r = [u - o.u, v - o.v]
    const n = apply3(R, o.normal)
    const len = Math.hypot(...X)
    const facing = -(n[0] * X[0] + n[1] * X[1] + n[2] * X[2]) / len
    const visible = smoothstep(opts.hiddenCos, opts.visibleCos, facing)
    const norm = Math.hypot(r[0], r[1])
    const huber = norm <= huberPx ? 1 : huberPx / norm
    // `fit` leaves the Huber factor out: it is what the RMS acceptance test
    // reads, and a robust weight would hide exactly the residuals it must see.
    const fit = o.weight * visible
    return { q, X, w: fit * huber, fit, r }
  })
}

function cost(terms) {
  let c = 0
  for (const { w, r } of terms) c += w * (r[0] * r[0] + r[1] * r[1])
  return c
}

/**
 * Solves the head pose from one frame's landmarks.
 *
 * @param {Array<{x:number,y:number}>} landmarks MediaPipe landmarks, normalised to the video frame.
 * @param {{fx:number,fy:number,cx:number,cy:number,width:number,height:number}} K
 * @param {{ init?: {rotation:number[],translation:number[]} | null, model?: typeof CANONICAL_MODEL } & Partial<typeof PNP_DEFAULTS>} [options]
 *   `model` defaults to the canonical rigid face; HeadPoseSolver swaps in the
 *   wearer's own once it has one.
 * @returns {null | { rotation:number[], translation:number[], rms:number, rmsFraction:number, points:number, iterations:number }}
 */
export function solveHeadPose(landmarks, K, options = {}) {
  const opts = { ...PNP_DEFAULTS, ...options }
  const model = options.model ?? CANONICAL_MODEL
  const obs = observations(landmarks, K, model)
  if (obs.length < opts.minPoints) return null

  const start = options.init ?? initialPose(landmarks, K, model)
  if (!start) return null
  let R = start.rotation.slice()
  let t = start.translation.slice()

  const spanPx = () => (K.fx * CANTHUS_SPAN_M) / Math.max(t[2], 1e-3)
  let lambda = 1e-3
  let iterations = 0
  let converged = false
  let terms = weigh(obs, R, t, K, opts, opts.huberFraction * spanPx())
  let current = cost(terms)

  for (; iterations < opts.maxIterations; iterations += 1) {
    // Normal equations J^T W J dx = -J^T W r for the left-perturbed pose
    // R' = exp(w) R, t' = t + dt. With q = R p and X = q + t:
    //   dX/dw = -[q]x, dX/dt = I, and d(u,v)/dX is the pinhole Jacobian.
    const H = Array.from({ length: 6 }, () => new Array(6).fill(0))
    const g = new Array(6).fill(0)
    for (const { q, X, w, r } of terms) {
      if (!(w > 0)) continue
      const iz = 1 / X[2]
      const ju = [K.fx * iz, 0, -K.fx * X[0] * iz * iz]
      const jv = [0, K.fy * iz, -K.fy * X[1] * iz * iz]
      // Rows of -[q]x: [0, q2, -q1], [-q2, 0, q0], [q1, -q0, 0]
      const rowU = [
        ju[1] * -q[2] + ju[2] * q[1],
        ju[0] * q[2] + ju[2] * -q[0],
        ju[0] * -q[1] + ju[1] * q[0],
        ju[0], ju[1], ju[2],
      ]
      const rowV = [
        jv[1] * -q[2] + jv[2] * q[1],
        jv[0] * q[2] + jv[2] * -q[0],
        jv[0] * -q[1] + jv[1] * q[0],
        jv[0], jv[1], jv[2],
      ]
      for (let a = 0; a < 6; a += 1) {
        g[a] += w * (rowU[a] * r[0] + rowV[a] * r[1])
        for (let b = a; b < 6; b += 1) H[a][b] += w * (rowU[a] * rowU[b] + rowV[a] * rowV[b])
      }
    }
    for (let a = 0; a < 6; a += 1) for (let b = 0; b < a; b += 1) H[a][b] = H[b][a]

    let accepted = false
    for (let attempt = 0; attempt < 8 && !accepted; attempt += 1) {
      const damped = H.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (v || 1) : v)))
      const dx = solve6(damped, g.map((v) => -v))
      if (!dx) { lambda *= 10; continue }
      const R2 = orthonormalize(mul3(expRotation([dx[0], dx[1], dx[2]]), R))
      const t2 = [t[0] + dx[3], t[1] + dx[4], t[2] + dx[5]]
      // Cost compared under the CURRENT weights, so the step is judged on the
      // same objective it was computed for.
      const trial = weigh(obs, R2, t2, K, opts, opts.huberFraction * spanPx())
      const trialCost = trial.reduce((c, term, i) => {
        const w = terms[i].w
        return c + w * (term.r[0] * term.r[0] + term.r[1] * term.r[1])
      }, 0)
      if (Number.isFinite(trialCost) && trialCost <= current) {
        const step = Math.hypot(dx[0], dx[1], dx[2]) + Math.hypot(dx[3], dx[4], dx[5]) * 10
        R = R2
        t = t2
        lambda = Math.max(lambda / 10, 1e-9)
        accepted = true
        terms = weigh(obs, R, t, K, opts, opts.huberFraction * spanPx())
        current = cost(terms)
        if (step < 1e-7) converged = true
      } else {
        lambda *= 10
      }
    }
    if (!accepted || converged) {
      iterations += 1
      break
    }
  }

  let sumW = 0
  let sumSq = 0
  let used = 0
  for (const { fit, r } of terms) {
    if (!(fit > 0)) continue
    used += 1
    sumW += fit
    sumSq += fit * (r[0] * r[0] + r[1] * r[1])
  }
  const rms = sumW > 0 ? Math.sqrt(sumSq / sumW) : Infinity
  const rmsFraction = rms / spanPx()
  if (!(used >= opts.minPoints) || !Number.isFinite(rms) || ![...R, ...t].every(Number.isFinite) || !(t[2] > 0.05)) {
    return null
  }

  return { rotation: R, translation: t, rms, rmsFraction, points: used, iterations }
}

// ---------------------------------------------------------------------------

/**
 * Builds the wearer's own rigid model from frontal frames.
 *
 * The canonical face is an average face. Fitting it to a real one leaves a
 * shape mismatch the solver can only absorb by tilting the head: measured on
 * the probe bust, a 10 degree pitch offset when seated and a pitch error that
 * grew with yaw to 8 degrees at 45 -- the frame riding up and down as the head
 * turned. Frontal frames pin the shape down where it matters: each rigid
 * point's position across the face (x, y) is observed directly, almost free of
 * foreshortening. Depth is the one thing a frontal view cannot see, so each
 * point keeps the canonical face's depth relief at the solved pose.
 *
 * The result is expressed in the head frame MediaPipe reports for those same
 * frontal frames, so a seated wearer is drawn exactly as before and only the
 * off-frontal solves change.
 */
export class UserModelBuilder {
  /**
   * @param {{ frames?: number, maxFrontalDeg?: number, depth?: 'landmark' | 'canonical' }} [options]
   *   depth: where each point's depth comes from. 'landmark' (default) uses
   *   MediaPipe's per-landmark z for THIS face, relative to the nasion;
   *   'canonical' keeps the average face's relief.
   */
  constructor({ frames = 20, maxFrontalDeg = 10, depth = 'landmark' } = {}) {
    this.frames = frames
    this.depth = depth
    this.maxFrontal = maxFrontalDeg * DEG
    this.reset()
  }

  reset() {
    this.sums = new Map()
    this.count = 0
  }

  get ready() {
    return this.count >= this.frames
  }

  /**
   * Adds one frame: the canonical fit `fit` and MediaPipe's pose `reference`
   * for the same landmarks. Ignored unless both say the head is near-frontal.
   */
  add(landmarks, K, fit, reference) {
    if (!fit || !reference) return false
    // Frontal by MediaPipe's account only: the canonical fit's own angle is
    // exactly what is biased by the shape mismatch this builder removes (10
    // degrees of pitch on the probe bust), so gating on it rejects the frames
    // that need correcting most.
    if (rotationAngle(reference.rotation, [1, 0, 0, 0, 1, 0, 0, 0, 1]) > this.maxFrontal) return false
    const Rt = transpose3(reference.rotation)
    // Same head, two estimates of its orientation: carries canonical normals
    // into the reference frame.
    const toRef = mul3(Rt, fit.rotation)
    // MediaPipe's z is in units of image width; at depth Z one image-width unit
    // is width * Z / fx metres. Anchored at the nasion, which the canonical fit
    // places well (it is on the midline, where the shapes agree best).
    const nasion = landmarks?.[168]
    const nasionPoint = CANONICAL_MODEL.find((p) => p.index === 168)
    const nasionZ = apply3(fit.rotation, nasionPoint.position)[2] + fit.translation[2]
    const zScale = (K.width * nasionZ) / K.fx
    for (const point of CANONICAL_MODEL) {
      const lm = landmarks?.[point.index]
      if (!lm) continue
      const q = apply3(fit.rotation, point.position)
      const z = this.depth === 'landmark' && Number.isFinite(lm.z) && nasion && Number.isFinite(nasion.z)
        ? nasionZ + (lm.z - nasion.z) * zScale
        : q[2] + fit.translation[2]
      if (!(z > 0.05)) continue
      const X = [((lm.x * K.width - K.cx) / K.fx) * z, ((lm.y * K.height - K.cy) / K.fy) * z, z]
      const local = apply3(Rt, [X[0] - fit.translation[0], X[1] - fit.translation[1], X[2] - fit.translation[2]])
      const entry = this.sums.get(point.index) ?? { sum: [0, 0, 0], n: 0, point, normal: apply3(toRef, point.normal) }
      for (let k = 0; k < 3; k += 1) entry.sum[k] += local[k]
      entry.n += 1
      this.sums.set(point.index, entry)
    }
    this.count += 1
    return true
  }

  /** The averaged model, in the same shape as CANONICAL_MODEL. */
  build() {
    const model = []
    for (const { sum, n, point, normal } of this.sums.values()) {
      if (n < this.frames / 2) continue
      model.push({ index: point.index, weight: point.weight, position: sum.map((v) => v / n), normal })
    }
    return model.length >= PNP_DEFAULTS.minPoints ? Object.freeze(model) : null
  }
}

/**
 * Frame-to-frame wrapper: warm-starts from the previous solution, seeds from
 * MediaPipe's matrix when there is none, and falls back to that matrix when the
 * fit is not trustworthy.
 *
 * With `personalize` (the default) it first collects frontal frames into the
 * wearer's own model (UserModelBuilder) and reports MediaPipe's matrix until
 * that model exists -- the try-on's silent frontal scan covers this, so the
 * glasses never appear on an unpersonalized solve.
 */
export class HeadPoseSolver {
  constructor(options = {}) {
    this.options = { ...PNP_DEFAULTS, ...options }
    // Past this, the previous solution is no longer a sensible start.
    this.maxWarmGap = options.maxWarmGap ?? 3
    // A fit this far from MediaPipe's own estimate converged somewhere else
    // (a mirrored minimum, a wrong face): trust the network instead.
    this.maxDisagreement = options.maxDisagreementDeg != null
      ? options.maxDisagreementDeg * DEG
      : 40 * DEG
    this.personalize = options.personalize ?? true
    this.builder = new UserModelBuilder(options.userModel)
    this.model = this.personalize ? null : CANONICAL_MODEL
    this.reset()
  }

  /** Drops the frame-to-frame state. The wearer's model survives: same person. */
  reset() {
    this.previous = null
    this.missed = 0
    this.lastSolve = null
  }

  /** Forgets the wearer's model too (a different person, or a re-scan). */
  resetUserModel() {
    this.builder.reset()
    this.model = this.personalize ? null : CANONICAL_MODEL
    this.reset()
  }

  /**
   * @param {Array<{x:number,y:number}>} landmarks
   * @param {ReturnType<typeof intrinsicsFromFov>} K
   * @param {ArrayLike<number> | null} mediaPipeMatrix facialTransformationMatrixes[0].data
   * @returns {{ matrix: Float32Array | ArrayLike<number>, source: 'pnp' | 'mediapipe', solve: object | null }}
   */
  solve(landmarks, K, mediaPipeMatrix) {
    const reference = mediaPipeMatrix ? facialMatrixToPose(mediaPipeMatrix) : null

    if (!this.model) {
      const fit = solveHeadPose(landmarks, K, { ...this.options, init: reference })
      this.lastSolve = fit
      if (fit && fit.rmsFraction <= this.options.maxRmsFraction) {
        this.builder.add(landmarks, K, fit, reference)
        if (this.builder.ready) this.model = this.builder.build()
      }
      return { matrix: mediaPipeMatrix, source: 'mediapipe', solve: fit }
    }

    const warm = this.previous && this.missed <= this.maxWarmGap ? this.previous : null
    const result = solveHeadPose(landmarks, K, { ...this.options, model: this.model, init: warm ?? reference })
    this.lastSolve = result

    const trustworthy = result &&
      result.rmsFraction <= this.options.maxRmsFraction &&
      (!reference || rotationAngle(result.rotation, reference.rotation) <= this.maxDisagreement)

    if (trustworthy) {
      this.previous = { rotation: result.rotation, translation: result.translation }
      this.missed = 0
      return { matrix: poseToFacialMatrix(result), source: 'pnp', solve: result }
    }

    this.missed += 1
    if (this.missed > this.maxWarmGap) this.previous = null
    return { matrix: mediaPipeMatrix, source: 'mediapipe', solve: result }
  }
}

/**
 * Profile guard: fades the glasses out where the face landmarks stop being
 * trustworthy, as a head turns toward profile or out of the frame.
 *
 * What goes wrong, measured on the probe reels (FINDINGS.md section 9):
 *  - On a clean face, MediaPipe's pose is good to ~45 degrees of yaw, then lags
 *    the real turn smoothly -- solved 48 at a true 57, 51 at a true 72 -- and the
 *    frame's nose contact drifts 10 mm by 55 degrees, 18 mm by 70. The solved yaw
 *    still RISES the whole way, so the engine's own yaw is a usable ceiling.
 *  - On real footage, the frame floats when the face runs out of the picture:
 *    the landmarks are squeezed inside what is visible (or hallucinated past its
 *    edge) and the pose reads ~30 degrees on a face visibly at ~65. The tell is
 *    in the image, not the landmarks: on the side the nose points, the face (skin)
 *    carries on past where the landmark hull ends, or out of the frame entirely.
 *
 * Signals deliberately NOT used to hide: the far/near eye width ratio. It is a
 * statement about the landmark layout, and a collapsed face's layout looks like
 * an honest ~32 degree one -- tuned to catch the real feed, it hid 55% of an
 * ordinary +/-45 degree turn on the CG bust.
 */
import { CANONICAL_MODEL, facialMatrixToPose, solveHeadPose } from './headPoseSolver.js'

const clamp01 = (x) => Math.min(1, Math.max(0, x))
const RAD = 180 / Math.PI

/** MediaPipe's face oval, in order around the face. */
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
]
/** Rows the overrun is read on: nasion, mid-nose, nose tip, upper lip. */
const OVERRUN_ROWS = [168, 5, 1, 0]
/** Skin reference: the nose bridge, lit and skin on every face that is tracked at all. */
const SKIN_REFERENCE = [6, 197, 195]

function horizontalSpan(landmarks, a, b, width) {
  const p = landmarks?.[a]
  const q = landmarks?.[b]
  return p && q ? Math.abs(p.x - q.x) * width : NaN
}

/** |yaw| of a MediaPipe facial transformation matrix, degrees (sign-free). */
export function matrixYawDeg(mediaPipeMatrix) {
  const pose = mediaPipeMatrix ? facialMatrixToPose(mediaPipeMatrix) : null
  if (!pose) return NaN
  const R = pose.rotation
  // The head's forward axis (third column) against the camera's, in the ground plane.
  return Math.atan2(Math.abs(R[2]), Math.abs(R[8])) * RAD
}

/**
 * How far the face carries on past the landmark hull on the side the nose
 * points, in face heights (landmark 10 to 152), from a frame's pixels.
 *
 * Per row (OVERRUN_ROWS), from the hull's edge outward: the run of skin-coloured
 * pixels (against the nose bridge's colour) until three non-skin pixels in a
 * row. An honest hull ends at the silhouette, so the run is ~0. A row whose hull
 * is past the edge of the image reads how far past (the landmarks are guessing
 * at a face the camera cannot see). A row whose skin never ends within
 * `maxRun`, or runs into the image edge, is unread: a skin-coloured wall, or a
 * cheek that simply reaches the edge, says nothing about the landmarks. The
 * result is the SECOND largest read row, so one row crossing a skin-coloured
 * patch of background is not enough.
 *
 * @param {Array<{x:number,y:number}>} landmarks normalised image coordinates
 * @param {{width:number,height:number,data:Uint8ClampedArray}} frame RGBA pixels
 *        of the same image (any resolution: an ImageData of a scaled copy is fine)
 * @returns {number} NaN when it cannot be read
 */
export function faceOverrun(landmarks, frame, { maxRun = 0.3 } = {}) {
  if (!landmarks?.[152] || !frame?.data || !(frame.width > 0) || !(frame.height > 0)) return NaN
  const W = frame.width
  const H = frame.height
  const P = (i) => [landmarks[i].x * W, landmarks[i].y * H]
  const faceH = Math.hypot(P(10)[0] - P(152)[0], P(10)[1] - P(152)[1])
  if (!(faceH > 8)) return NaN
  const mid = (P(234)[0] + P(454)[0]) / 2
  const d = P(1)[0] >= mid ? 1 : -1

  const rgb = (x, y) => {
    const o = (Math.min(H - 1, Math.max(0, Math.round(y))) * W + Math.min(W - 1, Math.max(0, Math.round(x)))) * 4
    return [frame.data[o], frame.data[o + 1], frame.data[o + 2]]
  }
  const ref = [0, 0, 0]
  for (const i of SKIN_REFERENCE) {
    const [cx, cy] = P(i)
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const p = rgb(cx + dx, cy + dy)
        ref[0] += p[0]; ref[1] += p[1]; ref[2] += p[2]
      }
    }
  }
  const rs = ref[0] + ref[1] + ref[2]
  if (!(rs > 0)) return NaN
  const rr = ref[0] / rs
  const rg = ref[1] / rs
  // Same hue (chromaticity), anywhere from shadowed to highlighted.
  const isSkin = (p) => {
    const s = p[0] + p[1] + p[2]
    if (s <= 0) return false
    const lum = (s * 27) / rs // the reference summed 27 pixels
    return lum > 0.35 && lum < 2.2 && Math.abs(p[0] / s - rr) + Math.abs(p[1] / s - rg) < 0.05
  }

  const rows = []
  for (const index of OVERRUN_ROWS) {
    const y = P(index)[1]
    let edge = -Infinity
    for (let i = 0; i < landmarks.length; i += 1) {
      const p = landmarks[i]
      if (p && Math.abs(p.y * H - y) <= 0.03 * faceH) edge = Math.max(edge, d * p.x * W)
    }
    for (let k = 0; k < FACE_OVAL.length; k += 1) {
      const a = P(FACE_OVAL[k])
      const b = P(FACE_OVAL[(k + 1) % FACE_OVAL.length])
      if (a[1] === b[1] || (a[1] - y) * (b[1] - y) > 0) continue
      edge = Math.max(edge, d * (a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0])))
    }
    const hull = d * edge // back to an image x
    if (hull < 0 || hull > W - 1) {
      // Landmarks placed past the edge of the picture: the network is guessing
      // at a face it cannot see, by this much.
      rows.push((hull < 0 ? -hull : hull - (W - 1)) / faceH)
      continue
    }
    // A run that never ends is a skin-coloured background (a warm-lit beige
    // wall reads as skin), not a face: unknown, not overrun.
    let value = NaN
    let miss = 0
    const start = hull - d * 0.01 * faceH
    for (let t = 0; t <= maxRun * faceH; t += 1) {
      const x = start + d * t
      // Skin running into the edge of the picture is an ordinary face near
      // the edge, landmarks and all: unread.
      if (x < 0 || x > W - 1) break
      if (isSkin(rgb(x, y))) miss = 0
      else if (++miss >= 3) {
        value = Math.max(0, (d * (x - d * 2) - edge) / faceH)
        break
      }
    }
    rows.push(value)
  }
  const read = rows.filter(Number.isFinite).sort((a, b) => b - a)
  return read.length >= 2 ? read[1] : NaN
}

/**
 * Raw per-frame signals:
 *  - yawDeg: |yaw| of MediaPipe's own pose. Lags past ~45 but keeps rising.
 *  - overrun: faceOverrun (needs `frame`; NaN without one).
 *  - eyeRatio, noseOffset, rigidRms (reprojection error of the best rigid fit
 *    of the canonical face, as a fraction of the canthus span): recorded for
 *    diagnosis only. All three read the landmark layout, which is
 *    face-dependent -- rigidRms climbs to 0.047 on the CG bust's honest 25
 *    degree nod, past where it used to hide.
 */
export function profileSignals(landmarks, K, mediaPipeMatrix = null, frame = null) {
  const right = horizontalSpan(landmarks, 33, 133, K.width)
  const left = horizontalSpan(landmarks, 362, 263, K.width)
  const eyeRatio = Number.isFinite(right) && Number.isFinite(left) && Math.max(right, left) > 0
    ? Math.min(right, left) / Math.max(right, left)
    : NaN

  const nose = landmarks?.[1]
  const a = landmarks?.[234]
  const b = landmarks?.[454]
  const noseOffset = nose && a && b && Math.abs(b.x - a.x) > 1e-6 ? (nose.x - a.x) / (b.x - a.x) : NaN

  const init = mediaPipeMatrix ? facialMatrixToPose(mediaPipeMatrix) : null
  const fit = solveHeadPose(landmarks, K, { init, model: CANONICAL_MODEL })
  return {
    eyeRatio,
    noseOffset,
    rigidRms: fit ? fit.rmsFraction : NaN,
    yawDeg: matrixYawDeg(mediaPipeMatrix),
    overrun: frame ? faceOverrun(landmarks, frame) : NaN,
  }
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

export const PROFILE_GUARD_DEFAULTS = Object.freeze({
  yawShow: 44,
  yawHide: 52,
  // An honest 3/4 face against a warm background read up to 0.087
  // (real-turn-kling), and 0.05 faded it to 63% and back; a face half out of
  // the picture reads 0.13-0.21 (real-turn-hf-portrait).
  overrunShow: 0.09,
  overrunHide: 0.14,
  // Only read pixels once the face is visibly turned (eye ratio below this);
  // head-on, the nose side is ambiguous and nothing is out of frame.
  sampleBelowEyeRatio: 0.9,
  // Out fast, so a floating frame is barely seen; back in slower, and only
  // after the face has read trustworthy for a quarter second. A shorter hold
  // (100 ms) let a mid-turn rebound fade the frame back to ~25% on the real
  // reel, for five frames, while it was still floating.
  fadeOutMs: 90,
  fadeInMs: 250,
  holdMs: 250,
})

/** 0 (landmarks are guessing) .. 1 (trustworthy). Missing signals do not veto. */
export function landmarkTrust(signals, options = PROFILE_GUARD_DEFAULTS) {
  if (!signals) return 1
  const o = { ...PROFILE_GUARD_DEFAULTS, ...options }
  const veto = (value, show, hide) => (Number.isFinite(value) ? 1 - smoothstep(show, hide, value) : 1)
  return Math.min(
    veto(signals.yawDeg, o.yawShow, o.yawHide),
    veto(signals.overrun, o.overrunShow, o.overrunHide),
  )
}

/**
 * On by default; ?profileguard=0 turns it off (to compare against, or if a
 * deployment ever needs the old behaviour back).
 */
export function resolveProfileGuardEnabled(search = typeof window !== 'undefined' ? window.location.search : '') {
  return new URLSearchParams(search).get('profileguard') !== '0'
}

/**
 * Reads a video (or canvas) frame into a small RGBA buffer for faceOverrun.
 * Scaled to `height` rows: the signal is a run length in face heights, so a few
 * hundred rows is plenty, and the readback stays cheap.
 */
export class FrameSampler {
  constructor({ height = 270 } = {}) {
    this.height = height
    this.canvas = null
    this.ctx = null
  }

  read(source) {
    const sw = source?.videoWidth || source?.width
    const sh = source?.videoHeight || source?.height
    if (!(sw > 0) || !(sh > 0) || typeof document === 'undefined') return null
    const h = Math.min(this.height, sh)
    const w = Math.max(1, Math.round((sw * h) / sh))
    if (!this.canvas) {
      this.canvas = document.createElement('canvas')
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
    try {
      this.ctx.drawImage(source, 0, 0, w, h)
      return this.ctx.getImageData(0, 0, w, h)
    } catch {
      return null // e.g. a cross-origin source; the guard then runs without overrun
    }
  }
}

/**
 * Turns per-frame trust into a glasses opacity with an asymmetric, time-based
 * fade. Deterministic in the timestamps it is given.
 */
export class ProfileGuard {
  constructor(options = {}) {
    this.options = { ...PROFILE_GUARD_DEFAULTS, ...options }
    this.sampler = options.sampler ?? new FrameSampler()
    this.reset()
  }

  reset() {
    this.opacity = 1
    this.lastTimestamp = null
    this.trustedSince = null
    this.lastTrust = 1
    this.lastSignals = null
  }

  /**
   * @param {Array<{x:number,y:number}>} landmarks
   * @param {{fx:number,fy:number,cx:number,cy:number,width:number,height:number}} K
   * @param {ArrayLike<number> | null} mediaPipeMatrix seeds the rigid fit
   * @param {number} timestamp ms
   * @param {CanvasImageSource | null} source the frame the landmarks came from
   * @returns {number} opacity 0..1
   */
  update(landmarks, K, mediaPipeMatrix, timestamp, source = null) {
    let signals = profileSignals(landmarks, K, mediaPipeMatrix)
    if (source && signals.eyeRatio < this.options.sampleBelowEyeRatio) {
      const frame = this.sampler.read(source)
      if (frame) signals = { ...signals, overrun: faceOverrun(landmarks, frame) }
    }
    return this.updateFromSignals(signals, timestamp)
  }

  updateFromSignals(signals, timestamp) {
    const o = this.options
    const trust = landmarkTrust(signals, o)
    const dt = this.lastTimestamp == null ? 0 : Math.max(0, Math.min(timestamp - this.lastTimestamp, 250))
    this.lastTimestamp = timestamp
    this.lastTrust = trust
    this.lastSignals = signals

    if (trust < this.opacity) {
      this.trustedSince = null
      this.opacity = Math.max(trust, this.opacity - dt / o.fadeOutMs)
    } else if (trust > this.opacity) {
      this.trustedSince ??= timestamp
      if (timestamp - this.trustedSince >= o.holdMs) {
        this.opacity = Math.min(trust, this.opacity + dt / o.fadeInMs)
      }
    }
    return this.opacity
  }
}

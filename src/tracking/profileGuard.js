/**
 * Profile guard: fades the glasses out where the face landmarks stop being
 * trustworthy, as a head turns toward profile.
 *
 * Measured on a real head-turn feed: once a face passes roughly 50-60 degrees
 * of yaw, MediaPipe's 2D landmarks collapse toward the middle of the face and
 * every pose derived from them -- MediaPipe's own matrix and our PnP alike --
 * reads about half the real turn (~30 degrees on a face visibly at ~65). The
 * frame is then drawn facing the camera on a face that is not, and floats off
 * it. No solver fixes that, because the input is wrong. meta.com hides the
 * glasses there; so does this.
 *
 * The decision uses signals read from the landmarks' own layout rather than the
 * solved yaw, which is exactly what under-reads. Opt-in for now: see
 * resolveProfileGuardEnabled for why.
 */
import { CANONICAL_MODEL, facialMatrixToPose, solveHeadPose } from './headPoseSolver.js'

const clamp01 = (x) => Math.min(1, Math.max(0, x))

function horizontalSpan(landmarks, a, b, width) {
  const p = landmarks?.[a]
  const q = landmarks?.[b]
  return p && q ? Math.abs(p.x - q.x) * width : NaN
}

/**
 * Raw per-frame signals:
 *  - eyeRatio: the narrower eye's corner-to-corner width over the wider one's.
 *    1 head-on; falls as the far eye foreshortens.
 *  - noseOffset: where the nose tip sits between the two cheek contour points,
 *    0..1 (0.5 head-on); runs toward 0 or 1 as the nose nears the silhouette.
 *  - rigidRms: reprojection error of the best rigid fit of the canonical face,
 *    as a fraction of the canthus span. A layout no rigid head can produce is
 *    the network guessing.
 */
export function profileSignals(landmarks, K, mediaPipeMatrix = null) {
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
  return { eyeRatio, noseOffset, rigidRms: fit ? fit.rmsFraction : NaN }
}

function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * Thresholds, measured on the real head-turn reel (test-shots/profile-guard):
 * on frames where the frame sits on the face, eyeRatio stayed >= 0.62 and
 * rigidRms <= 0.034; where it visibly floated off, eyeRatio fell to <= 0.58 or
 * rigidRms rose past 0.037 (0.061 on a frame whose eyes still read level --
 * the case eyeRatio alone misses). noseOffset was recorded too but saturates
 * on both sides of the boundary, so it is not used.
 */
export const PROFILE_GUARD_DEFAULTS = Object.freeze({
  eyeRatioHide: 0.55,
  eyeRatioShow: 0.66,
  rmsShow: 0.034,
  rmsHide: 0.042,
  // Out fast, so a floating frame is barely seen; back in slower, and only
  // after the face has read trustworthy for a quarter second. A shorter hold
  // (100 ms) let a mid-turn rebound of the eye ratio fade the frame back to
  // ~25% on the reel, for five frames, while it was still floating.
  fadeOutMs: 90,
  fadeInMs: 250,
  holdMs: 250,
})

/** 0 (landmarks are guessing) .. 1 (trustworthy). Missing signals do not veto. */
export function landmarkTrust(signals, options = PROFILE_GUARD_DEFAULTS) {
  if (!signals) return 1
  const o = { ...PROFILE_GUARD_DEFAULTS, ...options }
  const eye = Number.isFinite(signals.eyeRatio) ? smoothstep(o.eyeRatioHide, o.eyeRatioShow, signals.eyeRatio) : 1
  const rigid = Number.isFinite(signals.rigidRms) ? 1 - smoothstep(o.rmsShow, o.rmsHide, signals.rigidRms) : 1
  return Math.min(eye, rigid)
}

/**
 * OPT-IN (?profileguard=1). Not on by default, because the signals are
 * face-dependent: on the real head-turn reel the guard cut frames drawn while
 * floating from 42 to 3 with no cost on seated frames, but on the CG probe bust
 * the same thresholds hid 55% of an ordinary +/-45 degree turn (eye ratio 0.59
 * at a true 32 degrees there, versus 0.55 for the real face's COLLAPSED landmarks
 * at ~65). A collapsed near-profile face is self-consistent: per frame, its
 * landmarks look like an honest ~32 degree face. A default-on guard needs
 * evidence beyond the landmark layout (see FINDINGS.md §8).
 */
export function resolveProfileGuardEnabled(search = typeof window !== 'undefined' ? window.location.search : '') {
  return new URLSearchParams(search).get('profileguard') === '1'
}

/**
 * Turns per-frame trust into a glasses opacity with an asymmetric, time-based
 * fade. Deterministic in the timestamps it is given.
 */
export class ProfileGuard {
  constructor(options = {}) {
    this.options = { ...PROFILE_GUARD_DEFAULTS, ...options }
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
   * @returns {number} opacity 0..1
   */
  update(landmarks, K, mediaPipeMatrix, timestamp) {
    const signals = profileSignals(landmarks, K, mediaPipeMatrix)
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

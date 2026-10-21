/**
 * The wearer's own pupillary distance, measured from the iris.
 *
 * The frame used to be sized to the FACE: its width was solved to the temple
 * span, so a 130 mm and a 150 mm frame came out about the same on anyone, and a
 * narrow face was never shown that a frame is wide on it. Measured on the mock
 * head, the aviator (148 mm) drew at 2.0x the eye spacing; true size for that
 * face is 2.36x. meta.com and Fittingbox both measure the wearer instead (see
 * FINDINGS §2 and §5).
 *
 * The human iris is close to a constant: ~11.7 mm across in adults (SD ~0.5).
 * The pupil spacing measured in iris diameters is therefore the PD in
 * millimetres, from one image, with no depth or focal length involved.
 * Horizontal iris diameter and pupil spacing both foreshorten by cos(yaw) on a
 * small turn, so their ratio holds; frames are still gated to facing forward,
 * eyes open, and both irises agreeing, because a half-closed lid or a far iris
 * behind the nose is where the iris model guesses.
 *
 * Samples go into a median over the last PD_MAX_SAMPLES. The estimate is
 * trusted once PD_MIN_SAMPLES are in and their middle half spans at most
 * PD_CONVERGED_IQR_MM -- until then the caller uses the population mean.
 */

/** Adult horizontal visible iris diameter, mm. */
export const IRIS_DIAMETER_MM = 11.7
/** Population mean adult PD, mm: used until the wearer's own has converged. */
export const DEFAULT_PD_MM = 63
/** Plausible adult range; a reading outside it is a bad sample, not a face. */
export const PD_RANGE_MM = { min: 52, max: 76 }

export const PD_MAX_SAMPLES = 90
export const PD_MIN_SAMPLES = 30
export const PD_CONVERGED_IQR_MM = 3

/** Gates on the frame a sample is taken from. */
export const PD_MAX_YAW_DEG = 10
// Looser than yaw: MediaPipe reads a level head ~5 degrees pitched, and pitch
// does not foreshorten a horizontal span.
export const PD_MAX_PITCH_DEG = 15
/** Eyelid aperture / eye width below which the eye is closing. */
export const PD_MIN_EYE_OPEN = 0.15
/** Smallest iris worth measuring, px: below it one pixel is ~10% of the reading. */
export const PD_MIN_IRIS_PX = 9
/** The two iris diameters may differ by at most this fraction. */
export const PD_MAX_IRIS_MISMATCH = 0.12

const LEFT = { center: 468, ringH: [469, 471], corners: [33, 133], lids: [159, 145] }
const RIGHT = { center: 473, ringH: [474, 476], corners: [362, 263], lids: [386, 374] }

/**
 * One PD reading from one frame of MediaPipe landmarks.
 *
 * @param {Array<{x:number,y:number}>} landmarks normalised (0-1), 478 with irises
 * @param {number} width video width, px
 * @param {number} height video height, px
 * @param {{yawDeg?: number, pitchDeg?: number}} [pose] head angles, degrees
 * @returns {{pdMm: number} | {rejected: string}}
 */
export function irisPdSample(landmarks, width, height, pose = {}) {
  if (!Array.isArray(landmarks) || landmarks.length < 478 || !(width > 0) || !(height > 0)) {
    return { rejected: 'no-iris-landmarks' }
  }
  if (Math.abs(pose.yawDeg ?? 0) > PD_MAX_YAW_DEG) return { rejected: 'turned' }
  if (Math.abs(pose.pitchDeg ?? 0) > PD_MAX_PITCH_DEG) return { rejected: 'pitched' }

  const px = (i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height })
  const dist = (a, b) => {
    const p = px(a)
    const q = px(b)
    return Math.hypot(p.x - q.x, p.y - q.y)
  }

  for (const eye of [LEFT, RIGHT]) {
    const open = dist(...eye.lids) / Math.max(dist(...eye.corners), 1e-6)
    if (open < PD_MIN_EYE_OPEN) return { rejected: 'eye-closing' }
  }
  const irisL = dist(...LEFT.ringH)
  const irisR = dist(...RIGHT.ringH)
  if (Math.min(irisL, irisR) < PD_MIN_IRIS_PX) return { rejected: 'iris-too-small' }
  if (Math.abs(irisL - irisR) / Math.max(irisL, irisR) > PD_MAX_IRIS_MISMATCH) {
    return { rejected: 'iris-mismatch' }
  }

  const pdMm = IRIS_DIAMETER_MM * dist(LEFT.center, RIGHT.center) / ((irisL + irisR) / 2)
  if (!(pdMm >= PD_RANGE_MM.min && pdMm <= PD_RANGE_MM.max)) return { rejected: 'implausible' }
  return { pdMm }
}

function quantile(sorted, q) {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo)
}

export class PupillaryDistanceEstimator {
  constructor() {
    this.samples = []
  }

  reset() {
    this.samples = []
  }

  /** @param {{pdMm?: number}} sample from irisPdSample; rejected samples are ignored */
  add(sample) {
    if (!Number.isFinite(sample?.pdMm)) return
    this.samples.push(sample.pdMm)
    if (this.samples.length > PD_MAX_SAMPLES) this.samples.shift()
  }

  /**
   * @returns {{pdMm: number, converged: boolean, samples: number, iqrMm: number|null}}
   *   pdMm is the wearer's median once converged, else DEFAULT_PD_MM
   */
  estimate() {
    const n = this.samples.length
    if (n === 0) return { pdMm: DEFAULT_PD_MM, converged: false, samples: 0, iqrMm: null }
    const sorted = [...this.samples].sort((a, b) => a - b)
    const iqrMm = quantile(sorted, 0.75) - quantile(sorted, 0.25)
    const converged = n >= PD_MIN_SAMPLES && iqrMm <= PD_CONVERGED_IQR_MM
    return { pdMm: converged ? quantile(sorted, 0.5) : DEFAULT_PD_MM, converged, samples: n, iqrMm }
  }
}

/**
 * The frame's scale for true size.
 *
 * Scale = the wearer's eye spacing AS PLACED IN THE SCENE (the two iris
 * landmarks unprojected at their own depth) over their real PD. That makes one
 * scene unit at the eyes equal one real metre, so the frame, drawn at its
 * authored metre width, lands at its physical size -- with the perspective
 * between eyes and frame left to the renderer, as it is for a real pair.
 *
 * Taken from the scene rather than from the constant the depth solve assumes:
 * that constant is not what the render camera actually shows (the depth solve
 * and the cover-cropped display use different conventions), and assuming it
 * drew the mock head's frame at 2.21x the eye spacing instead of the true 2.36x.
 *
 * @param {number} sceneEyeSpacing distance between the irises in scene units
 * @param {number} pdMm the wearer's PD
 * @returns {number} scale (before the merchant's size multiplier)
 */
export function trueSizeScale(sceneEyeSpacing, pdMm) {
  return sceneEyeSpacing / (pdMm / 1000)
}

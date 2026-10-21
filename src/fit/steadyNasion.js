/**
 * The nasion, carried by the eye corners through head turns.
 *
 * Saddle-anchored frames sit on MediaPipe landmark 168. Facing the camera that
 * landmark is right; turned, it is not -- and neither is the rest of the nose.
 * Scored against the probe reel's truth (the bust surface under each landmark
 * on a frontal frame, carried through every truth pose), the whole nose ridge
 * (168, 6, 197, 195, 5, 4, 1) reads 1.8-2.9 mm HIGH at 12-46 degrees of yaw,
 * while the four eye corners (33, 133, 362, 263) average 0.3-0.8 mm. The corners
 * also beat 168 on every other segment of the reel: nod 0.43 vs 1.37 mm mean
 * (1.8 vs 6.6 worst), lighting 0.59 vs 2.58, shake 0.34 vs 1.77.
 *
 * So the nasion is measured where 168 is good -- frontal -- as an offset from
 * the eye corners in the head's own frame, and carried through turns by the
 * corners and the head rotation. The corners, not the irises: an iris follows
 * gaze, and someone turning to look at a mirror moves their eyes too.
 *
 * Frontal samples feed a capped running mean, like the frame's size estimate:
 * a face's shape does not change, so every good frontal sample estimates the
 * same constant, and the cap still lets a new face take over.
 *
 * Only the HEAD-VERTICAL part of that estimate is used, and it is low-passed.
 * Taking the whole corner-carried point was measured first and traded one error
 * for two: the corners sit behind the nasion, so the 2-3 degrees MediaPipe
 * over-rotates a turn swung the point 2.0-2.6 mm sideways at 12-38 degrees (from
 * 0.6-1.0), and rotation noise on that lever arm put jitter on a still head
 * (pose gate still-drift 0.33 -> 0.58 mm, over its 0.5 limit). 168 is good
 * sideways; it is only biased up. So the landmark keeps its own position and is
 * corrected along the head's up axis by a smoothed scalar: the bias moves with
 * the head's angle, slowly, not with every frame.
 *
 * OPT-IN (?steadynasion=1), because it is only proven on the CG bust. On the
 * two real-face reels (no truth) it moves the frame the OTHER way -- UP, by 2-5
 * px at 5-30 degrees on real-turn-hf-portrait (9.4 px peak) and 1.1-1.7 px on
 * real-turn-kling-portrait (4.4 px peak). Either MediaPipe's nose errs
 * differently on real faces, or the corners do; without real-face truth there is
 * no telling which, so it ships switched off, for comparing on a phone.
 */
import * as THREE from 'three'

/** Outer and inner corners of both eyes. */
export const EYE_CORNER_LANDMARKS = [33, 133, 362, 263]

/** Frontal samples the offset averages over. */
export const NASION_OFFSET_SAMPLES = 120

/** Per-frame easing of the vertical correction toward its latest estimate. */
export const NASION_CORRECTION_ALPHA = 0.1

export class SteadyNasion {
  constructor() {
    /** @type {THREE.Vector3|null} head-local nasion minus eye-corner centroid */
    this.offset = null
    /** Smoothed correction along the head's up axis, metres (+ = move up). */
    this.correction = 0
    this._count = 0
    this._eyes = new THREE.Vector3()
    this._local = new THREE.Vector3()
    this._up = new THREE.Vector3()
    this._inverse = new THREE.Quaternion()
  }

  reset() {
    this.offset = null
    this.correction = 0
    this._count = 0
  }

  /**
   * @param {THREE.Vector3} nasion landmark 168 in world space
   * @param {Array<THREE.Vector3|null>} corners EYE_CORNER_LANDMARKS in world space
   * @param {THREE.Quaternion} quaternion the head rotation the frame is drawn with
   * @param {boolean} frontal whether this frame may teach the offset
   * @returns {THREE.Vector3} the nasion to anchor on: the landmark until an offset
   *   is learned or when a corner is missing, else the landmark moved along the
   *   head's up axis by the smoothed vertical difference to corners + R*offset
   */
  update(nasion, corners, quaternion, frontal) {
    if (!nasion || !quaternion || !Array.isArray(corners) || corners.length === 0 || corners.some((c) => !c)) {
      return nasion
    }
    const eyes = this._eyes.set(0, 0, 0)
    for (const c of corners) eyes.add(c)
    eyes.multiplyScalar(1 / corners.length)

    if (frontal) {
      const local = this._local.copy(nasion).sub(eyes).applyQuaternion(this._inverse.copy(quaternion).invert())
      this._count = Math.min(this._count + 1, NASION_OFFSET_SAMPLES)
      if (!this.offset) this.offset = local.clone()
      else this.offset.add(local.sub(this.offset).multiplyScalar(1 / this._count))
    }

    if (!this.offset) return nasion
    const carried = this.offset.clone().applyQuaternion(quaternion).add(eyes)
    const up = this._up.set(0, 1, 0).applyQuaternion(quaternion)
    const target = carried.sub(nasion).dot(up)
    this.correction += (target - this.correction) * NASION_CORRECTION_ALPHA
    return nasion.clone().addScaledVector(up, this.correction)
  }
}

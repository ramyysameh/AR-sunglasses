/**
 * The head's own fore-aft frame, shared by the renderer and the probe.
 *
 * It lives here rather than in the probe because BOTH need it and they must
 * agree: the near temple is cut at the ear plane by the renderer and measured
 * against the ear plane by the metric, and when those were two different planes
 * -- the renderer using the pose quaternion's +Z, the probe using this -- they
 * sat about 29 degrees apart, and the arm the metric scored was not the arm the
 * renderer drew.
 */
import * as THREE from 'three'

/** Face-oval extremes, at the tragion. */
export const EAR_LANDMARKS = [234, 454]
/** Outer eye corners; tragion-to-canthus is close to the head's horizontal. */
export const EYE_LANDMARKS = [33, 263]
/** Nose tip: used ONLY to choose the sign of the fore-aft axis. */
export const NOSE_LANDMARK = 1

/**
 * The head's fore-aft frame, origin on the EAR PLANE, axis near-horizontal.
 *
 * The axis is the mean of the two EAR-TO-EYE vectors with the lateral component
 * projected out. Tragion to outer canthus runs close to the anatomical
 * horizontal, which is the property being bought here: the depth coordinate
 * must not absorb a sample's HEIGHT, because a temple arm rides ~50 mm above the
 * ear plane and any tilt in the axis turns that offset into depth.
 *
 * Two earlier versions of this got it wrong in the same direction:
 *
 *   ear midpoint -> nose tip      the nose sits well below the ear line, so the
 *                                 axis tilted ~30 degrees down and every arm on
 *                                 every model read as comfortably behind the
 *                                 ear. One frame reported its end 17 mm PAST
 *                                 the ear plane while the render plainly showed
 *                                 the arm stopping 27 px in front of the tragion.
 *   cross(lateral, brow -> chin)  better, but the forehead and chin are at
 *                                 different depths, so the vertical it is built
 *                                 from leans and ~5% of the height leaks back
 *                                 in -- 2.6 mm on a temple, 0.015 of a span.
 *
 * Each eye is paired with whichever ear is nearer, so the landmark convention
 * does not have to be assumed. The nose is used only for its SIGN: it says which
 * way out of the face is forward.
 *
 * @param {THREE.Vector3} earA tragion, one side (234)
 * @param {THREE.Vector3} earB tragion, other side (454)
 * @param {THREE.Vector3} eyeA outer canthus (33)
 * @param {THREE.Vector3} eyeB outer canthus (263)
 * @param {THREE.Vector3} nose nose tip (1), for orientation only
 * @param {{origin: THREE.Vector3, forward: THREE.Vector3}} [out] reusable output
 * @returns {{origin: THREE.Vector3, forward: THREE.Vector3, span: number} | null}
 */
export function headFrame(earA, earB, eyeA, eyeB, nose, out = {}) {
  const span = earA.distanceTo(earB)
  if (!(span > 0)) return null

  const origin = (out.origin ?? new THREE.Vector3()).addVectors(earA, earB).multiplyScalar(0.5)
  const forward = out.forward ?? new THREE.Vector3()

  const lateral = new THREE.Vector3().subVectors(earB, earA).normalize()
  const sameSide = earA.distanceToSquared(eyeA) <= earA.distanceToSquared(eyeB)
  forward
    .subVectors(sameSide ? eyeA : eyeB, earA)
    .add(new THREE.Vector3().subVectors(sameSide ? eyeB : eyeA, earB))
    .multiplyScalar(0.5)
  // Strip the sideways part, so the axis lies square across the head.
  forward.addScaledVector(lateral, -forward.dot(lateral))
  if (!(forward.lengthSq() > 0)) return null
  forward.normalize()

  if (forward.dot(new THREE.Vector3().subVectors(nose, origin)) < 0) forward.negate()

  return { origin, forward, span }
}

import * as THREE from 'three'
import { coverNDC } from './coverMap.js'

const DEFAULT_MIN_DEPTH = -1.8
const DEFAULT_MAX_DEPTH = -0.22
const DEFAULT_FALLBACK_DEPTH = -0.72
const DEFAULT_LANDMARK_DEPTH_SCALE = 0.08
// Depth relief applied to the occluder mesh so the cheeks/jaw bulge forward and
// actually mask the temple arms. Tunable: bigger = more pronounced 3D face shell.
/**
 * How much of the face's real depth relief the occluder mesh keeps.
 *
 * This was 0.45 -- the face flattened to under half its true depth -- and that
 * is why the FAR temple stayed visible through every head turn. Measured at 38
 * degrees of yaw: 100% of the far temple's pixels landed inside the occluder's
 * silhouette, yet only 1% were hidden, because flattening pulls the protruding
 * near-side features back toward the mean plane until they no longer sit in
 * front of an arm passing behind them. The occluder covered the right pixels
 * and lost the depth test.
 *
 * Glasses are NOT flattened, so anything below 1 shrinks the face's relief
 * relative to the frame it has to mask. Now a MULTIPLIER on the metric
 * conversion in landmarkDepthToMetres, so 1.0 means "the face's true depth"
 * rather than an arbitrary fraction. ?occdepth=<n> overrides for tuning.
 */
const DEFAULT_OCCLUDER_DEPTH_SCALE = 1.0

let _occluderDepthScale = null

function occluderDepthScale() {
  if (_occluderDepthScale == null) {
    const raw = typeof window !== 'undefined'
      ? parseFloat(new URLSearchParams(window.location.search).get('occdepth'))
      : NaN
    _occluderDepthScale = Number.isFinite(raw) && raw >= 0 && raw <= 3
      ? raw
      : DEFAULT_OCCLUDER_DEPTH_SCALE
  }

  return _occluderDepthScale
}

// Past this, one iris is occluded by the nose and the IPD estimate is noise
// rather than a foreshortened measurement -- cos would keep shrinking (and
// double the noise gain doing it), so clamp and let the hold below carry it.
const MAX_YAW_DEPTH_CORRECTION = Math.PI / 3 // 60 degrees

// Where the IPD depth estimate stops being a measurement. Both values are
// measured, not guessed -- see the `trust` comment in solve().
const IRIS_RELIABLE_YAW_DEG = 32
const IRIS_USELESS_YAW_DEG = 42

// Fraction of the way from bridgeTop (landmark 168) toward browCenter (9) that
// the frame anchor sits. See the frameAnchorXY comment for why this is a blend
// between landmarks rather than an offset in metres. 0.5 was picked on a real
// face over ?vlift=, bracketed against 0.4 (rim on the brow line) and 0.8 (rim
// over the brows) -- not derived, so re-tune with ?vlift if a frame reads low.
const DEFAULT_VERTICAL_LIFT = 0.5

/** Scratch for the forward-axis clearance offset; solve() runs every frame. */
const FORWARD = new THREE.Vector3()

function finiteVector3(vector) {
  return vector &&
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
}

function validDepth(depth) {
  return Number.isFinite(depth) && depth < DEFAULT_MAX_DEPTH && depth > DEFAULT_MIN_DEPTH
}

/**
 * Metres per unit of MediaPipe landmark z, at a given depth.
 *
 * Landmark z is NOT metric: it is normalised on roughly the same scale as x,
 * i.e. as a fraction of the image width. Subtracting it from a depth in metres
 * with a dimensionless fudge factor -- which is what this file did for a long
 * time -- measures the face and the glasses in two different spaces, and no
 * value of that factor is right at more than one camera distance.
 *
 * One normalised unit spans the full frame width, which at distance d is
 * 2*tan(fov/2)*d*aspect metres. Converting with that puts the occluder's relief
 * in the same units as everything else and scales correctly with distance.
 */
function landmarkDepthToMetres(camera, baseDepth) {
  const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
  return 2 * Math.tan(halfFov) * Math.abs(baseDepth) * nativeAspectOf(camera)
}

function anchorToWorld(anchor, camera, baseDepth, depthScale = DEFAULT_LANDMARK_DEPTH_SCALE) {
  if (!anchor || !camera?.isPerspectiveCamera) {
    return null
  }

  const depth = THREE.MathUtils.clamp(
    baseDepth - (anchor.z ?? 0) * depthScale,
    DEFAULT_MIN_DEPTH,
    DEFAULT_MAX_DEPTH
  )
  const distance = Math.abs(depth)
  const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
  const halfHeight = Math.tan(halfFov) * distance
  const halfWidth = halfHeight * camera.aspect
  const { ndcX, ndcY } = coverNDC(anchor, camera)

  return new THREE.Vector3(ndcX * halfWidth, ndcY * halfHeight, depth)
}

function anchorToWorldXY(anchor, camera, metricDepth) {
  if (!anchor || !camera?.isPerspectiveCamera) return null

  const distance = Math.abs(metricDepth)
  const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
  const halfHeight = Math.tan(halfFov) * distance
  const halfWidth = halfHeight * camera.aspect
  const { ndcX, ndcY } = coverNDC(anchor, camera)

  return new THREE.Vector3(ndcX * halfWidth, ndcY * halfHeight, metricDepth)
}

// Real (native) camera aspect -- the video's own intrinsic resolution, fixed
// per device/session and unaffected by how big or what shape the CSS display
// container is. Falls back to the render camera's aspect only if video
// dimensions aren't available yet (startup).
function nativeAspectOf(camera) {
  return camera?._videoW > 0 && camera?._videoH > 0
    ? camera._videoW / camera._videoH
    : camera?.aspect ?? 1
}

// Unprojects a RAW MediaPipe landmark (normalized to the native video frame)
// into metric world coordinates for MEASURING real-world size -- deliberately
// NOT going through coverNDC. coverNDC answers "where does this land on the
// display AFTER the object-fit:cover crop", which is exactly the wrong space
// for a physical measurement: the crop is a CSS/viewing choice with zero
// bearing on how far apart two points on a real face actually are. Using the
// display's aspect ratio here (as anchorToWorldXY does, correctly, for
// on-screen positioning) previously made the computed face width -- and
// therefore the glasses' scale -- change depending on the shape of whatever
// box the try-on happened to be rendered in (phone vs. desktop dialog vs.
// full tab), independent of the actual person's face or distance from the
// camera. Mirroring here matches coverNDC's selfie-view convention.
function anchorToMetricXY(anchor, camera, metricDepth) {
  if (!anchor || !camera?.isPerspectiveCamera) return null

  const distance = Math.abs(metricDepth)
  const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
  const halfHeight = Math.tan(halfFov) * distance
  const halfWidth = halfHeight * nativeAspectOf(camera)
  const ndcX = -(anchor.x * 2 - 1)
  const ndcY = -(anchor.y * 2 - 1)

  return new THREE.Vector3(ndcX * halfWidth, ndcY * halfHeight, metricDepth)
}

function decomposeMatrix(matrix) {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()

  matrix?.decompose?.(position, quaternion, scale)

  return { position, quaternion, scale }
}

/**
 * Blends between two world points, tolerating either being missing.
 * @returns {THREE.Vector3 | null}
 */
function lerpWorld(from, to, t) {
  if (!finiteVector3(from)) {
    return finiteVector3(to) ? to.clone() : null
  }
  if (!finiteVector3(to) || !(t > 0)) {
    return from.clone()
  }

  return from.clone().lerp(to, THREE.MathUtils.clamp(t, 0, 1))
}

let _verticalLift = null

/**
 * How far to lift the frame anchor from bridgeTop toward browCenter.
 * ?vlift=<0..1> overrides for live tuning on a phone, like ?gscale / ?voffset.
 */
function verticalLift(fallback = DEFAULT_VERTICAL_LIFT) {
  if (_verticalLift === null) {
    const raw = typeof window !== 'undefined'
      ? parseFloat(new URLSearchParams(window.location.search).get('vlift'))
      : NaN
    _verticalLift = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : undefined
  }

  return _verticalLift ?? fallback
}

function estimateMetricDepth(leftIris, rightIris, camera, realIPD_m = 0.063) {
  if (!leftIris || !rightIris || !camera?.isPerspectiveCamera) return null

  // Native video pixels (NOT the display box) -- must match the aspect
  // convention anchorToMetricXY uses for face WIDTH. This formula reduces to
  // a function of aspect ratio only (the pw/ph magnitude cancels out), so
  // using a DIFFERENT aspect here than in the width calculation doesn't just
  // change noise characteristics, it changes the absolute depth magnitude fed
  // into anchorToMetricXY's halfHeight -- undersizing the glasses even though
  // width alone was "fixed" (confirmed live: mixing conventions shrank
  // everything back down). The native aspect is more sensitive to ordinary
  // per-frame MediaPipe landmark noise than the old display aspect was, which
  // showed up as nose-bridge jitter -- fixed at the source by smoothing the
  // frontal case below (this file previously had NO damping there), not by
  // reintroducing a mismatched aspect.
  const pw = camera._videoW
  const ph = camera._videoH
  if (!pw || !ph || pw <= 0 || ph <= 0) return null

  // Normalized IPD (0-1 space, as MediaPipe outputs)
  const dxNorm = leftIris.x - rightIris.x
  const dyNorm = leftIris.y - rightIris.y
  // Convert to pixel space using the SAME dimensions used for focal length
  // focal length must be computed in the same pixel space as ipdPixels
  const ipdPixels = Math.sqrt(dxNorm * dxNorm * pw * pw + dyNorm * dyNorm * ph * ph)

  if (!Number.isFinite(ipdPixels) || ipdPixels < 8) return null

  // focalLength in pixels — must use same pw/ph as above
  const focalLength = (ph * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5)

  const metricDepth = -(realIPD_m * focalLength) / ipdPixels
  return THREE.MathUtils.clamp(metricDepth, DEFAULT_MIN_DEPTH, DEFAULT_MAX_DEPTH)
}

function span(a, b) {
  if (!a || !b) return 0

  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = (a.z ?? 0) - (b.z ?? 0)

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function weightedWorldFaceWidth({ leftTemple, rightTemple, leftCheek, rightCheek, leftIris, rightIris }) {
  const templeSpan = span(leftTemple, rightTemple)
  const cheekSpan = span(leftCheek, rightCheek)
  const irisSpan = span(leftIris, rightIris)
  const weightedSpan = templeSpan * 0.5 + cheekSpan * 0.3 + irisSpan * 0.2

  return Number.isFinite(weightedSpan) && weightedSpan > 0 ? weightedSpan : 0
}

export class FaceFitSolver {
  constructor(options = {}) {
    this.landmarkDepthScale = options.landmarkDepthScale ?? DEFAULT_LANDMARK_DEPTH_SCALE
    this.fallbackDepth = options.fallbackDepth ?? DEFAULT_FALLBACK_DEPTH
    this._smoothForeshorten = null
    this._heldDepth = null
  }

  /**
   * @param {{ pose?: any, landmarks?: any, faceMatrix?: any, scanProfile?: any, skuFitMetadata?: any, camera?: any }} [input]
   */
  solve({ pose, landmarks, faceMatrix, scanProfile, skuFitMetadata, camera } = {}) {
    if (!pose?.anchorPoints || !faceMatrix || !scanProfile?.isReady) {
      return null
    }

    const { position: matrixPosition, quaternion } = decomposeMatrix(faceMatrix)
    
    const ipdDepth = estimateMetricDepth(
      pose.anchorPoints?.leftIris,
      pose.anchorPoints?.rightIris,
      camera,
      0.076
    )
    const headEuler = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ')

    // Yaw foreshortens the (horizontal) iris span by cos(yaw), so the IPD
    // distance estimate inflates by 1/cos(yaw) and the frame recedes through
    // every turn. Undo that projection term geometrically rather than trying to
    // hold the depth still: the hold below is an EMA, and easing toward a
    // BIASED estimate just walks to the bias more slowly -- measured at ~11 mm
    // of recede front-to-turned, 45 mm of range across one oscillation, even
    // with the hold engaged. Correcting the input instead means a genuine
    // distance change (leaning in mid-turn) still registers.
    //
    // Pitch deliberately does NOT get the same treatment: rotating about X does
    // not foreshorten a horizontal segment at all, so there is no cos term to
    // undo. Its effect is the eyelid occluding the iris, which is not a
    // projection artefact -- that stays the frontal gate's job below.
    const yawForeshorten = Math.cos(
      THREE.MathUtils.clamp(headEuler.y, -MAX_YAW_DEPTH_CORRECTION, MAX_YAW_DEPTH_CORRECTION)
    )
    const rawDepth = ipdDepth != null
      ? ipdDepth * yawForeshorten
      : (validDepth(matrixPosition.z) ? matrixPosition.z : this.fallbackDepth)

    // Hold the distance steady while off-frontal; only re-estimate near-frontal.
    // Doing this at the source keeps x, y and z consistent (no recede, no
    // forward pop). Originally yaw-only -- pitch was missed, so looking down
    // still jittered (confirmed live).
    // The hold stays SLOW off-frontal on both axes, and that is load-bearing.
    //
    // Tried and reverted: letting yaw track the (now bias-corrected) estimate at
    // a yaw-scaled gain, on the theory that a 0.02 EMA is what made the frame
    // lag differently depending on travel direction. Measured the opposite --
    // depth spread went from 85 mm SD to 12 mm SD when the slow hold came back,
    // and while it was fast the frame visibly pulsed in size through every turn,
    // because scale is derived from this depth. Off-axis iris landmarks are
    // noisy enough that the hold is doing real work, independent of the bias the
    // cos correction above removes. Don't re-raise this gain without measuring
    // the z spread across a full turn.
    const frontalDepth = Math.abs(headEuler.y) < THREE.MathUtils.degToRad(5) &&
      Math.abs(headEuler.x) < THREE.MathUtils.degToRad(5)

    // How far to trust the IPD estimate at this yaw, measured rather than
    // assumed. Holding depth against a fully-settled frontal reference, the
    // estimate is FLAT within 1.4% out to ~32 degrees and then falls off a
    // cliff: +5% at 38, +22% at 45, +41% at 51. That is not foreshortening --
    // foreshortening is a smooth cosine, and the cos correction above already
    // removes it. It is the far iris disappearing behind the nose, after which
    // the apparent IPD collapses and there is no measurement left to correct.
    //
    // So the gain falls to zero across that band and the last good depth simply
    // holds. A slow non-zero gain is not a safe middle ground: at 0.02 per frame
    // it still converges ~70% of the way to a bad number in a couple of seconds
    // of held pose, which is exactly how a 121 mm recede accumulated.
    const yawDeg = Math.abs(THREE.MathUtils.radToDeg(headEuler.y))
    const trust = 1 - THREE.MathUtils.smoothstep(yawDeg, IRIS_RELIABLE_YAW_DEG, IRIS_USELESS_YAW_DEG)
    if (this._heldDepth == null) {
      this._heldDepth = rawDepth
    } else if (frontalDepth) {
      // Light EMA instead of snapping straight to rawDepth -- the native-video
      // aspect estimateMetricDepth now uses (matching anchorToMetricXY, see
      // above) is more sensitive to ordinary per-frame MediaPipe landmark
      // noise than the old display-aspect version was, which showed up as
      // visible nose-bridge jitter. Still responsive to real distance changes
      // (moving closer/farther) within a few frames, just not frame-instant.
      this._heldDepth += (rawDepth - this._heldDepth) * 0.35 * trust
    } else {
      this._heldDepth += (rawDepth - this._heldDepth) * 0.02 * trust
    }
    const baseDepth = this._heldDepth

    // IPD depth is measured at eye level; nose bridge is slightly forward
    const noseBridgeDepth = baseDepth + 0.022

    const anchorWorldPoints = Object.fromEntries(
      Object.entries(pose.anchorPoints).map(([key, anchor]) => [
        key,
        anchorToWorldXY(anchor, camera,
          (key === 'bridgeCenter' || key === 'bridgeTop' || key === 'noseTip')
            ? noseBridgeDepth
            : baseDepth
        ),
      ])
    )
    // Metric (native-camera, display-independent) counterparts of the points
    // that drive SIZE below (templeSpan/irisSpan/worldFaceWidth) -- see
    // anchorToMetricXY. Position above correctly keeps using anchorWorldPoints,
    // which needs the display's own aspect to land on the right screen pixel.
    const metricPoints = Object.fromEntries(
      ['leftTemple', 'rightTemple', 'leftIris', 'rightIris', 'leftCheek', 'rightCheek'].map((key) => [
        key,
        anchorToMetricXY(pose.anchorPoints[key], camera, baseDepth),
      ])
    )
    // Give the occluder real depth (cheeks/nose forward, jaw/ears back) instead of
    // a flat billboard, so temple arms passing behind the cheeks get masked.
    const faceWorldPoints = Array.isArray(landmarks)
      ? landmarks.map((landmark) => anchorToWorld(landmark, camera, baseDepth, landmarkDepthToMetres(camera, baseDepth) * occluderDepthScale()))
      : []
    // The nose bridge at its REAL depth, using the same per-landmark mapping the
    // occluder above uses.
    //
    // anchorWorldPoints places every anchor on a FLAT plane -- bridgeTop included,
    // at baseDepth + 22 mm, identical at every head angle. The occluder gives the
    // same landmark its own depth. So the frame and the face disagree about where
    // the skin is, and the disagreement moves with pitch: measured on a nod sweep,
    // the frame's nose saddle travelled 33 mm along the head's forward axis
    // (+22.8 mm ahead of the sellion looking up, 10.7 mm BEHIND it looking down)
    // and the bridge ended up 23.6 mm inside the nose at the bottom of the nod.
    //
    // Same bug class as the landmark-depth unit error and the yaw foreshortening:
    // a single scalar standing in for a quantity that actually varies.
    const bridgeSurfaceWorld = pose.anchorPoints?.bridgeTop
      ? anchorToWorld(pose.anchorPoints.bridgeTop, camera, baseDepth, landmarkDepthToMetres(camera, baseDepth))
      : null

    const bridgeWorld = anchorWorldPoints.bridgeCenter ?? anchorWorldPoints.bridgeTop
    const irisWorld = anchorWorldPoints.irisCenter
    const leftTemple = anchorWorldPoints.leftTemple
    const rightTemple = anchorWorldPoints.rightTemple
    const leftCheek = anchorWorldPoints.leftCheek
    const rightCheek = anchorWorldPoints.rightCheek
    const leftIris = anchorWorldPoints.leftIris
    const rightIris = anchorWorldPoints.rightIris
    const browTop = anchorWorldPoints.bridgeTop ?? anchorWorldPoints.browCenter

    // Anchor where the bridge meets the nose. This used to average in the iris
    // and brow landmarks, but those swing far more than the bridge when the head
    // pitches, dragging the anchor off the bridge -- so it became bridgeCenter
    // (landmark 6, mid-nose). That sat every frame visibly low, confirmed on a
    // real face: each calibrated model measured so far authors AR_bridge at
    // ~80% of frame height, so roughly four fifths of the frame hangs BELOW
    // whatever point this lands on, and mid-nose is already below the nasion.
    //
    // So: start at bridgeTop (landmark 168, the nasion) and lift a fraction of
    // the way toward browCenter (landmark 9, between the brows). A blend of two
    // landmarks rather than an offset in metres, on purpose -- it scales with
    // face size and camera distance for free, where a fixed constant would be
    // right at exactly one distance and one head size. browCenter sits on the
    // skull between the brows, not on the brow ridge, so this does not bring
    // back the pitch swing that pushed the old iris/brow average out.
    // Saddle-anchored models pin the frame's OWN nose saddle to the face, so the
    // anchor is the nose bridge itself (lift 0) rather than a blend up toward the
    // brow. The blend exists in the legacy path to compensate for placing the
    // model's bounding-box centre, which is not a point on the frame at all.
    const saddleAnchored = skuFitMetadata?.anchorMode === 'saddle'
    const frameAnchorXY = lerpWorld(
      browTop,
      anchorWorldPoints.browCenter,
      verticalLift(saddleAnchored ? 0 : DEFAULT_VERTICAL_LIFT)
    )
    const frameAnchor = new THREE.Vector3(
      frameAnchorXY?.x ?? matrixPosition.x,
      frameAnchorXY?.y ?? matrixPosition.y,
      noseBridgeDepth
    )

    if (!finiteVector3(frameAnchor)) {
      return null
    }

    const localBridgePivot = skuFitMetadata?.bridgePivot ?? new THREE.Vector3()
    const localLensCenter = skuFitMetadata?.lensCenterOffset ?? new THREE.Vector3()

    // Rotate the frame about its nose-bridge CONTACT point (a little behind the
    // front of the frame) rather than the model origin, so the contact stays glued
    // to the nose as the head pitches/turns.
    //   (I - R)·pivot is zero when facing forward, so the approved head-on
    //   placement is unchanged; it only engages under rotation.
    const rotatedPivot = localBridgePivot.clone().applyQuaternion(quaternion)
    const pivotCorrection = localBridgePivot.clone().sub(rotatedPivot)
    const lensCorrection = localLensCenter.clone().multiplyScalar(-1).applyQuaternion(quaternion)
    const targetPosition = frameAnchor.clone().add(pivotCorrection).add(lensCorrection)
    
    const surfaceDepth = noseBridgeDepth
    const minVisibleDepth = surfaceDepth + (skuFitMetadata?.frontFrameClearanceMeters ?? 0.003)
    targetPosition.z = Math.max(targetPosition.z, minVisibleDepth)

    const faceSpan = scanProfile.profile?.faceWidth ?? pose.faceMetrics?.weightedFaceSpan ?? 0
    const currentSpan = pose.faceMetrics?.weightedFaceSpan ?? faceSpan
    
    const templeSpan = span(metricPoints.leftTemple, metricPoints.rightTemple)
    const irisSpan = span(metricPoints.leftIris, metricPoints.rightIris)

    // Target: glasses width = 1.0x temple span (temples sit at hinge points).
    // No yaw foreshortening correction here — the size is frozen during turns
    // downstream (RenderLoop._smoothSolvedScale), and the depth is held steady at
    // the source, so the projected width stays consistent.
    const targetWidth = templeSpan > 0
      ? templeSpan
      : irisSpan * 1.6  // fallback: extrapolate temple span from iris span

    const naturalFrameWidth = Number.isFinite(skuFitMetadata?.frameWidthMeters) && skuFitMetadata.frameWidthMeters > 0
      ? skuFitMetadata.frameWidthMeters
      : 0.068

    const skuScale = Number.isFinite(skuFitMetadata?.scaleMultiplier) ? skuFitMetadata.scaleMultiplier : 1
    const fittedScale = targetWidth > 0 ? (targetWidth / naturalFrameWidth) * skuScale : 1

    const limits = skuFitMetadata?.scaleLimits ?? { min: 0.85, max: 1.25 }
    const scale = THREE.MathUtils.clamp(fittedScale, limits.min, limits.max)
    // Surfaced so a binding clamp is visible rather than silent. A frame sitting
    // exactly on its ceiling looks like a confident fit in the HUD and is really
    // the solver asking for a size it is not allowed to have.
    const scaleClamped = scale !== fittedScale

    // Put the frame's nose saddle ON the face's nose bridge, at every head angle.
    //
    // The legacy path positions the model ORIGIN -- which the loader set to the
    // bounding-box centre, a point that is not on the frame -- and then leans on
    // (I - R)*pivot to keep the contact steady under rotation. Where the frame
    // ends up therefore depends on its bounding box: measured on one mock frame,
    // the saddle landed -3.3 mm, +6.7 mm and +15.4 mm relative to the sellion for
    // three real models. An 18.7 mm spread that no single vertical lift can
    // remove, because it is a property of each frame's proportions.
    //
    // Solving for the saddle instead makes the placement exact rather than
    // corrected: saddleWorld = position + R*(saddle*s), so position =
    // anchor - R*(saddle*s) pins it for any R. That also subsumes the pivot
    // correction -- and fixes its missing render scale, since the lever arm is in
    // model units but the frame is drawn at `scale`.
    if (saddleAnchored && Number.isFinite(scale)) {
      // Clearance is applied along the HEAD's forward axis, not world Z. A world-Z
      // floor holds the frame off the skin only while the face points at the
      // camera; once the head pitches, "forward" is no longer Z and the floor
      // stops protecting the surface it was meant to protect.
      const clearance = skuFitMetadata?.frontFrameClearanceMeters ?? 0.003
      targetPosition
        .copy(bridgeSurfaceWorld ?? frameAnchor)
        .add(FORWARD.set(0, 0, clearance).applyQuaternion(quaternion))
        .sub(localBridgePivot.clone().multiplyScalar(scale).applyQuaternion(quaternion))
      // Deliberately no world-Z clamp here: it would reintroduce exactly the
      // pitch-varying depth error this anchor removes.
    }

    const scaleDrift = faceSpan > 0 && currentSpan > 0
      ? THREE.MathUtils.clamp(currentSpan / faceSpan, 0.985, 1.015)
      : 1
    // Yaw foreshortens a PROJECTED width by cos(yaw), and every span here is
    // projected at a fixed depth -- so a turning head reads as a narrowing face
    // and the frame tries to shrink with it. Measured across the mock sweep the
    // target ran 1.15 frontal to 0.85 at 53 degrees: a 26% swing on a head whose
    // width never changed, pinned at BOTH clamps at the extremes. Same bug class
    // as the IPD depth estimate above, and the same correction.
    //
    // Clamped at the same 60 degrees: past that an iris is occluded by the nose
    // and dividing by a small cosine amplifies noise instead of removing bias.
    const widthForeshorten = Math.cos(
      THREE.MathUtils.clamp(headEuler.y, -MAX_YAW_DEPTH_CORRECTION, MAX_YAW_DEPTH_CORRECTION)
    )
    const worldFaceWidth = weightedWorldFaceWidth(metricPoints) /
      Math.max(widthForeshorten, 0.5)
    const frameFitRatio = Number.isFinite(skuFitMetadata?.faceFitWidthRatio)
      ? skuFitMetadata.faceFitWidthRatio
      : 0.88

    const requiredAnchors = [bridgeWorld, irisWorld, leftTemple, rightTemple, leftCheek, rightCheek]
    const anchorQuality = requiredAnchors.filter(finiteVector3).length / requiredAnchors.length
    const scaleQuality = faceSpan > 0 ? 1 : 0.5
    const fitQuality = THREE.MathUtils.clamp(anchorQuality * 0.75 + scaleQuality * 0.25, 0, 1)

    return {
      glassesTransform: {
        position: targetPosition,
        quaternion,
        scale,
      },
      // The head yaw the solver used, so the size-freeze downstream keys off the
      // exact same value as the depth-hold here (no out-of-sync transition).
      headYaw: headEuler.y,
      fittedScaleRaw: fittedScale,
      scaleClamped,
      occlusionMesh: {
        landmarks,
        baseDepth,
        anchorWorldPoints,
        faceWorldPoints,
      },
      anchorWorldPoints,
      fitQuality,
      debugMetrics: {
        faceSpan,
        currentSpan,
        worldFaceWidth,
        fittedScale,
        frameFitRatio,
        scaleDrift,
        surfaceDepth,
        frameDepth: targetPosition.z,
        bridgeToIrisWorld: span(bridgeWorld, irisWorld),
        templeWorldSpan: span(leftTemple, rightTemple),
        cheekWorldSpan: span(leftCheek, rightCheek),
      },
    }
  }
}

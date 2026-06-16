import * as THREE from 'three'

const DEFAULT_MIN_DEPTH = -1.8
const DEFAULT_MAX_DEPTH = -0.22
const DEFAULT_FALLBACK_DEPTH = -0.72
const DEFAULT_LANDMARK_DEPTH_SCALE = 0.08
// Depth relief applied to the occluder mesh so the cheeks/jaw bulge forward and
// actually mask the temple arms. Tunable: bigger = more pronounced 3D face shell.
const OCCLUDER_DEPTH_SCALE = 0.45

function finiteVector3(vector) {
  return vector &&
    Number.isFinite(vector.x) &&
    Number.isFinite(vector.y) &&
    Number.isFinite(vector.z)
}

function validDepth(depth) {
  return Number.isFinite(depth) && depth < DEFAULT_MAX_DEPTH && depth > DEFAULT_MIN_DEPTH
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
  const ndcX = -(anchor.x * 2 - 1)
  const ndcY = -(anchor.y * 2 - 1)

  return new THREE.Vector3(ndcX * halfWidth, ndcY * halfHeight, depth)
}

function anchorToWorldXY(anchor, camera, metricDepth) {
  if (!anchor || !camera?.isPerspectiveCamera) return null

  const distance = Math.abs(metricDepth)
  const halfFov = THREE.MathUtils.degToRad(camera.fov) * 0.5
  const halfHeight = Math.tan(halfFov) * distance
  const halfWidth = halfHeight * camera.aspect
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

function averageWorld(points) {
  const valid = points.filter(finiteVector3)
  if (!valid.length) {
    return null
  }

  return valid.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / valid.length)
}

function estimateMetricDepth(leftIris, rightIris, camera, realIPD_m = 0.063) {
  if (!leftIris || !rightIris || !camera?.isPerspectiveCamera) return null

  const pw = camera._pixelWidth
  const ph = camera._pixelHeight
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
    const baseDepth = ipdDepth
      ?? (validDepth(matrixPosition.z) ? matrixPosition.z : this.fallbackDepth)

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
    // Give the occluder real depth (cheeks/nose forward, jaw/ears back) instead of
    // a flat billboard, so temple arms passing behind the cheeks get masked.
    const faceWorldPoints = Array.isArray(landmarks)
      ? landmarks.map((landmark) => anchorToWorld(landmark, camera, baseDepth, OCCLUDER_DEPTH_SCALE))
      : []
    const bridgeWorld = anchorWorldPoints.bridgeCenter ?? anchorWorldPoints.bridgeTop
    const irisWorld = anchorWorldPoints.irisCenter
    const leftTemple = anchorWorldPoints.leftTemple
    const rightTemple = anchorWorldPoints.rightTemple
    const leftCheek = anchorWorldPoints.leftCheek
    const rightCheek = anchorWorldPoints.rightCheek
    const leftIris = anchorWorldPoints.leftIris
    const rightIris = anchorWorldPoints.rightIris
    const browTop = anchorWorldPoints.bridgeTop ?? anchorWorldPoints.browCenter

    // Anchor on the nose bridge, where glasses physically rest. We previously
    // averaged in the iris and brow landmarks, but those swing far more than the
    // bridge when the head pitches up/down, dragging the anchor off the bridge.
    // A light pull toward bridgeTop keeps the resting point at the top of the
    // bridge (where the frame sits) without reintroducing the brow's pitch swing.
    const frameAnchorXY = averageWorld([bridgeWorld, bridgeWorld, browTop])
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
    
    const templeSpan = span(leftTemple, rightTemple)
    const irisSpan = span(leftIris, rightIris)

    // Target: glasses width = 1.0x temple span (temples sit at hinge points)
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

    const scaleDrift = faceSpan > 0 && currentSpan > 0
      ? THREE.MathUtils.clamp(currentSpan / faceSpan, 0.985, 1.015)
      : 1
    const worldFaceWidth = weightedWorldFaceWidth({
      leftTemple,
      rightTemple,
      leftCheek,
      rightCheek,
      leftIris,
      rightIris,
    })
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

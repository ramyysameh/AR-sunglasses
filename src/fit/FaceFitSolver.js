import * as THREE from 'three'

const DEFAULT_MIN_DEPTH = -1.8
const DEFAULT_MAX_DEPTH = -0.22
const DEFAULT_FALLBACK_DEPTH = -0.72
const DEFAULT_LANDMARK_DEPTH_SCALE = 0.08

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

  solve({ pose, landmarks, faceMatrix, scanProfile, skuFitMetadata, camera } = {}) {
    if (!pose?.anchorPoints || !faceMatrix || !scanProfile?.isReady) {
      return null
    }

    const { position: matrixPosition, quaternion } = decomposeMatrix(faceMatrix)
    const baseDepth = validDepth(matrixPosition.z)
      ? matrixPosition.z
      : validDepth(scanProfile.profile?.headDepth)
        ? scanProfile.profile.headDepth
        : this.fallbackDepth
    const anchorWorldPoints = Object.fromEntries(
      Object.entries(pose.anchorPoints).map(([key, anchor]) => [
        key,
        anchorToWorld(anchor, camera, baseDepth, this.landmarkDepthScale),
      ])
    )
    const faceWorldPoints = Array.isArray(landmarks)
      ? landmarks.map((landmark) => anchorToWorld(landmark, camera, baseDepth, this.landmarkDepthScale))
      : []
    const bridgeWorld = anchorWorldPoints.bridgeCenter ?? anchorWorldPoints.bridgeTop
    const irisWorld = anchorWorldPoints.irisCenter
    const leftTemple = anchorWorldPoints.leftTemple
    const rightTemple = anchorWorldPoints.rightTemple
    const leftCheek = anchorWorldPoints.leftCheek
    const rightCheek = anchorWorldPoints.rightCheek
    const leftIris = anchorWorldPoints.leftIris
    const rightIris = anchorWorldPoints.rightIris
    const brow = anchorWorldPoints.browCenter ?? anchorWorldPoints.bridgeTop
    const frameAnchor = averageWorld([
      bridgeWorld,
      irisWorld,
      brow,
    ]) ?? bridgeWorld ?? matrixPosition

    if (!finiteVector3(frameAnchor)) {
      return null
    }

    const localBridgePivot = skuFitMetadata?.bridgePivot ?? new THREE.Vector3()
    const localLensCenter = skuFitMetadata?.lensCenterOffset ?? new THREE.Vector3()
    const modelLocalCorrection = localBridgePivot.clone()
      .add(localLensCenter)
      .multiplyScalar(-1)
      .applyQuaternion(quaternion)
    const targetPosition = frameAnchor.clone().add(modelLocalCorrection)
    const surfaceDepth = Math.max(
      bridgeWorld?.z ?? targetPosition.z,
      leftCheek?.z ?? targetPosition.z,
      rightCheek?.z ?? targetPosition.z
    )
    const minVisibleDepth = surfaceDepth + (skuFitMetadata?.frontFrameClearanceMeters ?? 0.006)
    targetPosition.z = Math.max(targetPosition.z, minVisibleDepth)

    const faceSpan = scanProfile.profile?.faceWidth ?? pose.faceMetrics?.weightedFaceSpan ?? 0
    const currentSpan = pose.faceMetrics?.weightedFaceSpan ?? faceSpan
    const scaleDrift = faceSpan > 0 && currentSpan > 0
      ? THREE.MathUtils.clamp(currentSpan / faceSpan, 0.985, 1.015)
      : 1
    const skuScale = Number.isFinite(skuFitMetadata?.scaleMultiplier)
      ? skuFitMetadata.scaleMultiplier
      : 1
    const naturalFrameWidth = Number.isFinite(skuFitMetadata?.frameWidthMeters) && skuFitMetadata.frameWidthMeters > 0
      ? skuFitMetadata.frameWidthMeters
      : 0.145
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
      : 0.55
    const fittedScale = worldFaceWidth > 0
      ? (worldFaceWidth * frameFitRatio) / naturalFrameWidth
      : 1
    const limits = skuFitMetadata?.scaleLimits ?? { min: 1.0, max: 1.85 }
    const scale = THREE.MathUtils.clamp(fittedScale * skuScale * scaleDrift, limits.min, limits.max)
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

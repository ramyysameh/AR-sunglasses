/**
 * LandmarkProcessor
 *
 * Coordinate contract:
 * - MediaPipe Face Landmarker provides `facialTransformationMatrixes[0].data`,
 *   a Float32Array encoding a column-major 4x4 matrix in METRIC space.
 * - This module MUST NOT perform any manual conversion from normalized
 *   landmark coordinates to world coordinates. The matrix is the single
 *   authoritative source of 3D head pose.
 */
import * as THREE from 'three'
import { canonicalOffset } from '../config/poseConfig.js'

const IDENTITY_OFFSET = new THREE.Vector3()
const IDENTITY_ROTATION = new THREE.Euler()

function landmarkDistance(landmarks, aIndex, bIndex) {
  const a = landmarks?.[aIndex]
  const b = landmarks?.[bIndex]

  if (!a || !b) {
    return 0
  }

  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = (a.z ?? 0) - (b.z ?? 0)
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

  return Number.isFinite(distance) ? distance : 0
}

function computeFitScale(landmarks, naturalWidth, modelConfig = {}) {
  const safeNaturalWidth = Number.isFinite(naturalWidth) && naturalWidth > 0
    ? naturalWidth
    : 1

  const templeSpan = landmarkDistance(landmarks, 234, 454)
  const irisSpan = landmarkDistance(landmarks, 468, 473)
  const cheekSpan = landmarkDistance(landmarks, 123, 352)
  const weightedFaceSpan = templeSpan * 0.5 + irisSpan * 0.3 + cheekSpan * 0.2
  const baseScale = weightedFaceSpan > 0 ? weightedFaceSpan / safeNaturalWidth : 1
  const configScale = Number.isFinite(modelConfig.scaleMultiplier) ? modelConfig.scaleMultiplier : 1
  const fitScale = baseScale * configScale

  return {
    fitScale: Number.isFinite(fitScale) && fitScale > 0 ? fitScale : 1,
    metrics: {
      templeSpan,
      irisSpan,
      cheekSpan,
      weightedFaceSpan,
      naturalWidth: safeNaturalWidth,
      confidence: weightedFaceSpan > 0 ? 1 : 0,
    },
  }
}

function getLandmark(landmarks, index) {
  const landmark = landmarks?.[index]
  if (!landmark) {
    return null
  }

  return {
    x: landmark.x,
    y: landmark.y,
    z: landmark.z ?? 0,
  }
}

function midpoint(a, b) {
  if (!a || !b) return null

  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: ((a.z ?? 0) + (b.z ?? 0)) * 0.5,
  }
}

function computePoseQuality(faceMetrics, matrixScale, quaternion) {
  const hasMetrics = faceMetrics.templeSpan > 0 &&
    faceMetrics.irisSpan > 0 &&
    faceMetrics.cheekSpan > 0
  const scaleValid = Number.isFinite(matrixScale.x) &&
    Number.isFinite(matrixScale.y) &&
    Number.isFinite(matrixScale.z)
  const quatValid = Number.isFinite(quaternion.x) &&
    Number.isFinite(quaternion.y) &&
    Number.isFinite(quaternion.z) &&
    Number.isFinite(quaternion.w)

  if (!hasMetrics || !scaleValid || !quatValid) {
    return 0
  }

  const symmetry = Math.min(faceMetrics.templeSpan, faceMetrics.cheekSpan) /
    Math.max(faceMetrics.templeSpan, faceMetrics.cheekSpan)

  return THREE.MathUtils.clamp(0.55 + symmetry * 0.45, 0, 1)
}

export class LandmarkProcessor {
  processLandmarks(result, modelConfig = {}, naturalWidth = 1) {
    if (!result?.facialTransformationMatrixes?.length) {
      return null
    }

    const landmarks = result.faceLandmarks?.[0]
    if (!landmarks?.length) {
      return null
    }

    const matrixData = result.facialTransformationMatrixes[0].data

    if (!matrixData || matrixData.length < 16) {
      return null
    }

    const mediaPipeMatrix = new THREE.Matrix4().fromArray(matrixData)
    const coordFix = new THREE.Matrix4().set(
      -1,  0,  0,  0,
       0,  1,  0,  0,
       0,  0,  1,  0,
       0,  0,  0,  1
    )

    const rawMatrix = coordFix.multiply(mediaPipeMatrix)

    const matrixPosition = new THREE.Vector3()
    const quaternion = new THREE.Quaternion()
    const matrixScale = new THREE.Vector3()
    rawMatrix.decompose(matrixPosition, quaternion, matrixScale)

    const rotationOffset = modelConfig.rotationOffset ?? IDENTITY_ROTATION
    const rotationOffsetQuat = rotationOffset instanceof THREE.Quaternion
      ? rotationOffset
      : new THREE.Quaternion().setFromEuler(rotationOffset)
    quaternion.multiply(rotationOffsetQuat).normalize()

    const modelOffset = modelConfig.canonicalOffset ?? canonicalOffset ?? IDENTITY_OFFSET
    const position = matrixPosition.clone()
    const localOffset = modelOffset.clone().applyQuaternion(quaternion)
    position.add(localOffset)

    const { fitScale, metrics } = computeFitScale(landmarks, naturalWidth, modelConfig)
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
    const leftIris = getLandmark(landmarks, 468)
    const rightIris = getLandmark(landmarks, 473)
    const leftTemple = getLandmark(landmarks, 234)
    const rightTemple = getLandmark(landmarks, 454)
    const bridgeCenter = getLandmark(landmarks, 6)
    const bridgeTop = getLandmark(landmarks, 168)
    const noseTip = getLandmark(landmarks, 1)
    const browCenter = getLandmark(landmarks, 9)
    const forehead = getLandmark(landmarks, 10)
    const leftCheek = getLandmark(landmarks, 123)
    const rightCheek = getLandmark(landmarks, 352)
    const anchorPoints = {
      bridgeCenter,
      bridgeTop,
      irisCenter: midpoint(leftIris, rightIris),
      leftIris,
      rightIris,
      leftTemple,
      rightTemple,
      leftCheek,
      rightCheek,
      noseTip,
      browCenter,
      forehead,
    }
    const poseQuality = computePoseQuality(metrics, matrixScale, quaternion)

    return {
      rawMatrix,
      position,
      quaternion,
      fitScale,
      rawPose: {
        rawMatrix,
        position: matrixPosition.clone(),
        quaternion: quaternion.clone(),
        euler,
      },
      anchorPoints,
      poseQuality,
      faceMetrics: metrics,
      metrics: {
        ...metrics,
        matrixScale,
      },
    }
  }
}

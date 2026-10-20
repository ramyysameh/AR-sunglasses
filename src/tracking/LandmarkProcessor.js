/**
 * LandmarkProcessor
 *
 * Coordinate contract:
 * - MediaPipe Face Landmarker provides `facialTransformationMatrixes[0].data`,
 *   a Float32Array encoding a column-major 4x4 matrix in METRIC space.
 * - This module MUST NOT perform any manual conversion from normalized
 *   landmark coordinates to world coordinates. The matrix is the single
 *   authoritative source of 3D head pose.
 * - With ?pose=pnp that matrix is replaced by one the PnP solver produces in
 *   the SAME convention (headPoseSolver.poseToFacialMatrix), so everything
 *   below is unchanged; MediaPipe's own matrix stays the per-frame fallback.
 */
import * as THREE from 'three'
import { canonicalOffset } from '../config/poseConfig.js'
import { HeadPoseSolver, intrinsicsFromFov } from './headPoseSolver.js'

const IDENTITY_OFFSET = new THREE.Vector3()
const IDENTITY_ROTATION = new THREE.Euler()

/**
 * Where the head pose comes from. 'mediapipe' (default) reads the network's
 * facialTransformationMatrixes; 'pnp' solves it from the 2D landmarks against a
 * rigid face model (headPoseSolver.js), falling back to MediaPipe's matrix on a
 * frame it cannot fit. ?pose=pnp switches.
 */
export function resolvePoseMode(search = typeof window !== 'undefined' ? window.location.search : '') {
  return new URLSearchParams(search).get('pose') === 'pnp' ? 'pnp' : 'mediapipe'
}

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
  constructor(options = {}) {
    this.poseMode = options.poseMode ?? resolvePoseMode()
    // ?pnpdepth=canonical|landmark picks the wearer model's depth source (tuning).
    const depth = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('pnpdepth') : null
    const pnp = { ...options.pnp, ...(depth ? { userModel: { depth } } : {}) }
    this.headPoseSolver = this.poseMode === 'pnp' ? new HeadPoseSolver(pnp) : null
  }

  /**
   * @param {object} result FaceLandmarker result
   * @param {object} [modelConfig]
   * @param {number} [naturalWidth]
   * @param {{ fov?: number, _videoW?: number, _videoH?: number }} [camera]
   *   The render camera: its vertical FOV and the video's intrinsic size are the
   *   PnP solver's intrinsics. Unused in 'mediapipe' mode.
   */
  processLandmarks(result, modelConfig = {}, naturalWidth = 1, camera = null) {
    if (!result?.facialTransformationMatrixes?.length) {
      return null
    }

    const landmarks = result.faceLandmarks?.[0]
    if (!landmarks?.length) {
      return null
    }

    let matrixData = result.facialTransformationMatrixes[0].data
    let poseSource = 'mediapipe'

    if (!matrixData || matrixData.length < 16) {
      return null
    }

    if (this.headPoseSolver && camera?.fov > 0 && camera._videoW > 0 && camera._videoH > 0) {
      const K = intrinsicsFromFov(camera._videoW, camera._videoH, camera.fov)
      const solved = this.headPoseSolver.solve(landmarks, K, matrixData)
      matrixData = solved.matrix
      poseSource = solved.source
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
      poseSource,
      faceMetrics: metrics,
      metrics: {
        ...metrics,
        matrixScale,
      },
    }
  }
}

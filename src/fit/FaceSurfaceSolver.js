import * as THREE from 'three'

const DEFAULT_FALLBACK_DEPTH = -0.78
const DEFAULT_MIN_DEPTH = -1.8
const DEFAULT_MAX_DEPTH = -0.22
const DEFAULT_LANDMARK_DEPTH_SCALE = 0.1

function isFiniteDepth(depth) {
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

function averageVector(points) {
  const valid = points.filter(Boolean)
  if (!valid.length) {
    return null
  }

  return valid.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(1 / valid.length)
}

function computeFaceNormal(leftCheek, rightCheek, bridgeTop, bridgeCenter) {
  if (!leftCheek || !rightCheek || !bridgeTop || !bridgeCenter) {
    return new THREE.Vector3(0, 0, 1)
  }

  const across = rightCheek.clone().sub(leftCheek).normalize()
  const up = bridgeTop.clone().sub(bridgeCenter).normalize()
  const normal = across.cross(up).normalize()

  return normal.z < 0 ? normal.multiplyScalar(-1) : normal
}

export class FaceSurfaceSolver {
  constructor(options = {}) {
    this.fallbackDepth = options.fallbackDepth ?? DEFAULT_FALLBACK_DEPTH
    this.landmarkDepthScale = options.landmarkDepthScale ?? DEFAULT_LANDMARK_DEPTH_SCALE
  }

  solve({ pose, camera, calibrationState, modelConfig } = {}) {
    const anchors = pose?.anchorPoints ?? {}
    const matrixDepth = pose?.rawPose?.position?.z ?? pose?.position?.z
    const calibratedDepth = calibrationState?.surfaceBaseline?.frameDepth ??
      calibrationState?.faceProfile?.headDepth
    const baseDepth = isFiniteDepth(matrixDepth)
      ? matrixDepth
      : isFiniteDepth(calibratedDepth)
        ? calibratedDepth
        : this.fallbackDepth

    const anchorWorldPoints = Object.fromEntries(
      Object.entries(anchors).map(([key, anchor]) => [
        key,
        anchorToWorld(anchor, camera, baseDepth, this.landmarkDepthScale),
      ])
    )

    const bridgeWorld = anchorWorldPoints.bridgeCenter ??
      anchorWorldPoints.bridgeTop ??
      anchorWorldPoints.irisCenter
    const irisWorld = anchorWorldPoints.irisCenter
    const leftCheek = anchorWorldPoints.leftCheek
    const rightCheek = anchorWorldPoints.rightCheek
    const bridgeTop = anchorWorldPoints.bridgeTop
    const noseTip = anchorWorldPoints.noseTip
    const faceNormal = computeFaceNormal(leftCheek, rightCheek, bridgeTop, bridgeWorld)
    const surfaceReference = averageVector([
      bridgeWorld,
      bridgeTop,
      noseTip,
      leftCheek,
      rightCheek,
    ]) ?? bridgeWorld

    if (!surfaceReference) {
      return null
    }

    const bridgeClearance = modelConfig?.bridgeClearanceMeters ?? 0.012
    const nosePadOffset = modelConfig?.nosePadOffsetMeters ?? 0.004
    const lensOffset = modelConfig?.lensCenterOffset ?? new THREE.Vector3()
    const bridgeOffset = modelConfig?.bridgeLocalOffset ?? new THREE.Vector3()
    const surfaceDepth = Math.max(
      surfaceReference.z,
      bridgeWorld?.z ?? surfaceReference.z,
      noseTip?.z ?? surfaceReference.z,
      leftCheek?.z ?? surfaceReference.z,
      rightCheek?.z ?? surfaceReference.z
    )
    const frameDepth = THREE.MathUtils.clamp(
      surfaceDepth + bridgeClearance + nosePadOffset,
      DEFAULT_MIN_DEPTH,
      DEFAULT_MAX_DEPTH
    )
    const framePosition = (bridgeWorld ?? surfaceReference).clone()
    framePosition.z = frameDepth

    if (pose?.quaternion) {
      framePosition.add(bridgeOffset.clone().add(lensOffset).applyQuaternion(pose.quaternion))
    }

    const requiredAnchors = [bridgeWorld, irisWorld, leftCheek, rightCheek]
    const surfaceQuality = requiredAnchors.filter(Boolean).length / requiredAnchors.length

    return {
      bridgeWorld,
      irisWorld,
      templeWorld: {
        left: anchorWorldPoints.leftTemple,
        right: anchorWorldPoints.rightTemple,
      },
      cheekWorld: {
        left: leftCheek,
        right: rightCheek,
      },
      noseTipWorld: noseTip,
      anchorWorldPoints,
      faceNormal,
      surfaceDepth,
      framePosition,
      frameDepth,
      bridgeClearance,
      surfaceQuality,
    }
  }
}

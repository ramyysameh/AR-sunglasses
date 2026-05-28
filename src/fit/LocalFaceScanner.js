import * as THREE from 'three'

const DEFAULT_STAGE_TARGETS = {
  front: 12,
  yawLeft: 6,
  yawRight: 6,
  neutralReturn: 6,
}

const DEFAULT_MIN_POSE_QUALITY = 0.64
const DEFAULT_MAX_ANCHOR_VELOCITY = 0.014

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function averageAnchor(samples, key) {
  const values = samples
    .map((sample) => sample.pose.anchorPoints?.[key])
    .filter(Boolean)

  if (!values.length) return null

  return {
    x: average(values.map((value) => value.x)),
    y: average(values.map((value) => value.y)),
    z: average(values.map((value) => value.z ?? 0)),
  }
}

function anchorVelocity(a, b) {
  if (!a || !b) return 0

  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = (a.z ?? 0) - (b.z ?? 0)

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function matrixPosition(matrix) {
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()

  matrix?.decompose?.(position, quaternion, scale)

  return position
}

function yawFromPose(pose) {
  return THREE.MathUtils.radToDeg(pose?.rawPose?.euler?.y ?? 0)
}

function stageForYaw(yaw) {
  if (yaw <= -8) return 'yawLeft'
  if (yaw >= 8) return 'yawRight'
  return 'front'
}

function isStablePose(pose, previousPose, minQuality, maxAnchorVelocity) {
  if ((pose?.poseQuality ?? 0) < minQuality) {
    return false
  }

  const bridgeVelocity = anchorVelocity(
    pose.anchorPoints?.bridgeCenter,
    previousPose?.anchorPoints?.bridgeCenter
  )
  const irisVelocity = anchorVelocity(
    pose.anchorPoints?.irisCenter,
    previousPose?.anchorPoints?.irisCenter
  )

  return bridgeVelocity <= maxAnchorVelocity && irisVelocity <= maxAnchorVelocity
}

export class LocalFaceScanner {
  constructor(options = {}) {
    this.stageTargets = options.stageTargets ?? DEFAULT_STAGE_TARGETS
    this.minPoseQuality = options.minPoseQuality ?? DEFAULT_MIN_POSE_QUALITY
    this.maxAnchorVelocity = options.maxAnchorVelocity ?? DEFAULT_MAX_ANCHOR_VELOCITY
    this.samples = {
      front: [],
      yawLeft: [],
      yawRight: [],
      neutralReturn: [],
    }
    this.lastPose = null
    this.profile = null
    this.frozen = false
  }

  reset() {
    if (this.frozen && this.profile) return

    this.samples = {
      front: [],
      yawLeft: [],
      yawRight: [],
      neutralReturn: [],
    }
    this.lastPose = null
    this.profile = null
  }

  setFrozen(frozen) {
    this.frozen = Boolean(frozen)
  }

  update(pose) {
    if (!pose?.anchorPoints || !pose?.rawMatrix || !pose?.faceMetrics) {
      return this.getState()
    }

    if (this.frozen && this.profile) {
      return this.getState()
    }

    const stable = isStablePose(
      pose,
      this.lastPose,
      this.minPoseQuality,
      this.maxAnchorVelocity
    )
    this.lastPose = pose

    if (!stable) {
      return this.getState()
    }

    const yaw = yawFromPose(pose)
    const stage = this._stageForPoseYaw(yaw)
    if (!stage) {
      return this.getState()
    }
    const sample = {
      pose,
      yaw,
      headPosition: matrixPosition(pose.rawMatrix),
      createdAt: performance.now(),
    }

    this.samples[stage].push(sample)
    if (this.samples[stage].length > this.stageTargets[stage]) {
      this.samples[stage].shift()
    }

    if (this._hasEnoughSamples()) {
      this.profile = this._buildProfile()
    }

    return this.getState()
  }

  _hasEnoughSamples() {
    return this.samples.front.length >= this.stageTargets.front &&
      this.samples.yawLeft.length >= this.stageTargets.yawLeft &&
      this.samples.yawRight.length >= this.stageTargets.yawRight &&
      this.samples.neutralReturn.length >= this.stageTargets.neutralReturn
  }

  _stageForPoseYaw(yaw) {
    if (this.samples.front.length < this.stageTargets.front && Math.abs(yaw) < 8) {
      return 'front'
    }

    if (this.samples.yawLeft.length < this.stageTargets.yawLeft && yaw <= -8) {
      return 'yawLeft'
    }

    if (this.samples.yawRight.length < this.stageTargets.yawRight && yaw >= 8) {
      return 'yawRight'
    }

    if (
      this.samples.yawLeft.length >= this.stageTargets.yawLeft &&
      this.samples.yawRight.length >= this.stageTargets.yawRight &&
      this.samples.neutralReturn.length < this.stageTargets.neutralReturn &&
      Math.abs(yaw) < 7
    ) {
      return 'neutralReturn'
    }

    return null
  }

  _stageProgress(stage) {
    return Math.min(1, this.samples[stage].length / this.stageTargets[stage])
  }

  _buildProfile() {
    const allSamples = [
      ...this.samples.front,
      ...this.samples.yawLeft,
      ...this.samples.yawRight,
    ]
    const frontSamples = this.samples.front
    const leftIris = averageAnchor(frontSamples, 'leftIris')
    const rightIris = averageAnchor(frontSamples, 'rightIris')
    const leftCheek = averageAnchor(frontSamples, 'leftCheek')
    const rightCheek = averageAnchor(frontSamples, 'rightCheek')
    const bridgeAnchor = averageAnchor(frontSamples, 'bridgeCenter')
    const bridgeTop = averageAnchor(frontSamples, 'bridgeTop')
    const noseTip = averageAnchor(frontSamples, 'noseTip')

    return {
      isReady: true,
      quality: 1,
      frontPose: this._averageStagePose('front'),
      yawLeftPose: this._averageStagePose('yawLeft'),
      yawRightPose: this._averageStagePose('yawRight'),
      faceWidth: average(frontSamples.map((sample) => sample.pose.faceMetrics.weightedFaceSpan)),
      bridgeAnchor,
      eyeLine: {
        left: leftIris,
        right: rightIris,
        center: averageAnchor(frontSamples, 'irisCenter'),
      },
      cheekPlane: {
        left: leftCheek,
        right: rightCheek,
        center: averageAnchor(frontSamples, 'bridgeCenter'),
      },
      noseProtrusion: Math.abs((noseTip?.z ?? 0) - (bridgeAnchor?.z ?? 0)),
      bridgeToBrow: Math.abs((bridgeAnchor?.y ?? 0) - (bridgeTop?.y ?? 0)),
      scale: average(frontSamples.map((sample) => sample.pose.faceMetrics.weightedFaceSpan)),
      headDepth: average(allSamples.map((sample) => sample.headPosition.z).filter(Number.isFinite)),
      yawBaseline: average(frontSamples.map((sample) => sample.yaw)),
      createdAt: performance.now(),
    }
  }

  _averageStagePose(stage) {
    const samples = this.samples[stage]

    return {
      yaw: average(samples.map((sample) => sample.yaw)),
      headDepth: average(samples.map((sample) => sample.headPosition.z).filter(Number.isFinite)),
      sampleCount: samples.length,
    }
  }

  getState() {
    const progress = this.profile
      ? 1
      : (
          this._stageProgress('front') +
          this._stageProgress('yawLeft') +
          this._stageProgress('yawRight') +
          this._stageProgress('neutralReturn')
        ) / 4

    return {
      isReady: Boolean(this.profile),
      quality: progress,
      sampleCount: this.samples.front.length +
        this.samples.yawLeft.length +
        this.samples.yawRight.length +
        this.samples.neutralReturn.length,
      targetSamples: this.stageTargets.front +
        this.stageTargets.yawLeft +
        this.stageTargets.yawRight +
        this.stageTargets.neutralReturn,
      stageProgress: {
        front: this._stageProgress('front'),
        yawLeft: this._stageProgress('yawLeft'),
        yawRight: this._stageProgress('yawRight'),
        neutralReturn: this._stageProgress('neutralReturn'),
      },
      activeStage: this.profile ? 'ready' : this._nextStage(),
      profile: this.profile,
      frozen: this.frozen,
    }
  }

  _nextStage() {
    for (const stage of ['front', 'yawLeft', 'yawRight', 'neutralReturn']) {
      if (this.samples[stage].length < this.stageTargets[stage]) {
        return stage
      }
    }

    return 'ready'
  }
}

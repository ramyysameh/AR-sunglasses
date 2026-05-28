import * as THREE from 'three'

const DEFAULT_TARGET_SAMPLES = 24
const DEFAULT_MAX_ANCHOR_VELOCITY = 0.012
const DEFAULT_MIN_QUALITY = 0.68

function average(values) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function averageAnchor(samples, key) {
  return {
    x: average(samples.map((sample) => sample.anchorPoints[key]?.x ?? 0)),
    y: average(samples.map((sample) => sample.anchorPoints[key]?.y ?? 0)),
    z: average(samples.map((sample) => sample.anchorPoints[key]?.z ?? 0)),
  }
}

function anchorVelocity(a, b) {
  if (!a || !b) return 0

  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = (a.z ?? 0) - (b.z ?? 0)

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export class FitCalibrator {
  constructor(options = {}) {
    this.targetSamples = options.targetSamples ?? DEFAULT_TARGET_SAMPLES
    this.minQuality = options.minQuality ?? DEFAULT_MIN_QUALITY
    this.maxAnchorVelocity = options.maxAnchorVelocity ?? DEFAULT_MAX_ANCHOR_VELOCITY
    this.samples = []
    this.surfaceSamples = []
    this.lastPose = null
    this.profile = null
    this.frozen = false
  }

  reset() {
    if (this.frozen && this.profile) {
      return
    }

    this.samples = []
    this.surfaceSamples = []
    this.lastPose = null
    this.profile = null
  }

  setFrozen(frozen) {
    this.frozen = Boolean(frozen)
  }

  update(pose) {
    if (!pose?.anchorPoints || !pose?.faceMetrics) {
      return this.getState()
    }

    if (this.frozen && this.profile) {
      return this.getState()
    }

    const poseQuality = pose.poseQuality ?? 0
    const irisVelocity = anchorVelocity(pose.anchorPoints.irisCenter, this.lastPose?.anchorPoints?.irisCenter)
    const bridgeVelocity = anchorVelocity(pose.anchorPoints.bridgeCenter, this.lastPose?.anchorPoints?.bridgeCenter)
    const isStable = poseQuality >= this.minQuality &&
      irisVelocity <= this.maxAnchorVelocity &&
      bridgeVelocity <= this.maxAnchorVelocity

    this.lastPose = pose

    if (!isStable) {
      return this.getState()
    }

    this.samples.push(pose)
    if (this.samples.length > this.targetSamples) {
      this.samples.shift()
    }

    if (this.samples.length >= this.targetSamples) {
      this.profile = this._buildProfile()
    }

    return this.getState()
  }

  updateSurface(surfaceSolution) {
    if (!surfaceSolution || surfaceSolution.surfaceQuality < 0.75) {
      return this.getState()
    }

    if (this.frozen && this.profile?.surfaceBaseline) {
      return this.getState()
    }

    this.surfaceSamples.push({
      frameDepth: surfaceSolution.frameDepth,
      surfaceDepth: surfaceSolution.surfaceDepth,
      bridgeClearance: surfaceSolution.bridgeClearance,
      surfaceQuality: surfaceSolution.surfaceQuality,
    })

    if (this.surfaceSamples.length > this.targetSamples) {
      this.surfaceSamples.shift()
    }

    if (this.profile) {
      this.profile.surfaceBaseline = this._buildSurfaceBaseline()
    }

    return this.getState()
  }

  _buildSurfaceBaseline() {
    const samples = this.surfaceSamples
    if (!samples.length) {
      return null
    }

    return {
      frameDepth: average(samples.map((sample) => sample.frameDepth)),
      surfaceDepth: average(samples.map((sample) => sample.surfaceDepth)),
      bridgeClearance: average(samples.map((sample) => sample.bridgeClearance)),
      surfaceQuality: average(samples.map((sample) => sample.surfaceQuality)),
    }
  }

  _buildProfile() {
    const samples = this.samples
    const weightedFaceSpan = average(samples.map((sample) => sample.faceMetrics.weightedFaceSpan))
    const naturalWidth = average(samples.map((sample) => sample.faceMetrics.naturalWidth))
    const matrixDepth = average(samples.map((sample) => sample.rawPose.position.z))
    const fallbackDepth = -0.55
    const headDepth = Number.isFinite(matrixDepth) && matrixDepth < -0.05 && matrixDepth > -2
      ? matrixDepth
      : fallbackDepth
    const yawBaseline = average(samples.map((sample) => sample.rawPose.euler.y))

    return {
      isReady: true,
      sampleCount: samples.length,
      faceProfile: {
        headDepth,
        faceWidth: average(samples.map((sample) => sample.faceMetrics.templeSpan)),
        cheekWidth: average(samples.map((sample) => sample.faceMetrics.cheekSpan)),
        irisDistance: average(samples.map((sample) => sample.faceMetrics.irisSpan)),
        yawBaseline,
      },
      stableAnchors: {
        bridgeCenter: averageAnchor(samples, 'bridgeCenter'),
        bridgeTop: averageAnchor(samples, 'bridgeTop'),
        irisCenter: averageAnchor(samples, 'irisCenter'),
        leftTemple: averageAnchor(samples, 'leftTemple'),
        rightTemple: averageAnchor(samples, 'rightTemple'),
      },
      scaleBaseline: {
        weightedFaceSpan,
        naturalWidth,
        fitScale: naturalWidth > 0 ? weightedFaceSpan / naturalWidth : 1,
      },
      surfaceBaseline: this._buildSurfaceBaseline(),
    }
  }

  getState() {
    return {
      isReady: Boolean(this.profile),
      quality: this.profile ? 1 : this.samples.length / this.targetSamples,
      sampleCount: this.samples.length,
      targetSamples: this.targetSamples,
      faceProfile: this.profile?.faceProfile ?? null,
      stableAnchors: this.profile?.stableAnchors ?? null,
      scaleBaseline: this.profile?.scaleBaseline ?? null,
      surfaceBaseline: this.profile?.surfaceBaseline ?? null,
      frozen: this.frozen,
    }
  }
}

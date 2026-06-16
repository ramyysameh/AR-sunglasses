/**
 * Main AR render loop that fuses face tracking, pose filtering, occlusion, and Three.js rendering.
 */
import * as THREE from 'three'
import { scaleMultiplier, xOffset, yOffset, zOffset } from '../config/poseConfig.js'
import { FitCalibrator } from '../fit/FitCalibrator.js'
import { LocalFaceScanner } from '../fit/LocalFaceScanner.js'
import { FaceFitSolver } from '../fit/FaceFitSolver.js'

const TRACK_LOSS_RESET_MS = 180
// Lower lead than before (was 0.85): heavy lead on an already-smoothed signal
// overshoots and recoils, which reads as rubber-banding. A light lead just
// compensates residual filter latency.
const PREDICTION_FACTOR = 0.6
const MAX_PREDICTION_SPEED = 1.2
const FALLBACK_FACE_DEPTH = -0.78
const NEAREST_DISPLAY_DEPTH = -0.62
const LOW_QUALITY_FREEZE_FRAMES = 3
const LOW_QUALITY_THRESHOLD = 0.42

export class RenderLoop {
  constructor(options = {}) {
    this.canvas = options.canvas ?? null
    this.video = options.video ?? null
    this.renderer = null
    this.scene = null
    this.camera = null
    this.running = false
    this.rafId = null
    this.faceTracker = null
    this.landmarkProcessor = null
    this.positionFilter = options.positionFilter ?? null
    this.rotationFilter = options.rotationFilter ?? null
    this.fitCalibrator = options.fitCalibrator ?? new FitCalibrator()
    this.localFaceScanner = options.localFaceScanner ?? new LocalFaceScanner()
    this.faceFitSolver = options.faceFitSolver ?? new FaceFitSolver()
    this.onScanStateChange = options.onScanStateChange ?? null
    this.modelConfig = options.modelConfig ?? null
    this.glassesRoot = null
    this.faceOccluder = null
    this.contactShadow = null
    this.hud = null
    this.lastWidth = 0
    this.lastHeight = 0
    this.filterSettings = {
      positionMinCutoff: 1.0,
      positionBeta: 0.007,
      rotationMinCutoff: 0.5,
      rotationBeta: 0.05,
    }
    this.lastHeadQuaternion = new THREE.Quaternion()
    this.lastHeadPosition = new THREE.Vector3()
    this.lastScaleFactor = 1
    this.lastTempleSpan = 0
    this.lastFitScale = 1
    this.lastNoseBridgeZ = 0
    this.prevFilteredPos = null
    this.predictionDelta = 0
    this.lastTrackingTimestamp = null
    this.filtersNeedReset = false
    this.lastRawPosition = null
    this.lastRawQuat = null
    this.lastRawTimestamp = null
    this.lastGoodTransform = null
    this.lowQualityFrames = 0
    this.smoothedScale = null
    this.smoothedDepth = null
    this.lastPredictionTimestamp = null
    this.occlusionEnabled = true
    // The flat CircleGeometry "contact shadow" reads as a grey disc on the nose,
    // so keep it off. Revisit with a proper soft/blurred shadow later if desired.
    this.contactShadowEnabled = false
    this.filterMode = 'still'
    this.motionLevel = 0
    this.lastScanStateKey = ''
  }

  async init() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      // Required for the capture button to composite the WebGL overlay into a PNG.
      preserveDrawingBuffer: true,
    })
    this.renderer.setClearColor(0x000000, 0)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.1
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2))

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100)
    
    this.camera._pixelWidth = this.canvas?.clientWidth ?? 640
    this.camera._pixelHeight = this.canvas?.clientHeight ?? 480

    this.camera.position.set(0, 0, 0)
    this.camera.lookAt(0, 0, -1)

    const ambient = new THREE.AmbientLight(0xffffff, 0.85)
    const key = new THREE.DirectionalLight(0xffffff, 1.35)
    key.position.set(0.45, 1.1, 1.8)
    const fill = new THREE.DirectionalLight(0xffffff, 0.45)
    fill.position.set(-1.1, 0.15, 1.2)
    const rim = new THREE.DirectionalLight(0xcfe6ff, 0.3)
    rim.position.set(0, 0.2, -1)

    this.scene.add(ambient, key, fill, rim)
    this.contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.035, 32),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        depthTest: true,
      })
    )
    this.contactShadow.renderOrder = 1
    this.contactShadow.visible = false
    this.scene.add(this.contactShadow)

    this._syncSize()

    return this
  }

  setFilters(positionFilter, rotationFilter) {
    this.positionFilter = positionFilter
    this.rotationFilter = rotationFilter
  }

  setGlassesRoot(glassesRoot) {
    if (this.glassesRoot && this.scene) {
      this.scene.remove(this.glassesRoot)
    }

    this.glassesRoot = glassesRoot

    if (this.glassesRoot && this.scene) {
      this.scene.add(this.glassesRoot)
    }
  }

  setFaceOccluder(faceOccluder) {
    this.faceOccluder = faceOccluder

    if (this.faceOccluder?.occluderMesh && this.scene && this.faceOccluder.occluderMesh.parent !== this.scene) {
      this.scene.add(this.faceOccluder.occluderMesh)
    }
  }

  setHud(hud) {
    this.hud = hud

    if (this.hud?.setFreezeFitHandler) {
      this.hud.setFreezeFitHandler((frozen) => {
        this.fitCalibrator?.setFrozen(frozen)
        this.localFaceScanner?.setFrozen(frozen)
      })
    }

    if (this.hud?.setOcclusionToggleHandler) {
      this.hud.setOcclusionToggleHandler((enabled) => {
        this.occlusionEnabled = enabled
        if (!enabled) this.faceOccluder?.hide?.()
      })
    }

    if (this.hud?.setContactShadowToggleHandler) {
      this.hud.setContactShadowToggleHandler((enabled) => {
        this.contactShadowEnabled = enabled
        if (!enabled && this.contactShadow) this.contactShadow.visible = false
      })
    }
  }

  setModelConfig(modelConfig) {
    this.modelConfig = modelConfig
  }

  setFilterParams(params = {}) {
    this.filterSettings = {
      positionMinCutoff: params.positionMinCutoff ?? this.filterSettings.positionMinCutoff,
      positionBeta: params.positionBeta ?? this.filterSettings.positionBeta,
      rotationMinCutoff: params.rotationMinCutoff ?? this.filterSettings.rotationMinCutoff,
      rotationBeta: params.rotationBeta ?? this.filterSettings.rotationBeta,
    }

    this.positionFilter?.setParams({
      minCutoff: this.filterSettings.positionMinCutoff,
      beta: this.filterSettings.positionBeta,
      dCutoff: 1.0,
    })

    this.rotationFilter?.setParams({
      minCutoff: this.filterSettings.rotationMinCutoff,
      beta: this.filterSettings.rotationBeta,
      dCutoff: 1.0,
    })
  }

  getFilterSettings() {
    return { ...this.filterSettings }
  }

  /**
   * @param {{ faceTracker?: object, landmarkProcessor?: object, modelConfig?: object }} [deps]
   */
  start({ faceTracker, landmarkProcessor, modelConfig } = {}) {
    this.faceTracker = faceTracker ?? this.faceTracker
    this.landmarkProcessor = landmarkProcessor ?? this.landmarkProcessor
    this.modelConfig = modelConfig ?? this.modelConfig

    if (!this.running) {
      this.running = true
      this._frame()
    }
  }

  _resetTrackingState() {
    this.positionFilter?.reset?.()
    this.rotationFilter?.reset?.()
    this.prevFilteredPos = null
    this.predictionDelta = 0
    this.filtersNeedReset = false
    this.lastRawPosition = null
    this.lastRawQuat = null
    this.lastRawTimestamp = null
    this.lastGoodTransform = null
    this.lowQualityFrames = 0
    this.lastPredictionTimestamp = null
    this.smoothedScale = null
    this.smoothedDepth = null
  }

  _hideTrackedObjects(timestamp) {
    if (this.glassesRoot) {
      this.glassesRoot.visible = false
    }

    if (this.contactShadow) {
      this.contactShadow.visible = false
    }

    this.faceOccluder?.hide?.()

    if (
      this.lastTrackingTimestamp !== null &&
      timestamp - this.lastTrackingTimestamp > TRACK_LOSS_RESET_MS
    ) {
      this.filtersNeedReset = true
      this.prevFilteredPos = null
      this.predictionDelta = 0
      this.fitCalibrator?.reset?.()
      this.localFaceScanner?.reset?.()
    }

    this.hud?.update({
      templeSpan: 0,
      irisSpan: 0,
      cheekSpan: 0,
      fitScale: this.lastFitScale,
      predictionDelta: this.predictionDelta,
      calibrationReady: false,
      localScanStage: 'lost',
    })
  }

  _predictPosition(smoothPos) {
    if (!this.prevFilteredPos) {
      this.prevFilteredPos = smoothPos.clone()
      this.smoothedVelocity = null
      this.predictionDelta = 0
      this.lastPredictionTimestamp = performance.now()
      return smoothPos.clone()
    }

    const now = performance.now()
    const dt = Math.max((now - (this.lastPredictionTimestamp ?? now)) / 1000, 1 / 120)
    const velocity = smoothPos.clone().sub(this.prevFilteredPos)

    // Smooth the velocity before using it as a lead. Raw per-frame velocity is
    // noisy, and once scaled by the prediction gain that noise becomes visible
    // jitter during turns. An EMA gives a stable lead direction and magnitude.
    if (!this.smoothedVelocity) {
      this.smoothedVelocity = velocity.clone()
    } else {
      this.smoothedVelocity.lerp(velocity, 0.45)
    }

    const leadVelocity = this.smoothedVelocity.clone()
    const velocityLength = leadVelocity.length()
    const maxPredictionDelta = THREE.MathUtils.clamp(MAX_PREDICTION_SPEED * dt, 0.006, 0.045)
    if (velocityLength > maxPredictionDelta) {
      leadVelocity.multiplyScalar(maxPredictionDelta / velocityLength)
    }

    this.prevFilteredPos = smoothPos.clone()
    this.lastPredictionTimestamp = now
    this.predictionDelta = Math.min(velocityLength, maxPredictionDelta)

    // Scale lead by current motion: zero prediction (and zero noise amplification)
    // at rest, ramping to full lead during real movement.
    const predictionGain = PREDICTION_FACTOR * (this.motionLevel ?? 0)
    return smoothPos.clone().addScaledVector(leadVelocity, predictionGain)
  }

  _updateAdaptiveFilters(rawPosition, rawQuat, timestamp) {
    if (!this.lastRawPosition || this.lastRawTimestamp === null) {
      this.lastRawPosition = rawPosition.clone()
      this.lastRawQuat = rawQuat?.clone() ?? null
      this.lastRawTimestamp = timestamp
      return
    }

    const dt = Math.max((timestamp - this.lastRawTimestamp) / 1000, 1e-3)
    const linearSpeed = rawPosition.distanceTo(this.lastRawPosition) / dt
    // More sensitive gate (was /0.65): heads rarely translate that fast, so the
    // filter almost never opened up and everything lagged. /0.4 lets it respond
    // to normal head movement.
    const linearMotion = THREE.MathUtils.clamp(linearSpeed / 0.4, 0, 1)

    // A head tilt/turn is mostly rotation with little translation. Without this,
    // the gate reads a tilt as "still" and over-smooths the rotation, so the
    // glasses appear not to follow the head. Fold angular speed into the motion.
    let angularMotion = 0
    if (rawQuat && this.lastRawQuat) {
      const angularSpeed = rawQuat.angleTo(this.lastRawQuat) / dt // rad/s
      // More sensitive (was /1.8): a head turn should hit full motion quickly so
      // the filters open up and the glasses don't trail the turn.
      angularMotion = THREE.MathUtils.clamp(angularSpeed / 1.0, 0, 1)
    }

    const rawMotion = Math.max(linearMotion, angularMotion)
    // Deadzone: ignore tiny motion (landmark noise + involuntary sway) so the
    // filter stays in its heavily-smoothed "still" mode at rest and doesn't jitter.
    // Real movement still ramps motion to 1 for full responsiveness.
    // Wider deadzone (was 0.12): tracking is noisier when the head is held at an
    // angle, and that noise was tripping the gate out of "still" mode and jittering.
    // A bigger deadzone keeps any held pose (forward OR turned) in heavy smoothing.
    const deadzone = 0.2
    const motion = THREE.MathUtils.clamp((rawMotion - deadzone) / (1 - deadzone), 0, 1)
    this.motionLevel = motion
    this.filterMode = motion > 0.55 ? 'fast' : motion > 0.2 ? 'moving' : 'still'

    // Very low base cutoff = strong smoothing on any held pose (no jitter); high
    // ceiling = tight tracking during real movement so the face doesn't clip the frame.
    this.positionFilter?.setParams({
      minCutoff: THREE.MathUtils.lerp(0.85, 5.5, motion),
      beta: THREE.MathUtils.lerp(0.015, 0.20, motion),
      dCutoff: 1.0,
    })

    this.rotationFilter?.setParams({
      minCutoff: THREE.MathUtils.lerp(0.75, 5.0, motion),
      beta: THREE.MathUtils.lerp(0.04, 0.26, motion),
      dCutoff: 1.0,
    })

    this.lastRawPosition = rawPosition.clone()
    this.lastRawQuat = rawQuat?.clone() ?? this.lastRawQuat
    this.lastRawTimestamp = timestamp
  }

  _anchorToWorld(anchor, depth) {
    if (!anchor || !this.camera?.isPerspectiveCamera) {
      return null
    }

    const distance = Math.abs(depth)
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5
    const halfHeight = Math.tan(halfFov) * distance
    const halfWidth = halfHeight * this.camera.aspect
    const ndcX = -(anchor.x * 2 - 1)
    const ndcY = -(anchor.y * 2 - 1)

    return new THREE.Vector3(ndcX * halfWidth, ndcY * halfHeight, depth)
  }

  _validDepth(depth) {
    return Number.isFinite(depth) && depth < -0.05 && depth > -2
  }

  _getDisplayDepth(pose, calibrationState) {
    const matrixDepth = pose?.rawPose?.position?.z ?? pose?.position?.z
    if (this._validDepth(matrixDepth)) {
      return Math.min(matrixDepth, NEAREST_DISPLAY_DEPTH)
    }

    const calibratedDepth = calibrationState?.faceProfile?.headDepth
    return this._validDepth(calibratedDepth)
      ? Math.min(calibratedDepth, NEAREST_DISPLAY_DEPTH)
      : FALLBACK_FACE_DEPTH
  }

  _buildAnchorWorldPoints(anchorPoints, depth) {
    return Object.fromEntries(
      Object.entries(anchorPoints ?? {}).map(([key, anchor]) => [key, this._anchorToWorld(anchor, depth)])
    )
  }

  _getDisplayPosition(pose, calibrationState, depth) {
    const anchors = pose.anchorPoints ?? {}
    const bridgeAnchor = anchors.bridgeCenter ?? anchors.irisCenter
    const bridgeWorld = this._anchorToWorld(bridgeAnchor, depth)

    if (!bridgeWorld) {
      return pose.position.clone()
    }

    const bridgeOffset = this.modelConfig?.bridgeLocalOffset ?? this.modelConfig?.canonicalOffset ?? new THREE.Vector3()
    const lensOffset = this.modelConfig?.lensCenterOffset ?? new THREE.Vector3()
    const localOffset = bridgeOffset.clone().add(lensOffset).applyQuaternion(pose.quaternion)

    if (calibrationState?.isReady && calibrationState.stableAnchors?.bridgeCenter) {
      const stableBridgeWorld = this._anchorToWorld(calibrationState.stableAnchors.bridgeCenter, depth)
      if (stableBridgeWorld) {
        return bridgeWorld.lerp(stableBridgeWorld, 0.18).add(localOffset)
      }
    }

    return bridgeWorld.add(localOffset)
  }

  _computeStableScale(pose, calibrationState) {
    const globalScale = Number.isFinite(scaleMultiplier) ? scaleMultiplier : 1
    const baselineSpan = calibrationState?.scaleBaseline?.weightedFaceSpan
    const currentSpan = pose.faceMetrics?.weightedFaceSpan ?? baselineSpan
    const spanCorrection = baselineSpan > 0 && currentSpan > 0
      ? THREE.MathUtils.clamp(currentSpan / baselineSpan, 0.94, 1.06)
      : 1
    const configScale = Number.isFinite(this.modelConfig?.scaleMultiplier)
      ? this.modelConfig.scaleMultiplier
      : 1
    const targetScale = this.modelConfig?.modelUnit === 'meters'
      ? spanCorrection * globalScale
      : pose.fitScale * configScale * globalScale
    const limits = this.modelConfig?.scaleLimits ?? { min: 0.5, max: 1.8 }
    const clampedScale = THREE.MathUtils.clamp(targetScale, limits.min, limits.max)
    const damping = Number.isFinite(this.modelConfig?.fitDamping) ? this.modelConfig.fitDamping : 0.16

    this.smoothedScale = this.smoothedScale === null
      ? clampedScale
      : THREE.MathUtils.lerp(this.smoothedScale, clampedScale, damping)

    return this.smoothedScale
  }

  _smoothSolvedScale(targetScale) {
    const globalScale = Number.isFinite(scaleMultiplier) ? scaleMultiplier : 1
    const limits = this.modelConfig?.scaleLimits ?? { min: 0.85, max: 1.15 }
    const clampedScale = THREE.MathUtils.clamp(targetScale * globalScale, limits.min, limits.max)
    const damping = Number.isFinite(this.modelConfig?.fitDamping) ? this.modelConfig.fitDamping : 0.18

    this.smoothedScale = this.smoothedScale === null
      ? clampedScale
      : THREE.MathUtils.lerp(this.smoothedScale, clampedScale, damping)

    return this.smoothedScale
  }

  _applyTransform(transform) {
    if (!this.glassesRoot || !transform) {
      return
    }

    this.glassesRoot.visible = true
    this.glassesRoot.position.copy(transform.position)
    this.glassesRoot.quaternion.copy(transform.quaternion)
    this.glassesRoot.scale.setScalar(transform.scale)

    if (this.contactShadow) {
      this.contactShadow.visible = true
      this.contactShadow.visible = this.contactShadowEnabled
      this.contactShadow.position.copy(transform.surfaceSolution?.bridgeWorld ?? transform.position)
      this.contactShadow.position.y -= 0.012 * transform.scale
      this.contactShadow.position.z += 0.006 * transform.scale
      this.contactShadow.quaternion.copy(transform.quaternion)
      this.contactShadow.scale.setScalar(transform.scale)
    }

    if (!this.occlusionEnabled) {
      this.faceOccluder?.hide?.()
    } else if (transform.occlusionMesh?.faceWorldPoints) {
      this.faceOccluder?.updateFromFaceMesh?.(
        transform.occlusionMesh.faceWorldPoints,
        transform.anchorWorldPoints
      )
    } else if (transform.anchorWorldPoints) {
      this.faceOccluder?.updateFromAnchors(transform.anchorWorldPoints)
    } else if (transform.occluderMatrix) {
      this.faceOccluder?.update(transform.occluderMatrix)
    }
  }

  _isPositionInCameraView(position) {
    if (!this.camera || !position) {
      return false
    }

    const ndc = position.clone().project(this.camera)

    return Number.isFinite(ndc.x) &&
      Number.isFinite(ndc.y) &&
      Number.isFinite(ndc.z) &&
      Math.abs(ndc.x) <= 1.4 &&
      Math.abs(ndc.y) <= 1.4 &&
      ndc.z >= -1 &&
      ndc.z <= 1
  }

  _landmarkAnchorPosition(landmarks, matrixPosition) {
    const leftIris = landmarks?.[468]
    const rightIris = landmarks?.[473]
    const bridge = landmarks?.[6]
    const anchor = leftIris && rightIris
      ? {
          x: (leftIris.x + rightIris.x) * 0.5,
          y: (leftIris.y + rightIris.y) * 0.5,
        }
      : bridge

    if (!anchor || !this.camera?.isPerspectiveCamera) {
      return matrixPosition.clone()
    }

    const depth = this._validDepth(matrixPosition.z)
      ? matrixPosition.z
      : FALLBACK_FACE_DEPTH
    const distance = Math.abs(depth)
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov) * 0.5
    const halfHeight = Math.tan(halfFov) * distance
    const halfWidth = halfHeight * this.camera.aspect
    const ndcX = -(anchor.x * 2 - 1)
    const ndcY = -(anchor.y * 2 - 1)

    return new THREE.Vector3(
      ndcX * halfWidth,
      ndcY * halfHeight,
      depth
    )
  }

  _projectDebugPoints(anchorWorldPoints) {
    if (!this.camera || !anchorWorldPoints) {
      return null
    }

    const width = this.canvas?.clientWidth || this.lastWidth || 1
    const height = this.canvas?.clientHeight || this.lastHeight || 1
    const keys = ['bridgeCenter', 'irisCenter', 'leftTemple', 'rightTemple']

    return Object.fromEntries(keys.map((key) => {
      const point = anchorWorldPoints[key]
      if (!point) {
        return [key, null]
      }

      const ndc = point.clone().project(this.camera)
      return [key, {
        x: (ndc.x * 0.5 + 0.5) * width,
        y: (-ndc.y * 0.5 + 0.5) * height,
      }]
    }))
  }

  stop() {
    this.running = false

    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  _syncSize() {
    if (!this.renderer || !this.camera) {
      return
    }

    const width = this.video?.videoWidth ?? this.canvas?.clientWidth ?? this.lastWidth ?? 1
    const height = this.video?.videoHeight ?? this.canvas?.clientHeight ?? this.lastHeight ?? 1
    
    this.camera._pixelWidth = this.canvas?.clientWidth ?? this.video?.videoWidth ?? 640
    this.camera._pixelHeight = this.canvas?.clientHeight ?? this.video?.videoHeight ?? 480

    if (width === this.lastWidth && height === this.lastHeight) {
      return
    }

    this.lastWidth = width
    this.lastHeight = height
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  _frame() {
    if (!this.running) {
      return
    }

    this.rafId = requestAnimationFrame(() => this._frame())

    try {
      this._syncSize()

      const timestamp = performance.now()
      const result = this.faceTracker?.detect(this.video, timestamp)

      if (!result?.facialTransformationMatrixes?.length) {
        this._hideTrackedObjects(timestamp)
        this.renderer?.render(this.scene, this.camera)
        return
      }

      const landmarks = result.faceLandmarks?.[0]
      if (!landmarks?.length) {
        this._hideTrackedObjects(timestamp)
        this.renderer?.render(this.scene, this.camera)
        return
      }

      const glassesModel = this.glassesRoot
      if (!glassesModel) {
        return
      }
      if (!glassesModel.parent) {
        return
      }

      if (this.filtersNeedReset) {
        this._resetTrackingState()
      }

      const pose = this.landmarkProcessor?.processLandmarks(
        result,
        this.modelConfig,
        glassesModel.userData.naturalWidth
      )

      if (!pose) {
        this._hideTrackedObjects(timestamp)
        this.renderer?.render(this.scene, this.camera)
        return
      }

      if (pose.poseQuality < LOW_QUALITY_THRESHOLD) {
        this.lowQualityFrames += 1
      } else {
        this.lowQualityFrames = 0
      }

      if (this.lowQualityFrames > 1 && this.lastGoodTransform && this.lowQualityFrames <= LOW_QUALITY_FREEZE_FRAMES) {
        this.lowQualityFrames += 1
        this._applyTransform(this.lastGoodTransform)
        this.renderer?.render(this.scene, this.camera)
        return
      }

      const scanState = this.localFaceScanner.update(pose)
      this.fitCalibrator.update(pose)

      if (!scanState.isReady) {
        const scanStateKey = `${scanState.activeStage}:${scanState.sampleCount}:${scanState.targetSamples}`
        if (scanStateKey !== this.lastScanStateKey) {
          this.lastScanStateKey = scanStateKey
          this.onScanStateChange?.(scanState)
        }
        if (this.glassesRoot) this.glassesRoot.visible = false
        if (this.contactShadow) this.contactShadow.visible = false
        this.faceOccluder?.hide?.()
        this.hud?.update({
          calibrationReady: false,
          calibrationProgress: scanState.quality,
          calibrationSamples: scanState.sampleCount,
          calibrationTarget: scanState.targetSamples,
          localScanStage: scanState.activeStage,
          poseQuality: pose.poseQuality,
          templeSpan: pose.metrics?.templeSpan ?? 0,
          irisSpan: pose.metrics?.irisSpan ?? 0,
          cheekSpan: pose.metrics?.cheekSpan ?? 0,
          weightedFaceSpan: pose.faceMetrics?.weightedFaceSpan ?? 0,
          fitScale: this.lastFitScale,
          headQuaternion: pose.quaternion,
          headPosition: pose.rawPose?.position,
          predictionDelta: this.predictionDelta ?? 0,
        })
        this.renderer?.render(this.scene, this.camera)
        return
      }

      if (this.lastScanStateKey !== 'ready') {
        this.lastScanStateKey = 'ready'
        this.onScanStateChange?.(scanState)
      }

      const fitSolution = this.faceFitSolver.solve({
        pose,
        landmarks,
        faceMatrix: pose.rawMatrix,
        scanProfile: scanState,
        skuFitMetadata: this.modelConfig,
        camera: this.camera,
      })

      if (!fitSolution) {
        this._hideTrackedObjects(timestamp)
        this.renderer?.render(this.scene, this.camera)
        return
      }

      const anchorWorldPoints = fitSolution.anchorWorldPoints
      const basePosition = fitSolution.glassesTransform.position
      const tunedPosition = basePosition.clone().add(new THREE.Vector3(xOffset, yOffset, zOffset))

      this._updateAdaptiveFilters(tunedPosition, fitSolution.glassesTransform.quaternion, timestamp)

      const smoothPos = this.positionFilter
        ? this.positionFilter.filter(tunedPosition, timestamp)
        : tunedPosition
      const smoothQuat = this.rotationFilter
        ? this.rotationFilter.filter(fitSolution.glassesTransform.quaternion, timestamp)
        : fitSolution.glassesTransform.quaternion.clone()
      const predictedPos = this._predictPosition(smoothPos)
      // Extra depth (z) damping: the IPD-based depth estimate is noisy when the head
      // is held at an angle (foreshortened irises), trembling the frame in/out. Damp
      // it hard at rest, lightly during real movement so moving closer/farther tracks.
      const depthAlpha = THREE.MathUtils.lerp(0.05, 0.85, this.motionLevel ?? 0)
      this.smoothedDepth = this.smoothedDepth == null
        ? predictedPos.z
        : THREE.MathUtils.lerp(this.smoothedDepth, predictedPos.z, depthAlpha)
      predictedPos.z = this.smoothedDepth
      const fitScale = this._smoothSolvedScale(fitSolution.glassesTransform.scale)
      const transform = {
        position: predictedPos,
        quaternion: smoothQuat,
        scale: fitScale,
        anchorWorldPoints,
        occlusionMesh: fitSolution.occlusionMesh,
        fitSolution,
      }

      this._applyTransform(transform)
      this.lastGoodTransform = {
        position: predictedPos.clone(),
        quaternion: smoothQuat.clone(),
        scale: fitScale,
        anchorWorldPoints,
        occlusionMesh: fitSolution.occlusionMesh,
        fitSolution,
      }
      this.lastTrackingTimestamp = timestamp

      if (this.hud?.update) {
        this.hud.update({
          calibrationReady: scanState.isReady,
          calibrationProgress: scanState.quality,
          calibrationSamples: scanState.sampleCount,
          calibrationTarget: scanState.targetSamples,
          fitFrozen: scanState.frozen,
          localScanStage: scanState.activeStage,
          poseQuality: pose.poseQuality,
          fitQuality: fitSolution.fitQuality,
          surfaceQuality: fitSolution.fitQuality,
          frameDepth: fitSolution.debugMetrics?.frameDepth,
          surfaceDepth: fitSolution.debugMetrics?.surfaceDepth,
          bridgeClearance: this.modelConfig?.frontFrameClearanceMeters ?? 0,
          filterMode: this.filterMode,
          trackingDelta: pose.rawPose?.position?.distanceTo?.(predictedPos) ?? 0,
          templeSpan: pose.metrics?.templeSpan ?? 0,
          irisSpan: pose.metrics?.irisSpan ?? 0,
          cheekSpan: pose.metrics?.cheekSpan ?? 0,
          weightedFaceSpan: pose.faceMetrics?.weightedFaceSpan ?? 0,
          rawFitScale: fitSolution.glassesTransform.scale,
          fitScale,
          frameWidthMeters: glassesModel.userData.frameWidthMeters,
          rawModelWidth: glassesModel.userData.rawBounds?.size?.[0],
          normalizedModelWidth: glassesModel.userData.normalizedBounds?.size?.[0],
          modelDepth: glassesModel.userData.naturalDepth,
          depthPivot: glassesModel.userData.depthPivot,
          noseBridgeZ: smoothPos.z,
          headQuaternion: smoothQuat ?? this.lastHeadQuaternion,
          headPosition: smoothPos ?? this.lastHeadPosition,
          predictionDelta: this.predictionDelta ?? 0,
          debugPoints: this._projectDebugPoints(anchorWorldPoints),
        })
      }

      this.lastFitScale = fitScale
      this.lastTempleSpan = pose.metrics?.templeSpan ?? 0

      this.renderer?.render(this.scene, this.camera)
    } catch (error) {
      console.error('Render loop error:', error)
    }
  }
}

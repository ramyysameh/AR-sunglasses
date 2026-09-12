/**
 * Main AR render loop that fuses face tracking, pose filtering, occlusion, and Three.js rendering.
 */
import * as THREE from 'three'
import { NEAR_ARM_YAW_DEG, TEMPLE_CURL_RAD, TEMPLE_CUT_BEHIND_EAR_M, applyCurl, applyNearArmClip, applyOffset, applySplay, buildHinges, solveSplay } from '../models/templeHinge.js'
import { EAR_LANDMARKS, EYE_LANDMARKS, NOSE_LANDMARK, headFrame } from '../occlusion/headFrame.js'
import { scaleMultiplier, xOffset, yOffset, zOffset, rotOffsetX, rotOffsetY, rotOffsetZ, trackingSmoothness } from '../config/poseConfig.js'
import { FitCalibrator } from '../fit/FitCalibrator.js'
import { LocalFaceScanner } from '../fit/LocalFaceScanner.js'
import { FaceFitSolver } from '../fit/FaceFitSolver.js'
import { coverNDC } from '../fit/coverMap.js'
import { resolveGlassesScaleMultiplier } from './glassesScale.js'
import { createLensEnvironment } from './lensEnvironment.js'
import { resolveLensReflectionConfig } from './lensReflection.js'
import { resolveFrameReflectionConfig } from './frameReflection.js'
import { OcclusionProbe, compositeFrame, evaluate } from '../debug/occlusionProbe.js'

const TRACK_LOSS_RESET_MS = 180
// Lower lead than before (was 0.85): heavy lead on an already-smoothed signal
// overshoots and recoils, which reads as rubber-banding. A light lead just
// compensates residual filter latency.
const PREDICTION_FACTOR = 0.85
const MAX_PREDICTION_SPEED = 1.2
// Rotation lead (ms) to cancel capture->detect->render latency during turns.
const ROT_LEAD_MS = 60
const MAX_ROT_LEAD_FRAMES = 4
const FALLBACK_FACE_DEPTH = -0.78
const NEAREST_DISPLAY_DEPTH = -0.62
const LOW_QUALITY_FREEZE_FRAMES = 3
const LOW_QUALITY_THRESHOLD = 0.42
// How many frontal samples the running size estimate averages over. Capped so it
// remains a long moving average and can still follow a genuine change of face.
const FRONTAL_SCALE_SAMPLES = 120
// Beyond this yaw the face mesh is too foreshortened to measure head width from.
const SPLAY_MEASURE_YAW_DEG = 12
// Sanity bounds on the measured head half-width, guarding against acting on an
// occluder that has not been populated yet.
const MIN_PLAUSIBLE_HEAD_HALF_M = 0.05
const MAX_PLAUSIBLE_HEAD_HALF_M = 0.13
// Frontal samples the head-width estimate averages over before the arms are
// opened, and how far that average must move to justify re-solving.
const HEAD_WIDTH_SAMPLES = 90
const HEAD_WIDTH_RESOLVE_M = 0.004
// Half-thickness of the horizontal slab the head is measured in, at the temple's
// own height: wide enough to always catch face-mesh vertices, narrow enough not
// to reach the shell's ear ring.
const HEAD_SLAB_HALF_M = 0.008

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
    this._frontalScaleMean = null
    this._frontalScaleCount = 0
    this.lastPredictionTimestamp = null
    this.occlusionEnabled = true
    // The flat CircleGeometry "contact shadow" reads as a grey disc on the nose,
    // so keep it off. Revisit with a proper soft/blurred shadow later if desired.
    this.contactShadowEnabled = false
    this.filterMode = 'still'
    this.motionLevel = 0
    this.lastScanStateKey = ''
    // Read here rather than in init(): setGlassesRoot/setFaceOccluder can run
    // before init, and a flag set later would leave both of them early-returning
    // with nothing ever installing the probe.
    this.probeEnabled = typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('probe') === '1'
    this._probe = null
  }

  async init() {
    // preserveDrawingBuffer stays OFF: on iOS it makes the alpha canvas render
    // as solid green (uninitialized GPU buffer). The occlusion probe reads an
    // offscreen render target instead of the canvas, so pixel verification does
    // not need it -- see src/debug/occlusionProbe.js.
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
    })

    this.renderer.setClearColor(0x000000, 0)
    // The near temple is cut at the ear plane rather than occluded there; see
    // applyNearArmClip.
    this.renderer.localClippingEnabled = true
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // AgX matches Blender's default view transform, so the frame reads with the
    // same richness/contrast as in Blender (ACES was washing it out lighter).
    this.renderer.toneMapping = THREE.AgXToneMapping ?? THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio ?? 1, 2))

    // Reflections. Ambient light casts no specular, so a glossy surface has
    // nothing to bounce; this env map is the thing being reflected. Assigned
    // per-material (never scene.environment) so lens and frame can be tuned to
    // very different strengths: the lens reads as glass, the frame only picks up
    // a restrained edge highlight. See frameReflection.js for why the frame is
    // no longer excluded outright, and ?framerefl=0 to put it back.
    this.lensReflection = resolveLensReflectionConfig(window.location.search)
    this.frameReflection = resolveFrameReflectionConfig(window.location.search)
    this.lensEnvironment = createLensEnvironment(this.renderer, {
      sunAzimuthDeg: this.lensReflection.sunAzimuthDeg,
      sunElevationDeg: this.lensReflection.sunElevationDeg,
    })
    this.lensEnvMap = this.lensEnvironment.texture

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100)
    
    this.camera._pixelWidth = this.canvas?.clientWidth ?? 640
    this.camera._pixelHeight = this.canvas?.clientHeight ?? 480

    this.camera.position.set(0, 0, 0)
    this.camera.lookAt(0, 0, -1)

    // Ambient-only DIRECT lighting: the directionals stay at 0 intensity. They are
    // what produced the hard white streak sliding across the frame as the head
    // turned, and nothing here re-enables them.
    //
    // AmbientLight contributes zero specular, which is why an authored-glossy
    // frame used to render exactly like a matte one. Specular now comes from the
    // per-material env map (frameReflection.js) instead of a directional: an env
    // reflection is broad and prefiltered, so it reads as sheen along the bevels
    // rather than a single travelling hotspot.
    const ambient = new THREE.AmbientLight(0xffffff, 1.0)
    const key = new THREE.DirectionalLight(0xffffff, 0)
    key.position.set(0.45, 1.1, 1.8)
    const fill = new THREE.DirectionalLight(0xffffff, 0)
    fill.position.set(-1.1, 0.15, 1.2)
    const rim = new THREE.DirectionalLight(0xcfe6ff, 0)
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
    this._installProbe()

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
    // Each arm gets a pivot at its own hinge so it can be opened rigidly. Built
    // per model: a new model needs new pivots, and the old ones went with it.
    this._hinges = glassesRoot ? buildHinges(glassesRoot) : null

    if (this.glassesRoot && this.scene) {
      this.scene.add(this.glassesRoot)
    }

    // The probe needs both the glasses and the occluder; they are set by
    // different callers in either order, so try from both.
    this._installProbe()

    // A new model can have a radically different fitted scale/depth (e.g. a
    // normalized frame ~1.0 vs a raw-unit frame ~0.05). Force a tracking-state
    // reset so the smoothers re-seed to the new model's target on the next
    // frame instead of easing down from the previous model's value — which
    // otherwise makes a swapped-in frame appear huge and shrink over seconds.
    this.filtersNeedReset = true
  }

  setFaceOccluder(faceOccluder) {
    this.faceOccluder = faceOccluder

    if (this.faceOccluder?.occluderMesh && this.scene && this.faceOccluder.occluderMesh.parent !== this.scene) {
      this.scene.add(this.faceOccluder.occluderMesh)
    }

    this._installProbe()
  }

  /**
   * Wires up ?probe=1 once both the glasses and the occluder exist -- the probe
   * needs to toggle each of them, and they arrive from different callers.
   */
  _installProbe() {
    if (!this.probeEnabled || this._probe || !this.glassesRoot || !this.faceOccluder) {
      return
    }

    this._probe = new OcclusionProbe({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      glassesRoot: this.glassesRoot,
      faceOccluder: this.faceOccluder,
    })

    // The objects the probe measures, exposed so the HARNESS itself can be
    // debugged. A measurement of zero is ambiguous without them -- nothing drawn
    // because it was occluded, or because the glasses were hidden that frame?
    window.__probeRefs = {
      loop: this,
      glassesRoot: this.glassesRoot,
      faceOccluder: this.faceOccluder,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
    }

    window.__probe = {
      measure: () => this._probe.measure(THREE.MathUtils.radToDeg(this.headYaw ?? 0)),
      /**
       * Advances the engine by hand: pushes a mock video frame, then runs one
       * tracking+render step for it. Needed because both the mock camera and
       * this loop are rAF-driven, and rAF stops when the page is not painted.
       */
      tick: (frames = 1) => {
        for (let i = 0; i < frames; i += 1) {
          window.__mock?.step(1)
          this._step()
        }
      },
      /**
       * Walks every mock frame and scores the result.
       *
       * Settles by STEPPING FRAMES rather than sleeping. The video frame,
       * MediaPipe's landmarks and the smoothed pose each lag a pin by several
       * frames, so measuring immediately reports the previous pose -- but
       * waiting on wall time made the sweep depend on how fast the page happened
       * to be running, which is exactly what made earlier runs unreproducible
       * (three settings silently sampled three different parts of the turn).
       * A frame count is the same on any machine, and works while throttled.
       *
       * It has to yield between steps even so. requestFrame() only QUEUES a
       * frame onto the capture track; the <video> element picks it up when the
       * event loop turns, so a fully synchronous settle loop leaves the video
       * frozen on the previous pose and every row reports the same angle. The
       * yield is what lets the media pipeline deliver -- the frame count, not
       * the elapsed time, is still what defines the settle.
       */
      /**
       * Captures the composited view at one mock frame and writes it to disk via
       * the harness, returning the path. This is how an automated run SEES its
       * own work instead of asking a human to look.
       */
      shot: async (name, { frame = null, settleFrames = 14 } = {}) => {
        if (frame != null) window.__mock?.pin(frame)
        for (let f = 0; f < settleFrames; f += 1) {
          window.__probe.tick(1)
          await new Promise((r) => setTimeout(r, 16))
        }
        const dataUrl = compositeFrame(this._probe, this.video)
        const response = await fetch('/__shot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, dataUrl }),
        })
        return { ...(await response.json()), yaw: Math.round(THREE.MathUtils.radToDeg(this.headYaw ?? 0) * 10) / 10 }
      },

      /** Captures a whole turn, so a sweep can be reviewed as pictures. */
      sheet: async (prefix, frames, opts) => {
        const shots = []
        for (const frame of frames) shots.push(await window.__probe.shot(`${prefix}-f${frame}`, { frame, ...opts }))
        window.__mock?.release()
        return shots
      },

      /**
       * DISCARD THE FIRST SWEEP AFTER A PAGE LOAD.
       *
       * The fit keeps converging for a few seconds after the scan locks, so the
       * first pass reads worse than the engine settles to. Measured back to back
       * on one pose set: sweep 1 gave 0.123 short with 18 px of hole, sweeps 2-4
       * gave 0.056 and 9. Both are real; only the later ones are the steady
       * state, and a tuning pass driven by the first is chasing a transient.
       */
      sweep: async ({ settleFrames = 14, step = 1 } = {}) => {
        const mock = window.__mock
        if (!mock) return { error: 'no mock camera: use ?mock=turn' }
        const rows = []
        for (let i = 0; i < mock.frameCount; i += step) {
          mock.pin(i)
          for (let f = 0; f < settleFrames; f += 1) {
            window.__probe.tick(1)
            await new Promise((r) => setTimeout(r, 16))
          }
          rows.push({ frame: i, ...window.__probe.measure() })
        }
        mock.release()
        return { rows, ...evaluate(rows) }
      },
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
    this._frontalScaleMean = null
    this._frontalScaleCount = 0
    this._lastRotQuat = null
    this._angVelQ = null
  }

  // Opt-in live fit readout (visit with ?fitdbg=1). Shows what actually moves
  // during a head turn so the "shrinks / moves forward on big turns" report can
  // be measured on a real camera, which the pre-rendered mock can't reach.
  _updateFitDebugOverlay(data) {
    if (this._fitDbg === undefined) {
      this._fitDbg = new URLSearchParams(window.location.search).get('fitdbg') === '1'
    }
    if (!this._fitDbg) return
    if (!this._fitDbgEl) {
      const el = document.createElement('div')
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;font:12px/1.5 monospace;' +
        'color:#7fffd4;background:rgba(0,0,0,.72);padding:8px 10px;border-radius:8px;white-space:pre;pointer-events:none'
      document.body.appendChild(el)
      this._fitDbgEl = el
      this._fitDbgPeak = 0
    }
    const yaw = Math.abs(data.yaw)
    if (yaw > this._fitDbgPeak) this._fitDbgPeak = yaw
    this._fitDbgEl.textContent =
      `yaw      ${data.yaw.toFixed(1)}°  (peak ${this._fitDbgPeak.toFixed(0)}°)\n` +
      // Show what the solver actually asked for whenever the limits overrode it.
      // A frame sitting exactly on its ceiling reads as a confident fit here and
      // is really the solver requesting a size it is not allowed to have.
      `scale    applied ${data.scale.toFixed(4)}  target ${data.raw.toFixed(4)}` +
      `${data.clamped ? `  WANTED ${Number(data.fittedRaw).toFixed(4)}` : ''}\n` +
      `depth z  ${data.z.toFixed(4)}  (more -neg = farther)\n` +
      `fitQual  ${(data.quality ?? 0).toFixed(2)}`
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

  _predictRotation(quat, timestamp) {
    if (!this._lastRotQuat) {
      this._lastRotQuat = quat.clone()
      this._lastRotT = timestamp
      this._angVelQ = null
      return quat.clone()
    }

    const dt = Math.max((timestamp - (this._lastRotT ?? timestamp)) / 1000, 1 / 120)
    // Incremental rotation since last frame (the per-frame angular velocity).
    const delta = this._lastRotQuat.clone().invert().multiply(quat)
    this._lastRotQuat = quat.clone()
    this._lastRotT = timestamp

    // Smooth the angular velocity so the lead doesn't amplify per-frame noise.
    if (!this._angVelQ) {
      this._angVelQ = delta.clone()
    } else {
      this._angVelQ.slerp(delta, 0.4)
    }

    const motion = this.motionLevel ?? 0
    // Predict ahead by ~ROT_LEAD_MS, scaled by how much the head is actually
    // moving (zero lead at rest -> no jitter; full lead mid-turn -> no trailing).
    const leadFrames = THREE.MathUtils.clamp((ROT_LEAD_MS / 1000) / dt, 0, MAX_ROT_LEAD_FRAMES) * motion
    if (leadFrames <= 0.01) {
      return quat.clone()
    }

    // slerp(t>1) extrapolates along the same arc -> leads the rotation.
    const lead = new THREE.Quaternion().slerp(this._angVelQ, leadFrames)
    return quat.clone().multiply(lead)
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
      // More sensitive: a head turn should hit full motion quickly so the filters
      // open up immediately and the glasses don't trail the turn.
      angularMotion = THREE.MathUtils.clamp(angularSpeed / 0.6, 0, 1)
    }

    const rawMotion = Math.max(linearMotion, angularMotion)
    // Deadzone: ignore tiny motion (landmark noise + involuntary sway) so the
    // filter stays in its heavily-smoothed "still" mode at rest and doesn't jitter.
    // Real movement still ramps motion to 1 for full responsiveness.
    // Wider deadzone (was 0.12): tracking is noisier when the head is held at an
    // angle, and that noise was tripping the gate out of "still" mode and jittering.
    // A bigger deadzone keeps any held pose (forward OR turned) in heavy smoothing.
    const deadzone = 0.28
    const motion = THREE.MathUtils.clamp((rawMotion - deadzone) / (1 - deadzone), 0, 1)
    // The detector runs slower than the render loop, so a fresh pose arrives only
    // every ~2nd frame; the in-between (near-duplicate) frame reads as "still".
    // Using that raw value directly whipsaws motion 1->0->1 each frame, which flips
    // the filter cutoffs and the rotation lead on/off and shows up as rotational
    // shake on a tilt. Fast attack (follow real acceleration immediately), slow
    // release (ride through the duplicate frame instead of collapsing to 0).
    const prevMotion = this.motionLevel ?? 0
    this.motionLevel = motion > prevMotion
      ? motion
      : THREE.MathUtils.lerp(prevMotion, motion, 0.3)
    const smoothedMotion = this.motionLevel
    this.filterMode = smoothedMotion > 0.55 ? 'fast' : smoothedMotion > 0.2 ? 'moving' : 'still'

    // Global user smoothness knob (debug panel). Neutral at 0.5; >0.5 lowers the
    // cutoffs (smoother/laggier), <0.5 raises them (snappier/jitterier).
    const smoothFactor = Math.pow(0.4, (trackingSmoothness - 0.5) * 2)

    // Very low base cutoff = strong smoothing on any held pose (no jitter); high
    // ceiling = tight tracking during real movement so the face doesn't clip the frame.
    // Lower rest cutoffs = stronger smoothing when (nearly) still, so residual
    // landmark noise doesn't jitter the frame; high ceilings keep it responsive
    // once real movement ramps `motion` up.
    this.positionFilter?.setParams({
      minCutoff: THREE.MathUtils.lerp(0.40, 6.0, smoothedMotion) * smoothFactor,
      beta: THREE.MathUtils.lerp(0.010, 0.22, smoothedMotion) * smoothFactor,
      dCutoff: 1.0,
    })

    this.rotationFilter?.setParams({
      minCutoff: THREE.MathUtils.lerp(0.35, 6.0, smoothedMotion) * smoothFactor,
      beta: THREE.MathUtils.lerp(0.02, 0.30, smoothedMotion) * smoothFactor,
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
    const { ndcX, ndcY } = coverNDC(anchor, this.camera)

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
    const baseDamping = Number.isFinite(this.modelConfig?.fitDamping) ? this.modelConfig.fitDamping : 0.18

    // Every 2D face metric foreshortens with yaw, so the fitted size wobbles when
    // the head isn't frontal. Only re-fit the size when near-frontal AND fairly
    // still; hold it steady through turns (the face isn't actually resizing).
    const yawAbs = Math.abs(this.headYaw ?? 0)
    const frontal = yawAbs < THREE.MathUtils.degToRad(5)

    // Frontal samples feed a RUNNING MEAN rather than easing an EMA toward
    // whatever the latest sample happens to be.
    //
    // The freeze below holds the size through a turn, so the held value is
    // whatever the EMA reached during the brief window the head was frontal --
    // and that window is short, so it never fully converged. Each pass latched a
    // different number and the whole turn inherited it: measured 1.1966 sweeping
    // one way against 1.1755 the other, a 1.8% step at the crossing that read as
    // the frame changing size depending on which way the head had turned.
    //
    // A face's width does not change, so every good frontal sample is an
    // estimate of the same constant and averaging them is strictly better than
    // taking the most recent. The mean is direction-independent, which is what
    // removes the hysteresis, and it keeps converging the longer a face is seen.
    if (frontal && Number.isFinite(clampedScale)) {
      this._frontalScaleCount = Math.min((this._frontalScaleCount ?? 0) + 1, FRONTAL_SCALE_SAMPLES)
      this._frontalScaleMean = this._frontalScaleMean == null
        ? clampedScale
        : this._frontalScaleMean + (clampedScale - this._frontalScaleMean) / this._frontalScaleCount
    }

    // Capped count, so it stays a long moving average rather than becoming
    // immovable -- a different person in front of the camera still takes effect.
    const target = this._frontalScaleMean ?? clampedScale
    const damping = frontal
      ? THREE.MathUtils.lerp(baseDamping, 0.004, this.motionLevel ?? 0)
      : 0.0

    this.smoothedScale = this.smoothedScale === null
      ? target
      : THREE.MathUtils.lerp(this.smoothedScale, target, damping)

    return this.smoothedScale
  }

  _applyTransform(transform) {
    if (!this.glassesRoot || !transform) {
      return
    }

    // Global glasses-size fine-tune — see src/core/glassesScale.js. Fit scale
    // is computed device/container-independently at the source (FaceFitSolver),
    // so this is just a manual ?gscale=<n> override, 1.0 otherwise.
    if (this._glassesScaleMultiplier == null) {
      this._glassesScaleMultiplier = resolveGlassesScaleMultiplier(window.location.search)
    }
    // Vertical placement fine-tune, in world metres (negative = lower on the
    // nose). ?voffset=<n> overrides for live tuning; otherwise the per-model
    // config value (block models nudge down slightly); 0 by default.
    if (this._urlVerticalOffset === undefined) {
      const v = parseFloat(new URLSearchParams(window.location.search).get('voffset'))
      this._urlVerticalOffset = Number.isFinite(v) ? v : null
    }
    const verticalOffset = this._urlVerticalOffset ?? this.modelConfig?.verticalOffset ?? 0
    const scale = transform.scale * this._glassesScaleMultiplier

    this.glassesRoot.visible = true
    this.glassesRoot.position.copy(transform.position)
    this.glassesRoot.position.y += verticalOffset
    this.glassesRoot.quaternion.copy(transform.quaternion)
    this.glassesRoot.scale.setScalar(scale)

    if (this.contactShadow) {
      this.contactShadow.visible = true
      this.contactShadow.visible = this.contactShadowEnabled
      this.contactShadow.position.copy(transform.surfaceSolution?.bridgeWorld ?? transform.position)
      this.contactShadow.position.y -= 0.012 * scale
      this.contactShadow.position.z += 0.006 * scale
      this.contactShadow.quaternion.copy(transform.quaternion)
      this.contactShadow.scale.setScalar(scale)
    }

    if (!this.occlusionEnabled) {
      this.faceOccluder?.hide?.()
    } else if (transform.occlusionMesh?.faceWorldPoints) {
      // Smooth the mask like the frame: heavy at rest (kills nose-bridge jitter),
      // tight during motion so the mask still tracks the face without lag.
      const occluderAlpha = THREE.MathUtils.lerp(0.15, 0.9, this.motionLevel ?? 0)
      this.faceOccluder?.updateFromFaceMesh?.(
        transform.occlusionMesh.faceWorldPoints,
        transform.anchorWorldPoints,
        occluderAlpha,
        transform.occluderCorrection,
        // The frame's OWN rotation, for the same reason occluderCorrection is the
        // frame's own position delta: the head shell extrudes along this axis, so
        // the surface the temple arm hides behind is locked to the arm by
        // construction instead of by two smoothing curves agreeing.
        transform.quaternion
      )
    } else if (transform.anchorWorldPoints) {
      this.faceOccluder?.updateFromAnchors(transform.anchorWorldPoints)
    } else if (transform.occluderMatrix) {
      this.faceOccluder?.update(transform.occluderMatrix)
    }

    this._openTemples(transform)
    this._clipNearArm(transform)
  }

  /**
   * Opens both temples far enough to clear the head they are being worn on.
   *
   * Measured NEAR-FRONTAL only and then held. Off-frontal the face mesh is
   * foreshortened and half self-occluded so its apparent width shrinks with yaw;
   * re-measuring through a turn would open and close the arms as the head moved.
   * A head's width does not change, so measuring it once is right.
   *
   * Both arms take the SAME angle, the larger of the two solves: letting each
   * side follow its own measurement turns noise into a visibly crooked frame.
   */
  _openTemples(transform) {
    if (!this._hinges?.length || !this.faceOccluder?.occluderMesh) {
      return
    }
    if (!this.faceOccluder.occluderMesh.visible) {
      return
    }
    if (Math.abs(THREE.MathUtils.radToDeg(this.headYaw ?? 0)) > SPLAY_MEASURE_YAW_DEG) {
      return
    }

    const position = this.faceOccluder.occluderMesh.geometry.attributes.position
    if (position.count <= Math.max(...EAR_LANDMARKS)) {
      return
    }

    // About the EAR MIDPOINT, not the frame's own anchors. A head's width is a
    // property of the head, and measuring it from wherever a particular model
    // happens to put its temple anchors makes it a property of the glasses:
    // on one mock head GRIPZ read 105.2 mm and WILLOW 111.9 mm, which is enough
    // to send a solve keyed on it 3 degrees apart between two frames that need
    // the same answer.
    const axX = (this._splayAxX ??= new THREE.Vector3()).set(1, 0, 0).applyQuaternion(transform.quaternion)
    const axY = (this._splayAxY ??= new THREE.Vector3()).set(0, 1, 0).applyQuaternion(transform.quaternion)
    const mid = (this._splayMid ??= new THREE.Vector3())
    const ear = (this._splayEar ??= new THREE.Vector3())
    mid.set(0, 0, 0)
    for (const index of EAR_LANDMARKS) {
      ear.fromBufferAttribute(position, index).applyMatrix4(this.faceOccluder.occluderMesh.matrixWorld)
      mid.add(ear)
    }
    mid.multiplyScalar(1 / EAR_LANDMARKS.length)

    // How high the arm rides above the ear plane, so the head can be measured
    // at THAT height rather than at its widest point anywhere.
    const armTmp = (this._splayArmTmp ??= new THREE.Vector3())
    let armHeight = 0
    for (const hinge of this._hinges) {
      hinge.curl?.getWorldPosition(armTmp)
      armHeight += armTmp.sub(mid).dot(axY)
    }
    armHeight /= this._hinges.length

    // The head's half-width WHERE THE TEMPLE RUNS. Taking the whole occluder's
    // maximum instead aims the arm at a shell vertex 25.6 mm above the ear plane
    // reading 101.9 mm, while the temple rides 38.8 mm up where the face is
    // 90.0 -- 12 mm of reach the arm does not need, which is what put it around
    // the outside of the ear instead of along the head.
    let headHalfWidth = 0
    for (let i = 0; i < position.count; i += 1) {
      const dx = position.getX(i) - mid.x
      const dy = position.getY(i) - mid.y
      const dz = position.getZ(i) - mid.z
      if (Math.abs(dx * axY.x + dy * axY.y + dz * axY.z - armHeight) > HEAD_SLAB_HALF_M) continue
      const d = Math.abs(dx * axX.x + dy * axX.y + dz * axX.z)
      if (d > headHalfWidth) headHalfWidth = d
    }
    // A plausible human half-head is ~0.05-0.13 m in this space. Outside that
    // the occluder was not ready, and acting on it opens the arms to fit a head
    // that is not there.
    if (!(headHalfWidth > MIN_PLAUSIBLE_HEAD_HALF_M && headHalfWidth < MAX_PLAUSIBLE_HEAD_HALF_M)) {
      return
    }
    // Average before acting. A head's width does not change but the MEASURED
    // width does: inside this same gate it swings 110.6 to 128.9 mm on the mock
    // purely from foreshortening, and the solve is no longer saturated, so that
    // would now be visible movement rather than a number nobody sees.
    this._headWidthCount = Math.min((this._headWidthCount ?? 0) + 1, HEAD_WIDTH_SAMPLES)
    this._headWidthMean = this._headWidthMean == null
      ? headHalfWidth
      : this._headWidthMean + (headHalfWidth - this._headWidthMean) / this._headWidthCount
    if (this._splayForWidth != null && Math.abs(this._headWidthMean - this._splayForWidth) < HEAD_WIDTH_RESOLVE_M) {
      return
    }

    const scale = this.glassesRoot?.scale?.x || 1
    let angle = 0
    for (const hinge of this._hinges) {
      const solved = solveSplay(this._headWidthMean, hinge.armLateral * scale, hinge.jointDepth * scale)
      if (solved > angle) angle = solved
    }

    applyOffset(this._hinges, 0)
    applySplay(this._hinges, angle)
    applyCurl(this._hinges, TEMPLE_CURL_RAD)
    this.glassesRoot?.updateWorldMatrix(true, true)
    this._splayForWidth = this._headWidthMean
    this._splayAngle = angle
  }

  /**
   * Points the near-arm cut at the ear plane, once per frame.
   *
   * The plane has to be rebuilt every frame because it is the HEAD's, and it
   * moves with the head; the arm's own geometry cannot stand in for it. An
   * earlier version cut at the articulation joint instead, which is fixed in the
   * frame's own space -- it drifts up to 18 mm from the ear plane as the head
   * turns, and the arm visibly ended short of the ear at some angles and left a
   * detached fragment past it at others.
   */
  _clipNearArm(transform) {
    if (!this._hinges?.length || !this.faceOccluder?.occluderMesh) {
      return
    }
    const position = this.faceOccluder.occluderMesh.geometry.attributes.position
    if (!this.faceOccluder.occluderMesh.visible || position.count <= Math.max(...EAR_LANDMARKS)) {
      applyNearArmClip(this._hinges, 0, null, null)
      return
    }

    const yaw = THREE.MathUtils.radToDeg(this.headYaw ?? 0)
    const nearSide = Math.abs(yaw) < NEAR_ARM_YAW_DEG ? 0 : (yaw >= 0 ? -1 : 1)
    if (nearSide === 0) {
      applyNearArmClip(this._hinges, 0, null, null)
      return
    }

    // The head's OWN frame, not the pose quaternion's +Z. Those sit about 29
    // degrees apart, and the cut has to be the same plane the metric measures
    // against or the arm being scored is not the arm being drawn.
    const world = this.faceOccluder.occluderMesh.matrixWorld
    const at = (index, into) => into.fromBufferAttribute(position, index).applyMatrix4(world)
    const frame = headFrame(
      at(EAR_LANDMARKS[0], (this._clipA ??= new THREE.Vector3())),
      at(EAR_LANDMARKS[1], (this._clipB ??= new THREE.Vector3())),
      at(EYE_LANDMARKS[0], (this._clipC ??= new THREE.Vector3())),
      at(EYE_LANDMARKS[1], (this._clipD ??= new THREE.Vector3())),
      at(NOSE_LANDMARK, (this._clipE ??= new THREE.Vector3())),
      { origin: (this._clipMid ??= new THREE.Vector3()), forward: (this._clipForward ??= new THREE.Vector3()) },
    )
    if (!frame) {
      applyNearArmClip(this._hinges, 0, null, null)
      return
    }

    // Behind the tragion, not on it: the tragion is the ear's FRONT edge, so a
    // cut there sits on bare skin instead of inside the ear's outline.
    const cutAt = (this._clipCutAt ??= new THREE.Vector3())
      .copy(frame.origin)
      .addScaledVector(frame.forward, -TEMPLE_CUT_BEHIND_EAR_M)
    const plane = (this._clipPlane ??= new THREE.Plane())
    plane.setFromNormalAndCoplanarPoint(frame.forward, cutAt)
    const behind = (this._clipBehind ??= new THREE.Plane())
    behind.setFromNormalAndCoplanarPoint(
      (this._clipBack ??= new THREE.Vector3()).copy(frame.forward).negate(),
      cutAt,
    )
    applyNearArmClip(this._hinges, nearSide, plane, behind)
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
    const { ndcX, ndcY } = coverNDC(anchor, this.camera)

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

  dispose() {
    this.stop()
    this.lensEnvironment?.dispose?.()
    this.lensEnvironment = null
    this.lensEnvMap = null
  }

  _syncSize() {
    if (!this.renderer || !this.camera) {
      return
    }

    // Render at the DISPLAY (canvas) size so the overlay buffer matches what's
    // on screen — never CSS-stretched to a different aspect than it was rendered.
    const dispW = this.canvas?.clientWidth || this.video?.videoWidth || this.lastWidth || 1
    const dispH = this.canvas?.clientHeight || this.video?.videoHeight || this.lastHeight || 1

    // Keep both coordinate spaces so landmark projection can undo the video's
    // object-fit:cover crop (see coverNDC).
    this.camera._videoW = this.video?.videoWidth || dispW
    this.camera._videoH = this.video?.videoHeight || dispH
    this.camera._clientW = dispW
    this.camera._clientH = dispH
    this.camera._pixelWidth = dispW
    this.camera._pixelHeight = dispH

    // Always keep the camera aspect locked to the DISPLAY — covers the case where
    // the camera was just rebuilt (video change) with a different aspect.
    const aspect = dispW / dispH
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect
      this.camera.updateProjectionMatrix()
    }

    if (dispW === this.lastWidth && dispH === this.lastHeight) {
      return
    }

    this.lastWidth = dispW
    this.lastHeight = dispH
    this.renderer.setSize(dispW, dispH, false)
  }

  _frame() {
    if (!this.running) {
      return
    }

    this.rafId = requestAnimationFrame(() => this._frame())
    this._step()
  }

  /**
   * One frame of tracking and rendering, with no scheduling of its own.
   *
   * Split out so a harness can drive the engine directly. requestAnimationFrame
   * is throttled to a crawl whenever the page is not being painted, so with the
   * preview pane hidden the whole pipeline stalls: the scan never locks, the
   * glasses stay hidden, and every measurement comes back empty. Stepping this
   * by hand makes automated runs independent of whether anyone is watching --
   * and deterministic, since a step is a frame rather than a slice of wall time.
   */
  _step() {
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
      const filteredQuat = this.rotationFilter
        ? this.rotationFilter.filter(fitSolution.glassesTransform.quaternion, timestamp)
        : fitSolution.glassesTransform.quaternion.clone()
      // Apply the user's rotation fine-tune (debug panel) on top of the tracked pose.
      const smoothQuat = filteredQuat.clone()
      if (rotOffsetX || rotOffsetY || rotOffsetZ) {
        smoothQuat.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(rotOffsetX),
          THREE.MathUtils.degToRad(rotOffsetY),
          THREE.MathUtils.degToRad(rotOffsetZ),
          'XYZ'
        )))
      }
      // Lead the rotation to cancel pipeline latency so it doesn't trail a turn.
      const predictedQuat = this._predictRotation(smoothQuat, timestamp)

      // Use the SAME yaw the solver used for its depth-hold, so the size-freeze and
      // the depth-hold engage together (no out-of-sync transition that shrinks).
      this.headYaw = Number.isFinite(fitSolution.headYaw)
        ? fitSolution.headYaw
        : new THREE.Euler().setFromQuaternion(predictedQuat, 'YXZ').y

      const predictedPos = this._predictPosition(smoothPos)
      // Depth (z) jitter damping. (Yaw-induced depth inflation is now handled at
      // the source in FaceFitSolver, so x/y/z stay consistent.)
      const depthAlpha = THREE.MathUtils.lerp(0.05, 0.85, this.motionLevel ?? 0)
      this.smoothedDepth = this.smoothedDepth == null
        ? predictedPos.z
        : THREE.MathUtils.lerp(this.smoothedDepth, predictedPos.z, depthAlpha)
      predictedPos.z = this.smoothedDepth
      // The occluder mesh is built from RAW per-frame landmarks (it has to be,
      // to deform to the actual face shape), while the frame above just went
      // through OneEuro smoothing + predictive lead + this same depth damping.
      // Two independently-filtered systems drift relative to each other frame
      // to frame, which shows up as jitter exactly where they visually meet
      // (the nose bridge). Passing this exact delta into the occluder locks
      // its OVERALL position to the frame's, by construction, instead of
      // hoping two separately-tuned smoothing curves happen to agree.
      const occluderCorrection = predictedPos.clone().sub(tunedPosition)
      const fitScale = this._smoothSolvedScale(fitSolution.glassesTransform.scale)
      this._updateFitDebugOverlay({
        yaw: THREE.MathUtils.radToDeg(this.headYaw ?? 0),
        scale: fitScale,
        raw: fitSolution.glassesTransform.scale,
        fittedRaw: fitSolution.fittedScaleRaw,
        clamped: fitSolution.scaleClamped,
        z: predictedPos.z,
        quality: fitSolution.fitQuality,
      })
      const transform = {
        position: predictedPos,
        quaternion: predictedQuat,
        scale: fitScale,
        anchorWorldPoints,
        occlusionMesh: fitSolution.occlusionMesh,
        occluderCorrection,
        fitSolution,
      }

      this._applyTransform(transform)
      this.lastGoodTransform = {
        position: predictedPos.clone(),
        quaternion: predictedQuat.clone(),
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
          headQuaternion: predictedQuat ?? this.lastHeadQuaternion,
          headPosition: predictedPos ?? this.lastHeadPosition,
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

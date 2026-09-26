/**
 * MediaPipe FaceLandmarker wrapper that returns the raw per-frame result for the AR pipeline.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

// Served from this engine's own origin, never a third party: the shopper's
// browser must not reach Google or jsDelivr just to open the try-on (the
// privacy policy says no shopper data goes anywhere else), and an outage there
// must not break it. scripts/copy-mediapipe.mjs stages the wasm under a
// versioned path; MEDIAPIPE_VERSION must match the installed package
// (test/tryon/mediapipeAssets.test.js). The model is the float16 v1 face
// landmarker, committed under public/mediapipe/.
export const MEDIAPIPE_VERSION = '0.10.35'
const BASE_URL = import.meta.env?.BASE_URL ?? '/'
export const DEFAULT_MODEL_URL = `${BASE_URL}mediapipe/face_landmarker-float16-v1.task`
export const DEFAULT_WASM_ROOT = `${BASE_URL}mediapipe/${MEDIAPIPE_VERSION}/wasm`

export class FaceTracker {
  constructor(options = {}) {
    this.modelAssetPath = options.modelAssetPath ?? DEFAULT_MODEL_URL
    this.wasmRoot = options.wasmRoot ?? DEFAULT_WASM_ROOT
    this.faceLandmarker = null
    this.lastVideoTime = null
    this.lastResult = null
    this.lastDetectionWasFresh = false
    this.lastDetectionTimestamp = null
    this.frameIntervalMs = 1000 / 30
  }

  async init() {
    const filesetResolver = await FilesetResolver.forVisionTasks(this.wasmRoot)

    this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
      baseOptions: {
        modelAssetPath: this.modelAssetPath,
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    })

    return this
  }

  detect(videoElement, timestamp = performance.now()) {
    if (!this.faceLandmarker || !videoElement || videoElement.readyState < 2) {
      return null
    }

    const videoTime = Number(videoElement.currentTime)
    if (Number.isFinite(videoTime) && videoTime === this.lastVideoTime) {
      this.lastDetectionWasFresh = false
      return this.lastResult
    }

    this.lastResult = this.faceLandmarker.detectForVideo(videoElement, timestamp)
    if (this.lastDetectionTimestamp != null) {
      const observedInterval = timestamp - this.lastDetectionTimestamp
      if (observedInterval >= 8 && observedInterval <= 100) {
        this.frameIntervalMs += (observedInterval - this.frameIntervalMs) * 0.2
      }
    }
    this.lastDetectionTimestamp = timestamp
    this.lastVideoTime = Number.isFinite(videoTime) ? videoTime : null
    this.lastDetectionWasFresh = true
    return this.lastResult
  }

  dispose() {
    this.faceLandmarker?.close?.()
    this.faceLandmarker = null
    this.lastVideoTime = null
    this.lastResult = null
    this.lastDetectionWasFresh = false
    this.lastDetectionTimestamp = null
    this.frameIntervalMs = 1000 / 30
  }
}

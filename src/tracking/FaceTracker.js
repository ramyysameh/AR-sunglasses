/**
 * MediaPipe FaceLandmarker wrapper that returns the raw per-frame result for the AR pipeline.
 */
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

const DEFAULT_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const DEFAULT_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm'

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

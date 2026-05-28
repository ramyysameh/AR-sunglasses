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
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    })

    return this
  }

  detect(videoElement, timestamp = performance.now()) {
    if (!this.faceLandmarker || !videoElement || videoElement.readyState < 2) {
      return null
    }

    return this.faceLandmarker.detectForVideo(videoElement, timestamp)
  }

  dispose() {
    this.faceLandmarker?.close?.()
    this.faceLandmarker = null
  }
}

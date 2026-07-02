import * as THREE from 'three'
import { FaceTracker } from '../../tracking/FaceTracker.js'
import { LandmarkProcessor } from '../../tracking/LandmarkProcessor.js'
import { VectorFilter } from '../../filters/VectorFilter.js'
import { QuaternionFilter } from '../../filters/QuaternionFilter.js'
import { FaceOccluder } from '../../occlusion/FaceOccluder.js'
import { GlassesModelLoader } from '../../models/GlassesModelLoader.js'
import { DebugHUD } from '../../debug/DebugHUD.js'
import { RenderLoop } from '../../core/RenderLoop.js'
import { LocalFaceScanner } from '../../fit/LocalFaceScanner.js'
import { getGlassesConfig, getGlassesModelUrl } from '../../config/arConfig.js'
import { TryOnEventEmitter } from '../TryOnEventEmitter.js'
import { CameraError, describeCameraError } from '../../support/capabilities.js'

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop())
}

export class MediaPipeThreeProvider extends TryOnEventEmitter {
  constructor() {
    super()
    this.name = 'mediapipe'
    this.container = null
    this.video = null
    this.canvas = null
    this.loadingEl = null
    this.config = null
    this.stream = null
    this.renderLoop = null
    this.faceTracker = null
    this.landmarkProcessor = null
    this.glassesLoader = null
    this.currentSkuKey = null
    this.resizeHandler = null
    this.debugEnabled = false
  }

  async init(container, config = {}) {
    this.container = container
    this.config = config
    this.video = config.video ?? container?.querySelector?.('video')
    this.canvas = config.canvas ?? container?.querySelector?.('canvas')
    this.loadingEl = config.loadingEl ?? container?.querySelector?.('#loading')
    this.debugEnabled = config.debugEnabled ?? false

    if (!this.video || !this.canvas) {
      throw new Error('MediaPipe fallback needs both a video element and an overlay canvas.')
    }

    this._prepareDom()
    this._setLoading('Starting camera...')
    await this._startCamera()

    this._setLoading('Loading face tracker...')
    this.faceTracker = await new FaceTracker().init()
    this.landmarkProcessor = new LandmarkProcessor()

    this._setLoading('Loading render pipeline...')
    // In mock mode the "face" is a static image, so the head-turn calibration
    // can never complete — relax the scanner to lock on from the front view only.
    const mockParam = new URLSearchParams(window.location.search).get('mock')
    const mockMode = mockParam === '1' || mockParam === 'turn'
    const localFaceScanner = mockMode
      ? new LocalFaceScanner({ stageTargets: { front: 5, yawLeft: 0, yawRight: 0, neutralReturn: 0 } })
      : undefined
    this.renderLoop = await new RenderLoop({
      canvas: this.canvas,
      video: this.video,
      positionFilter: new VectorFilter(),
      rotationFilter: new QuaternionFilter(),
      onScanStateChange: (scanState) => this._updateScanMessage(scanState),
      ...(localFaceScanner ? { localFaceScanner } : {}),
    }).init()

    this.renderLoop.camera = this._initCamera()
    this.resizeHandler = () => this._checkVideoResize()
    this.video.addEventListener('loadedmetadata', this.resizeHandler)
    window.addEventListener('resize', this.resizeHandler)

    this.glassesLoader = await new GlassesModelLoader().init()
    await this.loadSku(config.defaultSkuKey)

    const faceOccluder = await new FaceOccluder().init(this.renderLoop.scene)
    const hud = await new DebugHUD().init(container, {
      initialParams: this.renderLoop.getFilterSettings(),
      onParamsChange: (params) => this.renderLoop.setFilterParams(params),
    })
    // Debug control sidebar is always shown so position/scale/rotation/tracking
    // can be tuned live. (Previously gated behind ?debug=1.)
    hud.setVisible(true)

    this.renderLoop.setFaceOccluder(faceOccluder)
    this.renderLoop.setHud(hud)
    this.renderLoop.setFilterParams(hud.params)
    this.emit('ready', { provider: this.name, sku: this.currentSkuKey })

    return this
  }

  async start() {
    const modelConfig = getGlassesConfig(this.currentSkuKey)
    this.renderLoop.start({
      faceTracker: this.faceTracker,
      landmarkProcessor: this.landmarkProcessor,
      modelConfig,
    })
    this.emit('tracking', { provider: this.name, sku: this.currentSkuKey })
  }

  async stop() {
    this.renderLoop?.stop?.()
    this.emit('trackingLost', { provider: this.name })
  }

  async loadSku(skuKey) {
    const modelConfig = getGlassesConfig(skuKey)
    const glassesRoot = await this.glassesLoader.load(getGlassesModelUrl(skuKey), skuKey)

    this.currentSkuKey = skuKey
    this.renderLoop.setModelConfig(modelConfig)
    this.renderLoop.setGlassesRoot(glassesRoot)
  }

  async capture() {
    if (!this.renderLoop?.renderer) {
      return null
    }

    const width = this.video.videoWidth || this.canvas.width || 1280
    const height = this.video.videoHeight || this.canvas.height || 720
    const captureCanvas = document.createElement('canvas')
    const ctx = captureCanvas.getContext('2d')

    captureCanvas.width = width
    captureCanvas.height = height
    ctx.drawImage(this.video, 0, 0, width, height)
    ctx.drawImage(this.renderLoop.renderer.domElement, 0, 0, width, height)

    const result = {
      dataUrl: captureCanvas.toDataURL('image/png'),
      filename: `${this.currentSkuKey ?? 'tryon'}-mediapipe-tryon.png`,
    }

    this.emit('captureReady', result)

    return result
  }

  async destroy() {
    await this.stop()
    this.video?.removeEventListener?.('loadedmetadata', this.resizeHandler)
    window.removeEventListener('resize', this.resizeHandler)
    this.faceTracker?.dispose?.()
    stopStream(this.stream)
    this.stream = null
    this.container?.classList?.remove('is-mediapipe-provider')
  }

  _prepareDom() {
    this.container?.classList?.add('is-mediapipe-provider')
    this.video.style.display = 'block'
    this.canvas.style.display = 'block'
    this.video.style.transform = 'scaleX(-1)'
  }

  async _startCamera() {
    // Dev/preview: ?mock=1 feeds a static face image instead of the webcam,
    // so the AR pipeline can be previewed without camera access.
    const mock = new URLSearchParams(window.location.search).get('mock')
    if (mock === '1' || mock === 'turn') {
      await this._startMockCamera()
      return
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: this.config.camera?.width ?? 1280 },
          height: { ideal: this.config.camera?.height ?? 720 },
        },
        audio: false,
      })
    } catch (error) {
      throw new CameraError(describeCameraError(error), error)
    }

    this.video.srcObject = this.stream
    this.video.muted = true
    this.video.playsInline = true

    await new Promise((resolve) => {
      if (this.video.readyState >= 1 && this.video.videoWidth > 0 && this.video.videoHeight > 0) {
        resolve()
        return
      }

      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true })
    })

    try {
      await this.video.play()
    } catch (error) {
      if (error?.name !== 'AbortError') {
        throw error
      }

      await new Promise((resolve) => requestAnimationFrame(() => resolve()))
      await this.video.play()
    }
  }

  async _startMockCamera() {
    // ?mock=1   -> static virtual face
    // ?mock=turn-> virtual face that oscillates left/right (to test head turns)
    const mode = new URLSearchParams(window.location.search).get('mock')
    const cb = Date.now()

    let images
    if (mode === 'turn') {
      const N = 9
      images = await Promise.all(
        Array.from({ length: N }, (_, i) => {
          const im = new Image()
          im.crossOrigin = 'anonymous'
          im.src = `/mock-turn/frame-${i}.png?v=${cb}`
          return im.decode().then(() => im)
        })
      )
    } else {
      const im = new Image()
      im.crossOrigin = 'anonymous'
      im.src = `/mock-face.png?v=${cb}`
      await im.decode()
      images = [im]
    }

    const first = images[0]
    const canvas = document.createElement('canvas')
    canvas.width = first.naturalWidth || 720
    canvas.height = first.naturalHeight || 720
    const ctx = canvas.getContext('2d')

    const N = images.length
    const start = performance.now()
    const PERIOD_MS = 2600 // one full left->right->left cycle (brisk, to stress tracking)
    this._oscStart = null
    const draw = () => {
      let idx = (N - 1) >> 1 // front frame (middle)
      // Hold front during init warm-up AND while the calibration overlay is
      // visible; only start oscillating once the scan has actually locked, so it
      // never starts turning before calibration completes.
      const scanOverlay = document.getElementById('scan-overlay')
      const calibrating = scanOverlay ? scanOverlay.hidden === false : false
      const warmup = performance.now() - start < 2500
      if (N > 1 && !calibrating && !warmup) {
        if (this._oscStart == null) this._oscStart = performance.now()
        const phase = Math.sin(((performance.now() - this._oscStart) / PERIOD_MS) * Math.PI * 2) // -1..1
        idx = Math.round((phase * 0.5 + 0.5) * (N - 1))
      }
      ctx.drawImage(images[idx], 0, 0, canvas.width, canvas.height)
      this._mockRAF = requestAnimationFrame(draw)
    }
    draw()

    this.stream = canvas.captureStream(30)
    this.video.srcObject = this.stream
    this.video.muted = true
    this.video.playsInline = true

    await new Promise((resolve) => {
      if (this.video.readyState >= 1 && this.video.videoWidth > 0) {
        resolve()
        return
      }
      this.video.addEventListener('loadedmetadata', () => resolve(), { once: true })
    })
    await this.video.play()
  }

  _initCamera() {
    // Vertical FOV from the video (aspect-independent ~45°).
    const vh = this.video.videoHeight || 720
    const fy = vh * 1.2
    const fovY = 2 * Math.atan(vh / (2 * fy)) * (180 / Math.PI)
    // Aspect + render size come from the DISPLAY (canvas), not the video, so the
    // glasses are never horizontally squished when the video aspect differs from
    // the window aspect. RenderLoop._syncSize keeps this in sync every frame.
    const cw = this.canvas?.clientWidth || this.video.videoWidth || 1280
    const ch = this.canvas?.clientHeight || vh || 720
    const camera = new THREE.PerspectiveCamera(fovY, cw / ch, 0.001, 1000)

    camera.position.set(0, 0, 0)
    camera.lookAt(0, 0, -1)
    this.renderLoop.renderer?.setSize(cw, ch, false)

    return camera
  }

  _checkVideoResize() {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (!width || !height || !this.renderLoop) {
      return
    }

    // Only rebuild the camera when the VIDEO intrinsics change; the display
    // aspect is handled continuously by RenderLoop._syncSize().
    if (this._lastVideoW === width && this._lastVideoH === height) {
      return
    }
    this._lastVideoW = width
    this._lastVideoH = height
    this.renderLoop.camera = this._initCamera()
  }

  _setLoading(message) {
    if (this.loadingEl) {
      this.loadingEl.textContent = message
      this.loadingEl.style.display = message ? 'flex' : 'none'
    }
  }

  _updateScanMessage(scanState) {
    // The animated scan overlay (driven by this 'scan' event) communicates the
    // stage and progress, so the text pill stays clear during scanning.
    this.emit('scan', scanState)
    this._setLoading('')
  }
}

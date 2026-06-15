import * as THREE from 'three'
import { FaceTracker } from '../../tracking/FaceTracker.js'
import { LandmarkProcessor } from '../../tracking/LandmarkProcessor.js'
import { VectorFilter } from '../../filters/VectorFilter.js'
import { QuaternionFilter } from '../../filters/QuaternionFilter.js'
import { FaceOccluder } from '../../occlusion/FaceOccluder.js'
import { GlassesModelLoader } from '../../models/GlassesModelLoader.js'
import { DebugHUD } from '../../debug/DebugHUD.js'
import { RenderLoop } from '../../core/RenderLoop.js'
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
    this.renderLoop = await new RenderLoop({
      canvas: this.canvas,
      video: this.video,
      positionFilter: new VectorFilter(),
      rotationFilter: new QuaternionFilter(),
      onScanStateChange: (scanState) => this._updateScanMessage(scanState),
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
    hud.setVisible(this.debugEnabled)

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

  _initCamera() {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    const fy = height * 1.2
    const fovY = 2 * Math.atan(height / (2 * fy)) * (180 / Math.PI)
    const camera = new THREE.PerspectiveCamera(fovY, width / height, 0.001, 1000)

    camera.position.set(0, 0, 0)
    camera.lookAt(0, 0, -1)
    this.renderLoop.renderer?.setSize(width, height, false)

    return camera
  }

  _checkVideoResize() {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (!width || !height || !this.renderLoop) {
      return
    }

    if (this.renderLoop.camera && this.renderLoop.lastWidth === width && this.renderLoop.lastHeight === height) {
      return
    }

    this.renderLoop.camera = this._initCamera()
    this.renderLoop.camera.aspect = width / height
    this.renderLoop.camera.updateProjectionMatrix()
  }

  _setLoading(message) {
    if (this.loadingEl) {
      this.loadingEl.textContent = message
      this.loadingEl.style.display = message ? 'flex' : 'none'
    }
  }

  _updateScanMessage(scanState) {
    if (!scanState || scanState.isReady) {
      this._setLoading('')
      return
    }

    const stageCopy = {
      front: 'Hold still and face the camera',
      yawLeft: 'Turn your head slightly left',
      yawRight: 'Turn your head slightly right',
      neutralReturn: 'Return to center',
    }
    const progress = Math.round((scanState.quality ?? 0) * 100)

    this._setLoading(`${stageCopy[scanState.activeStage] ?? 'Scanning face'}... ${progress}%`)
  }
}

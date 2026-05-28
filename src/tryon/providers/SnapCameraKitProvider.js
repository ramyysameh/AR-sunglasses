import {
  bootstrapCameraKit,
  createMediaStreamSource,
  Transform2D,
} from '@snap/camera-kit'
import { TryOnEventEmitter } from '../TryOnEventEmitter.js'
import {
  buildLensLaunchData,
  hasUsableSnapLensConfig,
} from '../validation.js'

function waitForAnimationFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

function stopStream(stream) {
  stream?.getTracks?.().forEach((track) => track.stop())
}

export class SnapCameraKitProvider extends TryOnEventEmitter {
  constructor() {
    super()
    this.name = 'snap'
    this.container = null
    this.canvas = null
    this.video = null
    this.config = null
    this.cameraKit = null
    this.session = null
    this.stream = null
    this.currentSkuKey = null
  }

  async init(container, config = {}) {
    this.container = container
    this.config = config
    this.canvas = config.canvas ?? container?.querySelector?.('canvas')
    this.video = config.video ?? container?.querySelector?.('video')

    if (!this.canvas) {
      throw new Error('Snap Camera Kit needs a live render canvas.')
    }

    if (!config.snap?.apiToken) {
      throw new Error('Snap Camera Kit API token is missing. Set VITE_SNAP_CAMERA_KIT_API_TOKEN or window.AR_TRYON_CONFIG.snap.apiToken.')
    }

    const defaultSku = this._getSku(config.defaultSkuKey)
    if (!hasUsableSnapLensConfig(defaultSku)) {
      throw new Error(`Snap Lens ID and Lens Group ID are missing for SKU "${config.defaultSkuKey}".`)
    }

    this._prepareDom()
    this.cameraKit = await bootstrapCameraKit({
      apiToken: config.snap.apiToken,
      logger: config.snap.logger ?? 'noop',
    })
    this.session = await this.cameraKit.createSession({ liveRenderTarget: this.canvas })
    this.session.events.addEventListener('error', (event) => {
      this.emit('error', {
        provider: this.name,
        error: event.detail?.error ?? event,
        lens: event.detail?.lens,
      })
    })

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: config.camera?.width ?? 1280 },
        height: { ideal: config.camera?.height ?? 720 },
      },
      audio: false,
    })
    const source = createMediaStreamSource(this.stream, {
      transform: Transform2D.MirrorX,
      cameraType: 'user',
      disableSourceAudio: true,
    })

    await this.session.setSource(source)
    if (Number.isFinite(config.snap?.fpsLimit)) {
      await this.session.setFPSLimit(config.snap.fpsLimit)
    }

    await this.loadSku(config.defaultSkuKey)
    this.emit('ready', { provider: this.name, sku: this.currentSkuKey })

    return this
  }

  async start() {
    await this.session?.play('live')
    this.emit('tracking', { provider: this.name, sku: this.currentSkuKey })
  }

  async stop() {
    await this.session?.pause('live')
    this.emit('trackingLost', { provider: this.name })
  }

  async loadSku(skuKey) {
    const skuConfig = this._getSku(skuKey)
    if (!hasUsableSnapLensConfig(skuConfig)) {
      throw new Error(`Cannot load SKU "${skuKey}" because Lens ID or Lens Group ID is missing.`)
    }

    const lens = await this.cameraKit.lensRepository.loadLens(skuConfig.lensId, skuConfig.lensGroupId)
    const applied = await this.session.applyLens(lens, buildLensLaunchData(skuConfig))
    if (!applied) {
      throw new Error(`Lens for SKU "${skuKey}" was not applied.`)
    }

    this.currentSkuKey = skuKey
    this.emit('tracking', { provider: this.name, sku: this.currentSkuKey })
  }

  async capture() {
    if (!this.session) {
      return null
    }

    await this.session.play('capture')
    await waitForAnimationFrame()

    const captureCanvas = this.session.output.capture
    const sourceCanvas = captureCanvas?.width && captureCanvas?.height
      ? captureCanvas
      : this.session.output.live
    const dataUrl = sourceCanvas.toDataURL('image/png')
    const result = {
      dataUrl,
      filename: `${this.currentSkuKey ?? 'tryon'}-snap-tryon.png`,
    }

    this.emit('captureReady', result)

    return result
  }

  async destroy() {
    await this.stop().catch(() => {})
    stopStream(this.stream)
    this.stream = null
    await this.session?.destroy?.()
    await this.cameraKit?.destroy?.()
    this.session = null
    this.cameraKit = null
    this.container?.classList?.remove('is-snap-provider')
  }

  _getSku(skuKey) {
    const skuConfig = this.config?.skus?.[skuKey]
    if (!skuConfig) {
      throw new Error(`Unknown try-on SKU "${skuKey}".`)
    }

    return skuConfig
  }

  _prepareDom() {
    this.container?.classList?.add('is-snap-provider')
    if (this.video) {
      this.video.style.display = 'none'
      this.video.srcObject = null
    }
    this.canvas.style.display = 'block'
    this.canvas.style.pointerEvents = 'none'
  }
}

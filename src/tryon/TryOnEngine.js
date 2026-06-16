import { TryOnEventEmitter } from './TryOnEventEmitter.js'

const PROVIDER_LOADERS = {
  mediapipe: async () => {
    const module = await import('./providers/MediaPipeThreeProvider.js')
    return module.MediaPipeThreeProvider
  },
}

export class TryOnEngine extends TryOnEventEmitter {
  constructor() {
    super()
    this.provider = null
    this.providerName = null
    this.config = null
  }

  async init(container, config = {}) {
    this.config = config
    this.providerName = this._resolveProviderName(config)
    const providerLoader = PROVIDER_LOADERS[this.providerName]

    if (!providerLoader) {
      throw new Error(`Unsupported try-on provider "${this.providerName}".`)
    }

    const ProviderClass = await providerLoader()
    this.provider = new ProviderClass()
    this._forwardProviderEvents(this.provider)
    await this.provider.init(container, config)
    this.emit('ready', { provider: this.providerName })

    return this
  }

  async start() {
    await this.provider?.start?.()
  }

  async stop() {
    await this.provider?.stop?.()
  }

  async loadSku(skuKey) {
    await this.provider?.loadSku?.(skuKey)
  }

  async capture() {
    return this.provider?.capture?.()
  }

  async destroy() {
    await this.provider?.destroy?.()
    this.provider = null
    this.providerName = null
  }

  _resolveProviderName(config) {
    return config.provider ?? config.defaultProvider ?? 'mediapipe'
  }

  _forwardProviderEvents(provider) {
    for (const eventName of ['ready', 'tracking', 'trackingLost', 'captureReady', 'error', 'scan']) {
      provider.on(eventName, (detail) => this.emit(eventName, detail))
    }
  }
}

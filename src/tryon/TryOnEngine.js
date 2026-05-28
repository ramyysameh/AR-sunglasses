import { TryOnEventEmitter } from './TryOnEventEmitter.js'
import { hasUsableSnapRuntimeConfig } from './validation.js'

const PROVIDER_LOADERS = {
  snap: async () => {
    const module = await import('./providers/SnapCameraKitProvider.js')
    return module.SnapCameraKitProvider
  },
  mediapipe: async () => {
    const module = await import('./providers/MediaPipeThreeProvider.js')
    return module.MediaPipeThreeProvider
  },
}

function isLocalBrowser() {
  if (typeof window === 'undefined') {
    return false
  }

  return ['localhost', '127.0.0.1', ''].includes(window.location.hostname)
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
    const requestedProvider = config.provider ?? config.defaultProvider ?? 'mediapipe'
    if (requestedProvider !== 'snap') {
      return requestedProvider
    }

    if (hasUsableSnapRuntimeConfig(config)) {
      return 'snap'
    }

    if (config.allowLocalFallback && config.fallbackProvider && isLocalBrowser()) {
      this.emit('error', {
        provider: 'snap',
        recoverable: true,
        error: new Error('Snap Camera Kit is not configured locally; using MediaPipe fallback.'),
      })

      return config.fallbackProvider
    }

    return 'snap'
  }

  _forwardProviderEvents(provider) {
    for (const eventName of ['ready', 'tracking', 'trackingLost', 'captureReady', 'error']) {
      provider.on(eventName, (detail) => this.emit(eventName, detail))
    }
  }
}

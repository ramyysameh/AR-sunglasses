import { TryOnEngine } from './src/tryon/TryOnEngine.js'
import { getTryOnRuntimeConfig } from './src/config/tryOnConfig.js'
import { checkEnvironment } from './src/support/capabilities.js'
import { defaultGlassesKey, registerRuntimeGlassesConfig } from './src/config/arConfig.js'
import { toEngineModelConfig } from './src/tryon/fitMetadataAdapter.js'
import { buildRegisterModelUrl } from './src/tryon/registerModelUrl.js'

const video = document.getElementById('camera-feed')
const canvas = document.getElementById('overlay-canvas')
const loadingEl = document.getElementById('loading')
const container = document.getElementById('ar-container')
const scanOverlay = document.getElementById('scan-overlay')
const scanCaptionText = scanOverlay?.querySelector('.scan-caption-text')
const scanBar = /** @type {SVGElement | null | undefined} */ (scanOverlay?.querySelector('.scan-progress-bar'))
const params = new URLSearchParams(window.location.search)
const debugEnabled = params.get('debug') === '1'
const provider = params.get('provider') || undefined
const sku = params.get('sku') || undefined
const shop = params.get('shop') || undefined
const productId = params.get('productId') || undefined
const modelUrl = params.get('model') || undefined

let tryOnEngine = null

const REMOTE_SKU_KEY = '__remote__'

/**
 * Fetches this shop+product's fit metadata and model URL from the Shopify app
 * backend and adapts it into the engine's model-config shape. Returns the SKU
 * key to load, or null if the remote config is unavailable/params are absent —
 * callers must fall back to the existing default SKU behavior in that case.
 * @returns {Promise<string | null>}
 */
async function resolveRemoteSkuKey() {
  if (!shop || !productId) {
    return null
  }

  try {
    const response = await fetch(`/api/tryon-config?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}`)
    if (!response.ok) {
      throw new Error(`tryon-config request failed with status ${response.status}`)
    }

    const { fitMetadata, modelUrl } = await response.json()

    const isValidPayload = Boolean(modelUrl) &&
      fitMetadata &&
      typeof fitMetadata === 'object' &&
      Number.isFinite(fitMetadata.frameWidthMeters) &&
      fitMetadata.bridgeAnchor &&
      fitMetadata.leftHinge &&
      fitMetadata.rightHinge

    if (!isValidPayload) {
      throw new Error('invalid tryon-config payload')
    }

    const engineModelConfig = toEngineModelConfig(fitMetadata, modelUrl)
    return registerRuntimeGlassesConfig(REMOTE_SKU_KEY, engineModelConfig)
  } catch (error) {
    console.warn('Falling back to default frame — could not load remote try-on config:', error)
    return null
  }
}

/**
 * Registers a merchant's block-configured GLB with the app (which calibrates +
 * caches it) and adapts the returned fit metadata into the engine's model
 * config. Returns the SKU key to load, or null if no ?model was given or the
 * registration failed — callers fall back to the shop/product config.
 * @returns {Promise<string | null>}
 */
async function resolveBlockModelKey() {
  if (!modelUrl) {
    return null
  }

  try {
    const response = await fetch(buildRegisterModelUrl(modelUrl, shop))
    if (!response.ok) {
      throw new Error(`register-model request failed with status ${response.status}`)
    }

    const { fitMetadata, modelUrl: servedUrl } = await response.json()
    const isValidPayload = Boolean(servedUrl) &&
      fitMetadata &&
      typeof fitMetadata === 'object' &&
      Number.isFinite(fitMetadata.frameWidthMeters) &&
      fitMetadata.bridgeAnchor &&
      fitMetadata.leftHinge &&
      fitMetadata.rightHinge

    if (!isValidPayload) {
      throw new Error('invalid register-model payload')
    }

    const engineModelConfig = toEngineModelConfig(fitMetadata, servedUrl)
    return registerRuntimeGlassesConfig(REMOTE_SKU_KEY, engineModelConfig)
  } catch (error) {
    console.warn('Falling back — could not register block model:', error)
    return null
  }
}

/**
 * @param {string} message
 * @param {{ isError?: boolean, onRetry?: (() => void) | null }} [options]
 */
function setLoading(message, { isError = false, onRetry = null } = {}) {
  if (!loadingEl) {
    return
  }

  loadingEl.textContent = message
  loadingEl.classList.toggle('is-error', isError)
  loadingEl.style.display = message ? 'flex' : 'none'

  if (onRetry) {
    const retryBtn = document.createElement('button')
    retryBtn.type = 'button'
    retryBtn.className = 'retry-btn'
    retryBtn.textContent = 'Try again'
    retryBtn.addEventListener('click', onRetry, { once: true })
    loadingEl.appendChild(retryBtn)
  }
}

const SCAN_COPY = {
  front: 'Hold still and face the camera',
  yawLeft: 'Slowly turn your head left',
  yawRight: 'Slowly turn your head right',
  neutralReturn: 'Return to center',
}
const SCAN_RING_CIRCUM = 2 * Math.PI * 80
let scanDoneTimer = null

/**
 * Drives the animated face-scan overlay from the engine's scan state.
 * @param {{ isReady?: boolean, activeStage?: string, quality?: number } | null} [scanState]
 */
function updateScan(scanState) {
  if (!scanOverlay) {
    return
  }

  if (!scanState) {
    scanOverlay.hidden = true
    return
  }

  if (scanState.isReady) {
    // Brief success flash on the ring, then dismiss.
    scanOverlay.hidden = false
    scanOverlay.dataset.stage = 'done'
    if (scanBar) scanBar.style.strokeDashoffset = '0'
    clearTimeout(scanDoneTimer)
    scanDoneTimer = setTimeout(() => {
      scanOverlay.hidden = true
      scanOverlay.dataset.stage = ''
    }, 750)
    return
  }

  clearTimeout(scanDoneTimer)
  scanOverlay.hidden = false
  const stage = scanState.activeStage ?? 'front'
  scanOverlay.dataset.stage = stage
  if (scanCaptionText) {
    scanCaptionText.textContent = SCAN_COPY[stage] ?? 'Scanning your face…'
  }
  const quality = Math.max(0, Math.min(1, scanState.quality ?? 0))
  if (scanBar) {
    scanBar.style.strokeDashoffset = String(SCAN_RING_CIRCUM * (1 - quality))
  }
}

async function startEngine() {
  const remoteSkuKey = (await resolveBlockModelKey()) ?? (await resolveRemoteSkuKey())
  const runtimeConfig = getTryOnRuntimeConfig({
    provider,
    defaultSkuKey: remoteSkuKey ?? sku ?? defaultGlassesKey,
    video,
    canvas,
    loadingEl,
    debugEnabled,
  })

  setLoading('Preparing your try‑on…')
  tryOnEngine = new TryOnEngine()
  tryOnEngine.on('error', ({ error, recoverable }) => {
    const message = error?.message ?? String(error)
    console.warn('Try-on provider warning:', message)
    if (!recoverable) {
      setLoading(message, { isError: true })
    }
  })
  tryOnEngine.on('ready', ({ provider: activeProvider }) => {
    container.dataset.provider = activeProvider
  })
  tryOnEngine.on('scan', updateScan)

  await tryOnEngine.init(container, runtimeConfig)
  await tryOnEngine.start()
  setLoading('')
}

async function main() {
  const environment = checkEnvironment()
  if (!environment.ok) {
    setLoading(environment.message ?? 'This device can’t run the try-on.', { isError: true })
    return
  }

  try {
    await startEngine()
  } catch (error) {
    console.error('Failed to start AR try-on app:', error)
    const recoverable = Boolean(error?.recoverable)
    // Tear down any partial session before a retry so the camera is released.
    await tryOnEngine?.destroy?.().catch(() => {})
    tryOnEngine = null

    setLoading(error?.message ?? 'Couldn’t start the try-on.', {
      isError: true,
      onRetry: recoverable ? () => { main() } : null,
    })
  }
}

window.addEventListener('beforeunload', () => {
  tryOnEngine?.destroy?.()
})

main()

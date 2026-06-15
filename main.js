import { TryOnEngine } from './src/tryon/TryOnEngine.js'
import { getTryOnRuntimeConfig } from './src/config/tryOnConfig.js'
import { checkEnvironment } from './src/support/capabilities.js'

const video = document.getElementById('camera-feed')
const canvas = document.getElementById('overlay-canvas')
const loadingEl = document.getElementById('loading')
const captureBtn = document.getElementById('capture-btn')
const container = document.getElementById('ar-container')
const params = new URLSearchParams(window.location.search)
const debugEnabled = params.get('debug') === '1'
const provider = params.get('provider') || undefined
const sku = params.get('sku') || undefined

let tryOnEngine = null

function downloadDataUrl(dataUrl, filename) {
  const link = document.createElement('a')
  link.href = dataUrl
  link.download = filename
  link.click()
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
    retryBtn.textContent = 'Retry'
    retryBtn.addEventListener('click', onRetry, { once: true })
    loadingEl.appendChild(retryBtn)
  }
}

async function startEngine() {
  const runtimeConfig = getTryOnRuntimeConfig({
    provider,
    defaultSkuKey: sku ?? undefined,
    video,
    canvas,
    loadingEl,
    debugEnabled,
  })

  setLoading('Starting AR try-on...')
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

  await tryOnEngine.init(container, runtimeConfig)
  await tryOnEngine.start()
  setLoading('')

  captureBtn?.addEventListener('click', async () => {
    const capture = await tryOnEngine.capture()
    if (capture?.dataUrl) {
      downloadDataUrl(capture.dataUrl, capture.filename ?? 'tryon.png')
    }
  })
}

async function main() {
  const environment = checkEnvironment()
  if (!environment.ok) {
    setLoading(environment.message ?? 'This device cannot run the try-on.', { isError: true })
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

    setLoading(error?.message ?? 'Failed to start AR try-on.', {
      isError: true,
      onRetry: recoverable ? () => { main() } : null,
    })
  }
}

window.addEventListener('beforeunload', () => {
  tryOnEngine?.destroy?.()
})

main()

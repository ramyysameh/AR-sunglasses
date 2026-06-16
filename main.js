import { TryOnEngine } from './src/tryon/TryOnEngine.js'
import { getTryOnRuntimeConfig } from './src/config/tryOnConfig.js'
import { checkEnvironment } from './src/support/capabilities.js'
import { glassesConfig, defaultGlassesKey } from './src/config/arConfig.js'

const video = document.getElementById('camera-feed')
const canvas = document.getElementById('overlay-canvas')
const loadingEl = document.getElementById('loading')
const captureBtn = document.getElementById('capture-btn')
const container = document.getElementById('ar-container')
const sidebarEl = document.getElementById('model-sidebar')
const modelListEl = document.getElementById('model-list')
const sidebarCollapseBtn = document.getElementById('sidebar-collapse')
const sidebarOpenBtn = document.getElementById('sidebar-open')
const scanOverlay = document.getElementById('scan-overlay')
const scanCaptionText = scanOverlay?.querySelector('.scan-caption-text')
const scanBar = /** @type {SVGElement | null | undefined} */ (scanOverlay?.querySelector('.scan-progress-bar'))
const params = new URLSearchParams(window.location.search)
const debugEnabled = params.get('debug') === '1'
const provider = params.get('provider') || undefined
const sku = params.get('sku') || undefined

let tryOnEngine = null
let currentSkuKey = sku || defaultGlassesKey
let isSwitching = false

const GLASSES_ICON = `<svg viewBox="0 0 48 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M3 9h5M40 9h5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
  <rect x="6.5" y="8" width="15" height="13" rx="6.5" stroke="currentColor" stroke-width="2.4"/>
  <rect x="26.5" y="8" width="15" height="13" rx="6.5" stroke="currentColor" stroke-width="2.4"/>
  <path d="M21.5 12.5c1.4-1.3 4.6-1.3 6 0" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
</svg>`

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

function collapseSidebar(collapsed) {
  sidebarEl?.classList.toggle('is-collapsed', collapsed)
  if (sidebarOpenBtn) {
    sidebarOpenBtn.hidden = !collapsed
  }
}

function setActiveCard(key) {
  const cards = modelListEl?.querySelectorAll('.model-card') ?? []
  cards.forEach((card) => {
    const active = card.dataset.sku === key
    card.classList.toggle('is-active', active)
    card.setAttribute('aria-selected', active ? 'true' : 'false')
  })
}

async function switchModel(key) {
  if (isSwitching || key === currentSkuKey || !tryOnEngine) {
    return
  }

  const cards = modelListEl?.querySelectorAll('.model-card') ?? []
  const targetCard = modelListEl?.querySelector(`.model-card[data-sku="${key}"]`)
  isSwitching = true
  cards.forEach((card) => { card.disabled = true })
  targetCard?.classList.add('is-loading')

  try {
    await tryOnEngine.loadSku(key)
    currentSkuKey = key
    setActiveCard(key)
  } catch (error) {
    console.error(`Failed to switch to frame "${key}":`, error)
    setLoading('Could not load that frame. Try another.', { isError: true })
  } finally {
    targetCard?.classList.remove('is-loading')
    cards.forEach((card) => { card.disabled = false })
    isSwitching = false
  }
}

function buildModelSwitcher() {
  if (!modelListEl) {
    return
  }

  modelListEl.innerHTML = ''
  for (const [key, config] of Object.entries(glassesConfig)) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = 'model-card'
    card.dataset.sku = key
    card.setAttribute('role', 'option')
    card.setAttribute('aria-selected', key === currentSkuKey ? 'true' : 'false')
    if (key === currentSkuKey) {
      card.classList.add('is-active')
    }

    const spec = Number.isFinite(config.frameWidthMm) ? `${config.frameWidthMm}mm frame` : 'Eyewear'
    card.innerHTML = `
      <span class="model-thumb">${GLASSES_ICON}</span>
      <span class="model-meta">
        <span class="model-name">${config.displayName ?? key}</span>
        <span class="model-spec">${spec}</span>
      </span>`
    card.addEventListener('click', () => switchModel(key))
    modelListEl.appendChild(card)
  }

  // Don't cover the camera by default on phones.
  if (window.innerWidth <= 640) {
    collapseSidebar(true)
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
  tryOnEngine.on('scan', updateScan)

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

sidebarCollapseBtn?.addEventListener('click', () => collapseSidebar(true))
sidebarOpenBtn?.addEventListener('click', () => collapseSidebar(false))

window.addEventListener('beforeunload', () => {
  tryOnEngine?.destroy?.()
})

buildModelSwitcher()
main()

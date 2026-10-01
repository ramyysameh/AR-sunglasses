/* eslint-disable react/prop-types -- lightweight props, same as the other flows */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import ModelViewer from './ModelViewer'
import AiProductSource from './AiProductSource'

// Keep in step with the server: storage.server.js MAX_PHOTO_BYTES and the
// $5 App Pricing meter. (A client component can't import .server modules.)
const MAX_PHOTO_BYTES = 10 * 1048576
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const PRICE = '$5'
const POLL_MS = 5000
const CONFIRM_MODAL_ID = 'ai-charge-confirm'
const GENERIC_ERROR = 'Something went wrong. Try again.'
const UPLOAD_FAILED = "The photos didn't upload. Check your connection and try again."
const LOAD_FAILED = "Couldn't load your AI models. Refresh the page to try again."

// Marks a message that is written for the merchant (a server `error` string or
// UPLOAD_FAILED). Anything else that gets thrown is shown as GENERIC_ERROR so
// raw exception text ("Failed to fetch", stack details) never reaches the UI.
class ShownError extends Error {}

export const PHOTO_SLOTS = [
  { key: 'front', label: 'Front', required: true },
  { key: 'left', label: 'Left side', required: true },
  { key: 'right', label: 'Right side', required: true },
  { key: 'back', label: 'Back (optional)', required: false },
]

export function photoError(file) {
  if (!file) return null
  if (!PHOTO_TYPES.includes(file.type)) return 'Use a JPG, PNG or WebP photo.'
  if (file.size > MAX_PHOTO_BYTES) return 'Photos must be 10 MB or smaller.'
  return null
}

export function canGenerate(photos) {
  return PHOTO_SLOTS.every((slot) => !slot.required || photos[slot.key])
    && PHOTO_SLOTS.every((slot) => !photoError(photos[slot.key]))
}

export function balanceMessage(allowance) {
  if (!allowance) return ''
  if (allowance.unlimited) return 'Unlimited AI models on your plan'
  if (allowance.freeRemaining > 0) return `${allowance.freeRemaining} of ${allowance.allowance} free AI models left`
  return `Next model: ${PRICE}, added to your Shopify bill`
}

export function saveNeedsCharge(allowance) {
  return Boolean(allowance) && !allowance.unlimited && allowance.freeRemaining <= 0
}

export function failureMessage(error) {
  if (error === 'low_confidence' || error?.startsWith('invalid_model')) {
    return "We couldn't build a model that fits from these photos. Try clearer photos: plain background, frame only (not worn), good light, whole frame in shot. You weren't charged."
  }
  if (error === 'timeout') return "Generating took too long. Try again. You weren't charged."
  return "Generating failed. Try again. You weren't charged."
}

export function generationView(generation) {
  const retry = generation.retriesLeft > 0 ? ['retry'] : []
  switch (generation.status) {
    case 'queued':
      return { label: 'Waiting to start. It begins when another model finishes.', tone: 'neutral', actions: [] }
    case 'running':
      return { label: 'Generating… this takes a few minutes. You can leave this page.', tone: 'info', actions: [] }
    case 'ready':
      return { label: 'Ready to review', tone: 'success', actions: ['save', ...retry, 'discard'] }
    case 'saving':
      return { label: 'Saving…', tone: 'info', actions: [] }
    case 'failed':
      return { label: failureMessage(generation.error), tone: 'critical', actions: [...retry, 'discard'] }
    default:
      return { label: 'Working on it…', tone: 'neutral', actions: [] }
  }
}

export function defaultImageSelection(images) {
  return images.slice(0, 4).map((image) => image.id)
}

export function toggleImage(selected, id) {
  if (selected.includes(id)) return selected.filter((x) => x !== id)
  return selected.length >= 4 ? selected : [...selected, id]
}

export function canGenerateFromProduct(selected) {
  return selected.length >= 3 && selected.length <= 4
}

export const MAX_PRODUCTS = 5

export function pickedFromLookup(product, images) {
  return { id: product.id, title: product.title, images, selected: defaultImageSelection(images) }
}

export function bulkItems(picked) {
  return picked
    .filter((product) => canGenerateFromProduct(product.selected))
    .map((product) => ({ productId: product.id, imageIds: product.selected }))
}

export function generateLabel(count) {
  if (count === 1) return 'Generate 3D model'
  return count > 1 ? `Generate 3D models (${count})` : 'Generate 3D models'
}

function sentence(text) {
  const trimmed = String(text).trim()
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

export function bulkResultMessage(results, picked) {
  const all = results ?? []
  const failed = all.filter((result) => result.error)
  if (!failed.length) return null
  const started = all.filter((result) => result.generation).length
  const lines = failed.map((result) => (
    sentence(`${picked.find((p) => p.id === result.productId)?.title ?? 'A product'}: ${result.error}`)
  ))
  return [...(started > 0 ? [`Started ${started} of ${all.length}.`] : []), ...lines].join(' ')
}

// Drops the products that started so only the ones that didn't stay for a fix and resend.
export function withoutStarted(picked, results) {
  const startedIds = (results ?? []).filter((r) => r.generation).map((r) => r.productId)
  return picked.filter((p) => !startedIds.includes(p.id))
}

// Picker order wins; products the merchant already ticked keep their ticks;
// ids with no data (removed in the picker or failed lookup) are dropped.
export function mergePicked(previous, ids, fresh) {
  return ids
    .map((id) => previous.find((p) => p.id === id) ?? fresh.find((p) => p.id === id))
    .filter(Boolean)
}

// failed: [{ id, title? }] for lookups that didn't come back.
export function lookupFailureMessage(failed) {
  if (!failed.length) return null
  if (failed.every((f) => f.title)) return failed.map((f) => `Couldn't load photos for ${f.title}.`).join(' ')
  return failed.length === 1
    ? "Couldn't load photos for 1 product. Try choosing it again."
    : `Couldn't load photos for ${failed.length} products. Try choosing them again.`
}

// Lives with the component that renders it; re-exported so callers/tests keep one import.
export { productTooFewPhotos } from './AiProductSource'

export function mappingMessage(mapping, productTitle) {
  if (!mapping) return null
  const name = productTitle || 'the product'
  if (mapping.mapped && mapping.replaced) return `Model saved and now used for try-on on ${name} (it replaced the previous model).`
  if (mapping.mapped) return `Model saved and added to ${name}.`
  if (mapping.reason === 'product_limit') return `Model saved. Your plan's product limit is reached, so it wasn't added to ${name}.`
  return `Model saved, but it couldn't be added to ${name}. Use Add try-on to add it.`
}

const ACTION_LABELS = { save: 'Save model', retry: 'Try again', discard: 'Discard' }

function PhotoSlot({ slot, file, disabled, onFile, onRejected }) {
  const ref = useRef(null)
  // React 18 strips onDropRejected from custom elements; attach it directly.
  useEffect(() => {
    const zone = ref.current
    if (!zone) return undefined
    zone.addEventListener('droprejected', onRejected)
    return () => zone.removeEventListener('droprejected', onRejected)
  }, [onRejected])
  const error = photoError(file)
  return (
    <s-stack direction="block" gap="small-200">
      <s-drop-zone
        ref={ref}
        label={slot.label}
        accept={PHOTO_TYPES.join(',')}
        accessibilityLabel={`Choose the ${slot.label.toLowerCase()} photo`}
        disabled={disabled}
        error={error ?? undefined}
        // onInput, not onChange: React 18 never dispatches change for s-drop-zone.
        onInput={(event) => onFile(event.currentTarget.files?.[0] ?? null)}
      ></s-drop-zone>
      {file && !error && <s-text color="subdued">{file.name}</s-text>}
    </s-stack>
  )
}

function GenerationRow({ generation, disabled, onAction }) {
  const view = generationView(generation)
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-badge tone={view.tone}>{view.label}</s-badge>
        {generation.productTitle && <s-text color="subdued">From {generation.productTitle}</s-text>}
        {generation.previewUrl && <ModelViewer src={generation.previewUrl} alt="AI-generated model preview" height={320} expandable />}
        {view.actions.length > 0 && (
          <s-stack direction="inline" gap="small-200">
            {view.actions.map((action) => (
              <s-button
                key={action}
                variant={action === 'save' ? 'primary' : 'secondary'}
                disabled={disabled}
                onClick={() => onAction(action)}
              >
                {ACTION_LABELS[action]}
              </s-button>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  )
}

async function postForm(fields) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const res = await fetch('/api/generations', { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

export default function AiModelFlow({ initialAllowance, showBalance = true }) {
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [photos, setPhotos] = useState({})
  const [source, setSource] = useState('product')
  const [picked, setPicked] = useState([])
  const [generations, setGenerations] = useState([])
  const [allowance, setAllowance] = useState(initialAllowance ?? null)
  const [busy, setBusy] = useState(false)
  // Which request the Generate button is spinning for (busy alone also covers the picker and row actions).
  const [generating, setGenerating] = useState(false)
  // partial = some models started and some didn't (a warning, not a failure).
  const [notice, setNotice] = useState(null)
  const error = notice?.message ?? null
  const setError = useCallback((message, { partial = false } = {}) => {
    setNotice(message ? { message, partial } : null)
  }, [])
  const [chargeFor, setChargeFor] = useState(null)
  // Polls can overlap a slow response; only the latest request may update state.
  const latestRequest = useRef(0)

  // Never throws: a failed poll keeps the current state on screen.
  const refresh = useCallback(async ({ initial = false } = {}) => {
    const requestId = ++latestRequest.current
    try {
      const res = await fetch('/api/generations')
      if (requestId !== latestRequest.current) return
      if (!res.ok) {
        // 404 = the feature is off for this shop, so say nothing.
        if (initial && res.status !== 404) setError(LOAD_FAILED)
        return
      }
      const body = await res.json()
      if (requestId !== latestRequest.current) return
      setGenerations(body.generations)
      setAllowance(body.allowance)
    } catch (e) {
      console.error('AI generations refresh failed', e)
    }
  }, [])

  useEffect(() => {
    refresh({ initial: true })
  }, [refresh])

  const anyRunning = generations.some((g) => g.status === 'queued' || g.status === 'running' || g.status === 'saving')
  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [anyRunning, refresh])

  const onRejected = useCallback(() => setError('Use a JPG, PNG or WebP photo of 10 MB or less.'), [])

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const chosen = PHOTO_SLOTS.map((slot) => photos[slot.key]).filter(Boolean)
      const presign = await postForm({
        intent: 'presign-photos',
        files: JSON.stringify(chosen.map((f) => ({ type: f.type, size: f.size }))),
      })
      if (!presign.ok) throw new ShownError(presign.body.error ?? GENERIC_ERROR)
      const { uploads } = presign.body
      if (!Array.isArray(uploads) || uploads.length !== chosen.length) {
        throw new Error('presign-photos returned an unexpected number of uploads')
      }
      await Promise.all(uploads.map(async ({ uploadUrl }, i) => {
        let res
        try {
          res = await fetch(uploadUrl, { method: 'PUT', body: chosen[i], headers: { 'Content-Type': chosen[i].type } })
        } catch (uploadError) {
          // A rejected fetch (CORS, dropped connection) is an upload failure too.
          console.error('AI photo upload failed', uploadError)
          throw new ShownError(UPLOAD_FAILED)
        }
        if (!res.ok) {
          console.error('AI photo upload failed', res.status)
          throw new ShownError(UPLOAD_FAILED)
        }
      }))
      const created = await postForm({
        intent: 'create',
        photoRefs: JSON.stringify(uploads.map((u) => u.storageRef)),
      })
      if (!created.ok) throw new ShownError(created.body.error ?? GENERIC_ERROR)
      setPhotos({})
      await refresh()
    } catch (e) {
      if (e instanceof ShownError) {
        setError(e.message)
      } else {
        console.error('AI generation failed', e)
        setError(GENERIC_ERROR)
      }
    } finally {
      setBusy(false)
    }
  }

  function switchSource(next) {
    setSource(next)
    setError(null)
  }

  // Same shape as generate(): server copy is shown, anything else is generic.
  function reportFailure(e, logLabel) {
    if (e instanceof ShownError) {
      setError(e.message)
    } else {
      console.error(logLabel, e)
      setError(GENERIC_ERROR)
    }
  }

  async function chooseProducts() {
    setBusy(true)
    setError(null)
    try {
      const selection = await shopify.resourcePicker({
        type: 'product',
        action: 'select',
        multiple: MAX_PRODUCTS,
        selectionIds: picked.map((p) => ({ id: p.id })),
      })
      if (!selection) return
      const ids = selection.slice(0, MAX_PRODUCTS).map((item) => item.id)
      // Keep ticks the merchant already changed; look up only new products.
      const wanted = ids.filter((id) => !picked.some((p) => p.id === id))
      const settled = await Promise.allSettled(wanted.map(async (id) => {
        const res = await postForm({ intent: 'product-images', productId: id })
        if (!res.ok) throw new Error(`product-images ${res.status}`)
        return pickedFromLookup(res.body.product, Array.isArray(res.body.images) ? res.body.images : [])
      }))
      const fresh = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value)
      setPicked(mergePicked(picked, ids, fresh))
      const failed = wanted
        .filter((id, i) => settled[i].status === 'rejected')
        .map((id) => ({ id, title: selection.find((item) => item.id === id)?.title }))
      settled.forEach((r) => { if (r.status === 'rejected') console.error('AI product photos failed', r.reason) })
      const failureMessage = lookupFailureMessage(failed)
      if (failureMessage) setError(failureMessage)
    } catch (e) {
      reportFailure(e, 'AI product photos failed')
    } finally {
      setBusy(false)
    }
  }

  async function generateFromProducts() {
    setBusy(true)
    setGenerating(true)
    setError(null)
    try {
      const items = bulkItems(picked)
      const created = await postForm({ intent: 'create-from-products', items: JSON.stringify(items) })
      if (!created.ok) throw new ShownError(created.body.error ?? GENERIC_ERROR)
      const message = bulkResultMessage(created.body.results, picked)
      // Keep only the products that didn't start, so the merchant can fix and resend them.
      const results = created.body.results ?? []
      setPicked((current) => withoutStarted(current, results))
      if (message) setError(message, { partial: results.some((r) => r.generation) })
      await refresh()
    } catch (e) {
      reportFailure(e, 'AI generation from products failed')
    } finally {
      setBusy(false)
      setGenerating(false)
    }
  }

  function askToConfirmCharge(generationId) {
    setChargeFor(generationId)
    shopify.modal.show(CONFIRM_MODAL_ID)
  }

  async function act(generation, action, { acceptCharge = false } = {}) {
    if (action === 'save' && saveNeedsCharge(allowance) && !acceptCharge) {
      askToConfirmCharge(generation.id)
      return
    }
    setBusy(true)
    setError(null)
    // Never rejects (confirmCharge calls this without awaiting it).
    try {
      const res = await postForm({
        intent: action,
        generationId: generation.id,
        ...(action === 'save' ? { acceptCharge: String(acceptCharge) } : {}),
      })
      if (res.body.code === 'CHARGE_NOT_CONFIRMED') {
        // Another save took the last free slot since this page loaded.
        askToConfirmCharge(generation.id)
        await refresh()
        return
      }
      if (!res.ok) {
        setError(res.body.error ?? GENERIC_ERROR)
        return
      }
      if (action === 'save') {
        const charged = res.body.paid ? ` ${PRICE} added to your Shopify bill.` : ''
        const mapped = mappingMessage(res.body.mapping, generation.productTitle)
        shopify.toast.show(mapped
          ? `${mapped}${charged}`
          : res.body.paid ? `Model saved.${charged}` : 'Model saved to your library')
        revalidator.revalidate()
      }
      await refresh()
    } catch (e) {
      console.error('AI generation action failed', e)
      setError(GENERIC_ERROR)
    } finally {
      setBusy(false)
    }
  }

  function confirmCharge() {
    shopify.modal.hide(CONFIRM_MODAL_ID)
    const generation = generations.find((g) => g.id === chargeFor)
    if (generation) act(generation, 'save', { acceptCharge: true })
  }

  return (
    <s-section heading="Create with AI">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="small-200">
          <s-button variant={source === 'product' ? 'primary' : 'secondary'} onClick={() => switchSource('product')}>
            From products
          </s-button>
          <s-button variant={source === 'upload' ? 'primary' : 'secondary'} onClick={() => switchSource('upload')}>
            Upload photos
          </s-button>
        </s-stack>
        {showBalance && <s-text type="strong">{balanceMessage(allowance)}</s-text>}
        {error && (
          <s-banner
            tone={notice.partial ? 'warning' : 'critical'}
            heading={notice.partial ? "Some models didn't start" : "Couldn't create the model"}
          >
            {error}
          </s-banner>
        )}
        {source === 'product' ? (
          <>
            <s-paragraph>
              Pick products from your store and we&apos;ll build their 3D models from the product photos.
            </s-paragraph>
            <AiProductSource
              picked={picked}
              disabled={busy}
              onChoose={chooseProducts}
              onToggle={(productId, imageId) => setPicked((current) => current.map((p) => (
                p.id === productId ? { ...p, selected: toggleImage(p.selected, imageId) } : p
              )))}
              onRemove={(productId) => setPicked((current) => current.filter((p) => p.id !== productId))}
            />
            <s-stack direction="inline">
              <s-button
                variant="primary"
                disabled={busy || bulkItems(picked).length === 0}
                {...(generating ? { loading: true } : {})}
                onClick={generateFromProducts}
              >
                {generateLabel(bulkItems(picked).length)}
              </s-button>
            </s-stack>
          </>
        ) : (
          <>
            <s-paragraph>
              Upload photos of a frame and we&apos;ll build its 3D model. Use a plain
              background, the frame only (not worn), good light, and the whole frame in shot.
            </s-paragraph>
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
              {PHOTO_SLOTS.map((slot) => (
                <PhotoSlot
                  key={slot.key}
                  slot={slot}
                  file={photos[slot.key]}
                  disabled={busy}
                  onRejected={onRejected}
                  onFile={(file) => setPhotos((current) => ({ ...current, [slot.key]: file ?? undefined }))}
                />
              ))}
            </s-grid>
            <s-stack direction="inline">
              <s-button variant="primary" disabled={busy || !canGenerate(photos)} {...(busy ? { loading: true } : {})} onClick={generate}>
                Generate 3D model
              </s-button>
            </s-stack>
          </>
        )}
        {generations.map((generation) => (
          <GenerationRow
            key={generation.id}
            generation={generation}
            disabled={busy}
            onAction={(action) => act(generation, action)}
          />
        ))}
      </s-stack>
      <s-modal id={CONFIRM_MODAL_ID} heading={`Save this model for ${PRICE}?`}>
        <s-paragraph>
          You&apos;ve used all the free AI models on your plan. This model costs {PRICE}.
          It will be added to your next Shopify bill.
        </s-paragraph>
        <s-button slot="primary-action" variant="primary" onClick={confirmCharge}>
          Save for {PRICE}
        </s-button>
        <s-button slot="secondary-actions" onClick={() => shopify.modal.hide(CONFIRM_MODAL_ID)}>
          Cancel
        </s-button>
      </s-modal>
    </s-section>
  )
}

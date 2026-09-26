/* eslint-disable react/prop-types -- plain JSX component, no PropTypes dependency */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useFetcher } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { ModelUploadFlow } from './ModelUploadFlow'
import ModelPicker from './ModelPicker'
import PreviewPanel from './PreviewPanel'

export const initialAddTryOnState = {
  open: false,
  step: 'model',
  modelAsset: null,
  product: null,
  error: null,
  publishing: false,
}

export function addTryOnReducer(state, action) {
  switch (action.type) {
    case 'open':
      return {
        ...initialAddTryOnState,
        open: true,
        modelAsset: action.asset || null,
        step: action.asset ? 'product' : 'model',
      }
    case 'model-selected':
      return { ...state, modelAsset: action.asset, step: 'product', error: null }
    // Picking in the list only selects; Continue (`next`) advances. An upload
    // still advances straight away via `model-selected`, since finishing an
    // upload is already the merchant's decision.
    case 'model-picked':
      return { ...state, modelAsset: action.asset, error: null }
    case 'product-selected':
      return { ...state, product: action.product, step: 'review', error: null }
    case 'next':
      return state.modelAsset ? { ...state, step: 'product', error: null } : state
    case 'back':
      if (state.publishing) return state
      return {
        ...state,
        step: state.step === 'review' ? 'product' : 'model',
        error: null,
      }
    case 'publishing':
      return { ...state, publishing: true, error: null }
    case 'publish-error':
      return { ...state, publishing: false, error: action.message }
    case 'publish-success':
    case 'close':
      return initialAddTryOnState
    default:
      return state
  }
}

// A flagged model the merchant reviewed and accepted is ready to use too;
// otherwise Models would call it Ready while the pickers left it out.
export function isReady(asset) {
  return !asset.status || asset.status.toLowerCase() === 'ready' || Boolean(asset.fitReviewedAt)
}

export function modelName(asset) {
  if (asset.label?.trim()) return asset.label.trim()
  if (asset.filename) return asset.filename
  if (asset.originalFilename) return asset.originalFilename
  return asset.id ? `Model ${asset.id.slice(0, 8)}` : 'Uploaded model'
}

export function initialModelAsset(assets, initialModelId) {
  if (!initialModelId) return null
  return assets.find((asset) => asset.id === initialModelId && isReady(asset)) ?? null
}

function productFromSelection(product) {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle || '',
    imageUrl: product.images?.[0]?.originalSrc ?? product.featuredImage?.originalSrc ?? null,
    imageAlt: product.images?.[0]?.altText ?? product.featuredImage?.altText ?? product.title,
  }
}

// Same picker as Change model (search, compact list, one preview), so choosing
// frames works the same way everywhere and scales past a handful of models.
function ModelStep({ assets, selectedId, onPick, onUploaded }) {
  const readyAssets = assets.filter(isReady)

  if (readyAssets.length === 0) {
    return (
      <s-stack direction="block" gap="base">
        <s-paragraph>Upload a .glb eyewear model to start setting up try-on.</s-paragraph>
        <ModelUploadFlow embedded onUploaded={onUploaded} />
      </s-stack>
    )
  }

  return (
    <s-stack direction="block" gap="base">
      <ModelPicker
        assets={readyAssets}
        value={selectedId ?? ''}
        onChange={(id) => {
          const asset = readyAssets.find((candidate) => candidate.id === id)
          if (asset) onPick(asset)
        }}
      />
      <s-divider></s-divider>
      <s-heading>Or upload a new model</s-heading>
      <ModelUploadFlow embedded onUploaded={onUploaded} />
    </s-stack>
  )
}

function ProductSummary({ product }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      {product.imageUrl && (
        <s-thumbnail src={product.imageUrl} alt={product.imageAlt || product.title} size="small"></s-thumbnail>
      )}
      <s-text type="strong">{product.title}</s-text>
    </s-stack>
  )
}

export function AddTryOnFlow({ assets, initialModelId, open, onClose, onPublished }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const modalRef = useRef(null)
  const sessionRef = useRef(open ? 1 : 0)
  const previousOpenRef = useRef(open)
  const closedSessionRef = useRef(null)
  const submissionRef = useRef(null)
  const startingAsset = initialModelAsset(assets, initialModelId)
  const [state, dispatch] = useReducer(
    addTryOnReducer,
    open
      ? addTryOnReducer(initialAddTryOnState, { type: 'open', asset: startingAsset })
      : initialAddTryOnState,
  )

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = open
    if (open && !wasOpen) {
      sessionRef.current += 1
      closedSessionRef.current = null
      submissionRef.current = null
      dispatch({ type: 'open', asset: initialModelAsset(assets, initialModelId) })
    } else if (!open && wasOpen) {
      submissionRef.current = null
      dispatch({ type: 'close' })
    }
  }, [assets, initialModelId, open])

  useEffect(() => {
    if (open) shopify.modal.show('add-tryon-flow')
    else shopify.modal.hide('add-tryon-flow')
  }, [open, shopify])

  const dismiss = useCallback(() => {
    if (submissionRef.current) {
      shopify.modal.show('add-tryon-flow')
      return
    }
    const session = sessionRef.current
    if (closedSessionRef.current === session) return
    closedSessionRef.current = session
    submissionRef.current = null
    dispatch({ type: 'close' })
    onClose?.()
  }, [onClose, shopify])

  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return undefined
    modal.addEventListener('afterhide', dismiss)
    return () => modal.removeEventListener('afterhide', dismiss)
  }, [dismiss])

  useEffect(() => {
    const submission = submissionRef.current
    if (
      !state.open
      || !state.publishing
      || !fetcher.data
      || !submission
      || submission.session !== sessionRef.current
      || submission.priorData === fetcher.data
    ) return
    submissionRef.current = null
    if (fetcher.data.mapped) {
      dispatch({ type: 'publish-success' })
      shopify.modal.hide('add-tryon-flow')
      onPublished?.()
    } else if (fetcher.data.error) {
      dispatch({ type: 'publish-error', message: fetcher.data.error })
    }
  }, [fetcher.data, onPublished, shopify, state.open, state.publishing])

  const close = () => {
    if (submissionRef.current) return
    shopify.modal.hide('add-tryon-flow')
  }

  const back = () => {
    if (submissionRef.current) return
    dispatch({ type: 'back' })
  }

  const beginPublishing = () => {
    submissionRef.current = {
      session: sessionRef.current,
      priorData: fetcher.data,
    }
    dispatch({ type: 'publishing' })
  }

  const pickProduct = async () => {
    if (!state.modelAsset) return
    const selection = await shopify.resourcePicker({ type: 'product', action: 'select' })
    if (selection?.[0]) {
      dispatch({ type: 'product-selected', product: productFromSelection(selection[0]) })
    }
  }

  const previewMapping = state.modelAsset && state.product
    ? {
        modelAssetId: state.modelAsset.id,
        product: state.product,
        previewUrl: null,
        qr: null,
      }
    : null
  const hasReadyModels = assets.some(isReady)
  // One heading per step, carried by the modal itself; the step number tells
  // the merchant how much is left.
  const STEPS = { model: 1, product: 2, review: 3 }
  const heading = state.step === 'model'
    ? (hasReadyModels ? 'Choose a model' : 'Upload a model')
    : state.step === 'product' ? 'Choose a product' : 'Review and publish'

  return (
    <s-modal ref={modalRef} id="add-tryon-flow" heading={heading}>
      <s-stack direction="block" gap="base">
        <s-text color="subdued">Step {STEPS[state.step]} of 3</s-text>
        {state.step === 'model' && (
          <ModelStep
            assets={assets}
            selectedId={state.modelAsset?.id}
            onPick={(asset) => dispatch({ type: 'model-picked', asset })}
            onUploaded={(asset) => dispatch({ type: 'model-selected', asset })}
          />
        )}

        {state.step === 'product' && state.modelAsset && (
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-button onClick={pickProduct} icon="product">
                {state.product ? 'Change product' : 'Select product'}
              </s-button>
              {state.product && <ProductSummary product={state.product} />}
            </s-stack>
          </s-stack>
        )}

        {state.step === 'review' && previewMapping && (
          <s-stack direction="block" gap="large-100">
            <ProductSummary product={state.product} />
            <s-text type="strong">{modelName(state.modelAsset)}</s-text>
            <PreviewPanel mapping={previewMapping} showPhonePreview={false} />
            {state.error && (
              <s-banner heading="Could not publish try-on" tone="critical">
                {state.error}
              </s-banner>
            )}
          </s-stack>
        )}
      </s-stack>

      <s-button slot="secondary-actions" onClick={close} disabled={state.publishing}>Cancel</s-button>
      {state.step !== 'model' && (
        <s-button slot="secondary-actions" onClick={back} disabled={state.publishing}>Back</s-button>
      )}
      {state.step === 'model' && hasReadyModels && (
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={!state.modelAsset}
          onClick={() => dispatch({ type: 'next' })}
        >
          Continue
        </s-button>
      )}
      {state.step === 'review' && state.modelAsset && state.product && (
        <fetcher.Form method="post" onSubmit={beginPublishing}>
          <input type="hidden" name="intent" value="map" />
          <input type="hidden" name="productId" value={state.product.id} />
          <input type="hidden" name="productHandle" value={state.product.handle || ''} />
          <input type="hidden" name="modelAssetId" value={state.modelAsset.id} />
          <s-button
            slot="primary-action"
            type="submit"
            variant="primary"
            loading={state.publishing || fetcher.state !== 'idle'}
          >
            {state.error ? 'Try again' : 'Publish try-on'}
          </s-button>
        </fetcher.Form>
      )}
    </s-modal>
  )
}

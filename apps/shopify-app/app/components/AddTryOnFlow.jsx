/* eslint-disable react/prop-types -- plain JSX component, no PropTypes dependency */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useFetcher } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { ModelUploadFlow } from './ModelUploadFlow'
import ModelViewer from './ModelViewer'
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

function isReady(asset) {
  return !asset.status || asset.status.toLowerCase() === 'ready'
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

function ModelStep({ assets, onSelect }) {
  const readyAssets = assets.filter(isReady)

  if (readyAssets.length === 0) {
    return (
      <s-stack direction="block" gap="base">
        <s-paragraph>Upload a .glb eyewear model to start setting up try-on.</s-paragraph>
        <ModelUploadFlow embedded onUploaded={onSelect} />
      </s-stack>
    )
  }

  return (
    <s-stack direction="block" gap="base">
      <s-heading>Choose a model</s-heading>
      {readyAssets.map((asset) => (
        <s-box key={asset.id} padding="base" borderWidth="base" borderRadius="base">
          <s-stack direction="block" gap="small-500">
            <ModelViewer src={`/models/${asset.id}.glb`} alt={modelName(asset)} />
            <s-text type="strong">{modelName(asset)}</s-text>
            <s-button onClick={() => onSelect(asset)}>Use {modelName(asset)}</s-button>
          </s-stack>
        </s-box>
      ))}
      <s-divider></s-divider>
      <s-heading>Upload a new model</s-heading>
      <ModelUploadFlow embedded onUploaded={onSelect} />
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
  const heading = state.step === 'model'
    ? (hasReadyModels ? 'Choose a model' : 'Upload a model')
    : 'Set up try-on'

  return (
    <s-modal ref={modalRef} id="add-tryon-flow" heading={heading}>
      {state.step === 'model' && (
        <ModelStep assets={assets} onSelect={(asset) => dispatch({ type: 'model-selected', asset })} />
      )}

      {state.step === 'product' && state.modelAsset && (
        <s-stack direction="block" gap="base">
          <s-heading>Choose a product</s-heading>
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
          <s-heading>Review try-on</s-heading>
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

      <s-button slot="secondary-actions" onClick={close} disabled={state.publishing}>Close</s-button>
      {state.step !== 'model' && (
        <s-button slot="secondary-actions" onClick={back} disabled={state.publishing}>Back</s-button>
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

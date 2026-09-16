/* eslint-disable react/prop-types -- route-local modal components consume loader-shaped data */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import { getActivePlanName } from '../billing.server'
import { handleProductAction } from '../productActions.server'
import ModelPicker from '../components/ModelPicker'
import PreviewPanel from '../components/PreviewPanel'
import StatusBadge from '../components/StatusBadge'
import { emptyWorkspace, loadWorkspace } from '../workspace.server'

// Resolved per-request, not at module load: the last resort must be an
// absolute URL, and only the incoming request reliably gives us one. Neither
// env var is guaranteed to be set (e.g. SHOPIFY_APP_URL is deliberately unset
// for local `shopify app dev`), and a relative string here would make
// previewUrl()'s `new URL(...)` throw and take the whole page down with it.
function resolveEngineUrl(request) {
  return (
    // eslint-disable-next-line no-undef
    process.env.TRYON_ENGINE_URL
    // eslint-disable-next-line no-undef
    || (process.env.SHOPIFY_APP_URL && `${process.env.SHOPIFY_APP_URL}/tryon/index.html`)
    || new URL('/tryon/index.html', request.url).toString()
  )
}

export const loader = async ({ request }) => {
  const engineUrl = resolveEngineUrl(request)
  const { session, admin } = await authenticate.admin(request)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328). Return empty and do no gated work.
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) return { ...emptyWorkspace(session.shop), engineUrl }
  return { ...await loadWorkspace({ admin, shop: session.shop, engineUrl }), engineUrl }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  return handleProductAction({ request, admin, shop: session.shop })
}

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

function retryMatches(data, productId, modelAssetId) {
  return Boolean(
    data?.retryable
    && data.productId === productId
    && data.modelAssetId === modelAssetId,
  )
}

export function mappingSubmitDisabled({
  productId,
  modelAssetId,
  currentModelAssetId = null,
  atLimit = false,
  result = null,
}) {
  if (!productId || !modelAssetId) return true
  const retryable = retryMatches(result, productId, modelAssetId)
  if (retryable) return false
  if (currentModelAssetId) return currentModelAssetId === modelAssetId
  return atLimit
}

export function mappingModalReducer(state, action) {
  if (action.type === 'open') {
    return { mappingId: action.mappingId, session: state.session + 1 }
  }
  if (action.type === 'dismiss') {
    return { mappingId: null, session: state.session + 1 }
  }
  return state
}

function useAfterHide(onAfterHide) {
  const modalRef = useRef(null)

  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return undefined
    modal.addEventListener('afterhide', onAfterHide)
    return () => modal.removeEventListener('afterhide', onAfterHide)
  }, [onAfterHide])

  return modalRef
}

function ChangeModelModalContent({ mapping, assets }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const [modelAssetId, setModelAssetId] = useState(mapping?.modelAssetId ?? '')
  const error = fetcher.data?.error
  const retryable = retryMatches(fetcher.data, mapping?.productId, modelAssetId)
  const disabled = mappingSubmitDisabled({
    productId: mapping?.productId,
    modelAssetId,
    currentModelAssetId: mapping?.modelAssetId,
    result: fetcher.data,
  })

  useEffect(() => {
    if (!fetcher.data?.mapped) return
    shopify.toast.show('Model changed')
    shopify.modal.hide('change-model')
  }, [fetcher.data, shopify])

  const changeModel = () => {
    if (disabled) return
    fetcher.submit(
      { intent: 'map', productId: mapping.productId, modelAssetId },
      { method: 'POST' },
    )
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Choose the frames that should appear when shoppers use try-on for this product.
        </s-paragraph>
        {mapping && (
          <ModelPicker assets={assets} value={modelAssetId} onChange={setModelAssetId} />
        )}
        {error && <s-banner heading="Could not change model" tone="critical">{error}</s-banner>}
      </s-stack>
      <s-button
        slot="secondary-actions"
        commandFor="change-model"
        command="--hide"
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={changeModel}
        disabled={disabled}
        {...(fetcher.state !== 'idle' ? { loading: true } : {})}
      >
        {retryable ? 'Try again' : 'Change model'}
      </s-button>
    </>
  )
}

function ChangeModelModal({ mapping, assets, session, onDismiss }) {
  const modalRef = useAfterHide(onDismiss)

  return (
    <s-modal
      ref={modalRef}
      id="change-model"
      heading={`Change model for ${mapping?.product?.title ?? 'product'}`}
    >
      <ChangeModelModalContent key={session} mapping={mapping} assets={assets} />
    </s-modal>
  )
}

function RemoveTryOnModalContent({ mapping }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const error = fetcher.data?.error

  useEffect(() => {
    if (!fetcher.data?.unmapped) return
    shopify.toast.show('Try-on removed')
    shopify.modal.hide('remove-tryon')
  }, [fetcher.data, shopify])

  const removeTryOn = () => {
    if (!mapping) return
    fetcher.submit(
      { intent: 'unmap', productId: mapping.productId },
      { method: 'POST' },
    )
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Shoppers will no longer be able to try these frames on from this product page.
        </s-paragraph>
        {error && <s-banner heading="Could not remove try-on" tone="critical">{error}</s-banner>}
      </s-stack>
      <s-button
        slot="secondary-actions"
        commandFor="remove-tryon"
        command="--hide"
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        onClick={removeTryOn}
        disabled={!mapping}
        {...(fetcher.state !== 'idle' ? { loading: true } : {})}
      >
        Remove try-on
      </s-button>
    </>
  )
}

function RemoveTryOnModal({ mapping, session, onDismiss }) {
  const modalRef = useAfterHide(onDismiss)

  return (
    <s-modal
      ref={modalRef}
      id="remove-tryon"
      heading={`Remove try-on from ${mapping?.product?.title ?? 'this product'}?`}
    >
      <RemoveTryOnModalContent key={session} mapping={mapping} />
    </s-modal>
  )
}

export default function Products() {
  const { mappings, assets, usage, themeUrl } = useLoaderData()
  const shopify = useAppBridge()

  const mapFetcher = useFetcher()
  const [picked, setPicked] = useState(null)
  const [modelAssetId, setModelAssetId] = useState('')
  const [changeModal, dispatchChangeModal] = useReducer(mappingModalReducer, {
    mappingId: null,
    session: 0,
  })
  const [removeModal, dispatchRemoveModal] = useReducer(mappingModalReducer, {
    mappingId: null,
    session: 0,
  })
  const mapError = mapFetcher.data?.error
  const mapRetryable = retryMatches(mapFetcher.data, picked?.id, modelAssetId)
  const mapDisabled = mappingSubmitDisabled({
    productId: picked?.id,
    modelAssetId,
    atLimit: usage.atLimit,
    result: mapFetcher.data,
  })
  const changeMapping = mappings.find((mapping) => mapping.id === changeModal.mappingId) ?? null
  const removeMapping = mappings.find((mapping) => mapping.id === removeModal.mappingId) ?? null
  const dismissChangeModal = useCallback(() => {
    dispatchChangeModal({ type: 'dismiss' })
  }, [])
  const dismissRemoveModal = useCallback(() => {
    dispatchRemoveModal({ type: 'dismiss' })
  }, [])

  useEffect(() => {
    if (mapFetcher.data?.mapped) {
      shopify.toast.show('Try-on added')
      setPicked(null)
      setModelAssetId('')
      shopify.modal.hide('add-tryon')
    }
  }, [mapFetcher.data, shopify])

  useEffect(() => {
    if (changeModal.mappingId) shopify.modal.show('change-model')
  }, [changeModal.mappingId, changeModal.session, shopify])

  useEffect(() => {
    if (removeModal.mappingId) shopify.modal.show('remove-tryon')
  }, [removeModal.mappingId, removeModal.session, shopify])

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({ type: 'product', action: 'select' })
    if (selection && selection[0]) {
      const p = selection[0]
      setPicked({ id: p.id, title: p.title, imageUrl: p.images?.[0]?.originalSrc ?? null })
    }
  }

  const submitMapping = () => {
    if (mapDisabled) return
    mapFetcher.submit({ intent: 'map', productId: picked.id, modelAssetId }, { method: 'POST' })
  }

  const liveCount = mappings.filter((mapping) => mapping.status === 'live').length
  const attentionCount = mappings.length - liveCount
  const usageText = usage.unlimited
    ? `${usage.used} product${usage.used === 1 ? '' : 's'} using try-on`
    : `${usage.used} of ${usage.limit} products using try-on`

  return (
    <s-page heading="Products">
      <s-button slot="primary-action" commandFor="add-tryon" command="--show" disabled={usage.atLimit}>
        Add try-on
      </s-button>

      <s-section>
        <s-box padding="base" background="subdued" borderRadius="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-text type="strong">{usage.planName ?? 'No active plan'}</s-text>
            <s-text>{usageText}</s-text>
            {mappings.length > 0 && (
              <s-text color="subdued">
                {liveCount} live, {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
              </s-text>
            )}
            {usage.atLimit && <s-badge tone="warning">Limit reached</s-badge>}
            {usage.pricingUrl && (
              <a href={usage.pricingUrl} target="_top" rel="noreferrer">Upgrade</a>
            )}
          </s-stack>
        </s-box>
      </s-section>

      <s-modal id="add-tryon" heading="Add try-on to a product">
        <s-stack direction="block" gap="base">
          {usage.atLimit && (
            <s-banner tone="warning">
              You&apos;re using all {usage.limit} products on your plan.{' '}
              {usage.pricingUrl && <a href={usage.pricingUrl} target="_top" rel="noreferrer">Upgrade</a>} to add more.
            </s-banner>
          )}
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button onClick={pickProduct} icon="product">
              {picked ? 'Change product' : 'Select product'}
            </s-button>
            {picked && (
              <s-stack direction="inline" gap="small-500" alignItems="center">
                {picked.imageUrl && <s-thumbnail src={picked.imageUrl} alt={picked.title} size="small"></s-thumbnail>}
                <s-text type="strong">{picked.title}</s-text>
              </s-stack>
            )}
          </s-stack>
          <ModelPicker assets={assets} value={modelAssetId} onChange={setModelAssetId} />
          {mapError && <s-banner heading="Could not add try-on" tone="critical">{mapError}</s-banner>}
        </s-stack>
        <s-button slot="secondary-actions" commandFor="add-tryon" command="--hide">
          Cancel
        </s-button>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={submitMapping}
          disabled={mapDisabled}
          {...(mapFetcher.state !== 'idle' ? { loading: true } : {})}
        >
          {mapRetryable ? 'Try again' : 'Add try-on'}
        </s-button>
      </s-modal>

      <s-section heading="Products with try-on">
        {mappings.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Add try-on to your first product</s-text>
            <s-paragraph>
              Upload a model on the <s-link href="/app/models">Models</s-link> page, then
              pick the product it belongs to.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Model</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {mappings.map((m) => (
                <s-table-row key={m.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500" alignItems="center">
                      {m.product?.imageUrl && (
                        <s-thumbnail src={m.product.imageUrl} alt={m.product.imageAlt ?? m.product.title} size="small"></s-thumbnail>
                      )}
                      <s-text type="strong">{m.product?.title ?? 'Product unavailable'}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{modelName(m.modelAsset)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500" alignItems="center">
                      <StatusBadge status={m.merchantStatus ?? m.status} />
                      {(m.status === 'add-to-theme' || m.status?.id === 'not_on_theme') && (
                        <s-button
                          href={m.themeUrl ?? themeUrl}
                          target="_top"
                          variant="primary"
                          icon="external"
                        >
                          Add to theme
                        </s-button>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500">
                      <s-button commandFor={`preview-${m.id}`} command="--show">
                        Preview
                      </s-button>
                      <s-button
                        variant="tertiary"
                        icon="menu-vertical"
                        accessibilityLabel={`Actions for ${m.product?.title ?? 'product'}`}
                        commandFor={`actions-${m.id}`}
                      ></s-button>
                      <s-menu id={`actions-${m.id}`} accessibilityLabel={`Actions for ${m.product?.title ?? 'product'}`}>
                        <s-button
                          icon="edit"
                          onClick={() => dispatchChangeModal({ type: 'open', mappingId: m.id })}
                        >
                          Change model
                        </s-button>
                        <s-button
                          icon="delete"
                          tone="critical"
                          onClick={() => dispatchRemoveModal({ type: 'open', mappingId: m.id })}
                        >
                          Remove try-on
                        </s-button>
                      </s-menu>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {mappings.map((m) => (
          <s-modal key={m.id} id={`preview-${m.id}`} heading={`Preview ${m.product?.title ?? 'try-on'}`}>
            <PreviewPanel mapping={m} />
          </s-modal>
        ))}
        <ChangeModelModal
          mapping={changeMapping}
          assets={assets}
          session={changeModal.session}
          onDismiss={dismissChangeModal}
        />
        <RemoveTryOnModal
          mapping={removeMapping}
          session={removeModal.session}
          onDismiss={dismissRemoveModal}
        />
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}

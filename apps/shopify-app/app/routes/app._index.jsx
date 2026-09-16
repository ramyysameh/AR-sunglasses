/* eslint-disable react/prop-types -- route-local dialogs consume loader-shaped data */
import { boundary } from '@shopify/shopify-app-react-router/server'
import { useAppBridge } from '@shopify/app-bridge-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFetcher, useLoaderData, useLocation, useRevalidator } from 'react-router'
import { authenticate } from '../shopify.server'
import { handleProductAction } from '../productActions.server'
import { loadWorkspace } from '../workspace.server'
import { AddTryOnFlow } from '../components/AddTryOnFlow'
import ModelPicker from '../components/ModelPicker'
import PreviewPanel from '../components/PreviewPanel'
import ProductOperationsList, { filterWorkspaceMappings } from '../components/ProductOperationsList'
import WorkspaceFilters from '../components/WorkspaceFilters'
import WorkspaceGuide from '../components/WorkspaceGuide'
import workspaceStyles from '../styles/workspace.css?url'

function resolveEngineUrl(request) {
  return (
    // eslint-disable-next-line no-undef
    process.env.TRYON_ENGINE_URL
    // eslint-disable-next-line no-undef
    || (process.env.SHOPIFY_APP_URL && `${process.env.SHOPIFY_APP_URL}/tryon/index.html`)
    || new URL('/tryon/index.html', request.url).toString()
  )
}

function isReady(asset) {
  return typeof asset.status === 'string' && asset.status.toLowerCase() === 'ready'
}

export function initialAddRequest(search, assets) {
  const params = new URLSearchParams(search)
  if (params.get('add') !== '1') return { open: false, modelId: undefined }
  const requestedId = params.get('model')
  const modelId = assets.some((asset) => asset.id === requestedId && isReady(asset))
    ? requestedId
    : undefined
  return { open: true, modelId }
}

function createAddTryOnFocusController({ setOpen, triggerRef, initiallyOpen = false }) {
  let awaitingHide = initiallyOpen

  return {
    open() {
      awaitingHide = true
      setOpen(true)
    },
    afterHide() {
      if (!awaitingHide) return
      awaitingHide = false
      setOpen(false)
      triggerRef.current?.focus()
    },
  }
}

export const links = () => [{ rel: 'stylesheet', href: workspaceStyles }]

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  return loadWorkspace({ admin, shop: session.shop, engineUrl: resolveEngineUrl(request) })
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  return handleProductAction({ request, admin, shop: session.shop })
}

export function ChangeModelDialog({ mapping, assets, onDone, session = 0 }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const attemptRef = useRef({ session, mappingId: mapping?.id, modelAssetId: mapping?.modelAssetId, submission: null })
  const modalRef = useRef(null)
  const [modelAssetId, setModelAssetId] = useState(mapping?.modelAssetId ?? '')
  const attempt = attemptRef.current
  if (
    attempt.session !== session
    || attempt.mappingId !== mapping?.id
    || attempt.modelAssetId !== mapping?.modelAssetId
  ) {
    attemptRef.current = {
      session,
      mappingId: mapping?.id,
      modelAssetId: mapping?.modelAssetId,
      submission: null,
    }
  }
  const submission = attemptRef.current.submission
  const retryable = Boolean(
    submission
    && submission.priorData !== fetcher.data
    && fetcher.data?.retryable
    && fetcher.data.productId === submission.productId
    && fetcher.data.modelAssetId === submission.modelAssetId
    && submission.productId === mapping?.productId
    && submission.modelAssetId === modelAssetId,
  )
  const submitDisabled = !mapping
    || !modelAssetId
    || (modelAssetId === mapping.modelAssetId && !retryable)

  useEffect(() => {
    const submission = attemptRef.current.submission
    if (!fetcher.data || !submission || submission.priorData === fetcher.data) return
    if (!fetcher.data.mapped) return
    attemptRef.current.submission = null
    shopify.toast.show('Model changed')
    shopify.modal.hide('workspace-change-model')
    onDone()
  }, [fetcher.data, onDone, shopify])

  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return undefined
    const invalidateRetry = () => { attemptRef.current.submission = null }
    modal.addEventListener('hide', invalidateRetry)
    return () => modal.removeEventListener('hide', invalidateRetry)
  }, [])

  const selectModel = (selectedModelAssetId) => {
    attemptRef.current.submission = null
    setModelAssetId(selectedModelAssetId)
  }

  const beginSubmit = () => {
    attemptRef.current.submission = {
      priorData: fetcher.data,
      productId: mapping?.productId,
      modelAssetId,
    }
  }

  return (
    <s-modal ref={modalRef} id="workspace-change-model" heading={`Change model for ${mapping?.product?.title ?? 'product'}`}>
      <s-stack direction="block" gap="base">
        <s-paragraph>Choose the frames shoppers should see for this product.</s-paragraph>
        {mapping && <ModelPicker assets={assets} value={modelAssetId} onChange={selectModel} />}
        {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      </s-stack>
      <s-button slot="secondary-actions" commandFor="workspace-change-model" command="--hide">Cancel</s-button>
      <fetcher.Form
        method="post"
        onSubmit={beginSubmit}
      >
        <input type="hidden" name="intent" value="map" />
        <input type="hidden" name="productId" value={mapping?.productId ?? ''} />
        <input type="hidden" name="modelAssetId" value={modelAssetId} />
        <s-button slot="primary-action" type="submit" variant="primary" disabled={submitDisabled} loading={fetcher.state !== 'idle'}>{retryable ? 'Try again' : 'Change model'}</s-button>
      </fetcher.Form>
    </s-modal>
  )
}

export function RemoveTryOnDialog({ mapping, onDone }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const submissionRef = useRef(null)

  useEffect(() => {
    const submission = submissionRef.current
    if (!fetcher.data || !submission || submission.priorData === fetcher.data) return
    submissionRef.current = null
    if (!fetcher.data.unmapped) return
    shopify.toast.show('Try-on removed')
    shopify.modal.hide('workspace-remove-tryon')
    onDone()
  }, [fetcher.data, onDone, shopify])

  return (
    <s-modal id="workspace-remove-tryon" heading={`Remove try-on from ${mapping?.product?.title ?? 'this product'}?`}>
      <s-paragraph>Shoppers will no longer see try-on on this product page.</s-paragraph>
      {fetcher.data?.error && <s-banner tone="critical">{fetcher.data.error}</s-banner>}
      <s-button slot="secondary-actions" commandFor="workspace-remove-tryon" command="--hide">Cancel</s-button>
      <fetcher.Form
        method="post"
        onSubmit={() => { submissionRef.current = { priorData: fetcher.data } }}
      >
        <input type="hidden" name="intent" value="unmap" />
        <input type="hidden" name="productId" value={mapping?.productId ?? ''} />
        <s-button slot="primary-action" type="submit" variant="primary" tone="critical" disabled={!mapping} loading={fetcher.state !== 'idle'}>Remove try-on</s-button>
      </fetcher.Form>
    </s-modal>
  )
}

export default function Workspace() {
  const data = useLoaderData()
  const location = useLocation()
  const revalidator = useRevalidator()
  const shopify = useAppBridge()
  const initialRequest = initialAddRequest(location.search, data.assets)
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const [addTryOnOpen, setAddTryOnOpen] = useState(initialRequest.open)
  const [initialModelId] = useState(initialRequest.modelId)
  const [previewMapping, setPreviewMapping] = useState(null)
  const [changeMapping, setChangeMapping] = useState(null)
  const [changeDialogSession, setChangeDialogSession] = useState(0)
  const [removeMapping, setRemoveMapping] = useState(null)
  const addTryOnTriggerRef = useRef(null)
  const addTryOnFocusControllerRef = useRef(null)
  if (!addTryOnFocusControllerRef.current) {
    addTryOnFocusControllerRef.current = createAddTryOnFocusController({
      setOpen: setAddTryOnOpen,
      triggerRef: addTryOnTriggerRef,
      initiallyOpen: initialRequest.open,
    })
  }
  const addTryOnFocusController = addTryOnFocusControllerRef.current
  const visibleMappings = filterWorkspaceMappings(data.mappings, { status, query })

  const openAddTryOn = addTryOnFocusController.open
  const handleGuideAction = (guideAction) => {
    if (guideAction.id === 'add-try-on') openAddTryOn()
    if (guideAction.id === 'choose-model') {
      const mapping = data.mappings.find((candidate) => candidate.id === guideAction.mappingId)
      if (mapping) openChangeModel(mapping)
    }
  }
  const openPreview = (mapping) => {
    setPreviewMapping(mapping)
    shopify.modal.show('workspace-preview')
  }
  const openChangeModel = (mapping) => {
    setChangeMapping(mapping)
    setChangeDialogSession((current) => current + 1)
    shopify.modal.show('workspace-change-model')
  }
  const openRemove = (mapping) => {
    setRemoveMapping(mapping)
    shopify.modal.show('workspace-remove-tryon')
  }
  const refreshWorkspace = useCallback(() => revalidator.revalidate(), [revalidator])
  const handlePublished = () => {
    shopify.toast.show('Try-on published')
    refreshWorkspace()
  }

  return (
    <s-page heading="Workspace">
      <s-button
        ref={addTryOnTriggerRef}
        slot="primary-action"
        commandFor="add-tryon-flow"
        command="--show"
        onClick={openAddTryOn}
        disabled={data.usage.atLimit}
      >
        Add try-on
      </s-button>

      <div className="workspace-shell">
        <WorkspaceGuide guide={data.guide} onAction={handleGuideAction} />
        <WorkspaceFilters counts={data.counts} status={status} query={query} onStatusChange={setStatus} onQueryChange={setQuery} />
        <section className="workspace-panel" aria-label="Product operations">
          <ProductOperationsList
            mappings={visibleMappings}
            totalCount={data.mappings.length}
            pricingUrl={data.usage.pricingUrl}
            onPreview={openPreview}
            onChangeModel={openChangeModel}
            onRemove={openRemove}
          />
        </section>
      </div>

      <AddTryOnFlow assets={data.assets} initialModelId={initialModelId} open={addTryOnOpen} onClose={addTryOnFocusController.afterHide} onPublished={handlePublished} />

      <s-modal id="workspace-preview" heading={`Preview ${previewMapping?.product?.title ?? 'try-on'}`}>
        {previewMapping && <PreviewPanel mapping={previewMapping} />}
      </s-modal>
      <ChangeModelDialog key={changeMapping?.id ?? 'no-change'} mapping={changeMapping} assets={data.assets} onDone={refreshWorkspace} session={changeDialogSession} />
      <RemoveTryOnDialog key={removeMapping?.id ?? 'no-remove'} mapping={removeMapping} onDone={refreshWorkspace} />

      <s-section slot="aside" heading="Support">
        <s-paragraph><s-link href="/privacy" target="_blank">Privacy policy</s-link></s-paragraph>
        <s-paragraph>Need help? <s-link href="mailto:ramy.sameh2@gmail.com">Contact support</s-link>.</s-paragraph>
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => boundary.headers(headersArgs)

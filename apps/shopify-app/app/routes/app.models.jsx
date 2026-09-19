/* eslint-disable react/prop-types -- route-local modal components consume loader-shaped data */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useFetcher, useLoaderData, useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { deleteModelGlb } from '../storage.server'
import { themeEditorUrl } from '../adminLinks.server'
// A .server.js import used only inside the loader below (never referenced
// from the component body) is stripped from the client bundle by the
// `.server.js` naming convention -- same pattern app.products.jsx already
// uses for `productStatus`. This keeps the "does this asset need review"
// predicate single-sourced in tryonStatus.server.js instead of re-deriving
// the confidence threshold here, so "ready but low confidence" can't read as
// needing review on Products but not on Models (or vice versa).
import { needsFitReview } from '../tryonStatus.server'
import ModelViewer from '../components/ModelViewer'
import ModelFitReview from '../components/ModelFitReview'

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  // Derived unconditionally, in both branches below: the review modal (every
  // "Review fit" action beside a model that needs one) offers a direct
  // theme-editor action, and a merchant on the no-plan screen must not be
  // silently missing it if app.jsx's gate is ever bypassed or this route is
  // reached mid-downgrade.
  const themeUrl = themeEditorUrl(session.shop)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328).
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { assets: [], themeUrl }
  }
  const assets = await prisma.modelAsset.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { mappings: true } } },
  })
  return {
    assets: assets.map(({ _count, ...a }) => ({
      ...a,
      mappingCount: _count.mappings,
      needsReview: needsFitReview(a),
    })),
    themeUrl,
  }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'rename') {
    const id = form.get('modelAssetId')?.toString()
    const label = form.get('label')?.toString().trim()
    if (!id) return { error: 'Missing model.' }
    // Scoped to the shop: an id from another shop must not be renamable.
    const { count } = await prisma.modelAsset.updateMany({
      where: { id, shop: session.shop },
      data: { label: label || null },
    })
    if (count === 0) return { error: 'That model no longer exists.' }
    return { renamed: true }
  }

  if (intent === 'delete') {
    const id = form.get('modelAssetId')?.toString()
    if (!id) return { error: 'Missing model.' }
    const asset = await prisma.modelAsset.findFirst({
      where: { id, shop: session.shop },
      include: { _count: { select: { mappings: true } } },
    })
    if (!asset) return { error: 'That model no longer exists.' }
    // The FK is ON DELETE RESTRICT, so deleting a mapped model would throw a
    // raw Prisma error. Refuse with something a merchant can act on instead.
    if (asset._count.mappings > 0) {
      return { error: `That model is used by ${asset._count.mappings} product(s). Remove try-on from them first.` }
    }
    await prisma.modelAsset.delete({ where: { id: asset.id } })
    try {
      await deleteModelGlb(asset.storageRef)
    } catch (e) {
      // The row is gone, which is what the merchant asked for. A stranded
      // object is a storage cost, not a user-visible failure.
      console.error('model GLB delete failed', e)
    }
    return { deleted: true }
  }

  // Model upload (presign/finalize) lives in the api.model-upload resource
  // route: a raw fetch() POST here returns the rendered HTML document instead
  // of JSON. See app/routes/api.model-upload.jsx.
  return { error: 'Unknown action.' }
}

const MAX_UPLOAD_BYTES = 25 * 1048576

export function modelName(asset) {
  return asset.label?.trim() || asset.filename || `Model ${asset.id.slice(0, 8)}`
}

export function uploadValidationError(file) {
  if (!file || !file.name.toLowerCase().endsWith('.glb')) return 'Choose a .glb file'
  if (file.size > MAX_UPLOAD_BYTES) return 'Model exceeds the 25 MB limit'
  return null
}

export function renameSubmitDisabled({ asset, draft, currentLabel, state }) {
  if (asset === null) return true
  return state !== 'idle' || draft.trim() === (currentLabel ?? '').trim()
}

export function modalSessionReducer(state, action) {
  if (action.type === 'open') {
    return { modelId: action.modelId, session: state.session + 1 }
  }
  if (action.type === 'dismiss') {
    return { modelId: null, session: state.session + 1 }
  }
  return state
}

export function uploadModalReducer(state, action) {
  if (action.type === 'select') {
    return { pendingFile: action.file, uploadError: null }
  }
  if (action.type === 'reject') {
    return { pendingFile: null, uploadError: 'Choose a .glb file' }
  }
  if (action.type === 'error') {
    return { ...state, uploadError: action.message }
  }
  return state
}

export function uploadModalHideBehavior(busy) {
  return busy
    ? { reopen: true, reset: false }
    : { reopen: false, reset: true }
}

export function createUploadCancellationCoordinator() {
  /** @type {{ controller: AbortController, xhr: XMLHttpRequest | null } | null} */
  // @ts-ignore -- the Shopify validator wraps this JS file as TSX and ignores JSDoc types.
  let activeUpload = null

  return {
    begin() {
      const controller = new AbortController()
      activeUpload = { controller, xhr: null }
      return controller.signal
    },
    attachXhr(xhr) {
      if (!activeUpload || activeUpload.controller.signal.aborted) {
        xhr.abort()
        return
      }
      activeUpload.xhr = xhr
    },
    detachXhr(xhr) {
      if (activeUpload?.xhr === xhr) activeUpload.xhr = null
    },
    abortForUnmount() {
      const upload = activeUpload
      activeUpload = null
      upload?.controller.abort()
      upload?.xhr?.abort()
    },
  }
}

function useModalEvents({ onHide = undefined, onAfterHide = undefined }) {
  const modalRef = useRef(null)

  useEffect(() => {
    const modal = modalRef.current
    if (!modal) return undefined
    if (onHide) modal.addEventListener('hide', onHide)
    if (onAfterHide) modal.addEventListener('afterhide', onAfterHide)
    return () => {
      if (onHide) modal.removeEventListener('hide', onHide)
      if (onAfterHide) modal.removeEventListener('afterhide', onAfterHide)
    }
  }, [onAfterHide, onHide])

  return modalRef
}

// Pulled out of the useEffect below so the wiring itself -- "does a
// `droprejected` event on the element reach the reducer as a `reject`
// action" -- is unit-testable against a plain fake element (addEventListener/
// removeEventListener only), without needing a real DOM. This repo's test
// environment has no jsdom (see productIndex.ui.test.js's ref-only coverage
// of the sibling previouspage/nextpage wiring), so this is the closest thing
// to a behavioral test available for the fix without adding a new
// dependency: it proves the actual attach/detach logic, and combined with
// uploadModalReducer's existing 'reject' coverage, closes the loop through
// to the rendered "Choose a .glb file" banner text.
export function attachDropRejectedListener(dropZone, dispatchUpload) {
  const handleDropRejected = () => dispatchUpload({ type: 'reject' })
  dropZone.addEventListener('droprejected', handleDropRejected)
  return () => dropZone.removeEventListener('droprejected', handleDropRejected)
}

// Split out from UploadModalContent so the dropZoneRef wiring can be
// asserted structurally (the ref lands on the real <s-drop-zone>, and
// onDropRejected is genuinely gone, not just unused) without executing
// hooks outside of a render -- the same tableRef/ProductTable split
// ProductIndex.jsx already uses for its own ref-wired custom element.
export function DropZoneField({ dropZoneRef, disabled, onInput }) {
  return (
    <s-drop-zone
      ref={dropZoneRef}
      label="Model file (.glb)"
      name="model"
      accept=".glb,model/gltf-binary"
      accessibilityLabel="Choose a GLB model file"
      disabled={disabled}
      // Not onChange: React 18's ChangeEventPlugin only special-cases a
      // real <select>/<input type=file> when deciding whether to dispatch a
      // synthetic `change` event -- s-drop-zone is a custom element, so
      // onChange here was silently never firing (a file chosen via the drop
      // zone never reached dispatchUpload). `input` is a simple,
      // type-agnostic DOM event React forwards regardless of tag name, and
      // Shopify's polaris-types IDL documents onInput for s-drop-zone
      // alongside onChange -- see ModelPicker.jsx's search field /
      // ProductIndex.jsx's search field for the same reasoning already
      // applied elsewhere in this app.
      onInput={onInput}
      // `onDropRejected` is NOT wired here -- `dropRejected` is not in React
      // 18's simpleEventPluginEvents registry, so the prop is silently
      // stripped and the handler never runs. See attachDropRejectedListener
      // above and its useEffect call site for the real fix.
    ></s-drop-zone>
  )
}

async function postUploadJson(body, signal) {
  const res = await fetch('/api/model-upload', { method: 'POST', body, signal })
  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Server error (HTTP ${res.status})`)
  }
  if (data.error) throw new Error(data.error)
  return data
}

function UploadModalContent({ cancellationCoordinator, onBusyChange }) {
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [{ pendingFile, uploadError }, dispatchUpload] = useReducer(uploadModalReducer, {
    pendingFile: null,
    uploadError: null,
  })
  const [progress, setProgress] = useState(null)
  const uploading = progress !== null
  const dropZoneRef = useRef(null)

  // `dropRejected` (fired when a dropped/chosen file fails the `accept`
  // filter) is not in React 18's simpleEventPluginEvents registry, so the
  // `onDropRejected` JSX prop DropZoneField used to carry was silently
  // stripped -- the handler never ran, and a merchant dropping a non-.glb
  // file got total silence instead of the "Choose a .glb file" banner.
  // Confirmed via @shopify/polaris-types/dist/polaris.d.ts:3881, which
  // documents the real IDL event as `ondroprejected` (i.e. the DOM event
  // name is `droprejected`). Wire it by hand, the same ref+addEventListener
  // pattern as useModalEvents above and the pagination wiring in
  // ProductIndex.jsx.
  useEffect(() => {
    const dropZone = dropZoneRef.current
    if (!dropZone) return undefined
    return attachDropRejectedListener(dropZone, dispatchUpload)
  }, [])

  const upload = async () => {
    const validationError = uploadValidationError(pendingFile)
    if (validationError) {
      dispatchUpload({ type: 'error', message: validationError })
      return
    }

    dispatchUpload({ type: 'select', file: pendingFile })
    onBusyChange(true)
    setProgress(0)
    const signal = cancellationCoordinator.begin()
    try {
      const presignForm = new FormData()
      presignForm.append('intent', 'upload-presign')
      const { uploadUrl, storageRef } = await postUploadJson(presignForm, signal)
      if (signal.aborted) return

      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        cancellationCoordinator.attachXhr(xhr)
        if (signal.aborted) {
          reject(new DOMException('Upload canceled', 'AbortError'))
          return
        }
        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', 'model/gltf-binary')
        xhr.upload.onprogress = (event) => {
          if (!signal.aborted && event.lengthComputable) {
            setProgress(Math.round((event.loaded / event.total) * 100))
          }
        }
        xhr.onload = () => {
          cancellationCoordinator.detachXhr(xhr)
          if (xhr.status >= 200 && xhr.status < 300) resolve(undefined)
          else reject(new Error(`Upload failed (${xhr.status})`))
        }
        xhr.onerror = () => {
          cancellationCoordinator.detachXhr(xhr)
          reject(new Error('Upload failed (network/CORS)'))
        }
        xhr.onabort = () => reject(new DOMException('Upload canceled', 'AbortError'))
        xhr.send(pendingFile)
      })
      if (signal.aborted) return

      setProgress('preparing')
      const finalizeForm = new FormData()
      finalizeForm.append('intent', 'upload-finalize')
      finalizeForm.append('storageRef', storageRef)
      finalizeForm.append('filename', pendingFile.name)
      await postUploadJson(finalizeForm, signal)
      if (signal.aborted) return

      onBusyChange(false)
      setProgress(null)
      shopify.toast.show('Model ready')
      shopify.modal.hide('upload-model')
      revalidator.revalidate()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!signal.aborted) dispatchUpload({ type: 'error', message })
    } finally {
      if (!signal.aborted) {
        onBusyChange(false)
        setProgress(null)
      }
    }
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Choose a .glb eyewear model up to 25 MB. We&apos;ll prepare it for try-on.
        </s-paragraph>
        <DropZoneField
          dropZoneRef={dropZoneRef}
          disabled={uploading}
          onInput={(event) => {
            dispatchUpload({
              type: 'select',
              file: event.currentTarget.files?.[0] ?? null,
            })
          }}
        />
        {pendingFile && (
          <s-text color="subdued">
            {pendingFile.name} ({(pendingFile.size / 1048576).toFixed(1)} MB)
          </s-text>
        )}
        {progress !== null && (
          <s-stack direction="block" gap="small-500">
            {typeof progress === 'number' ? (
              <>
                <progress value={progress} max="100" style={{ width: '100%' }} />
                <s-text>Uploading {progress}%</s-text>
              </>
            ) : (
              <s-text>Preparing model...</s-text>
            )}
            <s-text color="subdued">Keep this window open while the model is uploading and preparing.</s-text>
          </s-stack>
        )}
        {uploadError && (
          <s-banner heading="Could not upload model" tone="critical">
            {uploadError}
          </s-banner>
        )}
      </s-stack>
      {!uploading && (
        <s-button
          slot="secondary-actions"
          commandFor="upload-model"
          command="--hide"
        >
          Cancel
        </s-button>
      )}
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={upload}
        disabled={!pendingFile || uploading}
        {...(uploading ? { loading: true } : {})}
      >
        Upload model
      </s-button>
    </>
  )
}

function UploadModal() {
  const shopify = useAppBridge()
  const [session, setSession] = useState(0)
  const busyRef = useRef(false)
  const cancellationCoordinator = useRef(null)
  if (!cancellationCoordinator.current) {
    cancellationCoordinator.current = createUploadCancellationCoordinator()
  }

  const onBusyChange = useCallback((busy) => {
    busyRef.current = busy
  }, [])
  const finishHide = useCallback(() => {
    const behavior = uploadModalHideBehavior(busyRef.current)
    if (behavior.reopen) {
      shopify.modal.show('upload-model')
    } else if (behavior.reset) {
      setSession((value) => value + 1)
    }
  }, [shopify])
  const modalRef = useModalEvents({ onAfterHide: finishHide })

  useEffect(() => () => cancellationCoordinator.current.abortForUnmount(), [])

  return (
    <s-modal ref={modalRef} id="upload-model" heading="Upload model">
      <UploadModalContent
        key={session}
        cancellationCoordinator={cancellationCoordinator.current}
        onBusyChange={onBusyChange}
      />
    </s-modal>
  )
}

function RenameModalContent({ asset }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const [draft, setDraft] = useState(asset?.label ?? '')
  const disabled = renameSubmitDisabled({
    asset: asset ?? null,
    draft,
    currentLabel: asset?.label,
    state: fetcher.state,
  })

  useEffect(() => {
    if (!fetcher.data?.renamed) return
    shopify.toast.show('Name saved')
    shopify.modal.hide('rename-model')
  }, [fetcher.data, shopify])

  const rename = () => {
    if (disabled) return
    fetcher.submit(
      { intent: 'rename', modelAssetId: asset.id, label: draft.trim() },
      { method: 'POST' },
    )
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Model name"
          value={draft}
          placeholder={asset?.filename ?? 'Model name'}
          // Not onChange -- same React 18 custom-element dispatch gap as the
          // drop zone above: typing into the rename field never updated
          // `draft`, so Save stayed disabled (renameSubmitDisabled compares
          // draft to the current label) no matter what was typed. onInput is
          // the per-keystroke event this field already needs.
          onInput={(event) => setDraft(event.currentTarget.value)}
        ></s-text-field>
        <s-paragraph color="subdued">
          Leave the name blank to use the filename in your model library.
        </s-paragraph>
        {fetcher.data?.error && (
          <s-banner heading="Could not rename model" tone="critical">
            {fetcher.data.error}
          </s-banner>
        )}
      </s-stack>
      <s-button
        slot="secondary-actions"
        commandFor="rename-model"
        command="--hide"
      >
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={rename}
        disabled={disabled}
        {...(fetcher.state !== 'idle' ? { loading: true } : {})}
      >
        Save
      </s-button>
    </>
  )
}

function RenameModal({ asset, session, onDismiss }) {
  const modalRef = useModalEvents({ onAfterHide: onDismiss })

  return (
    <s-modal
      ref={modalRef}
      id="rename-model"
      heading={`Rename ${asset ? modelName(asset) : 'model'}`}
    >
      <RenameModalContent key={session} asset={asset} />
    </s-modal>
  )
}

function DeleteModalContent({ modelId }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()

  useEffect(() => {
    if (!fetcher.data?.deleted) return
    shopify.toast.show('Model deleted')
    shopify.modal.hide('delete-model')
  }, [fetcher.data, shopify])

  const remove = () => {
    if (!modelId) return
    fetcher.submit(
      { intent: 'delete', modelAssetId: modelId },
      { method: 'POST' },
    )
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          This removes the model and its 3D file. You can&apos;t undo it, and you&apos;ll
          need to upload the file again to use it later.
        </s-paragraph>
        {fetcher.data?.error && (
          <s-banner heading="Could not delete model" tone="critical">
            {fetcher.data.error}
          </s-banner>
        )}
      </s-stack>
      <s-button slot="secondary-actions" commandFor="delete-model" command="--hide">
        Cancel
      </s-button>
      <s-button
        slot="primary-action"
        variant="primary"
        tone="critical"
        onClick={remove}
        disabled={!modelId || fetcher.state !== 'idle'}
        {...(fetcher.state !== 'idle' ? { loading: true } : {})}
      >
        Delete model
      </s-button>
    </>
  )
}

function DeleteModal({ asset, modelId, session, onDismiss }) {
  const modalRef = useModalEvents({ onAfterHide: onDismiss })

  return (
    <s-modal
      ref={modalRef}
      id="delete-model"
      heading={asset ? `Delete ${modelName(asset)}?` : 'Delete model?'}
    >
      <DeleteModalContent key={session} modelId={modelId} />
    </s-modal>
  )
}

// One shared modal for every "Review fit" action in the grid, not one modal
// per card -- same route-owned-selected-id session pattern as Rename/Delete
// above. `asset` is null until a card's action opens it (and again after
// dismissal), so this renders nothing until then; ModelFitReview itself is
// the shared surface also used by PreviewPanel.jsx for the product preview.
function ReviewFitModalContent({ asset, themeUrl }) {
  if (!asset) return null
  return <ModelFitReview modelAssetId={asset.id} themeUrl={themeUrl} />
}

function ReviewFitModal({ asset, themeUrl, session, onDismiss }) {
  const modalRef = useModalEvents({ onAfterHide: onDismiss })

  return (
    <s-modal
      ref={modalRef}
      id="review-model-fit"
      heading={asset ? `Review fit for ${modelName(asset)}` : 'Review fit'}
    >
      <ReviewFitModalContent key={session} asset={asset} themeUrl={themeUrl} />
      <s-button slot="secondary-actions" commandFor="review-model-fit" command="--hide">
        Close
      </s-button>
    </s-modal>
  )
}

export default function Models() {
  const { assets, themeUrl } = useLoaderData()
  const shopify = useAppBridge()
  const [renameModal, dispatchRenameModal] = useReducer(modalSessionReducer, {
    modelId: null,
    session: 0,
  })
  const [deleteModal, dispatchDeleteModal] = useReducer(modalSessionReducer, {
    modelId: null,
    session: 0,
  })
  const [reviewModal, dispatchReviewModal] = useReducer(modalSessionReducer, {
    modelId: null,
    session: 0,
  })
  const renameAsset = assets.find((asset) => asset.id === renameModal.modelId) ?? null
  const deleteAsset = assets.find((asset) => asset.id === deleteModal.modelId) ?? null
  const reviewAsset = assets.find((asset) => asset.id === reviewModal.modelId) ?? null
  const dismissRename = useCallback(() => dispatchRenameModal({ type: 'dismiss' }), [])
  const dismissDelete = useCallback(() => dispatchDeleteModal({ type: 'dismiss' }), [])
  const dismissReview = useCallback(() => dispatchReviewModal({ type: 'dismiss' }), [])

  useEffect(() => {
    if (renameModal.modelId) shopify.modal.show('rename-model')
  }, [renameModal.modelId, renameModal.session, shopify])

  return (
    <s-page heading="Models">
      <s-button
        slot="primary-action"
        variant="primary"
        commandFor="upload-model"
        command="--show"
      >
        Upload model
      </s-button>

      <s-section heading="Model library">
        {assets.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Add your first model</s-text>
            <s-paragraph>
              Upload a .glb eyewear model to make it available for try-on products.
            </s-paragraph>
            <s-button commandFor="upload-model" command="--show">
              Upload model
            </s-button>
          </s-stack>
        ) : (
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 260px), 1fr))"
            gap="base"
          >
            {assets.map((asset) => {
              const displayName = modelName(asset)
              const showFilename = Boolean(
                asset.label?.trim() && asset.filename && asset.filename !== displayName,
              )

              return (
                <s-box
                  key={asset.id}
                  padding="base"
                  border="base"
                  borderRadius="base"
                >
                  <s-stack direction="block" gap="base">
                    <ModelViewer src={`/models/${asset.id}.glb`} alt={displayName} />
                    <s-stack direction="inline" gap="small-500" alignItems="center">
                      <s-heading>{displayName}</s-heading>
                      {/* Keyed on the loader's needsReview (status OR low
                          confidence, tryonStatus.server.js's single-sourced
                          needsFitReview), not raw asset.status -- a
                          status:'ready', low-confidence asset must read the
                          same way here as it does as Products' "Review fit"
                          status, or Help's "open Models and use Review fit"
                          guidance walks a merchant into a Models card that
                          just says "Ready" with no action. */}
                      <s-badge tone={asset.needsReview ? 'warning' : 'success'}>
                        {asset.needsReview ? 'Review fit' : 'Ready'}
                      </s-badge>
                      {asset.needsReview && (
                        <s-button
                          variant="tertiary"
                          commandFor="review-model-fit"
                          command="--show"
                          accessibilityLabel={`Review fit for ${displayName}`}
                          onClick={() => dispatchReviewModal({ type: 'open', modelId: asset.id })}
                        >
                          Review fit
                        </s-button>
                      )}
                    </s-stack>
                    {showFilename && <s-text color="subdued">{asset.filename}</s-text>}
                    {asset.mappingCount > 0 ? (
                      <s-text color="subdued">
                        Used by {asset.mappingCount} product{asset.mappingCount === 1 ? '' : 's'}.{' '}
                        <s-link href="/app/products">View products</s-link>
                      </s-text>
                    ) : (
                      <s-text color="subdued">Not used by any products</s-text>
                    )}
                    <s-stack direction="inline" gap="small-500">
                      <s-button
                        icon="edit"
                        onClick={() => dispatchRenameModal({ type: 'open', modelId: asset.id })}
                      >
                        Rename
                      </s-button>
                      {asset.mappingCount === 0 && (
                        <s-button
                          variant="tertiary"
                          tone="critical"
                          icon="delete"
                          commandFor="delete-model"
                          command="--show"
                          onClick={() => dispatchDeleteModal({
                            type: 'open',
                            modelId: asset.id,
                          })}
                        >
                          Delete
                        </s-button>
                      )}
                    </s-stack>
                  </s-stack>
                </s-box>
              )
            })}
          </s-grid>
        )}
      </s-section>

      <UploadModal />
      <RenameModal
        asset={renameAsset}
        session={renameModal.session}
        onDismiss={dismissRename}
      />
      <DeleteModal
        asset={deleteAsset}
        modelId={deleteModal.modelId}
        session={deleteModal.session}
        onDismiss={dismissDelete}
      />
      <ReviewFitModal
        asset={reviewAsset}
        themeUrl={themeUrl}
        session={reviewModal.session}
        onDismiss={dismissReview}
      />
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}

/* eslint-disable react/prop-types -- route-local modal components consume loader-shaped data */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useFetcher, useLoaderData, useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { deleteModelGlb } from '../storage.server'
import ModelViewer from '../components/ModelViewer'

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328).
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { assets: [] }
  }
  const assets = await prisma.modelAsset.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { mappings: true } } },
  })
  return {
    assets: assets.map(({ _count, ...a }) => ({ ...a, mappingCount: _count.mappings })),
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
    cancel() {
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

function UploadModalContent({ cancellationCoordinator }) {
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [{ pendingFile, uploadError }, dispatchUpload] = useReducer(uploadModalReducer, {
    pendingFile: null,
    uploadError: null,
  })
  const [progress, setProgress] = useState(null)
  const uploading = progress !== null

  const upload = async () => {
    const validationError = uploadValidationError(pendingFile)
    if (validationError) {
      dispatchUpload({ type: 'error', message: validationError })
      return
    }

    dispatchUpload({ type: 'select', file: pendingFile })
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
      revalidator.revalidate()

      shopify.toast.show('Model ready')
      shopify.modal.hide('upload-model')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!signal.aborted) dispatchUpload({ type: 'error', message })
    } finally {
      if (!signal.aborted) setProgress(null)
    }
  }

  return (
    <>
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Choose a .glb eyewear model up to 25 MB. We&apos;ll prepare it for try-on.
        </s-paragraph>
        <s-drop-zone
          label="Model file (.glb)"
          name="model"
          accept=".glb,model/gltf-binary"
          accessibilityLabel="Choose a GLB model file"
          disabled={uploading}
          onChange={(event) => {
            dispatchUpload({
              type: 'select',
              file: event.currentTarget.files?.[0] ?? null,
            })
          }}
          onDropRejected={() => dispatchUpload({ type: 'reject' })}
        ></s-drop-zone>
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
          </s-stack>
        )}
        {uploadError && (
          <s-banner heading="Could not upload model" tone="critical">
            {uploadError}
          </s-banner>
        )}
      </s-stack>
      <s-button
        slot="secondary-actions"
        commandFor="upload-model"
        command="--hide"
      >
        Cancel
      </s-button>
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
  const [session, setSession] = useState(0)
  const cancellationCoordinator = useRef(null)
  if (!cancellationCoordinator.current) {
    cancellationCoordinator.current = createUploadCancellationCoordinator()
  }

  const cancel = useCallback(() => cancellationCoordinator.current.cancel(), [])
  const reset = useCallback(() => setSession((value) => value + 1), [])
  const modalRef = useModalEvents({ onHide: cancel, onAfterHide: reset })

  useEffect(() => cancel, [cancel])

  return (
    <s-modal ref={modalRef} id="upload-model" heading="Upload model">
      <UploadModalContent
        key={session}
        cancellationCoordinator={cancellationCoordinator.current}
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
          onChange={(event) => setDraft(event.currentTarget.value)}
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

export default function Models() {
  const { assets } = useLoaderData()
  const shopify = useAppBridge()
  const [renameModal, dispatchRenameModal] = useReducer(modalSessionReducer, {
    modelId: null,
    session: 0,
  })
  const [deleteModal, dispatchDeleteModal] = useReducer(modalSessionReducer, {
    modelId: null,
    session: 0,
  })
  const renameAsset = assets.find((asset) => asset.id === renameModal.modelId) ?? null
  const deleteAsset = assets.find((asset) => asset.id === deleteModal.modelId) ?? null
  const dismissRename = useCallback(() => dispatchRenameModal({ type: 'dismiss' }), [])
  const dismissDelete = useCallback(() => dispatchDeleteModal({ type: 'dismiss' }), [])

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
                      <s-badge tone={asset.status === 'ready' ? 'success' : 'warning'}>
                        {asset.status === 'ready' ? 'Ready' : 'Check fit'}
                      </s-badge>
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
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}

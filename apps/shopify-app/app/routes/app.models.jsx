/* eslint-disable react/prop-types -- route-local modal components consume loader-shaped data */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { deleteModelGlb } from '../storage.server'
import ModelViewer from '../components/ModelViewer'
import {
  ModelUploadFlow,
  createUploadCancellationCoordinator,
  uploadModalHideBehavior,
  uploadModalReducer,
  uploadValidationError,
} from '../components/ModelUploadFlow'

export {
  createUploadCancellationCoordinator,
  uploadModalHideBehavior,
  uploadModalReducer,
  uploadValidationError,
}

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

export function modelName(asset) {
  return asset.label?.trim() || asset.filename || `Model ${asset.id.slice(0, 8)}`
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

function UploadModal() {
  return <ModelUploadFlow onUploaded={() => window.location.reload()} />
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

/* eslint-disable react/prop-types -- route-local modal components consume loader-shaped data */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { deleteModelGlb } from '../storage.server'
import { themeEditorUrl } from '../adminLinks.server'
import { planUsage } from '../planUsage.server'
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
import TopLevelAdminAction from '../components/TopLevelAdminAction'
import {
  attachDropRejectedListener,
  createUploadCancellationCoordinator,
  DropZoneField,
  uploadModalHideBehavior,
  uploadModalReducer,
  uploadValidationError,
} from '../components/ModelUploadFlow'

// Re-exported from the route that used to own them: upstream moved the upload
// modal's internals into the shared ModelUploadFlow component, but the
// existing tests (and any other caller) still reach for them here.
export {
  attachDropRejectedListener,
  createUploadCancellationCoordinator,
  DropZoneField,
  uploadModalHideBehavior,
  uploadModalReducer,
  uploadValidationError,
}

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
    return { assets: [], themeUrl, atLimit: false, pricingUrl: null }
  }
  const [assets, used] = await Promise.all([
    prisma.modelAsset.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { mappings: true } } },
    }),
    prisma.productMapping.count({ where: { shop: session.shop } }),
  ])
  // Same limit the Workspace enforces: at the limit, "Add try-on" here would
  // open a flow whose publish can only fail, so the page offers the upgrade.
  const usage = planUsage({ planName: activePlan, used, shop: session.shop })
  return {
    atLimit: usage.atLimit,
    pricingUrl: usage.pricingUrl,
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

const ADD_TRY_ON_HREF = '/app?add=1'

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
  const { assets, themeUrl, atLimit = false, pricingUrl = null } = useLoaderData()
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
      {/* Models are uploaded inside Add try-on (Models is a library, not an
          upload surface). The ?add=1 deep link opens that flow, whose first step
          offers an upload, so this page always has a way forward. */}
      {atLimit ? (
        <TopLevelAdminAction slot="primary-action" href={pricingUrl} accessibilityLabel="Upgrade plan to add try-on to more products">
          Upgrade plan
        </TopLevelAdminAction>
      ) : (
        <s-button slot="primary-action" href={ADD_TRY_ON_HREF}>
          Add try-on
        </s-button>
      )}
      <s-section heading="Model library">
        {assets.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Your model library is empty</s-text>
            <s-paragraph>
              Upload a .glb eyewear model when you add try-on to a product.
            </s-paragraph>
            <s-stack direction="inline">
              <s-button variant="primary" href={ADD_TRY_ON_HREF}>Upload a model</s-button>
            </s-stack>
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
                        {asset.needsReview ? 'Needs fit review' : 'Ready'}
                      </s-badge>
                    </s-stack>
                    {showFilename && <s-text color="subdued">{asset.filename}</s-text>}
                    {asset.mappingCount > 0 ? (
                      <s-text color="subdued">
                        Used by {asset.mappingCount} product{asset.mappingCount === 1 ? '' : 's'}.{' '}
                        <s-link href={`/app?q=${encodeURIComponent(displayName)}`}>View products</s-link>
                        {/* Says why Delete is missing instead of just hiding it. */}
                        {' '}Remove it from {asset.mappingCount === 1 ? 'that product' : 'those products'} to delete it.
                      </s-text>
                    ) : (
                      <s-text color="subdued">Not used by any products</s-text>
                    )}
                    <s-stack direction="inline" gap="small-500">
                      {asset.needsReview ? (
                        <s-button
                          commandFor="review-model-fit"
                          command="--show"
                          accessibilityLabel={`Review fit for ${displayName}`}
                          onClick={() => dispatchReviewModal({ type: 'open', modelId: asset.id })}
                        >
                          Review fit
                        </s-button>
                      ) : !atLimit && (
                        <s-button
                          href={`/app?add=1&model=${encodeURIComponent(asset.id)}`}
                          accessibilityLabel={`Add try-on with ${displayName}`}
                        >
                          Add try-on
                        </s-button>
                      )}
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

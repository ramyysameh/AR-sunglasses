/* eslint-disable react/prop-types -- route-local modal components consume loader-shaped data */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import QRCode from 'qrcode'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { listMappings, mapProductToModel } from '../models.server'
import { publishMapping, publishMappings, unpublishMapping } from '../tryonMetafield.server'
import { deleteMappingWithRecovery } from '../productMappingRecovery.server'
import { getActivePlanName, planLimit } from '../billing.server'
import { planUsage } from '../planUsage.server'
import ModelPicker from '../components/ModelPicker'
import ProductIndex from '../components/ProductIndex'
import TopLevelAdminAction from '../components/TopLevelAdminAction'
import { fetchProductsByIds } from '../products.server'
import { productStatus } from '../tryonStatus.server'
import { themeEditorUrl, previewUrl } from '../adminLinks.server'

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
  const themeUrl = themeEditorUrl(session.shop)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328). Return empty and do no gated work.
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return {
      mappings: [],
      assets: [],
      usage: planUsage({ planName: null, used: 0, shop: session.shop }),
      themeUrl,
      engineUrl,
    }
  }
  const [mappings, assets] = await Promise.all([
    listMappings(prisma, session.shop),
    prisma.modelAsset.findMany({ where: { shop: session.shop }, orderBy: { createdAt: 'desc' } }),
  ])
  // Self-heal: mappings made before the storefront gate existed have no
  // metafield, so their block would go dark. Re-publishing is idempotent and
  // batched. Best-effort -- a Shopify failure must not take down the page.
  try {
    await publishMappings(admin, mappings.map((m) => m.productId))
  } catch (e) {
    console.error('try-on metafield sync failed', e)
  }
  let products = new Map()
  try {
    products = await fetchProductsByIds(admin, mappings.map((m) => m.productId))
  } catch (e) {
    console.error('product enrichment failed', e)
  }
  return {
    mappings: await Promise.all(
      mappings.map(async (m) => {
        const base = {
          ...m,
          product: products.get(m.productId) ?? null,
          status: productStatus(m),
          // Stamped per-mapping (in addition to the route-level `themeUrl`
          // below, which ProductIndex.jsx/ProductRow already consume) so
          // PreviewPanel's ModelFitReview can offer a direct theme-editor
          // action without needing a themeUrl prop threaded through
          // ProductIndex.jsx, which this task does not otherwise touch.
          themeUrl,
        }
        // Best-effort, like the metafield sync and product enrichment above: a
        // preview convenience must never take down the primary page. A row
        // that fails here just renders its modal without a QR (see PreviewPanel).
        try {
          const url = previewUrl({ engineUrl, shop: session.shop, productId: m.productId })
          return {
            ...base,
            previewUrl: url,
            // Generated here, not in the browser: a client-side QR library would
            // need a CDN script and the admin iframe's CSP is not ours to widen.
            qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }),
          }
        } catch (e) {
          console.error('preview URL/QR generation failed', e)
          return { ...base, previewUrl: null, qr: null }
        }
      }),
    ),
    assets,
    usage: planUsage({ planName: activePlan, used: mappings.length, shop: session.shop }),
    themeUrl,
    engineUrl,
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

  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Pick a product and a model.' }
    }
    // Grandfather existing: only a genuinely NEW product counts against the cap.
    // mapProductToModel upserts on (shop, productId), so a re-map is not new.
    const existing = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop: session.shop, productId } },
    })
    if (!existing) {
      const limit = planLimit(activePlan)
      const count = await prisma.productMapping.count({ where: { shop: session.shop } })
      if (count >= limit) {
        return { error: "You've reached your plan's product limit. Upgrade to add try-on to more products." }
      }
    }
    // Throws when the asset is not this shop's -- a stale model id from a page
    // open since another session deleted it, or a tampered form. Either way the
    // merchant gets the modal's banner, not a raw framework error page, and the
    // internal message stays in the log.
    try {
      await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    } catch (e) {
      console.error('mapProductToModel failed', e)
      return { error: "That model isn't available any more. Pick another one." }
    }
    // The mapping is committed; now project it onto the storefront. The block
    // renders only where this metafield exists, so a failure here means a
    // mapping visible in the admin but not on the product page.
    try {
      await publishMapping(admin, productId)
    } catch (e) {
      console.error('try-on metafield publish failed', e)
      return {
        error: "Added, but try-on couldn't be turned on for your storefront. Try again.",
        retryable: true,
        productId,
        modelAssetId,
      }
    }
    return { mapped: true }
  }

  if (intent !== 'unmap') {
    return { error: 'Unknown action.' }
  }
  const productId = form.get('productId')?.toString().trim()
  if (!productId) {
    return { error: 'Missing product to remove.' }
  }
  // Unpublish first so a Shopify failure leaves the database mapping in place.
  // The row and its modal then survive revalidation and the merchant can retry.
  try {
    await unpublishMapping(admin, productId)
  } catch (e) {
    console.error('try-on metafield unpublish failed', e)
    return { error: "Try-on couldn't be removed from your storefront. Nothing was changed; try again." }
  }
  const deleteError = await deleteMappingWithRecovery({
    db: prisma,
    admin,
    shop: session.shop,
    productId,
  })
  if (deleteError) return deleteError
  return { unmapped: true }
}

function retryMatches(data, productId, modelAssetId) {
  return Boolean(
    data?.retryable
    && data.productId === productId
    && data.modelAssetId === modelAssetId,
  )
}

// Pure derivation: which page primary action is completable right now. The
// route must never offer a control that leads nowhere -- an Add try-on modal
// with no models to pick from, or a mapping request that will just bounce
// off the plan limit -- so this always resolves to something the merchant
// can actually finish.
export function productPrimaryAction({ assetCount, usage }) {
  if (assetCount === 0) return { kind: 'upload', label: 'Upload model', href: '/app/models' }
  if (usage.atLimit) return { kind: 'upgrade', label: 'Upgrade plan', href: usage.pricingUrl }
  return { kind: 'add', label: 'Add try-on', commandFor: 'add-tryon' }
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

  const liveCount = mappings.filter((mapping) => mapping.status.id === 'live').length
  const attentionCount = mappings.length - liveCount
  const usageText = usage.unlimited
    ? `${usage.used} product${usage.used === 1 ? '' : 's'} using try-on`
    : `${usage.used} of ${usage.limit} products using try-on`
  const primaryAction = productPrimaryAction({ assetCount: assets.length, usage })

  return (
    <s-page heading="Products">
      {primaryAction.kind === 'add' ? (
        <s-button slot="primary-action" commandFor={primaryAction.commandFor} command="--show">
          {primaryAction.label}
        </s-button>
      ) : primaryAction.kind === 'upgrade' ? (
        // The admin pricing page is never embeddable in this app's iframe --
        // TopLevelAdminAction breaks out reliably (window.open, not a
        // Polaris href/target App Bridge can intercept).
        <TopLevelAdminAction
          slot="primary-action"
          href={primaryAction.href}
          accessibilityLabel={primaryAction.label}
        >
          {primaryAction.label}
        </TopLevelAdminAction>
      ) : (
        // 'upload': in-app navigation to another route, not a Shopify admin
        // destination -- stays a plain in-app link.
        <s-button
          slot="primary-action"
          href={primaryAction.href}
          accessibilityLabel={primaryAction.label}
        >
          {primaryAction.label}
        </s-button>
      )}

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
              <TopLevelAdminAction href={usage.pricingUrl} accessibilityLabel="Upgrade plan" variant="tertiary">
                Upgrade
              </TopLevelAdminAction>
            )}
          </s-stack>
        </s-box>
      </s-section>

      {/* Unmounted (not just hidden) with zero models: there is nothing for
          ModelPicker to offer, and no page-level control opens this modal in
          that state -- see productPrimaryAction's 'upload' branch. */}
      {assets.length > 0 && (
        <s-modal id="add-tryon" heading="Add try-on to a product">
          <s-stack direction="block" gap="base">
            {usage.atLimit && (
              <s-banner tone="warning">
                {/* Prose + block action, not an inline link: TopLevelAdminAction
                    renders an <s-button>, which is inline-block, not inline --
                    embedding it mid-sentence (the previous "...plan.
                    <button>Upgrade</button> to add more." shape) orphans the
                    trailing text onto its own line and fragments the sentence
                    at narrow widths (Global Constraint: usable at 320px). */}
                <s-paragraph>
                  You&apos;re using all {usage.limit} products on your plan. Upgrade to add more.
                </s-paragraph>
                {usage.pricingUrl && (
                  <TopLevelAdminAction href={usage.pricingUrl} accessibilityLabel="Upgrade plan" variant="tertiary">
                    Upgrade
                  </TopLevelAdminAction>
                )}
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
      )}

      {assets.length === 0 ? (
        // True empty state: no models exist yet, so there is nothing to map
        // a product to. Distinct from the "models exist, nothing mapped"
        // case below -- conflating the two would send merchants into the
        // Add try-on modal before it has anything to offer. Owned here, not
        // by ProductIndex, which only renders once there's a collection to
        // filter/sort/paginate.
        <s-section heading="Products with try-on">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Upload a model to get started</s-text>
            <s-paragraph color="subdued">
              You need at least one 3D model before you can add try-on to a product.
            </s-paragraph>
            <s-button href="/app/models">Upload model</s-button>
          </s-stack>
        </s-section>
      ) : mappings.length === 0 ? (
        // Models exist, but none are mapped to a product yet. This used to
        // carry copy left over from before Task 3 split the true zero-model
        // empty state out above ("Upload a model on the Models page, then
        // pick the product it belongs to") -- correct instructions for a
        // merchant with NO models, but this branch only renders once at
        // least one model exists, so the actual blocker for someone reading
        // this is that they haven't used Add try-on yet, not that they need
        // to visit /app/models. Point at the real next step, and mirror the
        // sibling zero-model state's in-body action instead of relying
        // solely on the page-header primary action.
        //
        // The in-body Add try-on trigger is gated on primaryAction.kind ===
        // 'add', the same completable-action check productPrimaryAction
        // itself enforces for the header. Within this branch assets.length >
        // 0 is already guaranteed (the assets.length === 0 arm above already
        // claimed that case), so 'kind' here can only be 'add' or 'upgrade'
        // -- never 'upload'. At the plan limit, mappingSubmitDisabled's Add
        // try-on path has no `currentModelAssetId` to fall back on and so
        // resolves to `atLimit` unconditionally (app.products.jsx:207-219):
        // the modal's submit button would stay disabled no matter what the
        // merchant picked. Offering the trigger anyway would reopen exactly
        // the dead end Task 3 existed to close -- productPrimaryAction's own
        // doc comment above names this as "a mapping request that will just
        // bounce off the plan limit". So this state gets the same upgrade
        // messaging as the page-level usage box and the modal's own atLimit
        // banner instead of an action the merchant cannot complete.
        <s-section heading="Products with try-on">
          <s-stack direction="block" gap="base">
            <s-text type="strong">Add try-on to your first product</s-text>
            {primaryAction.kind === 'add' ? (
              <>
                <s-paragraph>
                  Use <s-text type="strong">Add try-on</s-text> above to connect your first product to a model.
                </s-paragraph>
                <s-button commandFor="add-tryon" command="--show">Add try-on</s-button>
              </>
            ) : (
              <>
                <s-paragraph>
                  You&apos;re using all {usage.limit} products on your plan. Upgrade to add your first product.
                </s-paragraph>
                {usage.pricingUrl && (
                  <TopLevelAdminAction href={usage.pricingUrl} accessibilityLabel="Upgrade plan" variant="tertiary">
                    Upgrade
                  </TopLevelAdminAction>
                )}
              </>
            )}
          </s-stack>
        </s-section>
      ) : (
        <ProductIndex
          mappings={mappings}
          themeUrl={themeUrl}
          onChangeModel={(mappingId) => dispatchChangeModal({ type: 'open', mappingId })}
          onRemove={(mappingId) => dispatchRemoveModal({ type: 'open', mappingId })}
        />
      )}
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
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}

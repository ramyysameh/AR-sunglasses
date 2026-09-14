import { useEffect, useState } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import QRCode from 'qrcode'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { listMappings, mapProductToModel } from '../models.server'
import { publishMapping, publishMappings, unpublishMapping } from '../tryonMetafield.server'
import { getActivePlanName, planLimit } from '../billing.server'
import { planUsage } from '../planUsage.server'
import ModelPicker from '../components/ModelPicker'
import PreviewPanel from '../components/PreviewPanel'
import { fetchProductsByIds } from '../products.server'
import { productStatus } from '../tryonStatus.server'
import { themeEditorUrl, previewUrl } from '../adminLinks.server'
import StatusBadge from '../components/StatusBadge'

// eslint-disable-next-line no-undef
const ENGINE_URL = process.env.TRYON_ENGINE_URL
  // eslint-disable-next-line no-undef
  || `${process.env.SHOPIFY_APP_URL || ''}/tryon/index.html`

export const loader = async ({ request }) => {
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
      engineUrl: ENGINE_URL,
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
        const url = previewUrl({ engineUrl: ENGINE_URL, shop: session.shop, productId: m.productId })
        return {
          ...m,
          product: products.get(m.productId) ?? null,
          status: productStatus(m),
          previewUrl: url,
          // Generated here, not in the browser: a client-side QR library would
          // need a CDN script and the admin iframe's CSP is not ours to widen.
          qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }),
        }
      }),
    ),
    assets,
    usage: planUsage({ planName: activePlan, used: mappings.length, shop: session.shop }),
    themeUrl,
    engineUrl: ENGINE_URL,
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
    await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    // The mapping is committed; now project it onto the storefront. The block
    // renders only where this metafield exists, so a failure here means a
    // mapping visible in the admin but not on the product page.
    try {
      await publishMapping(admin, productId)
    } catch (e) {
      console.error('try-on metafield publish failed', e)
      return { error: "Added, but try-on couldn't be turned on for your storefront. Try again." }
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
  await prisma.productMapping.deleteMany({ where: { shop: session.shop, productId } })
  // A metafield left behind keeps the block on the page, where it now opens to
  // a 404 from /api/tryon-config -- worse than either end state.
  try {
    await unpublishMapping(admin, productId)
  } catch (e) {
    console.error('try-on metafield unpublish failed', e)
    return { error: "Try-on removed, but it may still show on your storefront. Try again." }
  }
  return { unmapped: true }
}

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

export default function Products() {
  const { mappings, assets, usage, themeUrl } = useLoaderData()
  const unmapFetcher = useFetcher()
  const shopify = useAppBridge()

  const mapFetcher = useFetcher()
  const [picked, setPicked] = useState(null)
  const [modelAssetId, setModelAssetId] = useState('')
  const mapError = mapFetcher.data?.error

  useEffect(() => {
    if (mapFetcher.data?.mapped) {
      shopify.toast.show('Try-on added')
      setPicked(null)
      setModelAssetId('')
      document.getElementById('add-tryon')?.hide()
    }
  }, [mapFetcher.data, shopify])

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({ type: 'product', action: 'select' })
    if (selection && selection[0]) {
      const p = selection[0]
      setPicked({ id: p.id, title: p.title, imageUrl: p.images?.[0]?.originalSrc ?? null })
    }
  }

  const submitMapping = () => {
    if (!picked?.id || !modelAssetId) return
    mapFetcher.submit({ intent: 'map', productId: picked.id, modelAssetId }, { method: 'POST' })
  }

  useEffect(() => {
    if (unmapFetcher.data?.unmapped) shopify.toast.show('Try-on removed')
    if (unmapFetcher.data?.error) shopify.toast.show(unmapFetcher.data.error, { isError: true })
  }, [unmapFetcher.data, shopify])

  const remove = (productId) => unmapFetcher.submit({ intent: 'unmap', productId }, { method: 'POST' })

  return (
    <s-page heading="Products">
      <s-button slot="primary-action" commandFor="add-tryon" command="show" disabled={usage.atLimit}>
        Add try-on
      </s-button>

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
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={submitMapping}
          {...(mapFetcher.state !== 'idle' ? { loading: true } : {})}
        >
          Add try-on
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
                      <StatusBadge status={m.status} />
                      {m.status.id === 'not_on_theme' && (
                        <a href={themeUrl} target="_top" rel="noreferrer">Add to theme</a>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500">
                      <s-button variant="tertiary" commandFor={`preview-${m.id}`} command="show">
                        Preview
                      </s-button>
                      <s-button variant="tertiary" tone="critical" icon="delete" onClick={() => remove(m.productId)}>
                        Remove
                      </s-button>
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
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}

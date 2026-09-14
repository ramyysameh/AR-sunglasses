import { useEffect } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { listMappings } from '../models.server'
import { publishMappings, unpublishMapping } from '../tryonMetafield.server'
import { getActivePlanName } from '../billing.server'
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
    return { mappings: [], themeUrl, engineUrl: ENGINE_URL }
  }
  const mappings = await listMappings(prisma, session.shop)
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
    mappings: mappings.map((m) => ({
      ...m,
      product: products.get(m.productId) ?? null,
      status: productStatus(m),
    })),
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
  if (form.get('intent') !== 'unmap') {
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
  const { mappings, themeUrl, engineUrl } = useLoaderData()
  const unmapFetcher = useFetcher()
  const shopify = useAppBridge()

  useEffect(() => {
    if (unmapFetcher.data?.unmapped) shopify.toast.show('Try-on removed')
    if (unmapFetcher.data?.error) shopify.toast.show(unmapFetcher.data.error, { isError: true })
  }, [unmapFetcher.data, shopify])

  const remove = (productId) => unmapFetcher.submit({ intent: 'unmap', productId }, { method: 'POST' })

  return (
    <s-page heading="Products">
      <s-button slot="primary-action" href="/app/models">Add try-on</s-button>

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
                      <s-button
                        variant="tertiary"
                        href={previewUrl({ engineUrl, shop: m.shop, productId: m.productId })}
                        target="_blank"
                      >
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
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}

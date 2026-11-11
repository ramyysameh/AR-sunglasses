/* eslint-disable react/prop-types -- loader-shaped data, same as the other workspace panels */
import { useAppBridge } from '@shopify/app-bridge-react'
import { useEffect, useRef } from 'react'
import { useFetcher } from 'react-router'

/** "12 of 300 photo try-ons used in the last 24 hours" */
export function usageLine({ usedToday, dailyLimit }) {
  return `${usedToday} of ${dailyLimit} photo try-ons used in the last 24 hours`
}

/** "On for 17 of 18 products" */
export function coverageLine({ onCount, products, hasMore }) {
  const total = `${products.length}${hasMore ? '+' : ''}`
  return `On for ${onCount} of ${total} ${products.length === 1 ? 'product' : 'products'}`
}

function ProductThumb({ product }) {
  if (product.imageUrl) {
    return <s-thumbnail src={product.imageUrl} alt={product.imageAlt || product.title} size="small"></s-thumbnail>
  }
  return <div className="workspace-product-placeholder" role="img" aria-label={`No image available for ${product.title}`}></div>
}

/**
 * One product's switch. Its own fetcher, so several rows can be changed in a
 * row without one request cancelling another. Buttons rather than a toggle:
 * React 18 drops change events on Polaris s-* inputs (onClick is safe).
 */
function ProductRow({ product }) {
  const fetcher = useFetcher()
  const shopify = useAppBridge()
  const sentRef = useRef(null)
  const pending = fetcher.state !== 'idle'
  // Show the requested state while saving, so the row doesn't flicker back.
  const on = pending && fetcher.formData ? fetcher.formData.get('on') === 'true' : product.on
  const error = fetcher.data?.photoTryon?.productId === product.id ? fetcher.data.photoTryon.error : null

  useEffect(() => {
    const result = fetcher.data?.photoTryon
    if (!result || sentRef.current === fetcher.data || result.productId !== product.id) return
    sentRef.current = fetcher.data
    if (result.error) return
    shopify.toast.show(result.on ? `Photo try-on on for ${product.title}` : `Photo try-on off for ${product.title}`)
  }, [fetcher.data, product.id, product.title, shopify])

  const toggle = () => {
    fetcher.submit(
      { intent: 'photo-tryon', productId: product.id, on: String(!on) },
      { method: 'post' },
    )
  }

  return (
    <s-table-row>
      <s-table-cell>
        <s-stack className="workspace-product-cell" direction="inline" gap="small-500" alignItems="center">
          <ProductThumb product={product} />
          <s-text type="strong">{product.title}</s-text>
        </s-stack>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={on ? 'success' : 'neutral'}>{on ? 'On' : 'Off'}</s-badge>
        {error && <s-text tone="critical"> {error}</s-text>}
      </s-table-cell>
      <s-table-cell>
        <s-button
          variant={on ? 'secondary' : 'primary'}
          disabled={pending}
          {...(pending ? { loading: true } : {})}
          accessibilityLabel={`${on ? 'Turn off' : 'Turn on'} photo try-on for ${product.title}`}
          onClick={toggle}
        >
          {on ? 'Turn off' : 'Turn on'}
        </s-button>
      </s-table-cell>
    </s-table-row>
  )
}

/**
 * Workspace card for photo try-on: what it is, today's usage, and the
 * per-product on/off switches. Rendered only for shops that have the feature.
 */
export default function PhotoTryonCard({ panel }) {
  if (!panel) return null
  return (
    <s-section heading="Photo try-on" padding="none">
      <s-box padding="base">
        <s-stack direction="block" gap="small-200">
          <s-paragraph>
            A &quot;Try on with a photo&quot; button under Try on. Shoppers upload a selfie and get it back
            wearing the product, made with AI from the product&apos;s first photo. It doesn&apos;t need a 3D model.
            Shoppers&apos; photos are never saved.
          </s-paragraph>
          <s-paragraph>
            <s-text type="strong">{usageLine(panel)}</s-text>
            {` · ${coverageLine(panel)} · up to ${panel.perShopper} per shopper a day`}
          </s-paragraph>
          {panel.hasMore && (
            <s-paragraph color="subdued">
              Showing your first {panel.products.length} products. Products not listed here have photo try-on on.
            </s-paragraph>
          )}
        </s-stack>
      </s-box>
      {panel.products.length === 0 ? (
        <s-box padding="base"><s-paragraph>Add products to your store to use photo try-on.</s-paragraph></s-box>
      ) : (
        <s-table variant="auto">
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header>Photo try-on</s-table-header>
            <s-table-header>Action</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {panel.products.map((product) => <ProductRow key={product.id} product={product} />)}
          </s-table-body>
        </s-table>
      )}
    </s-section>
  )
}

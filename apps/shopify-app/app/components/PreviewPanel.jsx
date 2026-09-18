/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelFitReview from './ModelFitReview'

// Try-on is a phone experience and the merchant is at a desktop, so the QR is
// the primary affordance. Camera cannot work inside the admin iframe -- Shopify
// does not delegate the permission -- so both routes here leave the iframe.
//
// The loader treats QR/URL generation as best-effort (same posture as its
// metafield sync and product enrichment), so mapping.qr and mapping.previewUrl
// can be null here -- render the explanation without them rather than break.
//
// The fit-review section below is the shared ModelFitReview component, not
// a second copy of it -- see app/routes/app.models.jsx's review modal for
// the other caller. mapping.themeUrl is stamped onto every mapping by
// app.products.jsx's loader (alongside the route-level themeUrl it already
// returns for ProductIndex.jsx) specifically so this component can stay a
// single-prop `{ mapping }` component instead of needing its own themeUrl
// threaded in from callers.
export default function PreviewPanel({ mapping }) {
  return (
    <s-stack direction="block" gap="large-100">
      <s-stack direction="block" gap="base" alignItems="center">
        <s-heading>Try it on your phone</s-heading>
        <s-paragraph>Scan this code to open the camera try-on.</s-paragraph>
        {mapping.qr ? (
          <img src={mapping.qr} alt="QR code linking to the try-on preview" width="220" height="220" />
        ) : (
          <s-banner heading="Phone preview unavailable" tone="warning">
            Refresh the page and try again.
          </s-banner>
        )}
        {mapping.previewUrl && (
          <s-button href={mapping.previewUrl} target="_blank" icon="external">
            Open on this computer
          </s-button>
        )}
      </s-stack>

      <ModelFitReview modelAssetId={mapping.modelAssetId} themeUrl={mapping.themeUrl ?? null} />
    </s-stack>
  )
}

/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelViewer from './ModelViewer'

// Try-on is a phone experience and the merchant is at a desktop, so the QR is
// the primary affordance. Camera cannot work inside the admin iframe -- Shopify
// does not delegate the permission -- so both routes here leave the iframe.
//
// The loader treats QR/URL generation as best-effort (same posture as its
// metafield sync and product enrichment), so mapping.qr and mapping.previewUrl
// can be null here -- render the explanation without them rather than break.
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

      <s-stack direction="block" gap="base">
        <s-heading>Check the fit</s-heading>
        <ModelViewer
          src={`/models/${mapping.modelAssetId}.glb`}
          alt="Your glasses model"
        />
        <s-paragraph color="subdued">
          If the frames look too small or too large here, adjust Glasses size in the
          block settings in your theme editor.
        </s-paragraph>
      </s-stack>
    </s-stack>
  )
}

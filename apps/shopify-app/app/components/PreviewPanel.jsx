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
    <s-stack direction="block" gap="base" alignItems="center">
      <ModelViewer
        src={`/models/${mapping.modelAssetId}/fit-preview.glb`}
        alt="Your frames on a reference head"
      />
      <s-paragraph tone="subdued">
        If the frames look too small or too large here, adjust Glasses size in the
        block settings in your theme editor.
      </s-paragraph>
      <s-paragraph>Scan to try it on your phone.</s-paragraph>
      {mapping.qr ? (
        <img src={mapping.qr} alt="QR code linking to the try-on preview" width="220" height="220" />
      ) : (
        <s-paragraph tone="subdued">Preview link unavailable right now. Try again shortly.</s-paragraph>
      )}
      {mapping.previewUrl && (
        <s-paragraph>
          <a href={mapping.previewUrl} target="_blank" rel="noreferrer">Open on this computer</a>
        </s-paragraph>
      )}
    </s-stack>
  )
}

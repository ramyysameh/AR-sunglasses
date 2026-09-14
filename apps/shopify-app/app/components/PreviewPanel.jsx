/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */

// Try-on is a phone experience and the merchant is at a desktop, so the QR is
// the primary affordance. Camera cannot work inside the admin iframe -- Shopify
// does not delegate the permission -- so both routes here leave the iframe.
export default function PreviewPanel({ mapping }) {
  return (
    <s-stack direction="block" gap="base" alignItems="center">
      <s-paragraph>Scan to try it on your phone.</s-paragraph>
      <img src={mapping.qr} alt="QR code linking to the try-on preview" width="220" height="220" />
      <s-paragraph>
        <a href={mapping.previewUrl} target="_blank" rel="noreferrer">Open on this computer</a>
      </s-paragraph>
    </s-stack>
  )
}

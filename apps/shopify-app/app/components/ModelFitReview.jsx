/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelViewer from './ModelViewer'
import TopLevelAdminAction from './TopLevelAdminAction'

// Shared "what the merchant is reviewing, and what to do about it" surface
// for a single model's on-face fit: the reference-head preview plus sizing
// guidance and (when a theme URL is available) a direct way into the block
// settings that control it. Used from both the product preview panel
// (PreviewPanel, one mapping at a time) and the Models review modal (one
// selected asset at a time) -- never render more than one of these per page,
// the same "exactly one ModelViewer" rule ModelPicker.jsx already follows.
export default function ModelFitReview({ modelAssetId, themeUrl = null }) {
  return (
    <s-stack direction="block" gap="base">
      <s-heading>Check the fit</s-heading>
      <s-paragraph color="subdued">
        This shows your frames on a reference head so you can judge scale before a
        shopper sees them.
      </s-paragraph>
      <ModelViewer
        // The GLB response is immutable, so bump this version whenever the
        // composition changes to bypass existing browser and edge caches.
        src={`/models/${modelAssetId}/fit-preview.glb?v=2`}
        alt="Your frames on a reference head"
      />
      <s-paragraph color="subdued">
        If the frames look too small or too large here, adjust Glasses size in the
        block settings in your theme editor.
      </s-paragraph>
      {themeUrl && (
        <TopLevelAdminAction
          href={themeUrl}
          accessibilityLabel="Open the theme editor to adjust glasses size"
        >
          Open theme editor
        </TopLevelAdminAction>
      )}
    </s-stack>
  )
}

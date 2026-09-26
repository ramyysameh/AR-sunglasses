/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelViewer from './ModelViewer'
import TopLevelAdminAction from './TopLevelAdminAction'

// Shared "what the merchant is reviewing, and what to do about it" surface
// for a single model's fit: the model preview plus sizing guidance and (when
// a theme URL is available) a direct way into the block settings that control
// it. Mounted from the Models review modal (one selected asset at a time).
//
// The preview is the model's own GLB, NOT the reference-head composition at
// /models/{id}/fit-preview.glb. That is a deliberate product decision made
// upstream in 9d93e54, which moved PreviewPanel off the composed preview and
// added a test ("previews the glasses model without composing it onto a mock
// head") asserting the reference head stays absent. This component renders the
// same kind of surface, so it follows the same decision -- otherwise the admin
// would show frames on a mock head in one place and bare in another. The
// fit-preview server route still exists but is no longer rendered by any UI.
//
// "One at a time" means one per open modal, not one in the whole DOM tree:
// a list surface may mount one preview <s-modal> (and so one ModelFitReview,
// each with its own lazy ModelViewer) per visible row -- that per-row modal
// cost is the list's concern, not a violation of this one. The invariant this
// component actually guards is ModelPicker.jsx's: never more than one
// ModelViewer rendered for the SAME selection/target at once (e.g. never one
// per choice in a list).
export default function ModelFitReview({ modelAssetId, themeUrl = null }) {
  return (
    <s-stack direction="block" gap="base">
      <s-heading>Review the fit</s-heading>
      <s-paragraph color="subdued">
        Check the scale of your frames before a shopper sees them.
      </s-paragraph>
      <ModelViewer
        src={`/models/${modelAssetId}.glb`}
        alt="Your glasses model"
      />
      <s-paragraph color="subdued">
        If the frames look too small or too large here, adjust Glasses size in the
        block settings in your theme editor. If the fit looks right, mark it as
        reviewed.
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

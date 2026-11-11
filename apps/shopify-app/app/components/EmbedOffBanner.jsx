/* eslint-disable react/prop-types -- plain JSX component, no PropTypes library in use */
import TopLevelAdminAction from './TopLevelAdminAction'

/**
 * Shown when setup is finished but App Bridge reports the try-on embed is off
 * in the published theme (a merchant switched it off, or changed themes).
 * Setup and row statuses stay "Live" from past storefront views, so without
 * this the Workspace offered no way back.
 */
export default function EmbedOffBanner({ embedUrl, onCheckAgain }) {
  return (
    <s-banner heading="Try-on is switched off in your theme" tone="warning">
      <s-stack direction="block" gap="small-200">
        <s-paragraph>
          Shoppers can&apos;t see the Try-on button right now. Turn it back on: your theme editor opens in a new tab
          with try-on already switched on. Click Save there, then come back to this tab.
        </s-paragraph>
        <s-stack direction="inline" gap="small-200">
          <TopLevelAdminAction
            href={embedUrl}
            variant="primary"
            newTab
            accessibilityLabel="Turn on try-on (opens your theme editor in a new tab)"
          >
            Turn on try-on
          </TopLevelAdminAction>
          <s-button variant="tertiary" onClick={onCheckAgain}>Check again</s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  )
}

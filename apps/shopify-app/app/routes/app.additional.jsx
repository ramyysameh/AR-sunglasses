import { useLoaderData } from 'react-router'
import { themeEditorUrl } from '../adminLinks.server.js'
import { authenticate } from '../shopify.server.js'
import TopLevelAdminAction from '../components/TopLevelAdminAction.jsx'

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request)
  return { themeEditorUrl: themeEditorUrl(session.shop) }
}

export default function HelpPage() {
  const { themeEditorUrl } = useLoaderData()

  return (
    <s-page heading="Help">
      <s-section heading="Fit is too small or too large">
        <s-paragraph>
          Open the theme editor, select the AR Try-On block on the product page,
          and adjust Glasses size. Start at 1, then preview the product.
        </s-paragraph>
        <TopLevelAdminAction
          href={themeEditorUrl}
          accessibilityLabel="Open theme editor to adjust glasses size"
        >
          Open theme editor
        </TopLevelAdminAction>
      </s-section>

      <s-section heading="Try on button is missing">
        <s-paragraph>
          {/* Upstream's workspace redesign removed the standalone Products
              page (app.products.jsx now redirects to /app), so this points at
              the Workspace. The theme editor stays plain prose rather than
              upstream's inline <a target="_top">: the section already ends in
              a TopLevelAdminAction "Open theme editor" button, which is the
              reliable break-out for a Shopify admin destination (a raw
              target="_top" anchor mid-sentence duplicates that action and
              fragments the sentence at narrow widths). */}
          Assign a model to the product in <s-link href="/app">Workspace</s-link>,
          then add the AR Try-On block to the product template in the theme editor.
          The button stays hidden until both are ready.
        </s-paragraph>
        <TopLevelAdminAction
          href={themeEditorUrl}
          accessibilityLabel="Open theme editor to add the AR Try-On block"
          variant="tertiary"
        >
          Open theme editor
        </TopLevelAdminAction>
      </s-section>

      <s-section heading="Camera is blocked">
        <s-paragraph>
          Ask the shopper to allow camera access for your store in their browser
          settings, then reload the product page.
        </s-paragraph>
        <s-paragraph>
          Face tracking runs in the shopper&apos;s browser. No photo or video is
          uploaded or stored. Read the <s-link href="/privacy" target="_blank">privacy policy</s-link>.
        </s-paragraph>
      </s-section>

      <s-section heading="Model won't upload">
        <s-paragraph>
          Use a .glb file no larger than 25 MB. If the upload finishes with a
          Review fit status instead of Ready, open it on the Models page and use
          Review fit to check its scale before assigning it to products.
        </s-paragraph>
        <s-paragraph>
          <s-link href="/app/models">Open Models</s-link>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Still need help?">
        <s-paragraph>
          <s-link href="mailto:ramy.sameh2@gmail.com">Contact support</s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  )
}

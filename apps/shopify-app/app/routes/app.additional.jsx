import { useLoaderData } from 'react-router'
import { embedActivationUrl, themeEditorUrl } from '../adminLinks.server.js'
import { authenticate } from '../shopify.server.js'
import TopLevelAdminAction from '../components/TopLevelAdminAction.jsx'

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request)
  return { themeEditorUrl: themeEditorUrl(session.shop), embedUrl: embedActivationUrl(session.shop) }
}

export default function HelpPage() {
  const { themeEditorUrl, embedUrl } = useLoaderData()

  return (
    <s-page heading="Help">
      <s-section heading="New here?">
        <s-paragraph><s-link href="/app/tutorial">Follow the tutorial</s-link></s-paragraph>
      </s-section>

      <s-section heading="Fit is too small or too large">
        <s-paragraph>
          Open the theme editor, open App embeds, select AR Try-on (or the AR
          Try-On block if you placed it), and adjust Glasses size. Start at 1,
          then preview the product.
        </s-paragraph>
        <TopLevelAdminAction
          href={embedUrl}
          accessibilityLabel="Open theme editor to adjust glasses size"
        >
          Open theme editor
        </TopLevelAdminAction>
      </s-section>

      <s-section heading="Try on button is missing">
        <s-paragraph>
          Save a model for the product (or add try-on to it in <s-link href="/app">Workspace</s-link>),
          then turn on try-on in your store: it adds the button to every product with a model.
          In the theme editor, click Save.
        </s-paragraph>
        <TopLevelAdminAction
          href={embedUrl}
          accessibilityLabel="Turn on try-on in the theme editor"
        >
          Turn on try-on
        </TopLevelAdminAction>
        <s-paragraph>
          Want the button somewhere specific? Place the AR Try-On block on your product template instead.
        </s-paragraph>
        <TopLevelAdminAction
          href={themeEditorUrl}
          accessibilityLabel="Place the button yourself in the theme editor"
          variant="tertiary"
        >
          Place the button yourself
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
          Needs fit review status instead of Ready, open it on the Models page and
          use Review fit to check its scale. Once it looks right, choose Mark as
          reviewed.
        </s-paragraph>
        <s-paragraph>
          <s-link href="/app/models">Open Models</s-link>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Still need help?">
        <s-paragraph>
          <s-link href="mailto:zendolabs@gmail.com">Contact support</s-link>
        </s-paragraph>
      </s-section>
    </s-page>
  )
}

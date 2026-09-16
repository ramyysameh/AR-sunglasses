import { useLoaderData } from 'react-router'
import { themeEditorUrl } from '../adminLinks.server.js'
import { authenticate } from '../shopify.server.js'

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
        <s-paragraph>
          <a href={themeEditorUrl} target="_top" rel="noreferrer">
            Open theme editor
          </a>
        </s-paragraph>
      </s-section>

      <s-section heading="Try on button is missing">
        <s-paragraph>
          Assign a model to the product in <s-link href="/app">Workspace</s-link>,
          then add the AR Try-On block to the product template in the{' '}
          <a href={themeEditorUrl} target="_top" rel="noreferrer">
            theme editor
          </a>. The button stays hidden until both are ready.
        </s-paragraph>
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
          Use a .glb file no larger than 25 MB. If the upload finishes with Check
          fit, preview it before assigning it to products.
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

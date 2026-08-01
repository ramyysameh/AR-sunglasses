import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { requireActivePlanForLoader } from "../billing.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  await requireActivePlanForLoader(admin);

  return null;
};

export default function Index() {
  return (
    <s-page heading="AR Try-on">
      <s-button slot="primary-action" href="/app/models">
        Go to Models
      </s-button>

      <s-section heading="Let shoppers try on your glasses">
        <s-paragraph>
          AR Try-on lets shoppers see how sunglasses look on their own face
          before they buy, using their device camera in real time, directly on
          the product page. Face tracking runs entirely in the shopper&apos;s
          browser -- no photo or video is ever uploaded or stored.
        </s-paragraph>
      </s-section>

      <s-section heading="Get started">
        <s-ordered-list>
          <s-list-item>
            On the <s-link href="/app/models">Models</s-link> page, upload a
            calibrated 3D model (GLB) of a frame. It&apos;s validated and
            calibrated automatically.
          </s-list-item>
          <s-list-item>
            Map that model to the matching product using its product ID.
          </s-list-item>
          <s-list-item>
            In the theme editor, add the &quot;AR Try-On&quot; block to that
            product&apos;s page. The try-on engine URL is pre-filled -- you
            only need to save.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Support">
        <s-paragraph>
          <s-link href="/privacy" target="_blank">
            Privacy policy
          </s-link>
        </s-paragraph>
        <s-paragraph>
          Questions or issues? Reach out at{" "}
          <s-link href="mailto:ramy.sameh2@gmail.com">
            ramy.sameh2@gmail.com
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

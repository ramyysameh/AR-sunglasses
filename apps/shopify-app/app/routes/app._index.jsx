import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getActivePlanName } from "../billing.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  // The app.jsx layout owns the no-subscription screen and hides this route's
  // content, so this loader must NOT throw its own redirect: a /app -> /app
  // redirect loops forever and renders a dead, control-less page (App Store
  // rejection Ref 127328). On no plan, do no gated DB work and return zeros;
  // the checklist just shows "To do".
  const activePlan = await getActivePlanName(admin, session.shop);
  if (!activePlan) {
    return { modelCount: 0, mappingCount: 0 };
  }
  const [modelCount, mappingCount] = await Promise.all([
    prisma.modelAsset.count({ where: { shop: session.shop } }),
    prisma.productMapping.count({ where: { shop: session.shop } }),
  ]);
  return { modelCount, mappingCount };
};

export default function Index() {
  const { modelCount, mappingCount } = useLoaderData();
  const hasModels = modelCount > 0;
  const hasMappings = mappingCount > 0;

  return (
    <s-page heading="AR Try-on">
      <s-button slot="primary-action" href="/app/models">Go to Models</s-button>

      <s-section heading="Let shoppers try on your glasses">
        <s-paragraph>
          AR Try-on lets shoppers see how sunglasses look on their own face before they
          buy, using their device camera in real time, directly on the product page. Face
          tracking runs entirely in the shopper&apos;s browser -- no photo or video is ever
          uploaded or stored.
        </s-paragraph>
      </s-section>

      <s-section heading="Setup">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={hasModels ? "success" : "neutral"} icon={hasModels ? "check-circle" : "circle"}>
              {hasModels ? `${modelCount} uploaded` : "To do"}
            </s-badge>
            <s-text>Upload a calibrated 3D model on the <s-link href="/app/models">Models</s-link> page.</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone={hasMappings ? "success" : "neutral"} icon={hasMappings ? "check-circle" : "circle"}>
              {hasMappings ? `${mappingCount} mapped` : "To do"}
            </s-badge>
            <s-text>Map each model to its product.</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-badge tone="neutral" icon="circle">Last step</s-badge>
            <s-text>Add the &quot;AR Try-On&quot; block to the product page in the theme editor.</s-text>
          </s-stack>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Support">
        <s-paragraph><s-link href="/privacy" target="_blank">Privacy policy</s-link></s-paragraph>
        <s-paragraph>
          Questions or issues? Reach out at{" "}
          <s-link href="mailto:ramy.sameh2@gmail.com">ramy.sameh2@gmail.com</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

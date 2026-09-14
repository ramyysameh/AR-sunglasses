import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getActivePlanName } from "../billing.server";
import { planUsage } from "../planUsage.server";
import { themeEditorUrl } from "../adminLinks.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  // The app.jsx layout owns the no-subscription screen and hides this route's
  // content, so this loader must NOT throw its own redirect: a /app -> /app
  // redirect loops forever and renders a dead, control-less page (App Store
  // rejection Ref 127328). On no plan, do no gated DB work and return zeros.
  const activePlan = await getActivePlanName(admin, session.shop);
  const themeUrl = themeEditorUrl(session.shop);
  if (!activePlan) {
    return {
      modelCount: 0,
      mappingCount: 0,
      liveCount: 0,
      usage: planUsage({ planName: null, used: 0, shop: session.shop }),
      themeUrl,
    };
  }
  const [modelCount, mappingCount, liveCount] = await Promise.all([
    prisma.modelAsset.count({ where: { shop: session.shop } }),
    prisma.productMapping.count({ where: { shop: session.shop } }),
    prisma.productMapping.count({ where: { shop: session.shop, lastSeenLiveAt: { not: null } } }),
  ]);
  return {
    modelCount,
    mappingCount,
    liveCount,
    usage: planUsage({ planName: activePlan, used: mappingCount, shop: session.shop }),
    themeUrl,
  };
};

export default function Index() {
  const { modelCount, mappingCount, liveCount, usage, themeUrl } = useLoaderData();
  const steps = [
    { done: modelCount > 0, text: "Upload a model", note: modelCount > 0 ? `${modelCount} uploaded` : null },
    { done: mappingCount > 0, text: "Add try-on to a product", note: mappingCount > 0 ? `${mappingCount} products` : null },
    { done: liveCount > 0, text: "Add the button to your theme", note: null },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <s-page heading="AR Try-on">
      <s-button slot="primary-action" href="/app/products">Go to products</s-button>

      <s-section heading="Set up try-on">
        <s-paragraph>{doneCount} of 3 done</s-paragraph>
        <s-stack direction="block" gap="base">
          {steps.map((step) => (
            <s-stack key={step.text} direction="inline" gap="base" alignItems="center">
              <s-badge tone={step.done ? "success" : "neutral"} icon={step.done ? "check-circle" : "circle"}>
                {step.done ? "Done" : "To do"}
              </s-badge>
              <s-text>{step.text}</s-text>
              {step.note && <s-text tone="subdued">{step.note}</s-text>}
            </s-stack>
          ))}
        </s-stack>
        {liveCount === 0 && (
          // Top-level: the theme editor is an admin URL and cannot be embedded
          // in this app's iframe, the same reason app.jsx breaks out for pricing.
          <s-paragraph>
            <a href={themeUrl} target="_top" rel="noreferrer">Add to theme</a>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Your plan">
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{usage.planName ?? "No plan"}</s-text>
          {usage.unlimited ? (
            <s-text tone="subdued">{usage.used} products using try-on</s-text>
          ) : (
            <>
              <s-text tone="subdued">{usage.used} of {usage.limit} products using try-on</s-text>
              {usage.pricingUrl && (
                <s-paragraph>
                  <a href={usage.pricingUrl} target="_top" rel="noreferrer">
                    {usage.atLimit ? "Upgrade to add more products" : "Change plan"}
                  </a>
                </s-paragraph>
              )}
            </>
          )}
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

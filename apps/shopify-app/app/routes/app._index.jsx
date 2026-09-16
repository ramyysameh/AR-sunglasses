import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { loadWorkspace } from "../workspace.server";

function resolveEngineUrl(request) {
  return (
    // eslint-disable-next-line no-undef
    process.env.TRYON_ENGINE_URL
    // eslint-disable-next-line no-undef
    || (process.env.SHOPIFY_APP_URL && `${process.env.SHOPIFY_APP_URL}/tryon/index.html`)
    || new URL('/tryon/index.html', request.url).toString()
  );
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  // The app.jsx layout owns the no-subscription screen and hides this route's
  // content, so this loader must NOT throw its own redirect: a /app -> /app
  // redirect loops forever and renders a dead, control-less page (App Store
  // rejection Ref 127328). On no plan, do no gated DB work and return zeros.
  return loadWorkspace({ admin, shop: session.shop, engineUrl: resolveEngineUrl(request) });
};

export default function Index() {
  const { assets, counts, usage, themeUrl } = useLoaderData();
  const modelCount = assets.length;
  const mappingCount = counts.all;
  const liveCount = counts.live;
  const usagePercent = usage.unlimited || usage.limit <= 0
    ? 0
    : Math.min(100, Math.round((usage.used / usage.limit) * 100));
  const openPricing = () => {
    if (usage.pricingUrl) window.open(usage.pricingUrl, "_top");
  };
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
        {/* Top-level: the theme editor is an admin URL and cannot be embedded
            in this app's iframe, the same reason app.jsx breaks out for
            pricing. Always rendered: liveCount is a lastSeenLiveAt signal, not
            proof the block is absent, so hiding this on liveCount > 0 would
            strand a low-traffic store whose block is installed but unseen. */}
        <s-paragraph>
          <a href={themeUrl} target="_top" rel="noreferrer">
            {liveCount === 0 ? "Add to theme" : "Manage in theme editor"}
          </a>
        </s-paragraph>
      </s-section>

      <s-section heading="Your plan">
        <s-stack direction="block" gap="base">
          {usage.unlimited ? (
            <>
              <s-text type="strong">{usage.planName ?? "No plan"}</s-text>
              <s-text tone="subdued">{usage.used} products using try-on</s-text>
            </>
          ) : (
            <>
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{usage.planName ?? "No plan"}</s-text>
                  <s-text tone="subdued">{usage.used} / {usage.limit} products</s-text>
                </s-stack>
                {usage.pricingUrl && (
                  <s-button
                    variant="secondary"
                    accessibilityLabel="Upgrade plan"
                    onClick={openPricing}
                  >
                    Upgrade plan
                  </s-button>
                )}
              </s-stack>
              <div
                role="progressbar"
                aria-label={`${usage.used} of ${usage.limit} products used`}
                aria-valuemin="0"
                aria-valuemax={usage.limit}
                aria-valuenow={Math.min(usage.used, usage.limit)}
                style={{
                  width: "100%",
                  height: "8px",
                  overflow: "hidden",
                  borderRadius: "4px",
                  background: "#e3e3e3",
                }}
              >
                <div
                  style={{
                    width: `${usagePercent}%`,
                    height: "100%",
                    borderRadius: "4px",
                    background: "#008060",
                  }}
                />
              </div>
              <s-text tone="subdued">
                {usage.limit - usage.used > 0
                  ? `${usage.limit - usage.used} product${usage.limit - usage.used === 1 ? "" : "s"} remaining`
                  : "Upgrade to add more products"}
              </s-text>
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

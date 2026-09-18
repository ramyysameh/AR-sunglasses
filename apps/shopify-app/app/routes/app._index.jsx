import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getActivePlanName, hasFreeAccess } from "../billing.server";
import { planUsage } from "../planUsage.server";
import { themeEditorUrl } from "../adminLinks.server";
import prisma from "../db.server";
import SetupGuide, { buildSetupSteps, nextSetupAction } from "../components/SetupGuide";
import TopLevelAdminAction from "../components/TopLevelAdminAction";

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
    // Owner-comped stores keep their unlimited backend entitlement, but this
    // card previews the Starter tier so the owner sees the merchant upgrade UI.
    usage: planUsage({
      planName: hasFreeAccess(session.shop) ? "Starter" : activePlan,
      used: mappingCount,
      shop: session.shop,
    }),
    themeUrl,
  };
};

export default function Index() {
  const { modelCount, mappingCount, liveCount, usage, themeUrl } = useLoaderData();
  const usagePercent = usage.unlimited || usage.limit <= 0
    ? 0
    : Math.min(100, Math.round((usage.used / usage.limit) * 100));
  const steps = buildSetupSteps({ modelCount, mappingCount, liveCount, themeUrl });
  const primaryAction = nextSetupAction(steps);

  return (
    <s-page heading="AR Try-on">
      {/* Contextual primary action: always the next useful thing to do. Only
          the theme step's target is "_top" -- an admin URL that cannot be
          embedded in this app's iframe (same reason app.jsx breaks out for
          pricing) -- so that's the only case that needs the top-level
          break-out; every other step is a plain in-app route. */}
      {primaryAction.target === "_top" ? (
        <TopLevelAdminAction
          slot="primary-action"
          href={primaryAction.href}
          accessibilityLabel={primaryAction.actionLabel}
        >
          {primaryAction.actionLabel}
        </TopLevelAdminAction>
      ) : (
        <s-button
          slot="primary-action"
          href={primaryAction.href}
          accessibilityLabel={primaryAction.actionLabel}
        >
          {primaryAction.actionLabel}
        </s-button>
      )}

      <SetupGuide steps={steps} />

      <s-section heading="Your plan">
        <s-stack direction="block" gap="base">
          {usage.unlimited ? (
            <>
              <s-text type="strong">{usage.planName ?? "No plan"}</s-text>
              <s-text color="subdued">{usage.used} products using try-on</s-text>
            </>
          ) : (
            <>
              <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">{usage.planName ?? "No plan"}</s-text>
                  <s-text color="subdued">{usage.used} / {usage.limit} products</s-text>
                </s-stack>
                {usage.pricingUrl && (
                  <TopLevelAdminAction href={usage.pricingUrl} accessibilityLabel="Upgrade plan">
                    Upgrade plan
                  </TopLevelAdminAction>
                )}
              </s-stack>
              <div
                role="progressbar"
                aria-label={`${usage.used} of ${usage.limit} products used`}
                aria-valuemin={0}
                aria-valuemax={usage.limit}
                aria-valuenow={Math.min(usage.used, usage.limit)}
              >
                <s-box background="subdued" borderRadius="base" overflow="hidden" blockSize="8px">
                  <s-box background="strong" blockSize="8px" inlineSize={`${usagePercent}%`}></s-box>
                </s-box>
              </div>
              <s-text color="subdued">
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

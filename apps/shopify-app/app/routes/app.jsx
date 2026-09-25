import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { getActivePlanName, pricingUrlFor } from "../billing.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const activePlan = await getActivePlanName(admin, session.shop);
  // No active subscription (fresh install, or lapsed -- grace covers only the
  // storefront, not the merchant's own admin). Send them to Managed Pricing.
  let pricingUrl = null;
  if (!activePlan) {
    pricingUrl = pricingUrlFor(session.shop);
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", pricingUrl };
};

export default function App() {
  const { apiKey, pricingUrl } = useLoaderData();

  useEffect(() => {
    if (pricingUrl) {
      // Top-level navigation: the pricing page is an admin URL, not embeddable.
      window.open(pricingUrl, "_top");
    }
  }, [pricingUrl]);

  if (pricingUrl) {
    // A plain <a target="_top"> (not an s-link, and deliberately not
    // TopLevelAdminAction either) guarantees an interactable control that
    // survives even if the auto-redirect above is popup-blocked: App Bridge
    // only intercepts navigation from Polaris s-* components, and a user
    // click on target="_top" performs the top-level break-out the admin
    // pricing page needs (it can't be embedded in this app's iframe).
    // TopLevelAdminAction (app/components/TopLevelAdminAction.jsx) is an
    // <s-button>, i.e. exactly the kind of Polaris component this comment
    // says to avoid here -- every OTHER admin destination in this app uses
    // it, but this is the one recovery path a merchant with no subscription
    // has if App Bridge itself is misbehaving, so it keeps the more
    // primitive, harder-to-intercept control on purpose.
    return (
      <AppProvider embedded apiKey={apiKey}>
        <s-page heading="Welcome to AR Try-on">
          <s-section heading="Let shoppers try your frames on before they buy">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                AR Try-on adds a live camera try-on to your product pages.
                Shoppers see your frames on their own face, tracked in real
                time — nothing is uploaded and there is no app for them to
                install.
              </s-paragraph>

              <s-stack direction="block" gap="small-200">
                <s-text type="strong">Setting up takes three steps</s-text>
                <s-unordered-list>
                  <s-list-item>Upload an eyewear model.</s-list-item>
                  <s-list-item>Map it to one of your products.</s-list-item>
                  <s-list-item>Add the try-on block in your theme editor.</s-list-item>
                </s-unordered-list>
              </s-stack>

              <s-paragraph color="subdued">
                Choose a plan to get started. You can change or cancel it at any
                time from your Shopify admin.
              </s-paragraph>

              <s-stack direction="block" gap="small-200">
                {/* The screen's one action, so it reads as a button. It opens the
                    pricing page from a click handler, which App Bridge does not
                    intercept (same approach as TopLevelAdminAction). */}
                <s-button variant="primary" onClick={() => window.open(pricingUrl, "_top")}>
                  Choose a plan
                </s-button>
                <s-text color="subdued">
                  {/* Deliberately a plain <a target="_top"> -- see the comment
                      above this return for why a primitive fallback stays. */}
                  Button not working? <a href={pricingUrl} target="_top" rel="noreferrer">Open plans</a>
                </s-text>
              </s-stack>
            </s-stack>
          </s-section>

          <s-section slot="aside" heading="Questions?">
            <s-paragraph>
              <s-link href="mailto:zendolabs@gmail.com">Contact support</s-link>
            </s-paragraph>
            <s-paragraph>
              <s-link href="/privacy" target="_blank">Privacy policy</s-link>
            </s-paragraph>
          </s-section>
        </s-page>
      </AppProvider>
    );
  }

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Workspace</s-link>
        <s-link href="/app/models">Models</s-link>
        <s-link href="/app/additional">Help</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};

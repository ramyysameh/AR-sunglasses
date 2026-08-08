import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { getActivePlanName } from "../billing.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const activePlan = await getActivePlanName(admin);
  // No active subscription (fresh install, or lapsed -- grace covers only the
  // storefront, not the merchant's own admin). Send them to Managed Pricing.
  let pricingUrl = null;
  if (!activePlan) {
    const store = session.shop.replace(/\.myshopify\.com$/, "");
    // eslint-disable-next-line no-undef
    const handle = process.env.SHOPIFY_APP_HANDLE || "";
    pricingUrl = `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`;
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
    // A plain <a target="_top"> (not an s-link) guarantees an interactable
    // control that survives even if the auto-redirect above is popup-blocked:
    // App Bridge only intercepts navigation from Polaris s-* components, and a
    // user click on target="_top" performs the top-level break-out the admin
    // pricing page needs (it can't be embedded in this app's iframe).
    return (
      <AppProvider embedded apiKey={apiKey}>
        <s-page heading="Choose a plan">
          <s-section heading="A subscription is required">
            <s-paragraph>
              AR Try-on needs an active plan before you can add try-on to your
              products. Choose a plan to get started.
            </s-paragraph>
            <s-paragraph>
              <a href={pricingUrl} target="_top" rel="noreferrer">
                Choose a plan
              </a>
            </s-paragraph>
          </s-section>
        </s-page>
      </AppProvider>
    );
  }

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
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

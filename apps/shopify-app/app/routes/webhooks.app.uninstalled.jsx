import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Uninstall revokes access. It deliberately does NOT purge the merchant's
 * models.
 *
 * Shopify's model separates the two: uninstall means stop processing,
 * shop/redact (~48h later) means erase. Honouring that separation means a
 * merchant who uninstalls by accident and reinstalls within the window keeps
 * every calibrated model — and calibration is expensive to redo.
 *
 * Full erasure lives in webhooks.shop.redact.jsx via purgeShopData. Do not
 * "fix" this by deleting ModelAsset/ProductMapping here.
 */
export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};

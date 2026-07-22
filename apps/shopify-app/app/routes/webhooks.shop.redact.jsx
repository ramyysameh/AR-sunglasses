import { authenticate } from "../shopify.server";
import db from "../db.server";
import { purgeShopData } from "../webhooks.server";

/**
 * Mandatory GDPR topic. Shopify sends this ~48h after uninstall and expects
 * every trace of the shop to be gone.
 *
 * Deliberately does NOT read `session`: this fires after uninstall, when the
 * Session row is already gone and authenticate.webhook returns session as
 * undefined. Only `shop`, which comes from the HMAC-verified payload, is safe
 * to rely on.
 *
 * A purge failure propagates on purpose. Returning 200 on a failed purge would
 * tell Shopify the data was erased when it was not; a 500 makes Shopify retry
 * over ~48h, and the purge is idempotent under retry.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  const result = await purgeShopData(db, shop);

  console.log(
    JSON.stringify({
      event: "compliance_webhook",
      topic,
      shop,
      action: "purged",
      ...result,
      at: new Date().toISOString(),
    }),
  );

  return new Response();
};

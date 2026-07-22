import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR topic: a shopper has asked what personal data we hold.
 *
 * THIS IS INTENTIONALLY A NO-OP, NOT AN UNIMPLEMENTED STUB.
 *
 * The app stores no shopper personal data. Face tracking runs entirely
 * client-side via MediaPipe; the camera feed never leaves the device and no
 * frame is ever transmitted. Verified against the schema on 2026-07-22: the
 * only tables are Session, ModelAsset and ProductMapping, holding the shop
 * domain, merchant STAFF identity from OAuth, uploaded GLBs and product
 * mappings. Nothing is keyed to a shopper.
 *
 * There is therefore nothing to return. Acknowledging with 200 is the correct
 * and complete response.
 *
 * If a shopper-keyed table is ever added — a try-on event log, per-visitor
 * analytics — this handler becomes non-compliant and must return real data.
 * See the spec's verification block and re-run it.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(
    JSON.stringify({
      event: "compliance_webhook",
      topic,
      shop,
      action: "acknowledged_no_data_stored",
      at: new Date().toISOString(),
    }),
  );

  return new Response();
};

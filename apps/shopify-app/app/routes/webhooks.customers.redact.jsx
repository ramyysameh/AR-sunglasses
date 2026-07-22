import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR topic: a shopper has asked us to erase their personal data.
 *
 * THIS IS INTENTIONALLY A NO-OP, NOT AN UNIMPLEMENTED STUB.
 *
 * The app stores no shopper personal data — see the note in
 * webhooks.customers.data_request.jsx for the full reasoning and the schema
 * verification. There is nothing to erase.
 *
 * Merchant staff data is covered by shop/redact, not this topic.
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

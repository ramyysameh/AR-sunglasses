# Phase 2 — Compliance: design

**Date:** 2026-07-22
**Milestone:** Shopify App Store submission (roadmap: `2026-07-17-app-store-submission-roadmap.md`)
**Status:** design approved, pending implementation plan

## Goal

Pass Shopify's automated compliance check. A public app that does not subscribe to
and correctly answer the three mandatory GDPR webhook topics is rejected before a
human reviewer ever sees it.

Exit criteria:

- `customers/data_request`, `customers/redact`, `shop/redact` are subscribed in
  `shopify.app.toml` and answered with 200 by deployed routes.
- Lifecycle subscriptions (`app/uninstalled`, `app/scopes_update`) are restored.
- HMAC rejection is demonstrated by test, not assumed.
- `shop/redact` provably erases every trace of a shop, in both Postgres and S3.
- A public privacy policy URL exists and discloses camera-data handling.

## Context

Phase 1 left the app live at `https://ar-sunglasses-shopify-app.vercel.app`,
installed and running embedded. Two webhook routes exist
(`webhooks.app.uninstalled.jsx`, `webhooks.app.scopes_update.jsx`) but
`shopify.app.toml`'s `[webhooks]` section carries **no subscriptions at all** —
they were stripped for local dev because `--use-localhost` cannot register
localhost webhook URIs. That constraint is gone now that the app has a stable
public HTTPS URL.

Investigation during design surfaced three facts that shaped the result:

1. `webhooks.app.uninstalled.jsx` deletes only `Session` rows. `ModelAsset`,
   `ProductMapping`, and every S3 GLB survive an uninstall indefinitely.
2. `storage.server.js` exposes no delete, and the `artryon-app` IAM user is
   scoped to `PutObject`/`GetObject`/`ListBucket`.
3. `shopify.app.toml` declares `api_version = "2026-10"`, which does not exist
   in the installed `@shopify/shopify-api` enum (highest is `2026-07`), while
   `shopify.server.js` pins `ApiVersion.October25` = `2025-10`.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | `shop/redact` performs a full purge including S3 objects | No orphaned storage; cleanest reviewer story |
| D2 | `app/uninstalled` deletes sessions only — no model purge | Matches Shopify semantics; accidental uninstall + reinstall within 48h preserves the merchant's calibrated models, which are expensive to recompute |
| D3 | Compliance requests logged to stdout, not persisted | Vercel retains logs; a `ComplianceLog` table would itself hold shop identifiers needing their own retention policy |
| D4 | Privacy policy served from the app at `/privacy` | Stable URL, no external hosting, immediately available for the Phase 6 listing |
| D5 | S3 deletion happens **before** any DB deletion | See "Failure semantics" — this is the load-bearing decision |
| D6 | TOML `api_version` aligned **down** to `2025-10` | Matches the code's pin exactly; bumping to `2026-07` changes payload shapes and does not belong in a compliance phase |

D2 deliberately contradicts the roadmap's item 4 note ("verify `app/uninstalled`
actually purges shop data"). Approved on 2026-07-22.

## Architecture

```
app/
  webhooks.server.js                     NEW  purgeShopData(shop)
  storage.server.js                      MOD  + deleteModelGlb(storageRef)
  routes/
    webhooks.app.uninstalled.jsx         MOD  comment only; behavior unchanged
    webhooks.app.scopes_update.jsx       —    unchanged
    webhooks.customers.data_request.jsx  NEW  log + 200
    webhooks.customers.redact.jsx        NEW  log + 200
    webhooks.shop.redact.jsx             NEW  purgeShopData
    privacy.jsx                          NEW  public policy page
shopify.app.toml                         MOD  subscriptions + compliance_topics
```

`purgeShopData` lives in its own module rather than inline in the route so it can
be tested directly against Neon without constructing a signed webhook request,
and so any future purge trigger (support tooling, manual redaction) shares one
implementation.

### Failure semantics — why S3 precedes Postgres

`ModelAsset.storageRef` is the *only* record of which S3 objects belong to a
shop. Deleting DB rows first and then failing on S3 permanently loses the object
list: those GLBs orphan in the bucket, undeletable except by manual inspection.

Deleting S3 first inverts this into a safe failure. A storage error throws, the
route returns 500, Shopify retries, and because no DB row was touched the retry
recomputes an identical object list. The operation is exactly idempotent under
retry. Shopify retries over ~48h, which is ample headroom.

DB deletion order is forced by the `ProductMapping → ModelAsset` foreign key:
mappings, then assets, then sessions.

S3 `DeleteObject` on an absent key succeeds, and Prisma `deleteMany` on an empty
match succeeds, so a duplicate delivery is a clean no-op.

### Required operator action

`purgeShopData` cannot succeed until `s3:DeleteObject` is added to the
`artryon-app` IAM policy for bucket `artryon-models-gripz`. Until then
`shop/redact` returns 500 and retries. This is a safe failure — no data is lost
or leaked — but the phase is not complete until the policy is updated.

## Handler behavior

### `customers/data_request`, `customers/redact` — no-op with 200

The app stores **no shopper personal data**. MediaPipe face tracking runs
entirely client-side; the camera feed never leaves the device and no frame is
ever transmitted. Persisted data is limited to: shop domain, merchant *staff*
identity from the OAuth session (`Session.email`/`firstName`/`lastName`),
merchant-uploaded GLB assets, and product↔model mappings. None of it belongs to
a shopper.

There is therefore nothing to return for a data request and nothing to erase for
a redaction. Both handlers verify HMAC, log `topic + shop + timestamp`, return
200.

Each handler carries a comment explaining *why* it is a no-op. Without it, a
future maintainer — or a Shopify reviewer reading the repository — will read an
empty handler as unimplemented.

Merchant staff data is covered by `shop/redact`, not `customers/redact`.

### `shop/redact` — full purge

`purgeShopData(shop)`: collect `storageRef`s → delete S3 objects → delete
`ProductMapping` → delete `ModelAsset` → delete `Session`.

### `app/uninstalled` — unchanged

Sessions only, per D2. Gains a comment recording the reasoning so the omission
is not later "fixed".

### Session availability gotcha

Compliance webhooks arrive *after* uninstall, when no `Session` row exists;
`authenticate.webhook()` returns `session` as undefined. The existing uninstalled
handler guards with `if (session)`. New handlers must not reference `session` at
all — only `shop`, taken from the HMAC-verified payload.

## HMAC verification

`authenticate.webhook(request)` already performs HMAC-SHA256 verification against
`SHOPIFY_API_SECRET` and throws a 401 `Response` before returning. Every handler
calls it first.

The work here is proving that, and **not** introducing a second, weaker
verification path beside it. Tests post to each of the five webhook routes with
(a) an invalid HMAC asserting 401 and (b) a correctly computed HMAC asserting
200.

## Privacy policy

Public route `/privacy`, outside the `app.` prefix so it bypasses embedded auth.

Content:

- Camera and face data: processed client-side via MediaPipe, never transmitted,
  never stored. No biometric template is retained.
- What is stored: shop domain, merchant staff identity from OAuth, uploaded GLB
  assets, product mappings.
- Retention: uninstall revokes access; full erasure on `shop/redact` ~48h later.
- Sub-processors: Vercel (hosting), Neon (database), AWS S3 (asset storage).
- GDPR rights: access, rectification, erasure, portability.
- Controller contact: `ramy.sameh2@gmail.com`.

## Testing

Unit tests for `purgeShopData` run against Neon (the app suite already loads
`.env` and runs 16/16 green there), with storage stubbed via the in-memory map
pattern established in `storage.server.test`.

**Test isolation is mandatory here, not optional.** These tests exercise
deletion against a live shared database. Every fixture shop domain must be
uniquely generated per test run (e.g. `redact-test-${randomUUID()}.myshopify.com`)
and each test must clean up only its own rows. A test that purges a
predictable or real shop domain would destroy live data — this is the one
place in the suite where a careless fixture is genuinely destructive.

Assertions:

1. FK ordering — purge succeeds with mappings present.
2. **Multi-shop isolation** — purging shop A leaves shop B's rows and objects
   completely untouched. The highest-value test in the phase; a bug here is a
   cross-tenant data destruction incident.
3. Idempotency — a second purge of an already-purged shop succeeds.
4. Storage-failure abort — when `deleteModelGlb` throws, no DB row is deleted.
5. Every `storageRef` for the shop is passed to deletion, and none belonging to
   another shop.

Plus the HMAC 401/200 matrix across all five routes.

Deployment verification: after `shopify app deploy`, confirm the three compliance
subscriptions appear in the Partner Dashboard and that the live Vercel URL
answers each topic.

## Out of scope

- Bumping the API version to `2026-07` (D6) — separate work.
- `register-model` endpoint hardening — Phase 3.
- Listing copy, screenshots, pricing — Phase 6.
- Scope minimization review (`write_products,write_metaobjects,write_metaobject_definitions`)
  — belongs with the Phase 6 listing submission.

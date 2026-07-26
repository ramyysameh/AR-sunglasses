# Phase 5 — Billing: design

**Status:** approved design, ready for `superpowers:writing-plans`.

Part of the App Store submission roadmap
(`docs/superpowers/specs/2026-07-17-app-store-submission-roadmap.md`). Billing is
**required** — the locked decision is *paid at launch*. This phase makes the app
charge merchants via Shopify's billing and gate usage by plan.

## 1. Scope

Add subscription billing to the AR try-on app: three paid tiers, enforced by the
number of products a merchant has enabled try-on on. Merchants subscribe through
Shopify's hosted pricing page; the app reads their plan and enforces its limit.

**Out of scope:** usage-based (per-try-on) billing — the app tracks no try-on
events, so a usage metric is not available without first building event tracking.
Deferred; not needed for launch.

## 2. Decisions (all locked with the operator)

| Decision | Value |
|---|---|
| Billing mechanism | **Shopify Managed Pricing** (plans declared in Partner Dashboard) |
| Tiers | **Starter ≤ 10**, **Growth ≤ 40**, **Pro unlimited** |
| Gating metric | **Products with try-on enabled** = `ProductMapping` rows per shop |
| Prices | Set in the Partner Dashboard — **never in code** |
| Free trial | **7 days**, per-plan Partner Dashboard setting — **no code** |
| Over-limit behaviour | **Block new, grandfather existing** |
| Lapse behaviour (storefront) | **7-day grace period, then off** |
| Lapse behaviour (admin) | Gated immediately → redirect to pricing |

### Why Managed Pricing

Shopify hosts the pricing page and handles plan selection, upgrades, downgrades,
proration, and trials. The app never builds a pricing UI or plan-change flow. It
only needs each plan's **name → product-limit** mapping to enforce the tier.
Prices and trial length live in the dashboard and can change without a deploy.

### Why "products with try-on", not "models uploaded"

The customer-facing value is per **product** (a storefront visitor tries on when
viewing a product). `ProductMapping` (shop, productId) is exactly that count.
Uploading a model without mapping it to a product consumes nothing.

## 3. How the app knows a shop's plan

The plan is needed in two places with **opposite performance profiles**:

- **Admin** (`app.models`, `app.jsx`) — low traffic, authenticated. Can query
  Shopify live for the active subscription.
- **Storefront** (`api.tryon-config`) — hot path, and the one Phase 4 Slice 1 put
  behind edge caching. Calling Shopify's API per storefront try-on would undo
  that win.

**Therefore: a local `ShopSubscription` record is the source of truth**, kept
current by Shopify's `app_subscriptions/update` webhook (fires on subscribe,
upgrade, downgrade, cancel, and payment failure). Both enforcement points read a
cheap local row — the cached hot path stays fast, and the webhook keeps the row
authoritative. The admin loader may additionally reconcile live on load as a
safety net against a missed webhook.

### `ShopSubscription` model

```prisma
model ShopSubscription {
  shop        String   @id            // one row per shop
  planName    String?                 // matches a Partner Dashboard plan name; null = never subscribed
  status      String                  // ACTIVE | CANCELLED | FROZEN | DECLINED | EXPIRED | ...
  graceEndsAt DateTime?               // set when status leaves ACTIVE; null while active
  updatedAt   DateTime @updatedAt
}
```

Requires a Prisma migration, generated and applied through the **direct endpoint**
established in Phase 4 (`directUrl`) — no advisory-lock contention. Follow the
migration procedure the schema already uses.

## 4. Enforcement points

### A. No active subscription → require a plan

`app.jsx` (the admin layout loader wrapping every admin page) checks for an active
subscription via `getActivePlan(shop)`. If the status is not ACTIVE — fresh
install, or lapsed (**including during the grace window**) — redirect to Shopify's
Managed Pricing page. The grace period (point C) applies **only to the storefront**;
the merchant's own admin is gated the moment the subscription leaves ACTIVE, so
they are nudged to fix billing immediately. A merchant cannot reach the Models page
without an active plan. Standard paid-app gate; no custom UI.

### B. At the limit → block new products

In the `map` action (`app.models.jsx`, the `intent === 'map'` branch), before
`mapProductToModel`:

1. Determine the plan's limit from `PLAN_LIMITS[planName]` (`Pro → Infinity`).
2. If the target `productId` is **not already mapped** (a genuinely new product)
   **and** `productMapping.count({ where: { shop } }) >= limit` → reject with
   *"You've reached your plan's limit — upgrade to add more,"* linking to the
   pricing page.
3. Re-mapping an already-mapped product (the upsert's update path) and the Pro
   tier both skip the check.

`mapProductToModel` upserts on `(shop, productId)` (`models.server.js:44`), so
re-mapping is not a new product — the count check must gate only the create path.

### C. Subscription lapses → 7-day grace, then off

On an `app_subscriptions/update` webhook with a non-ACTIVE status, set
`graceEndsAt = now + 7 days` (a `GRACE_PERIOD_DAYS` constant). A subsequent ACTIVE
status clears it (`graceEndsAt = null`).

- **Storefront** (`api.tryon-config`): serve if `status === 'ACTIVE' || (graceEndsAt
  && now < graceEndsAt)`; else 404 (the engine falls back to no try-on). The
  "turn off" is a read-time timestamp comparison — **no scheduled job**; the
  transition happens on the first request after the window closes. Still a local
  row read, so the cached path stays fast.
- **Admin**: treated as no active subscription immediately on lapse (redirect to
  pricing). The grace protects the merchant's *customers*, not the merchant's own
  admin access.

Trial subscriptions report status ACTIVE, so a trialing merchant passes every
check with no special handling; a trial that ends unpaid lapses through this same
path.

## 5. New/changed surfaces

- `app/billing.server.js` (new): `getActivePlan(shop)` (reads `ShopSubscription`,
  reconciles live in admin context), `PLAN_LIMITS` map, `GRACE_PERIOD_DAYS`,
  helpers `isServable(sub, now)` and `planLimit(planName)`.
- `app/routes/webhooks.app.subscriptions_update.jsx` (new): HMAC-verified handler
  that upserts the `ShopSubscription` row. Mirrors `webhooks.app.scopes_update`.
- `shopify.app.toml`: add the `app_subscriptions/update` subscription.
- `app/routes/app.models.jsx`: limit check in the `map` action (point B).
- `app/routes/app.jsx`: subscription gate in the loader (point A).
- `app/routes/api.tryon-config.jsx`: grace-aware servable check (point C).
- `prisma/schema.prisma` + migration: `ShopSubscription`.
- `purgeShopData` (GDPR `shop/redact`): **must delete `ShopSubscription` rows** for
  the shop, or a new table with shop data reopens the Phase 2 compliance gap.

## 6. Verification

- **Unit:**
  - Limit: new product at limit → blocked; re-map existing → allowed; Pro →
    always allowed; count at limit-1 → allowed, at limit → blocked.
  - `isServable`: ACTIVE → true; lapsed within grace → true; lapsed past grace →
    false; never-subscribed → false.
  - `planLimit`: each plan name → its number; Pro → Infinity; unknown → 0 (fail
    closed).
- **Webhook:** `app_subscriptions/update` upserts status and `graceEndsAt` for
  subscribe (ACTIVE, grace cleared) and cancel (non-ACTIVE, grace set).
- **Compliance regression:** `purgeShopData` deletes the shop's `ShopSubscription`
  row (extend the existing purge test).
- **Live (operator-driven, the Phase 5 exit criterion):** with the three plans
  configured in the Partner Dashboard, a real test subscription on the dev store
  charges, unlocks the admin, and gates at the tier limit. Only the operator can
  drive this (Partner Dashboard plan setup + approving the charge).

## 7. Operator vs. code

- **Operator (Partner Dashboard / decisions):** create the three Managed Pricing
  plans with names matching `PLAN_LIMITS`, set prices, set the 7-day trial per
  plan, approve the test charge during live verification.
- **Code (mine):** everything in §5 and §6.

**Plan names are the contract between dashboard and code.** The names the operator
enters in the Partner Dashboard must exactly match the keys in `PLAN_LIMITS`
(`Starter`, `Growth`, `Pro`), or enforcement fails closed (unknown plan → limit 0
→ everything blocked). This coupling is called out for the plan and must be
verified during live testing.

## 8. Constraints carried from prior phases

- Dev and production **share one Neon database**; test fixtures are
  `randomUUID()`-tagged and cleaned by exact name in `afterAll`; the suite is not
  run against production casually.
- Migrations run through the **direct endpoint** (`directUrl`); if a build ever
  reports `P1002` advisory-lock timeout, clear it with
  `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory';` then
  redeploy once.
- Keep the storefront path (`api.tryon-config`, `/models/:id.glb`) free of live
  Shopify API calls so the Phase 4 edge caching holds.

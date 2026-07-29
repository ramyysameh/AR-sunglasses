# Phase 5 Billing — handoff for a fresh session

**Status: all code done, tested, reviewed, committed. NOT deployed. Blocked on
external Shopify setup, not on code.**

Branch `feat/phase5-billing`, 7 commits on top of `main`@`952973a`. Spec:
`docs/superpowers/specs/2026-07-26-phase5-billing-design.md`. Plan:
`docs/superpowers/plans/2026-07-26-phase5-billing.md`. Ledger:
`.superpowers/sdd/progress-phase5-billing.md`.

## What's done (do not redo)

All 7 code tasks: pure billing helpers (`app/billing.server.js` —
`PLAN_LIMITS` Starter=10/Growth=40/Pro=Infinity, `planLimit` fail-closed,
`isServable` grace logic, `getActivePlanName` live GraphQL read), the
`ShopSubscription` model + migration (already applied to the shared Neon DB),
the `app_subscriptions/update` webhook, tier-limit enforcement in
`app.models.jsx`, the storefront 402 gate in `api.tryon-config.jsx` (reads
only the local row, no Shopify call — keeps the Phase 4 edge cache intact),
the admin redirect-to-pricing gate in `app.jsx`, and the `purgeShopData`
extension for GDPR `shop/redact`. All DB-backed tests pass individually
against the shared Neon DB (dev + prod share one DB — never widen a cleanup
filter; use `randomUUID()`-tagged fixtures + `afterAll`).

Final whole-branch review done (inline self-review — see caveat below): no
Critical/Important findings. Four Minor items logged in the ledger, one
resolved (M2: user chose "leave as-is," no try/catch on the admin's
subscription-verification call).

## What's NOT done — the actual blocker

**Shopify App Pricing plans (formerly "Managed Pricing") do not exist yet,
and creating them requires an App Store listing, which this app does not
have.** Confirmed live in this session:

1. The Dev Dashboard (dev.shopify.com) has no pricing/listing UI for this app
   — only Overview/Monitoring/Logs/Versions/Settings.
2. Partner Dashboard → App distribution → All apps shows only a "your app
   management moved to Dev Dashboard" notice, not the app itself. Docs say
   pricing lives under **Distribution → Shopify App Store listing → Manage
   listing → Pricing content → Manage**, but Shopify is mid-migration between
   the old Partner Dashboard and the new Dev Dashboard, and the old path is
   not reachable for this app right now.
3. **This is Phase 6 (listing) territory leaking into Phase 5.** Starting an
   App Store listing (even a draft, just far enough to add pricing) is the
   next concrete step — not a code task.

## Next steps for the fresh session

1. Help the user find the current (post-migration) path to create an App
   Store listing / access Shopify App Pricing for this app. Try: Dev
   Dashboard → the app → look for a "Distribution" or "App Store" entry that
   may have been added since; or search Shopify's docs/changelog for the
   current listing-creation flow, since the UI was actively being migrated as
   of 2026-07-26.
2. Once a listing exists, create exactly 3 plans named **`Starter`**,
   **`Growth`**, **`Pro`** (exact names — they are the code↔dashboard
   contract; a mismatch makes `planLimit` fail closed and blocks everyone).
   Each needs a price (user's choice) and a **7-day free trial**.
3. User sets `SHOPIFY_APP_HANDLE` in Vercel (all 3 environments) and local
   `apps/shopify-app/.env` — used to build the pricing-page redirect URL.
   Documented in `.env.example`.
4. **Only then**: merge `feat/phase5-billing` → `main`, push (triggers
   production deploy — the `ShopSubscription` migration is already applied,
   so `prisma migrate deploy` should no-op; if `P1002` advisory-lock appears,
   the fix is the same as Phase 4: Neon SQL
   `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory';`
   then redeploy once).
5. Live-verify together: no subscription → redirected to pricing; subscribe
   (test charge) → admin unlocks + webhook populates `ShopSubscription`; map
   10 products then try an 11th → blocked; storefront try-on on a mapped
   product → 200; cancel → admin re-gates immediately, storefront still
   serves during the 7-day grace.
6. **Watch for this specific risk during step 5**: `getActivePlanName` reads
   `currentAppInstallation.activeSubscriptions` via the Admin API. Shopify
   recently split this into "Shopify App Pricing" with a separate Partner API
   for subscription status. If the admin does NOT unlock after a real test
   subscribe, that's the signal this read needs updating to the newer API —
   fix it then, verified live, rather than guessing now.
7. **Rollout note**: the moment this deploys, every shop without an active
   subscription loses storefront try-on (402) and gets redirected in admin.
   The dev/test store must subscribe to keep working.

## Caveat carried into any further work on this branch

The auto-mode classifier refused every subagent dispatch this session except
one (Task 1's implementer+reviewer went through cleanly; every other
implementer/reviewer/final-review dispatch was refused, sometimes after one
retry). Tasks 2–7 and the final review were done inline by the controller and
self-reviewed — real TDD, real green tests against the shared Neon DB, but
not independently reviewed. **Get a genuine fresh-eyes review of this branch
before submitting to the App Store** (same standing caveat as Phases 3 and
4). If subagent dispatch works again in the fresh session, that review is a
good use of it.

## Constraints carried from Phases 4/5 (unchanged)

- Dev and prod share one Neon DB. Never run the full app test suite
  casually; DB-backed tests use `randomUUID()` fixtures + `afterAll`.
- Migrations route through `directUrl` (the direct Neon endpoint); runtime
  uses the pooled `DATABASE_URL` with `connection_limit=1&pgbouncer=true`.
- The try-on engine is a committed artifact at
  `apps/shopify-app/public/tryon` — untouched by this branch.
- Keep the storefront path (`api.tryon-config`, `/models/:id.glb`) free of
  live Shopify API calls so the Phase 4 edge caching holds. (Task 5 upholds
  this — verified in review.)

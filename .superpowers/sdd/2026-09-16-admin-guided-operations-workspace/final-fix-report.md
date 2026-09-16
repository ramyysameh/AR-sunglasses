# Final Fix Report: Admin Guided Operations Workspace

## Status

Complete. All four final-review Important findings were addressed in one coherent fix wave with regression coverage and full Shopify-app verification.

## Fixes

### Change-model dialog sessions

- Synchronizes the selected model from the mapping whenever the dialog session, mapping, or mapping's current model changes.
- Cancelling and reopening the same product now discards an abandoned selection.
- A revalidated mapping supplies the fresh current model on the next open.
- Existing same-session publication retry behavior remains intact and remains scoped to the matching product, model, response transition, and dialog session.

### Exact theme path after enrichment failure

- Added nullable `ProductMapping.productHandle` through an additive PostgreSQL migration.
- The map action now accepts the add flow's existing `productHandle` field and passes it into the tenant-scoped mapping upsert.
- New mappings persist the handle; remapping with a supplied handle refreshes it; model-only changes preserve the stored handle.
- Workspace enrichment prefers Shopify's current product handle and falls back to the stored mapping handle when product enrichment is unavailable.
- Existing rows remain valid with `NULL` and continue to use the generic product-template theme link when no handle is known.

### Add flow publication lifecycle

- Close and Back are disabled while publication is in progress and their handlers also reject programmatic invocation during the matching submission.
- A native modal `afterhide` during publication no longer clears flow state or the submission; the modal is shown again and the response remains consumable.
- Successful publication still invokes the publication callback once, hides the modal, and completes the close lifecycle once.

### Plan-limit recovery beside Add

- At the plan limit, the disabled page-level Add try-on action is accompanied by a compact explanation and direct `View plans` link.
- The notice is secondary and does not add another page primary action.
- Higher-priority model-issue and add-to-theme guides remain unchanged and retain their single recovery action.

## Test-First Evidence

The initial focused RED run produced seven expected failures across five files:

- stale model selection remained after reopen and after mapping refresh;
- Close and Back were not disabled during publication;
- Prisma rejected the absent `productHandle` field and the mapping contract returned no handle;
- exact theme recovery could not be constructed from a persisted handle;
- no plan route existed beside the disabled Add action for model-issue or add-to-theme states.

After the implementation, the focused GREEN run passed 45 tests. A product-action boundary regression was then mutation-checked by temporarily removing handle forwarding: the test failed with `productHandle: null`, and passed after restoration. The final focused run passed 50 tests across six files.

## Verification

- Focused regressions: 6 files, 50 tests passed.
- Complete Shopify suite: 52 files, 301 tests passed.
- Typecheck: `react-router typegen && tsc --noEmit` passed.
- Production build: client and SSR builds passed.
- Targeted ESLint: passed for all changed JavaScript and JSX with `no-undef` disabled to isolate two pre-existing `globalThis` findings in `models.server.js`.
- Prisma schema validation: passed.
- Prisma migration status: six migrations found; database schema up to date.
- Prisma client generation: passed against Prisma 6.19.3.
- `git diff --check`: passed.
- Root AR suite was not rerun because no shared engine or calibration code changed.

## Migration Review

- Migration is additive and production-compatible: `ALTER TABLE "ProductMapping" ADD COLUMN "productHandle" TEXT;`.
- The column is nullable and has no backfill or default, so existing rows and writes remain valid during deployment.
- Runtime code tolerates old rows with `NULL` and uses the existing generic theme-editor fallback.
- The checked-in schema and migration agree. Deployment must continue to run the existing `prisma generate` and `prisma migrate deploy` setup before serving the new application code; no generated client artifact is committed.
- Tenant scoping remains enforced by the existing `(shop, productId)` unique key and owned-model check. Handle persistence does not introduce an unscoped lookup.

## Concerns

- Production build retains the existing large `model-viewer` chunk warning and React Router v8 future-flag warnings.
- Full-suite stderr includes expected diagnostics from failure-path tests and an existing mocked-export warning in `tryonConfig.billing.test.js`; the suite still passed 301/301.
- The repository ESLint configuration does not recognize two existing `globalThis` uses in `models.server.js`; targeted lint therefore used a command-line `no-undef` exception rather than changing unrelated lines.
- Native Shopify modal behavior and the compact plan-limit layout still require live embedded-admin acceptance for visual placement and Escape/backdrop dismissal behavior.

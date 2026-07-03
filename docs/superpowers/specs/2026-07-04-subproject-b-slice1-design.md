# Sub-project B, Slice 1 — Shopify App + one model + PDP try-on

- **Date:** 2026-07-04
- **Status:** Approved (design). Next: implementation plan (writing-plans).
- **Parent:** [Shopify App Roadmap](2026-07-02-shopify-ar-tryon-roadmap-design.md) — Sub-project B (Shopify app shell), first vertical slice.
- **Builds on:** [Sub-project A1](2026-07-03-subproject-a1-calibration-pipeline.md) (the calibration pipeline this slice runs server-side).

## Goal

Prove the whole Shopify integration loop end-to-end on a **development store** with the
smallest slice: a merchant installs the app, uploads one GLB and maps it to one product
(A1 calibrates it server-side), and a **"Try on" button appears on that product's PDP**
that opens the working try-on with that calibrated model.

This de-risks the Shopify plumbing (OAuth, admin, storefront extension, model→runtime
wiring) before the rest of Sub-project B is fleshed out.

## Confirmed decisions

- **First slice = thin end-to-end vertical** (install → map one model → PDP button → try-on).
- **Stack:** Shopify official **Remix app template** + **Prisma** + **PostgreSQL** (roadmap-locked).
- **Dev hosting:** the **Shopify CLI dev tunnel** (`shopify app dev`) — no production host decision
  needed for this slice (that's Sub-project D).
- **GLB storage:** served by the **app backend** (defer object-storage/CDN).
- **A1 runs server-side on upload** (the A1 modules are Node-runnable — direct reuse).
- **Try-on delivery:** the Theme App Extension opens the **existing hosted try-on app in an
  iframe** (`allow="camera"`); the try-on fetches its config from the app. Reuses the whole
  current engine; camera/CSP isolated in the iframe.

## Components

- **App shell** — Shopify Remix template: OAuth install, session storage (Prisma/Postgres),
  webhook scaffolding. Generated; we set access scopes and routes.
- **Data model (Prisma/Postgres):**
  - `ModelAsset { id, shop, storageRef, fitMetadata (json), confidence (float|null), status }`.
  - `ProductMapping { id, shop, productId, modelAssetId }`.
- **Admin (embedded Polaris/Remix routes):** upload a GLB → server runs A1
  `validate → normalize → calibrate` → persists the normalized GLB + fit-metadata + confidence
  → a screen to map a Shopify product to that model. Surfaces A1's validation issues and
  confidence report / `needsManual`.
- **A1 server integration** — a small service: GLB buffer → run the A1 pipeline (Node) →
  persist normalized GLB + fit-metadata record. Direct import of the A1 `src/calibration/*`
  modules.
- **Model + config serving:**
  - `GET /models/:assetId.glb` — serves the normalized GLB (scoped to the shop).
  - `GET /api/tryon-config?shop=&productId=` → `{ modelUrl, fitMetadata }` (public, shop-scoped).
- **Storefront Theme App Extension** — an app block on the product page: a "Try on" button
  opening a dialog with an iframe to the hosted try-on, passing `shop` + `productId`.
  Auto-installed (replaces the manual `shopify/sections/ar-try-on.liquid`).
- **Engine adapter** (in the existing Vite try-on app) — on load: read `shop` + `productId`
  from the URL → fetch `/api/tryon-config` → **adapt the A1 fit-metadata record into the
  engine's model-config shape** (the fields today hand-authored in `arConfig.js` /
  `tryOnConfig.js`) → load the model and run try-on.

## Data flow

```
Admin:   upload GLB → A1 (server) → persist ModelAsset(fitMetadata,confidence)
         → merchant maps ProductMapping(productId → modelAssetId)

Shopper: PDP → extension "Try on" → iframe(hosted try-on, ?shop&productId)
         → try-on fetches /api/tryon-config → adapter → engine renders calibrated try-on
```

## Config delivery (minor fork — resolved)

The extension passes `shop` + `productId` to the iframe; the try-on **fetches**
`/api/tryon-config` from the app. (Alternative considered: bake `modelUrl` + `fitMetadata`
into the extension via app-proxy/metafields at render time — rejected for this slice as it
couples the storefront render to the config and complicates caching.)

## Error handling

- A1 validator `fail` → admin shows the reasons and blocks mapping.
- Low confidence / `needsManual` → admin surfaces the confidence report. **For this slice,
  use a tagged/spec-compliant model so calibration is confident;** the in-admin manual
  anchor tool (adapting A1's harness) is deferred to the next slice.
- No mapping for a product → the extension button is hidden/disabled.
- Try-on config fetch fails → the iframe shows a graceful error (reuse the engine's existing
  error surface).

## Testing

- **Unit:** the A1-integration service (GLB buffer → persisted fit-metadata + confidence);
  the fit-metadata → engine-config adapter (record → the shape the engine consumes).
- **Integration:** upload → map → `GET /api/tryon-config` returns the correct `{modelUrl,
  fitMetadata}` for the mapped product; unmapped product returns an empty/disabled response.
- **Manual / E2E:** on a dev store via the Shopify CLI — install, upload, map, and confirm
  the PDP "Try on" button opens the try-on with the calibrated model.

## Deferred (explicit)

Multi-model admin UX + the in-admin manual calibration tool (next B slice); billing/tiers +
done-for-you ops + add-to-cart + analytics (Sub-project C); object-storage/CDN; production
hosting + GDPR-webhook hardening + security review + App Store submission (Sub-project D).

## Open questions (resolve during planning)

- Exact OAuth **access scopes** (read products for the mapping picker; anything else?).
- The precise **fit-metadata → engine-config** field mapping (A1 record vs. the engine's
  current `arConfig` fields) — nail down in the adapter task.
- GLB storage mechanism detail (Postgres blob vs. app filesystem/volume) for the dev slice.

## Exit criteria

On a development store: install the app → upload a GLB (A1 calibrates it) → map it to a
product → the product's PDP shows a "Try on" button → clicking it runs the try-on with that
calibrated model.

## Next step

Invoke the writing-plans skill to produce the implementation plan for this slice.

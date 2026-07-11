# Block-level GLB model (paste a GLB URL in the Try-On block) — Design

**Date:** 2026-07-11
**Status:** Approved (approach A2 — server-side calibration)

## Goal

Let a merchant point the AR Try-On theme block at a glasses GLB they host on
**Shopify Files**, and have that model load — correctly fitted — when a customer
taps **Try on**. No embedded-admin upload screen, no product-mapping step: the
model is configured entirely in the theme editor.

Primary use case: put **Gripz Pelmo** in the store by uploading `gripz_pelmo.glb`
to Shopify Files and pasting its URL into the block.

## Why this shape

The engine already: reads `?shop`/`?productId`, fetches a config, adapts A1
fit-metadata via `toEngineModelConfig`, and loads a model. The app already:
calibrates an uploaded GLB (`calibrateUpload`, Task 4), stores it, and serves it
(`/models/:id.glb`, Task 6). This design **reuses that machinery** and only adds:
a block setting, one public endpoint, and one engine code path. Calibration stays
on the server (calibrate once, cache, no `gltf-transform` in the customer bundle).

## Flow

```
Merchant: upload gripz_pelmo.glb → Shopify Files → copy CDN URL
        → paste URL into Try-On block's "Model (GLB) URL" field
Customer: taps "Try on"
  → iframe: <engine_url>/tryon/index.html?model=<glbUrl>
  → engine: GET /api/register-model?url=<glbUrl>   (same origin as /tryon)
      → app: dedupe by sourceUrl
             ↳ hit  → return stored { modelUrl, fitMetadata }
             ↳ miss → fetch GLB bytes → calibrateUpload → store (sourceUrl) → return
  → engine: toEngineModelConfig(fitMetadata, modelUrl) → load + fit
```

## Components

### 1. Theme block — `extensions/tryon-button/blocks/tryon_button.liquid`
- Add a setting:
  `{ "type": "text", "id": "model_url", "label": "Model (GLB) URL",
     "info": "Upload the .glb under Settings → Files and paste its URL here." }`
- When `block.settings.model_url` is present, append `&model={{ block.settings.model_url | url_encode }}`
  to the iframe `src` (alongside the existing `shop`/`productId`).

### 2. App — new public route `app/routes/api.register-model.jsx`
- `GET /api/register-model?url=<glbUrl>` — public (no admin auth), permissive CORS
  (`Access-Control-Allow-Origin: *`), like `api.tryon-config`.
- Validates `url` is a non-empty `https:` URL; 400 otherwise.
- Delegates to `registerModelByUrl(prisma, url)` (below).
- Returns `{ modelUrl, fitMetadata }` (same shape as `getTryonConfig`) or a 4xx/5xx
  with a short JSON error on validation/calibration failure.

### 3. App — `app/models.server.js` : `registerModelByUrl(prisma, url)`
- **Dedupe:** `prisma.modelAsset.findFirst({ where: { sourceUrl: url } })`. If found,
  return `{ modelUrl: /models/<id>.glb, fitMetadata }` without re-fetching.
- **Miss:** `fetch(url)` → `Uint8Array` → `calibrateUpload(bytes)` (Task 4) →
  `saveModelGlb` (Task 6 storage) → `prisma.modelAsset.create({ …, sourceUrl: url })`.
- Returns `{ modelUrl, fitMetadata }`.
- Throws on non-2xx fetch, oversized body, or `calibrateUpload` validation failure;
  the route maps the throw to a JSON error.

### 4. Prisma — `ModelAsset.sourceUrl`
- Add `sourceUrl String? @unique` (nullable — existing upload/admin assets have none;
  block-registered assets carry the source URL as the dedupe key). New migration.
- The dedupe key is `sourceUrl`, **not** `shop`. `ModelAsset.shop` (required) is set to the
  `shop` the engine passes through (the block already has it) or a `"__block__"` placeholder
  when absent — it's metadata here, not part of the lookup. A given GLB URL calibrates once
  and is shared across shops.

### 5. Engine — `main.js`
- Read `const modelUrl = params.get('model')`.
- New `async resolveBlockModelKey()`: if `modelUrl` present →
  `fetch('/api/register-model?url=' + encodeURIComponent(modelUrl))` →
  `{ fitMetadata, modelUrl: served }` → `toEngineModelConfig(fitMetadata, served)` →
  `registerRuntimeGlassesConfig(REMOTE_SKU_KEY, cfg)` → return the key; on any failure
  log a warning and return `null`.
- Resolution priority in `startEngine`: **block model** → `shop`+`productId`
  (`resolveRemoteSkuKey`) → default SKU. First non-null wins.

### 6. Engine — portrait auto-scale (`src/core/RenderLoop.js`)
- Bake in the tuned value: when no `?gscale` override is given, default the glasses
  multiplier to **~1.7 in portrait** (viewport taller than wide) and **1.0 otherwise**.
  `?gscale=<n>` still overrides for further tuning. (Value refined from on-device tuning;
  may be revisited per-device.)

## Data / interfaces

- `GET /api/register-model?url=<glbUrl>` → `200 { modelUrl: string, fitMetadata: object }`
  | `400 { error }` (bad url) | `502 { error }` (fetch failed) | `422 { error }`
  (calibration rejected the model).
- `fitMetadata` shape is the A1 `eyewear-v1` record already produced by `calibrateUpload`.
- `toEngineModelConfig(fitMetadata, modelUrl)` is unchanged (Task 8).

## Error handling & fallback

- Block model fails (bad URL, fetch error, calibration reject) → engine logs and falls
  back to `shop`/`productId`, then the default frame — the try-on still opens.
- Calibration of an untagged GLB uses the geometric estimate (best-effort fit); the
  in-admin manual-anchor tool remains out of scope (future slice).

## Testing

- **App (TDD):** `registerModelByUrl` — (a) calibrates + stores + returns config for a
  tagged GLB (feed bytes via a stubbed `fetch`/local fixture, reuse `tagged-sample.glb`
  builder), (b) dedupes on second call with the same URL (one asset, no re-calibrate).
- **App route:** build compiles; `GET /api/register-model` returns 400 for a missing/bad
  URL. Endpoint verified over HTTP the same way `/api/tryon-config` was (seed + curl).
- **Engine:** `react-router`/vite build compiles the new path; manual E2E below.
- **Manual E2E:** upload `gripz_pelmo.glb` to the dev store's Files, paste the URL in the
  block, tap **Try on** → Gripz Pelmo loads and fits (desktop + phone at the portrait scale).

## Out of scope / future

- In-app upload button (keeps the Files → paste-URL flow).
- **Hardening the public `register-model` endpoint — sub-project D, and this MUST land before
  production traffic.** The endpoint is unauthenticated and, per distinct URL, performs a
  server-side fetch and persists a new `ModelAsset` row + on-disk GLB. Deferred protections:
  (a) SSRF — restrict the fetch to Shopify-CDN hosts (allowlist); (b) request size cap (the
  current `arrayBuffer()` read is unbounded in memory); (c) **persistence/resource bounds** —
  auth or rate-limiting + an eviction/growth bound, since an attacker looping distinct URLs can
  grow the DB and fill disk regardless of any single-file size cap; (d) the concurrent
  first-registration race (two calls for a new URL both calibrate; the loser writes an
  orphaned GLB then hits a raw P2002 unique error that the route currently maps to a
  misleading 422) — fix via unique-catch → re-read the existing row and return it.
- Draco-compressed GLB inputs (assume raw GLBs like the exported models).
- Per-device portrait-scale calibration (single constant for now).

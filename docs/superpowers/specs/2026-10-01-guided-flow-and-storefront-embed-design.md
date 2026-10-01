# Guided flow, storefront embed, bulk AI generation and tutorial — design

Date: 2026-10-01 · Status: approved in conversation, awaiting spec review
App: AR Try-on (Shopify embedded app, `apps/shopify-app`, theme extension
`extensions/tryon-button`). Builds on the live "Create with AI" feature
(`2026-09-30-ai-model-generation-design.md`).

## Problem

Merchants should get from install to a live try-on in three moves: open the app,
generate 3D models, turn try-on on. Today the last move is the hard one: the
storefront button is an app *block* the merchant must place in the product
template in the theme editor. Smaller gaps: only 2 AI generations can run at a
time and only for one product per click, the generated-model preview can't zoom,
saved AI models are all called "AI model", the Models page has no usage bar, and
the Help page is text only.

## Decisions (made by the owner)

1. Storefront: an **app embed**, switched on once with a deep link + Save.
2. Bulk: **pick up to 5 products in one go**, one Generate button, up to 5 run at
   once, the rest queue.
3. Tutorial screenshots use **generic demo sunglasses**, no Gripz branding.
4. Build in three parts, each tested and deployed on its own:
   **A** names, zoom, usage bars · **B** bulk, embed, guided flow · **C** tutorial.

## Part A — quick wins

### A1. Generated models are named after their product
- `saveGeneration` names the asset after `generation.productTitle` when the row
  came from a product (`photoSource = 'product'`), else keeps `'AI model'`.
  The name is the `ModelAsset.label` passed to `saveCalibratedModel`
  (`generations.server.js`, currently the literal `'AI model'`).
- If another asset of the shop already has that label, append ` (2)`, ` (3)`, …
  (first free number).
- One-off backfill (Prisma migration, SQL only): assets labelled `AI model` whose
  id equals a saved generation's `modelAssetId` with a non-null `productTitle`
  take that title. Collisions are not de-duplicated in the backfill (only one
  such asset exists today).
- Rename keeps working as now.

### A2. Large 3D preview (amended 2026-10-01: owner chose a large/full-screen preview over zoom buttons)
- Small viewers rotate by drag only (zoom off, so the wheel scrolls the page). An **Expand** button opens a large preview filling the app window: drag to rotate, scroll/pinch to zoom, **Full screen** when the browser allows it, Close/Esc to exit. Review cards (320 px) and library cards are expandable. The +/−/reset design below is superseded.

#### Original A2 (superseded)
- `ModelViewer.jsx` drops `disable-zoom`; wheel / pinch zoom and drag-rotate work.
- New props: `height` (default 160) and `controls` (default false). With
  `controls`, three small buttons overlay the viewer: **+**, **−**, **Reset**
  (model-viewer `zoom()` / `cameraOrbit` reset via the element ref).
- Generation review cards use `height={320} controls`. Library cards keep 160 px
  with zoom enabled, no buttons.
- In-page scrolling: model-viewer only captures the wheel while the pointer is
  over it; that is acceptable on a 320 px card.

### A3. Usage bars on the Models page
- Top of `app.models.jsx`, above Create with AI:
  - **Free AI models** — `used of allowance` with a bar (reuse `usagePercent`);
    Pro / comped: no bar, "Unlimited · N created". Hidden when the AI feature is
    off for the shop. Past the allowance: full bar + "then $5 each".
  - **Products with try-on** — the existing `PlanUsage` component (same data the
    Workspace loader builds via `planUsage.server.js`).
- The loader adds what it is missing (plan usage); the AI allowance is already
  loaded for the Create with AI panel.

## Part B — bulk generation, storefront embed, guided flow

### B1. Bulk generation from products
- **UI (`AiProductSource.jsx`, `AiModelFlow.jsx`).** "Choose products" opens the
  App Bridge resource picker with `multiple: 5`. Each chosen product is a row:
  title + its image thumbnails, first 4 ticked, merchant may tick 3–4. A product
  with fewer than 3 images shows "Needs at least 3 photos" and is excluded. The
  button reads "Generate 3D models (N)" and is disabled when N = 0. "Upload
  photos" stays single-model.
- **API (`api.generations.jsx`).** New intent `create-from-products` taking
  `[{ productId, imageIds }]` (1–5 items). For each item, in order: the existing
  `importProductPhotos` + `createGeneration` path. Items fail independently; the
  response lists per-product `{ productId, generationId? , error? }`. Photo
  cleanup rules stay as for `create-from-product` (delete imported photos only
  for pre-row errors). The single-product intent remains for compatibility.
- **Limits (`generations.server.js`).** `LIMITS.running` 2 → **5**. Over the
  cap, `createGeneration` no longer throws `TOO_MANY_RUNNING`; it creates the row
  as `queued` without starting the job. `perDay` (20) still throws `DAILY_LIMIT`
  and counts queued rows.
- **Queue.** `startQueued(prisma, shop, now)`: while running+collecting < 5,
  claim the oldest `queued` row (conditional update `queued → running`) and call
  `startGeneration`; a start failure follows the existing start-failure path.
  Called after a job leaves `running`/`collecting` (end of `advanceGeneration`,
  i.e. from the webhook and from polling) and at the start of
  `listGenerations`. The 15-minute timeout counts from `startedAt`, which is set
  when a queued row actually starts.
- **UI states.** `queued` rows show "Waiting to start" (existing status set
  already includes `queued`).
- Charging is unchanged: each save is decided free/paid on its own.

### B2. Storefront app embed
- **New block** `extensions/tryon-button/blocks/tryon_embed.liquid`,
  `"target": "body"`, name "AR Try-on". Settings: button label (default "Try
  on"), glasses size (`gscale`, same range as the block), engine URL
  (pre-filled, same default and info text as the block).
- **Shared snippet.** The button, dialog/iframe and "I rendered" ping move from
  `tryon_button.liquid` into `snippets/tryon_core.liquid`, rendered by both
  blocks with `product`, settings and a unique id. The app block's behaviour
  and output stay byte-for-byte equivalent apart from the extraction.
- **Where it renders.** Only when `request.page_type == 'product'` and
  `product.metafields["$app:tryon"].enabled.value` is true (the existing gate).
  Nothing renders otherwise.
- **Placement.** Rendered as a hidden template; a small inline script moves the
  button to directly after the main product form's add-to-cart button
  (`form[action*="/cart/add"] [type="submit"]`, first match inside `main`). If
  none is found, the button shows fixed bottom-right (floating). The dialog is
  appended to `body` either way.
- **No doubles.** The app block marks its button `data-ar-tryon="block"`. The
  embed script does nothing if such an element exists on the page.
- **Activation link.** `adminLinks.server.js` gains `embedActivationUrl(shop)`:
  `https://<shop>/admin/themes/current/editor?context=apps&activateAppId=<api
  key>/tryon_embed` (same canonical API key as `themeEditorUrl`). Exact
  parameter format is confirmed against Shopify's theme-app-extension docs
  during implementation and covered by a unit test.
- **Detection.** No new scopes. The embed reports through the same ping as the
  block (`api.tryon-installed` → `blockSeenAt`), so "try-on is on in the store"
  = any mapping of the shop has `blockSeenAt`. The guided step offers "View on
  your store" (a mapped product's storefront URL, opened top-level) so the
  merchant's own visit produces the first ping.
- **Deploy.** Ships with `shopify app deploy --allow-updates`, like the block.

### B3. Guided home page
- The Workspace (`app._index.jsx`) shows a three-step guide until all are done:
  1. **Create 3D models** — the Create with AI panel (multi-product), with
     "Upload your own .glb" as a secondary link. Done when the shop has ≥ 1
     ready model asset.
  2. **Review and save** — done when ≥ 1 product has a mapping (saving a
     product-sourced AI model maps it automatically).
  3. **Turn on try-on in your store** — primary button "Turn on try-on"
     (`embedActivationUrl`, opened top-level via `TopLevelAdminAction`), helper
     text "In the theme editor, click Save", plus "View on your store" and
     "Check again". Done when the shop has any `blockSeenAt`.
- Each step shows done / current / upcoming. When all three are done the guide
  collapses to the existing "Everything is live" line; the product list below
  is unchanged.
- `workspaceGuide` in `workspace.server.js` gains the three-step model; its
  recovery states (model issue, review fit, plan limit) keep priority once
  setup is complete. The "Add to theme" recovery state now points at
  `embedActivationUrl` instead of the block deep link.
- The Models page keeps the library, usage bars and the same Create with AI
  panel.
- Help page: "Try on button is missing" now explains the embed switch and links
  to it; the block deep link stays available as "Place the button yourself".

## Part C — tutorial page

- New route `app.tutorial.jsx`, nav link "Tutorial" between Models and Help.
- Sections: 1 Create models · 2 Review and save · 3 Turn on try-on · 4 Check your
  store, then troubleshooting (fit too small/large, button missing, camera
  blocked) moved from Help. Help keeps the contact link and points to Tutorial.
- Each step: a screenshot (`public/tutorial/<step>.png`, captured from the
  redesigned app on the dev store at 1280-wide, 2x) with an SVG overlay drawn by
  a small `AnnotatedScreenshot` component from data: numbered markers, circles
  (ellipses) and arrows, positioned in percentages of the image so they scale.
  Each marker number matches a caption line under the image.
- **Demo content.** 3 neutral demo sunglasses products on the dev store, using
  the generic product photos from the listing media
  (`D:\AR Sunglasses\marketing\`), with AI models generated for them (uses
  OpenAI credit). No Gripz products, logos or names visible in screenshots.
- Built after Part B is deployed, so screenshots show the final UI.

## Error handling

| Case | Behaviour |
|---|---|
| Some products in a bulk request fail to import | Others still start; the failed ones are listed with the reason |
| Over 5 running | Extra rows queue and start automatically |
| Daily limit reached mid-batch | Remaining products are refused with the daily-limit message |
| Queued row's start fails | Same as today's start failure (failed, not charged) |
| Embed can't find Add to cart | Floating button bottom-right |
| Old app block present | Embed stays silent |
| Embed switched on but never pinged | Step 3 stays "Waiting for your store"; "View on your store" + "Check again" |

## Testing

- DB-free unit tests (fake Prisma, as today): naming + `(2)` suffix; queueing
  over the cap, `startQueued` claim/start/failure, daily limit counting queued
  rows; bulk route per-item results and cleanup; `workspaceGuide` step states;
  `embedActivationUrl`; usage bar maths; `ModelViewer` props.
- Never run DB-backed tests or `prisma migrate` locally (shared Neon DB).
- Storefront: the embed on the dev store theme — button under Add to cart, the
  floating fallback (theme preview with the form hidden), no double with the
  block, ping recorded.
- End to end on the dev store: pick 3 products → 3 generations (≥ 1 queued when
  6+), save one → named after its product, mapped, usage bar moves; turn on the
  embed → step 3 completes after "View on your store".

## Out of scope

- Writing theme files directly (not allowed for App Store apps).
- Detecting embed state by reading theme settings (would need `read_themes`).
- Bulk for "Upload photos".
- Per-product button placement or styling beyond the embed settings.

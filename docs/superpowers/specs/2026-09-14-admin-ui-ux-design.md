# Merchant admin UI/UX redesign

Date: 2026-09-14
Branch: `feature/admin-ux` (worktree `wt-admin-ux`, based on `origin/main` @ d4afe77)

## Goal

Make the embedded admin of the AR Try-on Shopify app good enough that a merchant
can install it, get try-on live on a product, and confirm it works — without
support. Four drivers, all of which the design must serve:

1. Merchants get stuck during onboarding and churn.
2. The app should read as a credible paid app at App Store review.
3. The Models page is clunky once a merchant has more than a couple of models.
4. The plan limit should be visible as a path, not discovered as a wall.

## Where we are starting

Three merchant-facing routes, all Polaris web components (`s-page`, `s-section`):

| Route | Today |
| --- | --- |
| `app/routes/app._index.jsx` | Blurb plus a three-item setup checklist |
| `app/routes/app.models.jsx` | Upload, map, mappings table and model gallery in one 420-line scroll |
| `app/routes/app.additional.jsx` | "Help": static prose |

`app/routes/app.jsx` owns the nav and the no-subscription screen.

### Problems this design fixes

- **The map form is blind.** A merchant picks a model from a `<s-select>` of
  `gripzpelmo.glb · Sep 7` labels while the 3D previews sit in a different
  section further down the page.
- **Setup step 3 can never complete.** "Add the AR Try-On block in the theme
  editor" is prose, and its badge is hardcoded to `To do`.
- **The plan cap is invisible until it fires.** `planLimit()` surfaces only as
  an error string after a failed map. No usage readout, no upgrade path.
- **Models are write-only.** No rename, no delete, no reverse lookup of which
  products use a model. Orphans accumulate with no cleanup.
- **Pipeline jargon leaks to merchants**: `geometric (confidence 82%)`,
  `Needs manual anchor`, `Calibrated`.
- **No way to verify try-on** without leaving the admin for the storefront.
- **Errors are reported twice** — a toast and a banner for the same failure.

## Hard constraints

These are settled facts, established before design. Do not re-litigate them
during implementation.

### Camera cannot work inside the admin iframe

Shopify does not set `allow="camera"` on the iframe it wraps embedded apps in.
Permissions Policy is a delegation chain, so a nested iframe cannot obtain
camera access regardless of what the app sets on it. There is no App Bridge API
for this. The storefront block works because there the chain is top-level page →
iframe, not admin → app → iframe.

**Consequence:** an in-admin live try-on is not buildable. The preview story is
QR-to-phone, open-in-new-tab, and a camera-free static fit render.

### No `read_themes` scope

Scopes are `write_products,write_metaobjects,write_metaobject_definitions`.
Adding `read_themes` would force a re-auth prompt for every installed merchant
plus a scope justification at review.

**Consequence:** theme-block presence is detected by proof of life
(`/api/tryon-config` being hit), not by reading the theme.

### Plan limits

`PLAN_LIMITS = { Starter: 10, Growth: 40, Pro: Infinity }`. Comped shops
(`FREE_ACCESS_SHOPS` / `FREE_ACCESS_UNTIL`) are treated as Pro.

## Information architecture

`Home · Products · Models · Help`

The central move is splitting today's Models page in two. It currently answers
"what have I uploaded?" and "what is my store actually doing?" at the same time
and serves neither well. Pages are named after the merchant's nouns, not the
app's data model — there is no merchant-facing page called "Mappings".

| Page | Purpose | One-line contract |
| --- | --- | --- |
| Home | Status and setup | Is try-on working, and what is left to do? |
| Products | The working surface | Which products have try-on, and is each one live? |
| Models | Asset library | What frames have I uploaded, and where are they used? |
| Help | Troubleshooting | Something looks wrong — what do I do? |

## Home

### Setup checklist

Three steps, each with real state:

| Step | Complete when |
| --- | --- |
| Upload a model | `ModelAsset.count > 0` |
| Add try-on to a product | `ProductMapping.count > 0` |
| Add the button to your theme | Any `ProductMapping.lastSeenLiveAt` is set |

Step 3 carries an **"Add to theme"** button that deep-links to the theme editor
with the `tryon_button` block pre-inserted:

```
https://admin.shopify.com/store/{store}/themes/current/editor
  ?template=product
  &addAppBlockId={extensionUuid}/tryon_button
  &target=mainSection
```

The link must open top-level (`target="_top"`) — the admin theme editor is not
embeddable, the same reason `app.jsx` opens the Managed Pricing URL that way.

**Risk:** `extensions/tryon-button/shopify.extension.toml` declares
`uid = "53b5dfb4-3bb4-0954-72aa-7e751170befc5b13a1dd"`, but it is not confirmed
that the CLI `uid` is the identifier `addAppBlockId` expects (versus the
deployed extension's registration id). Verify against a real store during
implementation. **Fallback if it does not resolve:** a plain "Open theme editor"
link plus the existing written steps — degraded, not broken. The checklist item
and its completion detection are unaffected either way.

### Proof-of-life detection

`app/routes/api.tryon-config.jsx` is hit exactly when the try-on engine opens on
a storefront — which means the block is installed, the product is mapped, and
the subscription is servable. That is stronger evidence than the theme JSON
containing a block.

That route already receives both `shop` and `productId`, so record
`lastSeenLiveAt` **per mapping**, not per shop. A per-shop timestamp would mark
every product "Live" the moment any one product was used — wrong, and wrong in
the direction that hides a broken product from the merchant.

**Throttling is required**: this path is documented as never calling Shopify and
is effectively edge-cacheable, so it must not take a database write per try-on
open. Write only when the stored value is older than one hour.

### Plan usage

A usage readout on Home: `4 of 10 products using try-on`, the plan name, and an
Upgrade link to the Managed Pricing URL. Pro and comped shops show usage without
a meter or an upgrade prompt — there is nothing to upgrade to.

## Products

The primary working surface. One row per product with try-on:

`[product image] Product title / model name [model 3D thumb] [status] [Preview] [⋯]`

Row overflow menu: **Change model**, **Remove try-on**.

### Status vocabulary

Merchant-facing words. The underlying calibration numbers stay on the Models
page, where they are actionable.

Evaluated in this order; the first match wins, so a product can only ever show
one status:

| Order | Status | Tone | Condition |
| --- | --- | --- | --- |
| 1 | Check fit | warning | Model confidence is low or it needs a manual anchor |
| 2 | Not on your theme yet | warning | `lastSeenLiveAt` is null |
| 3 | Live | success | Mapped, model ready, and seen working |

Fit problems outrank installation problems deliberately: a merchant who fixes
the theme block only to find the glasses sit wrong has been sent down the wrong
path first.

`geometric (confidence 82%)`, `Needs manual anchor` and `Calibrated` are retired
from this page. The `sourceLabel()` helper moves to the Models page.

"Not on your theme yet" links to the same theme deep link as Home step 3 —
the merchant gets the fix where they notice the problem.

### Add try-on

One focused modal replacing today's two disconnected fields:

1. Pick a product (existing `shopify.resourcePicker`).
2. Choose a model from **visual cards showing the rendered frames**, not a
   filename dropdown. This is the single biggest usability fix on the page.
3. Or upload a new model inline, without leaving the flow.

Plan-cap enforcement stays exactly where it is in the `map` action — grandfather
existing mappings, count only genuinely new products. The modal additionally
disables the submit and explains the cap when the merchant is already at it, so
the wall is visible before they do the work rather than after.

## Models

A grid of model cards: 3D preview, name, confidence, where it is used.

- **Rename.** Requires a new nullable `ModelAsset.label` column. Display falls
  back to `filename`, then to the existing short-id form.
- **Delete.** Guarded by usage: a model mapped to products cannot be deleted
  until those mappings are removed. The card states "Used by 2 products" and
  links to the filtered Products view.
- **Calibration detail.** Confidence and anchor source live here, in the place a
  merchant can act on them (re-upload, or adjust fit).

## Preview

Three surfaces, one URL. The preview URL is the hosted engine with the shop and
product already applied:

```
{engineUrl}?shop={shop}&productId={productId}&gscale={gscale}&src=preview
```

`src=preview` marks this as merchant traffic so it is excluded from the
proof-of-life signal (see Schema changes).

1. **QR code** — primary. Try-on is a phone experience and the merchant is on a
   desktop; scanning opens it top-level on their phone, where the camera works.
2. **Open in new tab** — same URL, desktop webcam, one `target="_blank"`.
3. **Fit preview on the mock head** — camera-free, renders inside the admin.
   Uses `test-mock-head/head.glb` with the merchant's frames positioned by the
   existing fit solver. This is the only preview that works inside the iframe,
   and it targets the known "glasses look too small" failure directly.

## Help

Restructured around actual failures rather than a description of the happy path:

- **Glasses look too small** — the Glasses size slider in the block settings;
  default 1, try ~1.6. This is the known recurring complaint and leads.
- **The Try on button does not appear** — block not added, or product not
  mapped. Links to the theme deep link.
- **The camera does not start** — browser permission, and HTTPS.
- Model requirements: `.glb`, 25 MB cap, what calibration measures.

## Cross-cutting

- **One error surface per failure.** Form-scoped errors render as an inline
  banner; background and navigation-away results use a toast. Never both for the
  same event, which today's `mapFetcher` path does.
- **Empty states are invitations,** not apologies: name the space and give the
  verb ("Add your first model"), not "No models yet."
- All copy sentence case, no "successfully", no exclamation marks.

## Schema changes

```prisma
model ModelAsset {
  label String?           // merchant-supplied name; falls back to filename
}

model ProductMapping {
  lastSeenLiveAt DateTime?  // last time the engine fetched config for this product
}
```

Both are additive and nullable, on tables that already exist. No backfill and no
new table. An existing merchant sees step 3 as incomplete, and their products as
"Not on your theme yet", until each storefront product is next used — which is
correct rather than pessimistic: the app genuinely does not know yet, and the
status resolves itself the first time a shopper (or the merchant's own QR
preview) opens try-on.

**The preview must not count as proof of life.** The QR and new-tab previews
load the same engine and therefore hit the same endpoint, so without a marker a
merchant could preview their own product and have the app report "Live" and
"theme done" while no block exists on the theme at all — exactly the false green
this signal is meant to avoid. The preview URL therefore carries `&src=preview`,
and the route skips the `lastSeenLiveAt` write when it is present. Everything
else about the response is identical.

## Out of scope

- Live camera try-on inside the admin. Not buildable (see constraints).
- Reading the merchant's theme to verify block installation. Needs a scope
  expansion that costs a re-auth for every installed merchant.
- Any change to the storefront try-on engine, the theme block, or the
  calibration pipeline. This is an admin-only slice, deployable on its own, the
  same way the earlier Polaris work shipped.
- Analytics (try-on opens, conversion). Real product surface, separate spec.

## Success criteria

1. A merchant with a fresh install can reach a working storefront try-on using
   only in-app affordances — no documentation, no support.
2. The setup checklist reaches three of three, driven by observed state.
3. Choosing a model shows the merchant the actual frames before they commit.
4. Plan usage is legible before the cap is reached, with an upgrade path.
5. A model can be renamed and deleted; deletion cannot orphan a live product.
6. No pipeline vocabulary on Home or Products.
7. The try-on can be verified from the admin on a phone via QR without typing
   a URL.

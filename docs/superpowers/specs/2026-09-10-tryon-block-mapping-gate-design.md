# Gate the try-on block on a mapped model

**Date:** 2026-09-10
**Status:** Approved, not yet implemented

## Problem

The AR Try-On theme app block is added by the merchant to a product template in the
theme editor, so it renders on *every* product using that template — including
products that have no calibrated model. On those products the button opens a dialog
whose iframe gets a 404 from `/api/tryon-config` and falls back to a default model, or
shows nothing useful. The merchant has no way to say "only these products".

The block cannot see the app's Postgres `ProductMapping` rows, so today it has no basis
on which to hide itself.

## Rule

The block renders **only when the product has a `ProductMapping` row for that shop.**

Mapping in the app admin is the single source of truth. The block's existing
`model_url` setting is no longer an independent path to a rendered try-on — it degrades
to a per-block model override that only takes effect on an already-mapped product.

## Mechanism

Liquid cannot query the app's database, so the app mirrors the fact "this product has a
model" into an **app-owned product metafield** that Liquid can read:

| | |
|---|---|
| Namespace | `$app:tryon` |
| Key | `enabled` |
| Type | `boolean` |
| Owner | Product |

Liquid reads it with the reserved-prefix syntax documented for theme app extensions:

```liquid
{% assign tryon_enabled = block.settings.product.metafields["$app:tryon"].enabled.value %}
```

This is server-rendered, which means: no flash of a button that then disappears, no
network request from the theme, no CORS surface, and correct output when JS is blocked.

No new access scopes. `write_products` (already granted, see `shopify.app.toml`) covers
product-owned metafields.

### Why a boolean rather than the asset id

The block only needs to know *whether* a model exists; it already resolves *which* model
through `/api/tryon-config` at runtime. Storing the asset id would create a second copy
of a value that changes on every re-map, with nothing reading it. Boolean has no
staleness mode: it is either present or absent.

## Components

### 1. `app/tryonMetafield.server.js` (new)

One job: translate a mapping change into a metafield change. HTTP-free apart from the
injected `admin` client, so it is testable the way `models.server.js` is.

```
publishMapping(admin, productGid)    -> metafieldsSet   { namespace: "$app:tryon", key: "enabled", type: "boolean", value: "true" }
unpublishMapping(admin, productGid)  -> metafieldsDelete same identity
```

- Both throw a tagged error (`errors.server.js` `tagged()`, matching existing style) when
  the mutation returns `userErrors`.
- `unpublishMapping` treats a missing product or missing metafield as success — unmapping
  a product the merchant already deleted must not fail.

### 2. `app/routes/app.models.jsx` — action

- `intent === 'map'`: after `mapProductToModel(...)` succeeds, call `publishMapping`.
- `intent === 'unmap'`: after the `deleteMany`, call `unpublishMapping`.

Ordering is deliberate: the database write is the source of truth and commits first; the
metafield is a derived projection of it.

### 3. `app/routes/app.models.jsx` — loader (backfill / self-heal)

Every mapping that exists today predates this feature and has no metafield. Shipping only
the write-on-map would blank the button on products that currently work, including the
live Gripz mappings.

The loader already fetches the mapped products through `fetchProductsByIds` for display.
Extend that query to also return the metafield, and re-publish any mapping whose metafield
is missing.

This is self-healing rather than a one-shot migration: it also repairs a merchant who
deletes the metafield by hand from the admin, and it needs no separate script or deploy
step. Its cost is that a merchant must open the Models page once after the update for
existing mappings to light up.

Backfill failures are logged and swallowed — the same treatment the loader already gives
`fetchProductsByIds`, for the same reason: a Shopify API hiccup must not take down the
admin page.

### 4. `app/products.server.js`

Add to `PRODUCTS_QUERY`:

```graphql
metafield(namespace: "$app:tryon", key: "enabled") { value }
```

and surface it on the returned record so the loader can detect drift.

### 5. `extensions/tryon-button/blocks/tryon_button.liquid`

Wrap the block's entire output — markup, `<script>`, and `<style>` — in the check. A
hidden block must emit nothing at all, not an empty styled container.

```liquid
{% assign tryon_enabled = block.settings.product.metafields["$app:tryon"].enabled.value %}
{% if tryon_enabled %}
  ...existing block...
{% elsif request.design_mode %}
  <div class="ar-tryon__unmapped" {{ block.shopify_attributes }}>
    AR Try-On: no model is mapped to this product yet. Map one in the AR Try-on app,
    then reload the editor.
  </div>
{% endif %}
```

`request.design_mode` is true only inside the theme editor. Without that branch a
merchant who adds the block to an unmapped product sees empty space and concludes the app
is broken. On the live storefront the `{% elsif %}` never fires and output is empty.

Also reword the `model_url` setting's `info` text. It currently reads "Leave blank to use
the product's mapped model", which now has it backwards: a mapping is required either
way, and this field only overrides which GLB a mapped product loads.

## Error handling

| Failure | Behaviour |
|---|---|
| `metafieldsSet` fails during `map` | Mapping is kept (the config API still serves it). The action returns an error message instead of `{ mapped: true }`, so the merchant sees a failure toast rather than a false success. The loader retries on next visit. |
| `metafieldsDelete` fails during `unmap` | Mapping is already deleted. Return an error message — the stale metafield would leave a button that opens to a 404, so the merchant needs to know. |
| Product deleted in Shopify | `unpublishMapping` swallows not-found. |
| Backfill fails in loader | Logged, page renders normally. |

## Testing

- `test/tryonMetafield.server.test.js` (new) — mocked `admin.graphql`: success path, a
  `userErrors` response throws, delete-on-missing-product resolves.
- Map/unmap action tests extending the existing `test/appModels.unmap.test.js` pattern:
  metafield publish is called with the right product gid; a publish failure surfaces as an
  action error rather than success.
- Loader test: a mapping whose product returns a null metafield triggers a re-publish; one
  with a metafield does not.
- Liquid has no unit-test path. Verified manually on the dev store after
  `shopify app deploy --allow-updates`: mapped product shows the button, unmapped product
  renders nothing, unmapped product in the theme editor shows the note.

## Out of scope

- Auto-adding the block to product templates. Shopify blocks live in templates, not on
  individual products; an app cannot insert a block per product. Hiding on unmapped
  products is the achievable equivalent and is what merchants expect.
- Removing the `model_url` setting or the `registerModelByUrl` endpoint. Both remain, now
  reachable only from a block on a mapped product.
- Any change to the engine, `/api/tryon-config`, or billing gates.

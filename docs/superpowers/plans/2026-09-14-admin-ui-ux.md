# Merchant admin UI/UX redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the embedded merchant admin into Home / Products / Models / Help so a merchant can install the app, get try-on live on a product, and verify it works without support.

**Architecture:** Pure helpers first (status precedence, plan usage, URL builders, proof-of-life recording) as `*.server.js` modules with real unit tests, then the four route files consume them. Today's 420-line `app.models.jsx` splits into `app.products.jsx` (the working surface) and `app.models.jsx` (the asset library). Two additive nullable columns carry the new state. Admin-only: no change to the try-on engine, the theme block, or the calibration pipeline.

**Tech Stack:** React Router 7 (flat file routes), Polaris web components (`s-*`), App Bridge React, Prisma + Postgres (Neon), Vitest, `@gltf-transform/core` (already a dependency), `qrcode` (new).

**Spec:** `docs/superpowers/specs/2026-09-14-admin-ui-ux-design.md`

## Global Constraints

- **Never add `read_themes` or any scope.** Scopes stay exactly `write_products,write_metaobjects,write_metaobject_definitions`. A scope change forces re-auth for every installed merchant.
- **Never attempt camera access in the admin.** Shopify does not set `allow="camera"` on the app iframe; it cannot work. No `getUserMedia`, no `<iframe allow="camera">` in any admin route.
- **No loader may throw a redirect to `/app` or `/app/*`.** `app.jsx` owns the no-subscription screen. A loader redirect caused App Store rejection Ref 127328. On no active plan, return empty data and render nothing gated.
- **`/api/tryon-config` must not call Shopify and must not write per request.** It is effectively edge-cacheable. The only new write is throttled to once per hour per mapping.
- **Plan limits are `PLAN_LIMITS = { Starter: 10, Growth: 40, Pro: Infinity }`** from `app/billing.server.js`. Comped shops (`hasFreeAccess`) are treated as Pro/unlimited.
- **Copy rules:** sentence case, contractions, no "successfully", no exclamation marks, no "please", no "simply/just/easy". Errors say what happened then what to do. Empty states name the space and give a verb.
- **No merchant-facing pipeline jargon** on Home or Products: never `geometric`, `confidence N%`, `needs_manual`, `Needs manual anchor`, `Calibrated`. Those belong on Models only.
- **Tests:** Vitest, `npm test` from `apps/shopify-app`. Files go in `apps/shopify-app/test/*.test.js`. DB-backed tests use a `randomUUID().slice(0,8)` shop tag and clean up in `beforeEach`/`afterAll` — see `test/appIndex.loader.test.js`. There is no React Testing Library; UI is verified through loader/action tests plus explicit manual checks.
- **Testing policy — write the tests this plan specifies and no others.** Each task's tests were chosen because they lock an invariant that would otherwise break silently: the status precedence order, the write throttle, the preview exclusion, plan-cap grandfathering, the cross-shop rename refusal, the delete guard against the `ON DELETE RESTRICT` foreign key. Do not add tests that assert a library's own output format, restate the implementation, or smoke-test an empty list. Do not add a test "for coverage". If a task's specified tests pass and the code is right, the task is done.
- **All commands run from `apps/shopify-app/`** unless stated otherwise. Work happens in the `wt-admin-ux` worktree on branch `feature/admin-ux`.

## File structure

**New files**

| File | Responsibility |
| --- | --- |
| `app/tryonStatus.server.js` | Pure status precedence + label mapping for a mapping row |
| `app/planUsage.server.js` | Plan name, used/limit, unlimited flag, pricing URL |
| `app/adminLinks.server.js` | Theme-editor deep link and preview URL builders |
| `app/components/StatusBadge.jsx` | Renders a status from `tryonStatus.server.js` |
| `app/components/ModelPicker.jsx` | Visual model cards used by the add-try-on modal |
| `app/components/PreviewPanel.jsx` | QR, open-in-tab, mock-head render |
| `app/routes/app.products.jsx` | The working surface: products with try-on |
| `app/routes/models.$assetId.fit-preview[.]glb.jsx` | Serves head+frames merged GLB |
| `prisma/migrations/20260914000000_admin_ux/migration.sql` | Both new columns |

**Modified**

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | `ModelAsset.label`, `ProductMapping.lastSeenLiveAt` |
| `app/tryonConfig.server.js` | Add `recordTryonSeen()` |
| `app/routes/api.tryon-config.jsx` | Call `recordTryonSeen` unless `src=preview` |
| `app/routes/app.jsx` | Nav: Home / Products / Models / Help |
| `app/routes/app._index.jsx` | Real checklist + plan usage |
| `app/routes/app.models.jsx` | Reduced to the library: upload, rename, delete |
| `app/routes/app.additional.jsx` | Troubleshooting-led Help |
| `app/billing.server.js` | Export `pricingUrlFor(shop)` (extracted from `app.jsx`) |

---

## Phase A — data and pure helpers

### Task 1: Schema and migration for the two new columns

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260914000000_admin_ux/migration.sql`

**Interfaces:**
- Produces: `ModelAsset.label: string | null`, `ProductMapping.lastSeenLiveAt: Date | null`

- [ ] **Step 1: Add the columns to the schema**

In `prisma/schema.prisma`, inside `model ModelAsset` add after `filename`:

```prisma
  label       String?
```

Inside `model ProductMapping` add after `createdAt`:

```prisma
  lastSeenLiveAt DateTime?
```

- [ ] **Step 2: Write the migration SQL**

Create `prisma/migrations/20260914000000_admin_ux/migration.sql`:

```sql
-- A merchant-supplied name for a model. Display falls back to `filename`, then
-- to a short id. Nullable: every existing row keeps its current label.
ALTER TABLE "ModelAsset" ADD COLUMN "label" TEXT;

-- Last time the try-on engine fetched config for THIS product. Per-mapping, not
-- per-shop: a per-shop timestamp would mark every product live as soon as any
-- one product was used, hiding a broken product from the merchant. Null means
-- "never seen working", which is the correct starting state for existing rows.
ALTER TABLE "ProductMapping" ADD COLUMN "lastSeenLiveAt" TIMESTAMP(3);
```

- [ ] **Step 3: Apply and regenerate**

Run: `npx prisma migrate deploy && npx prisma generate`
Expected: both statements apply, client regenerates with no error.

- [ ] **Step 4: Verify the existing suite still passes**

Run: `npm test`
Expected: PASS. Both columns are additive and nullable, so nothing existing changes.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260914000000_admin_ux
git commit -m "feat(db): add ModelAsset.label and ProductMapping.lastSeenLiveAt"
```

---

### Task 2: Status precedence helper

The single source of truth for what a merchant sees about a product. Pure, so it is cheap to test exhaustively.

**Files:**
- Create: `app/tryonStatus.server.js`
- Test: `test/tryonStatus.server.test.js`

**Interfaces:**
- Produces: `productStatus(mapping) -> { id, label, tone }` where `id` is one of `'check_fit' | 'not_on_theme' | 'live'` and `tone` is a Polaris badge tone (`'warning' | 'success'`). `mapping` is a `ProductMapping` row with `modelAsset` included.

- [ ] **Step 1: Write the failing test**

Create `test/tryonStatus.server.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { productStatus } from '../app/tryonStatus.server.js'

const seen = new Date('2026-09-01T00:00:00Z')
const ready = { status: 'ready', confidence: 0.9 }

describe('productStatus', () => {
  it('is live when calibrated and seen working', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: ready }))
      .toMatchObject({ id: 'live', tone: 'success' })
  })

  it('is not-on-theme when never seen', () => {
    expect(productStatus({ lastSeenLiveAt: null, modelAsset: ready }))
      .toMatchObject({ id: 'not_on_theme', tone: 'warning' })
  })

  it('is check-fit when the model needs a manual anchor', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'needs_manual', confidence: 0.9 } }))
      .toMatchObject({ id: 'check_fit' })
  })

  it('is check-fit when confidence is low', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'ready', confidence: 0.4 } }))
      .toMatchObject({ id: 'check_fit' })
  })

  // Precedence: a fit problem outranks an install problem. A merchant who fixes
  // the theme block only to find the glasses sit wrong was sent down the wrong
  // path first.
  it('prefers check-fit over not-on-theme when both apply', () => {
    expect(productStatus({ lastSeenLiveAt: null, modelAsset: { status: 'needs_manual', confidence: 0.4 } }))
      .toMatchObject({ id: 'check_fit' })
  })

  it('treats unknown confidence as acceptable', () => {
    expect(productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'ready', confidence: null } }))
      .toMatchObject({ id: 'live' })
  })

  it('never leaks pipeline words in the label', () => {
    const labels = [
      productStatus({ lastSeenLiveAt: seen, modelAsset: ready }).label,
      productStatus({ lastSeenLiveAt: null, modelAsset: ready }).label,
      productStatus({ lastSeenLiveAt: seen, modelAsset: { status: 'needs_manual' } }).label,
    ].join(' ').toLowerCase()
    for (const word of ['geometric', 'confidence', 'anchor', 'calibrat', 'needs_manual']) {
      expect(labels).not.toContain(word)
    }
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/tryonStatus.server.test.js`
Expected: FAIL — cannot resolve `../app/tryonStatus.server.js`.

- [ ] **Step 3: Implement the helper**

Create `app/tryonStatus.server.js`:

```js
// The one place that decides what a merchant is told about a product. Pure, and
// deliberately the only module allowed to turn pipeline state into merchant
// words -- Home and Products must never read `status` or `confidence` directly.

// Below this, the geometric fit is uncertain enough that a merchant should look
// at it before trusting the result on a customer's face.
export const LOW_CONFIDENCE = 0.6

/**
 * @param {{ lastSeenLiveAt: Date|null, modelAsset: { status: string, confidence?: number|null } }} mapping
 * @returns {{ id: 'check_fit'|'not_on_theme'|'live', label: string, tone: 'warning'|'success' }}
 */
export function productStatus(mapping) {
  const asset = mapping.modelAsset ?? {}
  const lowConfidence = typeof asset.confidence === 'number' && asset.confidence < LOW_CONFIDENCE

  // Order is load-bearing; see the precedence test.
  if (asset.status !== 'ready' || lowConfidence) {
    return { id: 'check_fit', label: 'Check fit', tone: 'warning' }
  }
  if (!mapping.lastSeenLiveAt) {
    return { id: 'not_on_theme', label: 'Not on your theme yet', tone: 'warning' }
  }
  return { id: 'live', label: 'Live', tone: 'success' }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/tryonStatus.server.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/tryonStatus.server.js test/tryonStatus.server.test.js
git commit -m "feat(admin): add merchant-facing product status precedence"
```

---

### Task 3: Plan usage helper

**Files:**
- Create: `app/planUsage.server.js`
- Modify: `app/billing.server.js`
- Test: `test/planUsage.server.test.js`

**Interfaces:**
- Consumes: `planLimit(name)` from `app/billing.server.js`
- Produces: `pricingUrlFor(shop)` exported from `app/billing.server.js`; `planUsage({ planName, used, shop }) -> { planName, used, limit, unlimited, atLimit, pricingUrl }`

- [ ] **Step 1: Write the failing test**

Create `test/planUsage.server.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { planUsage } from '../app/planUsage.server.js'

const shop = 'demo-shop.myshopify.com'

describe('planUsage', () => {
  it('reports used against the plan limit', () => {
    expect(planUsage({ planName: 'Starter', used: 4, shop }))
      .toMatchObject({ planName: 'Starter', used: 4, limit: 10, unlimited: false, atLimit: false })
  })

  it('flags being at the limit', () => {
    expect(planUsage({ planName: 'Starter', used: 10, shop })).toMatchObject({ atLimit: true })
  })

  it('treats an unlimited plan as unlimited with no upgrade prompt', () => {
    const usage = planUsage({ planName: 'Pro', used: 99, shop })
    expect(usage).toMatchObject({ unlimited: true, atLimit: false })
    expect(usage.pricingUrl).toBeNull()
  })

  it('offers a pricing URL on a capped plan', () => {
    expect(planUsage({ planName: 'Growth', used: 1, shop }).pricingUrl).toContain('/charges/')
  })

  // Comped shops need no special case here: getActivePlanName already returns
  // 'Pro' for them, so they arrive as an unlimited plan like any other. Do not
  // add a `comped` parameter -- it would be a branch that cannot be reached.
  it('reports zero limit for an unknown plan name', () => {
    // planLimit fails closed on a dashboard/code name mismatch.
    expect(planUsage({ planName: 'Mystery', used: 0, shop })).toMatchObject({ limit: 0, atLimit: true })
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/planUsage.server.test.js`
Expected: FAIL — cannot resolve `../app/planUsage.server.js`.

- [ ] **Step 3: Extract the pricing URL builder into billing.server.js**

`app/routes/app.jsx` currently builds this inline. Move it so both the layout and the usage helper use one implementation. Add to the end of `app/billing.server.js`:

```js
/**
 * Managed Pricing page for a shop. Not embeddable -- callers must open it
 * top-level (target="_top"), never inside the app iframe.
 * @param {string} shop myshopify domain
 * @returns {string}
 */
export function pricingUrlFor(shop) {
  const store = String(shop).replace(/\.myshopify\.com$/, '')
  // eslint-disable-next-line no-undef
  const handle = process.env.SHOPIFY_APP_HANDLE || ''
  return `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`
}
```

- [ ] **Step 4: Implement the usage helper**

Create `app/planUsage.server.js`:

```js
import { planLimit, pricingUrlFor } from './billing.server.js'

/**
 * What the merchant is told about their plan. Unlimited plans get no meter and
 * no upgrade prompt -- there is nothing to upgrade to.
 *
 * Comped shops need no special case: getActivePlanName already returns 'Pro'
 * for them, so they arrive here as an unlimited plan like any other.
 * @param {{ planName: string|null, used: number, shop: string }} input
 */
export function planUsage({ planName, used, shop }) {
  const limit = planLimit(planName)
  const unlimited = !Number.isFinite(limit)
  return {
    planName,
    used,
    limit,
    unlimited,
    atLimit: !unlimited && used >= limit,
    pricingUrl: unlimited ? null : pricingUrlFor(shop),
  }
}
```

- [ ] **Step 5: Point app.jsx at the shared builder**

In `app/routes/app.jsx`, replace the inline URL construction in the loader with the import. Change the import line to add `pricingUrlFor`:

```js
import { getActivePlanName, pricingUrlFor } from "../billing.server";
```

and replace the body of the `if (!activePlan)` block with:

```js
  if (!activePlan) {
    pricingUrl = pricingUrlFor(session.shop);
  }
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `npx vitest run test/planUsage.server.test.js test/billing.server.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/planUsage.server.js app/billing.server.js app/routes/app.jsx test/planUsage.server.test.js
git commit -m "feat(admin): add plan usage helper and share the pricing URL builder"
```

---

### Task 4: Theme deep link and preview URL builders

**Files:**
- Create: `app/adminLinks.server.js`
- Test: `test/adminLinks.server.test.js`

**Interfaces:**
- Produces: `themeEditorUrl(shop) -> string`, `previewUrl({ engineUrl, shop, productId, gscale }) -> string`
- `THEME_EXTENSION_UID` is read from `process.env.SHOPIFY_THEME_EXTENSION_UID`, falling back to the uid committed in `extensions/tryon-button/shopify.extension.toml`.

- [ ] **Step 1: Write the failing test**

Create `test/adminLinks.server.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { themeEditorUrl, previewUrl } from '../app/adminLinks.server.js'

describe('themeEditorUrl', () => {
  it('targets the product template on the current theme', () => {
    const url = new URL(themeEditorUrl('demo-shop.myshopify.com'))
    expect(url.host).toBe('admin.shopify.com')
    expect(url.pathname).toBe('/store/demo-shop/themes/current/editor')
    expect(url.searchParams.get('template')).toBe('product')
    expect(url.searchParams.get('target')).toBe('mainSection')
    expect(url.searchParams.get('addAppBlockId')).toMatch(/\/tryon_button$/)
  })

})

describe('previewUrl', () => {
  const base = {
    engineUrl: 'https://ar-sunglasses-tryon.vercel.app/tryon/index.html',
    shop: 'demo-shop.myshopify.com',
    productId: 'gid://shopify/Product/123',
  }

  it('carries shop and product', () => {
    const url = new URL(previewUrl(base))
    expect(url.searchParams.get('shop')).toBe('demo-shop.myshopify.com')
    expect(url.searchParams.get('productId')).toBe('gid://shopify/Product/123')
  })

  // Load-bearing: without this marker a merchant previewing their own product
  // would mark it "live" and complete the theme step with no block installed.
  it('always marks itself as preview traffic', () => {
    expect(new URL(previewUrl(base)).searchParams.get('src')).toBe('preview')
  })

})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/adminLinks.server.test.js`
Expected: FAIL — cannot resolve `../app/adminLinks.server.js`.

- [ ] **Step 3: Implement the builders**

Create `app/adminLinks.server.js`:

```js
// The uid committed in extensions/tryon-button/shopify.extension.toml. Override
// with SHOPIFY_THEME_EXTENSION_UID if the deployed registration id turns out to
// differ from the CLI uid -- see the spec's risk note.
const FALLBACK_EXTENSION_UID = '53b5dfb4-3bb4-0954-72aa-7e751170befc5b13a1dd'
const BLOCK_HANDLE = 'tryon_button'

function extensionUid() {
  // eslint-disable-next-line no-undef
  return process.env.SHOPIFY_THEME_EXTENSION_UID || FALLBACK_EXTENSION_UID
}

/**
 * Deep link to the theme editor with the try-on block pre-inserted into the
 * product template. Not embeddable: open top-level (target="_top"), the same
 * reason app.jsx opens the Managed Pricing URL that way.
 * @param {string} shop myshopify domain
 */
export function themeEditorUrl(shop) {
  const store = String(shop).replace(/\.myshopify\.com$/, '')
  const url = new URL(`https://admin.shopify.com/store/${store}/themes/current/editor`)
  url.searchParams.set('template', 'product')
  url.searchParams.set('addAppBlockId', `${extensionUid()}/${BLOCK_HANDLE}`)
  url.searchParams.set('target', 'mainSection')
  return url.toString()
}

/**
 * The try-on engine, pointed at one product. src=preview marks this as merchant
 * traffic so api.tryon-config excludes it from the proof-of-life signal.
 * @param {{ engineUrl: string, shop: string, productId: string, gscale?: number }} input
 */
export function previewUrl({ engineUrl, shop, productId, gscale }) {
  const url = new URL(engineUrl)
  url.searchParams.set('shop', shop)
  url.searchParams.set('productId', productId)
  url.searchParams.set('src', 'preview')
  if (gscale != null) url.searchParams.set('gscale', String(gscale))
  return url.toString()
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/adminLinks.server.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add app/adminLinks.server.js test/adminLinks.server.test.js
git commit -m "feat(admin): add theme deep link and preview URL builders"
```

---

### Task 5: Record proof of life on the config endpoint

**Files:**
- Modify: `app/tryonConfig.server.js`
- Modify: `app/routes/api.tryon-config.jsx`
- Test: `test/tryonSeen.server.test.js`
- Test: `test/tryonConfig.route.test.js` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `recordTryonSeen(prisma, shop, productId, now?) -> Promise<boolean>` — resolves `true` if it wrote, `false` if throttled or the mapping is missing.

- [ ] **Step 1: Write the failing test**

Create `test/tryonSeen.server.test.js`:

```js
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { recordTryonSeen, SEEN_THROTTLE_MS } from '../app/tryonConfig.server.js'

const tag = randomUUID().slice(0, 8)
const shop = `seen-${tag}.myshopify.com`
const productId = `gid://shopify/Product/${tag}`

const prisma = (await import('../app/db.server.js')).default

let assetId
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  assetId = asset.id
  await prisma.productMapping.create({ data: { shop, productId, modelAssetId: assetId } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

const read = () =>
  prisma.productMapping.findUnique({ where: { shop_productId: { shop, productId } } })

describe('recordTryonSeen', () => {
  it('stamps a mapping that has never been seen', async () => {
    const now = new Date('2026-09-14T12:00:00Z')
    expect(await recordTryonSeen(prisma, shop, productId, now)).toBe(true)
    expect((await read()).lastSeenLiveAt.toISOString()).toBe(now.toISOString())
  })

  // This endpoint is effectively edge-cacheable and must not take a write per
  // try-on open.
  it('does not write again inside the throttle window', async () => {
    const first = new Date('2026-09-14T12:00:00Z')
    await recordTryonSeen(prisma, shop, productId, first)
    const soon = new Date(first.getTime() + SEEN_THROTTLE_MS - 1000)
    expect(await recordTryonSeen(prisma, shop, productId, soon)).toBe(false)
    expect((await read()).lastSeenLiveAt.toISOString()).toBe(first.toISOString())
  })

  it('writes again once the window has passed', async () => {
    const first = new Date('2026-09-14T12:00:00Z')
    await recordTryonSeen(prisma, shop, productId, first)
    const later = new Date(first.getTime() + SEEN_THROTTLE_MS + 1000)
    expect(await recordTryonSeen(prisma, shop, productId, later)).toBe(true)
    expect((await read()).lastSeenLiveAt.toISOString()).toBe(later.toISOString())
  })

  it('is a no-op for an unmapped product', async () => {
    expect(await recordTryonSeen(prisma, shop, 'gid://shopify/Product/absent')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/tryonSeen.server.test.js`
Expected: FAIL — `recordTryonSeen` is not exported.

- [ ] **Step 3: Implement the recorder**

Append to `app/tryonConfig.server.js`:

```js
// One hour. This route is hit on every try-on open and is documented as never
// calling Shopify; a write per request would turn an edge-cacheable read into a
// database round trip on the storefront's hot path.
export const SEEN_THROTTLE_MS = 60 * 60 * 1000

/**
 * Record that the engine fetched config for this product -- proof the theme
 * block is installed and working. Per-mapping, not per-shop: a per-shop stamp
 * would mark every product live as soon as any one was used.
 *
 * Best-effort by contract: callers must not let a failure here fail the
 * response. Returns whether it actually wrote.
 * @returns {Promise<boolean>}
 */
export async function recordTryonSeen(prisma, shop, productId, now = new Date()) {
  const mapping = await prisma.productMapping.findUnique({
    where: { shop_productId: { shop, productId } },
    select: { id: true, lastSeenLiveAt: true },
  })
  if (!mapping) return false
  if (mapping.lastSeenLiveAt && now.getTime() - mapping.lastSeenLiveAt.getTime() < SEEN_THROTTLE_MS) {
    return false
  }
  await prisma.productMapping.update({
    where: { id: mapping.id },
    data: { lastSeenLiveAt: now },
  })
  return true
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/tryonSeen.server.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing route test for the preview exclusion**

Append to `test/tryonConfig.route.test.js`, inside the existing `describe('GET /api/tryon-config')`:

```js
  it('does not record proof of life for preview traffic', async () => {
    const seen = []
    vi.doMock('../app/tryonConfig.server.js', async (orig) => ({
      ...(await orig()),
      recordTryonSeen: async (_p, shop, productId) => { seen.push([shop, productId]); return true },
    }))
    vi.resetModules()
    const mod = await import('../app/routes/api.tryon-config.jsx')
    await mod.loader({
      request: new Request(
        'https://app.test/api/tryon-config?shop=s.myshopify.com&productId=gid%3A%2F%2Fshopify%2FProduct%2F1&src=preview',
      ),
    })
    expect(seen).toHaveLength(0)
    vi.doUnmock('../app/tryonConfig.server.js')
    vi.resetModules()
  })
```

- [ ] **Step 6: Run it to make sure it fails**

Run: `npx vitest run test/tryonConfig.route.test.js`
Expected: PASS — but for the wrong reason, since the route does not call `recordTryonSeen` yet. That is expected here; step 7 wires the call, and the test then guards the real exclusion. Do not spend time trying to make this one fail first.

- [ ] **Step 7: Wire the route**

In `app/routes/api.tryon-config.jsx`, change the import line:

```js
import { getTryonConfig, recordTryonSeen } from '../tryonConfig.server'
```

Then, immediately before the final `return Response.json(cfg)`, insert:

```js
  // Proof of life: reaching here means the block is installed, the product is
  // mapped, and the subscription is servable. Merchant previews carry
  // src=preview and are excluded -- otherwise previewing your own product would
  // report a theme block that was never installed.
  if (url.searchParams.get('src') !== 'preview') {
    try {
      await recordTryonSeen(db, shop, productId)
    } catch (e) {
      // Never fail the storefront's config fetch over a bookkeeping write.
      console.error('recordTryonSeen failed', e)
    }
  }
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS. Confirm `test/tryonConfig.billing.test.js` still passes — the billing gate still runs before this code.

- [ ] **Step 9: Commit**

```bash
git add app/tryonConfig.server.js app/routes/api.tryon-config.jsx test/tryonSeen.server.test.js test/tryonConfig.route.test.js
git commit -m "feat(tryon): record per-product proof of life, excluding merchant previews"
```

---

## Phase B — Home

### Task 6: Home checklist and plan usage

**Files:**
- Modify: `app/routes/app._index.jsx`
- Test: `test/appIndex.loader.test.js` (extend)

**Interfaces:**
- Consumes: `planUsage` (Task 3), `themeEditorUrl` (Task 4)
- Produces: loader returns `{ modelCount, mappingCount, liveCount, usage, themeUrl }`

- [ ] **Step 1: Write the failing test**

Append to `test/appIndex.loader.test.js`, inside the existing describe:

```js
  it('reports plan usage and a theme link', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/u.glb`, fitMetadata: {} } })
    await prisma.productMapping.create({ data: { shop, productId: `gid://shopify/Product/${tag}-u`, modelAssetId: asset.id } })

    const result = await loader({ request: new Request('https://x/app') })
    expect(result.usage).toMatchObject({ used: 1, unlimited: true })
    expect(result.themeUrl).toContain('addAppBlockId')
  })

  it('counts a product as live only once it has been seen working', async () => {
    const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/l.glb`, fitMetadata: {} } })
    const pid = `gid://shopify/Product/${tag}-l`
    await prisma.productMapping.create({ data: { shop, productId: pid, modelAssetId: asset.id } })
    expect((await loader({ request: new Request('https://x/app') })).liveCount).toBe(0)

    await prisma.productMapping.update({
      where: { shop_productId: { shop, productId: pid } },
      data: { lastSeenLiveAt: new Date() },
    })
    expect((await loader({ request: new Request('https://x/app') })).liveCount).toBe(1)
  })
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/appIndex.loader.test.js`
Expected: FAIL — `result.usage` is undefined.

- [ ] **Step 3: Extend the loader**

In `app/routes/app._index.jsx`, replace the import block and loader with:

```jsx
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { getActivePlanName } from "../billing.server";
import { planUsage } from "../planUsage.server";
import { themeEditorUrl } from "../adminLinks.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  // The app.jsx layout owns the no-subscription screen and hides this route's
  // content, so this loader must NOT throw its own redirect: a /app -> /app
  // redirect loops forever and renders a dead, control-less page (App Store
  // rejection Ref 127328). On no plan, do no gated DB work and return zeros.
  const activePlan = await getActivePlanName(admin, session.shop);
  const themeUrl = themeEditorUrl(session.shop);
  if (!activePlan) {
    return {
      modelCount: 0,
      mappingCount: 0,
      liveCount: 0,
      usage: planUsage({ planName: null, used: 0, shop: session.shop }),
      themeUrl,
    };
  }
  const [modelCount, mappingCount, liveCount] = await Promise.all([
    prisma.modelAsset.count({ where: { shop: session.shop } }),
    prisma.productMapping.count({ where: { shop: session.shop } }),
    prisma.productMapping.count({ where: { shop: session.shop, lastSeenLiveAt: { not: null } } }),
  ]);
  return {
    modelCount,
    mappingCount,
    liveCount,
    usage: planUsage({ planName: activePlan, used: mappingCount, shop: session.shop }),
    themeUrl,
  };
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run test/appIndex.loader.test.js`
Expected: PASS.

- [ ] **Step 5: Replace the page body**

In the same file, replace the `Index` component with:

```jsx
export default function Index() {
  const { modelCount, mappingCount, liveCount, usage, themeUrl } = useLoaderData();
  const steps = [
    { done: modelCount > 0, text: "Upload a model", note: modelCount > 0 ? `${modelCount} uploaded` : null },
    { done: mappingCount > 0, text: "Add try-on to a product", note: mappingCount > 0 ? `${mappingCount} products` : null },
    { done: liveCount > 0, text: "Add the button to your theme", note: null },
  ];
  const doneCount = steps.filter((s) => s.done).length;

  return (
    <s-page heading="AR Try-on">
      <s-button slot="primary-action" href="/app/products">Go to products</s-button>

      <s-section heading="Set up try-on">
        <s-paragraph>{doneCount} of 3 done</s-paragraph>
        <s-stack direction="block" gap="base">
          {steps.map((step) => (
            <s-stack key={step.text} direction="inline" gap="base" alignItems="center">
              <s-badge tone={step.done ? "success" : "neutral"} icon={step.done ? "check-circle" : "circle"}>
                {step.done ? "Done" : "To do"}
              </s-badge>
              <s-text>{step.text}</s-text>
              {step.note && <s-text tone="subdued">{step.note}</s-text>}
            </s-stack>
          ))}
        </s-stack>
        {liveCount === 0 && (
          // Top-level: the theme editor is an admin URL and cannot be embedded
          // in this app's iframe, the same reason app.jsx breaks out for pricing.
          <s-paragraph>
            <a href={themeUrl} target="_top" rel="noreferrer">Add to theme</a>
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Your plan">
        <s-stack direction="block" gap="small-500">
          <s-text type="strong">{usage.planName ?? "No plan"}</s-text>
          {usage.unlimited ? (
            <s-text tone="subdued">{usage.used} products using try-on</s-text>
          ) : (
            <>
              <s-text tone="subdued">{usage.used} of {usage.limit} products using try-on</s-text>
              {usage.pricingUrl && (
                <s-paragraph>
                  <a href={usage.pricingUrl} target="_top" rel="noreferrer">
                    {usage.atLimit ? "Upgrade to add more products" : "Change plan"}
                  </a>
                </s-paragraph>
              )}
            </>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Support">
        <s-paragraph><s-link href="/privacy" target="_blank">Privacy policy</s-link></s-paragraph>
        <s-paragraph>
          Questions or issues? Reach out at{" "}
          <s-link href="mailto:ramy.sameh2@gmail.com">ramy.sameh2@gmail.com</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
```

- [ ] **Step 6: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 7: Commit**

```bash
git add app/routes/app._index.jsx test/appIndex.loader.test.js
git commit -m "feat(admin): make the setup checklist complete and show plan usage"
```

---

## Phase C — Products

### Task 7: The Products route

Split the mappings table out of `app.models.jsx` into its own route. This task moves the read path and the unmap action only; adding try-on comes next.

**Files:**
- Create: `app/routes/app.products.jsx`
- Create: `app/components/StatusBadge.jsx`
- Modify: `app/routes/app.jsx`
- Test: `test/appProducts.loader.test.js`

**Interfaces:**
- Consumes: `productStatus` (Task 2), `themeEditorUrl`/`previewUrl` (Task 4), `listMappings` from `app/models.server.js`, `fetchProductsByIds` from `app/products.server.js`, `publishMappings`/`unpublishMapping` from `app/tryonMetafield.server.js`
- Produces: route `/app/products`; loader returns `{ mappings, themeUrl, engineUrl }` where each mapping carries `product` and `status`

- [ ] **Step 1: Write the failing test**

Create `test/appProducts.loader.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `prod-${tag}.myshopify.com`

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
        })),
      },
    }),
  },
}))
// Metafield sync and product enrichment are Shopify round trips; the loader
// treats both as best-effort and this route's own logic is what is under test.
vi.mock('../app/tryonMetafield.server.js', () => ({
  publishMappings: async () => {},
  publishMapping: async () => {},
  unpublishMapping: async () => {},
}))
vi.mock('../app/products.server.js', () => ({ fetchProductsByIds: async () => new Map() }))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app.products.jsx')

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('app.products loader', () => {
  it('attaches a merchant-facing status to each mapping', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop, storageRef: `${tag}/a.glb`, fitMetadata: {}, status: 'ready', confidence: 0.9 },
    })
    await prisma.productMapping.create({
      data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: asset.id },
    })

    const result = await loader({ request: new Request('https://x/app/products') })
    expect(result.mappings).toHaveLength(1)
    expect(result.mappings[0].status).toMatchObject({ id: 'not_on_theme' })
  })

})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/appProducts.loader.test.js`
Expected: FAIL — cannot resolve `../app/routes/app.products.jsx`.

- [ ] **Step 3: Add the status badge component**

Create `app/components/StatusBadge.jsx`:

```jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */

// Renders whatever tryonStatus.server.js decided. Deliberately dumb: the
// precedence rules live in one tested module, not spread across routes.
export default function StatusBadge({ status }) {
  return <s-badge tone={status.tone}>{status.label}</s-badge>;
}
```

- [ ] **Step 4: Create the route**

Create `app/routes/app.products.jsx`:

```jsx
import { useEffect } from 'react'
import { useFetcher, useLoaderData } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import { boundary } from '@shopify/shopify-app-react-router/server'
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { listMappings } from '../models.server'
import { publishMappings, unpublishMapping } from '../tryonMetafield.server'
import { getActivePlanName } from '../billing.server'
import { fetchProductsByIds } from '../products.server'
import { productStatus } from '../tryonStatus.server'
import { themeEditorUrl, previewUrl } from '../adminLinks.server'
import StatusBadge from '../components/StatusBadge'

// eslint-disable-next-line no-undef
const ENGINE_URL = process.env.TRYON_ENGINE_URL
  // eslint-disable-next-line no-undef
  || `${process.env.SHOPIFY_APP_URL || ''}/tryon/index.html`

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  const themeUrl = themeEditorUrl(session.shop)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328). Return empty and do no gated work.
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { mappings: [], themeUrl, engineUrl: ENGINE_URL }
  }
  const mappings = await listMappings(prisma, session.shop)
  // Self-heal: mappings made before the storefront gate existed have no
  // metafield, so their block would go dark. Re-publishing is idempotent and
  // batched. Best-effort -- a Shopify failure must not take down the page.
  try {
    await publishMappings(admin, mappings.map((m) => m.productId))
  } catch (e) {
    console.error('try-on metafield sync failed', e)
  }
  let products = new Map()
  try {
    products = await fetchProductsByIds(admin, mappings.map((m) => m.productId))
  } catch (e) {
    console.error('product enrichment failed', e)
  }
  return {
    mappings: mappings.map((m) => ({
      ...m,
      product: products.get(m.productId) ?? null,
      status: productStatus(m),
    })),
    themeUrl,
    engineUrl: ENGINE_URL,
  }
}

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  const form = await request.formData()
  if (form.get('intent') !== 'unmap') {
    return { error: 'Unknown action.' }
  }
  const productId = form.get('productId')?.toString().trim()
  if (!productId) {
    return { error: 'Missing product to remove.' }
  }
  await prisma.productMapping.deleteMany({ where: { shop: session.shop, productId } })
  // A metafield left behind keeps the block on the page, where it now opens to
  // a 404 from /api/tryon-config -- worse than either end state.
  try {
    await unpublishMapping(admin, productId)
  } catch (e) {
    console.error('try-on metafield unpublish failed', e)
    return { error: "Try-on removed, but it may still show on your storefront. Try again." }
  }
  return { unmapped: true }
}

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

export default function Products() {
  const { mappings, themeUrl, engineUrl } = useLoaderData()
  const unmapFetcher = useFetcher()
  const shopify = useAppBridge()

  useEffect(() => {
    if (unmapFetcher.data?.unmapped) shopify.toast.show('Try-on removed')
    if (unmapFetcher.data?.error) shopify.toast.show(unmapFetcher.data.error, { isError: true })
  }, [unmapFetcher.data, shopify])

  const remove = (productId) => unmapFetcher.submit({ intent: 'unmap', productId }, { method: 'POST' })

  return (
    <s-page heading="Products">
      <s-button slot="primary-action" href="/app/models">Add try-on</s-button>

      <s-section heading="Products with try-on">
        {mappings.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Add try-on to your first product</s-text>
            <s-paragraph>
              Upload a model on the <s-link href="/app/models">Models</s-link> page, then
              pick the product it belongs to.
            </s-paragraph>
          </s-stack>
        ) : (
          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header>Model</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Actions</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {mappings.map((m) => (
                <s-table-row key={m.id}>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500" alignItems="center">
                      {m.product?.imageUrl && (
                        <s-thumbnail src={m.product.imageUrl} alt={m.product.imageAlt ?? m.product.title} size="small"></s-thumbnail>
                      )}
                      <s-text type="strong">{m.product?.title ?? 'Product unavailable'}</s-text>
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>{modelName(m.modelAsset)}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500" alignItems="center">
                      <StatusBadge status={m.status} />
                      {m.status.id === 'not_on_theme' && (
                        <a href={themeUrl} target="_top" rel="noreferrer">Add to theme</a>
                      )}
                    </s-stack>
                  </s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-500">
                      <s-button
                        variant="tertiary"
                        href={previewUrl({ engineUrl, shop: m.shop, productId: m.productId })}
                        target="_blank"
                      >
                        Preview
                      </s-button>
                      <s-button variant="tertiary" tone="critical" icon="delete" onClick={() => remove(m.productId)}>
                        Remove
                      </s-button>
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  )
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs)
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run test/appProducts.loader.test.js`
Expected: PASS, 1 test.

- [ ] **Step 6: Add Products to the nav**

In `app/routes/app.jsx`, replace the `<s-app-nav>` block with:

```jsx
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Products</s-link>
        <s-link href="/app/models">Models</s-link>
        <s-link href="/app/additional">Help</s-link>
      </s-app-nav>
```

- [ ] **Step 7: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 8: Commit**

```bash
git add app/routes/app.products.jsx app/routes/app.jsx app/components/StatusBadge.jsx test/appProducts.loader.test.js
git commit -m "feat(admin): add the Products page with merchant-facing status"
```

---

### Task 8: Add-try-on flow with visual model picking

Replaces today's blind `<s-select>` of filenames. The merchant sees the actual frames before committing.

**Files:**
- Create: `app/components/ModelPicker.jsx`
- Modify: `app/routes/app.products.jsx`
- Test: `test/appProducts.map.test.js`

**Interfaces:**
- Consumes: `mapProductToModel`, `publishMapping`, `planLimit`, `planUsage` (Task 3), `ModelViewer`
- Produces: a `map` intent on the Products action; loader additionally returns `assets` and `usage`

- [ ] **Step 1: Write the failing test**

Create `test/appProducts.map.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `map-${tag}.myshopify.com`

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Starter', status: 'ACTIVE' }] } },
        })),
      },
    }),
  },
}))
vi.mock('../app/tryonMetafield.server.js', () => ({
  publishMappings: async () => {},
  publishMapping: async () => {},
  unpublishMapping: async () => {},
}))
vi.mock('../app/products.server.js', () => ({ fetchProductsByIds: async () => new Map() }))

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/app.products.jsx')

const post = (fields) =>
  action({ request: new Request('https://x/app/products', { method: 'POST', body: new URLSearchParams(fields) }) })

let assetId
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  assetId = asset.id
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('app.products map action', () => {
  it('maps a product to a model', async () => {
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}`, modelAssetId: assetId })
    expect(res).toMatchObject({ mapped: true })
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(1)
  })

  it('enforces the plan cap for a new product', async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}-new`, modelAssetId: assetId })
    expect(res.error).toMatch(/limit/i)
  })

  // Grandfathering: re-pointing an existing product at a different model is not
  // a new product and must work even at the cap.
  it('allows re-mapping an existing product at the cap', async () => {
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await post({ intent: 'map', productId: `gid://shopify/Product/${tag}-0`, modelAssetId: assetId })
    expect(res).toMatchObject({ mapped: true })
  })

})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/appProducts.map.test.js`
Expected: FAIL — the action returns `{ error: 'Unknown action.' }` for `map`.

- [ ] **Step 3: Extend the loader to carry assets and usage**

In `app/routes/app.products.jsx`, add these imports:

```js
import { listMappings, mapProductToModel } from '../models.server'
import { publishMapping, publishMappings, unpublishMapping } from '../tryonMetafield.server'
import { getActivePlanName, planLimit } from '../billing.server'
import { planUsage } from '../planUsage.server'
import ModelPicker from '../components/ModelPicker'
```

(replacing the existing `listMappings`, `tryonMetafield` and `billing` import lines).

In the loader, replace the no-plan early return with:

```js
  if (!activePlan) {
    return {
      mappings: [],
      assets: [],
      usage: planUsage({ planName: null, used: 0, shop: session.shop }),
      themeUrl,
      engineUrl: ENGINE_URL,
    }
  }
```

Replace the `const mappings = await listMappings(...)` line with:

```js
  const [mappings, assets] = await Promise.all([
    listMappings(prisma, session.shop),
    prisma.modelAsset.findMany({ where: { shop: session.shop }, orderBy: { createdAt: 'desc' } }),
  ])
```

and add to the returned object, after `mappings`:

```js
    assets,
    usage: planUsage({ planName: activePlan, used: mappings.length, shop: session.shop }),
```

- [ ] **Step 4: Add the map intent to the action**

In the same file, replace the `if (form.get('intent') !== 'unmap')` guard with an intent switch. Insert before the unmap handling:

```js
  const intent = form.get('intent')

  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Pick a product and a model.' }
    }
    // Grandfather existing: only a genuinely NEW product counts against the cap.
    // mapProductToModel upserts on (shop, productId), so a re-map is not new.
    const existing = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop: session.shop, productId } },
    })
    if (!existing) {
      const limit = planLimit(activePlan)
      const count = await prisma.productMapping.count({ where: { shop: session.shop } })
      if (count >= limit) {
        return { error: "You've reached your plan's product limit. Upgrade to add try-on to more products." }
      }
    }
    await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    // The mapping is committed; now project it onto the storefront. The block
    // renders only where this metafield exists, so a failure here means a
    // mapping visible in the admin but not on the product page.
    try {
      await publishMapping(admin, productId)
    } catch (e) {
      console.error('try-on metafield publish failed', e)
      return { error: "Added, but try-on couldn't be turned on for your storefront. Try again." }
    }
    return { mapped: true }
  }

  if (intent !== 'unmap') {
    return { error: 'Unknown action.' }
  }
```

and delete the old `if (form.get('intent') !== 'unmap') { return { error: 'Unknown action.' } }` lines.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run test/appProducts.map.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Build the visual model picker**

Create `app/components/ModelPicker.jsx`:

```jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import ModelViewer from './ModelViewer'

function modelName(a) {
  return a.label || a.filename || `Model ${a.id.slice(0, 8)}`
}

// The point of this component: a merchant picks the frames they can SEE. The
// old <s-select> of "gripzpelmo.glb - Sep 7" labels asked them to choose blind
// while the previews sat in a different section of the page.
export default function ModelPicker({ assets, value, onChange }) {
  if (assets.length === 0) {
    return (
      <s-paragraph>
        Upload a model first -- then you can add try-on to a product.
      </s-paragraph>
    )
  }
  return (
    <s-grid gridTemplateColumns="1fr 1fr" gap="base">
      {assets.map((a) => (
        <s-box
          key={a.id}
          padding="base"
          borderWidth={value === a.id ? 'large' : 'base'}
          borderRadius="base"
          onClick={() => onChange(a.id)}
        >
          <s-stack direction="block" gap="small-500">
            <ModelViewer src={`/models/${a.id}.glb`} alt={modelName(a)} />
            <s-text type={value === a.id ? 'strong' : undefined}>{modelName(a)}</s-text>
          </s-stack>
        </s-box>
      ))}
    </s-grid>
  )
}
```

- [ ] **Step 7: Wire the modal into the Products page**

In `app/routes/app.products.jsx`, add to the component's state and handlers (inside `export default function Products()`, after the existing `useAppBridge` line):

```jsx
  const mapFetcher = useFetcher()
  const [picked, setPicked] = useState(null)
  const [modelAssetId, setModelAssetId] = useState('')
  const mapError = mapFetcher.data?.error

  useEffect(() => {
    if (mapFetcher.data?.mapped) {
      shopify.toast.show('Try-on added')
      setPicked(null)
      setModelAssetId('')
      document.getElementById('add-tryon')?.hide()
    }
  }, [mapFetcher.data, shopify])

  const pickProduct = async () => {
    const selection = await shopify.resourcePicker({ type: 'product', action: 'select' })
    if (selection && selection[0]) {
      const p = selection[0]
      setPicked({ id: p.id, title: p.title, imageUrl: p.images?.[0]?.originalSrc ?? null })
    }
  }

  const submitMapping = () => {
    if (!picked?.id || !modelAssetId) return
    mapFetcher.submit({ intent: 'map', productId: picked.id, modelAssetId }, { method: 'POST' })
  }
```

Add `useState` to the React import at the top of the file:

```js
import { useEffect, useState } from 'react'
```

Replace the primary action button with a modal opener, and add the modal just inside `<s-page>`:

```jsx
      <s-button slot="primary-action" commandFor="add-tryon" command="show" disabled={usage.atLimit}>
        Add try-on
      </s-button>

      <s-modal id="add-tryon" heading="Add try-on to a product">
        <s-stack direction="block" gap="base">
          {usage.atLimit && (
            <s-banner tone="warning">
              You&apos;re using all {usage.limit} products on your plan.{' '}
              {usage.pricingUrl && <a href={usage.pricingUrl} target="_top" rel="noreferrer">Upgrade</a>} to add more.
            </s-banner>
          )}
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button onClick={pickProduct} icon="product">
              {picked ? 'Change product' : 'Select product'}
            </s-button>
            {picked && (
              <s-stack direction="inline" gap="small-500" alignItems="center">
                {picked.imageUrl && <s-thumbnail src={picked.imageUrl} alt={picked.title} size="small"></s-thumbnail>}
                <s-text type="strong">{picked.title}</s-text>
              </s-stack>
            )}
          </s-stack>
          <ModelPicker assets={assets} value={modelAssetId} onChange={setModelAssetId} />
          {mapError && <s-banner heading="Could not add try-on" tone="critical">{mapError}</s-banner>}
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          onClick={submitMapping}
          {...(mapFetcher.state !== 'idle' ? { loading: true } : {})}
        >
          Add try-on
        </s-button>
      </s-modal>
```

and add `assets` and `usage` to the `useLoaderData()` destructure.

- [ ] **Step 8: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 9: Manual check**

Deploy to the dev store (`npm run deploy`) and confirm on the Products page: the Add try-on modal opens, the model cards render actual 3D previews, selecting one highlights it, and adding creates a row whose status reads "Not on your theme yet".

Note: per `memory/admin-ui-polaris-overhaul`, this app cannot be previewed via `shopify app dev` — the App Store release loads instead of the tunnel. Admin changes must be deployed to be seen.

- [ ] **Step 10: Commit**

```bash
git add app/routes/app.products.jsx app/components/ModelPicker.jsx test/appProducts.map.test.js
git commit -m "feat(admin): add try-on through a modal with visual model picking"
```

---

## Phase D — Models library

### Task 9: Reduce app.models.jsx to the library, with usage counts

**Files:**
- Modify: `app/routes/app.models.jsx`
- Test: `test/appModels.loader.test.js` (update)

**Interfaces:**
- Consumes: nothing new
- Produces: loader returns `{ assets }` where each asset carries `mappingCount`; the map/unmap intents are gone (they live on Products now)

- [ ] **Step 1: Update the existing loader test**

In `test/appModels.loader.test.js`, replace assertions that expect `mappings` with:

```js
    const result = await loader({ request: new Request('https://x/app/models') })
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0].mappingCount).toBe(1)
    expect(result.mappings).toBeUndefined()
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/appModels.loader.test.js`
Expected: FAIL — `mappingCount` is undefined and `mappings` is still returned.

- [ ] **Step 3: Rewrite the loader**

In `app/routes/app.models.jsx`, replace the loader with:

```jsx
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  // app.jsx owns the no-subscription screen; this loader must NOT redirect
  // (App Store rejection Ref 127328).
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { assets: [] }
  }
  const assets = await prisma.modelAsset.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { mappings: true } } },
  })
  return {
    assets: assets.map(({ _count, ...a }) => ({ ...a, mappingCount: _count.mappings })),
  }
}
```

Delete the `listMappings`, `publishMappings`, `publishMapping`, `unpublishMapping`, `fetchProductsByIds` imports and the metafield-sync / product-enrichment blocks — the Products route owns them now.

- [ ] **Step 4: Strip the map and unmap intents from the action**

Replace the action with:

```jsx
export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  const activePlan = await getActivePlanName(admin, session.shop)
  if (!activePlan) {
    return { error: 'No active subscription. Choose a plan to continue.' }
  }
  const form = await request.formData()
  const intent = form.get('intent')

  if (intent === 'rename') {
    const id = form.get('modelAssetId')?.toString()
    const label = form.get('label')?.toString().trim()
    if (!id) return { error: 'Missing model.' }
    // Scoped to the shop: an id from another shop must not be renamable.
    const { count } = await prisma.modelAsset.updateMany({
      where: { id, shop: session.shop },
      data: { label: label || null },
    })
    if (count === 0) return { error: 'That model no longer exists.' }
    return { renamed: true }
  }

  if (intent === 'delete') {
    const id = form.get('modelAssetId')?.toString()
    if (!id) return { error: 'Missing model.' }
    const asset = await prisma.modelAsset.findFirst({
      where: { id, shop: session.shop },
      include: { _count: { select: { mappings: true } } },
    })
    if (!asset) return { error: 'That model no longer exists.' }
    // The FK is ON DELETE RESTRICT, so deleting a mapped model would throw a
    // raw Prisma error. Refuse with something a merchant can act on instead.
    if (asset._count.mappings > 0) {
      return { error: `That model is used by ${asset._count.mappings} product(s). Remove try-on from them first.` }
    }
    await prisma.modelAsset.delete({ where: { id: asset.id } })
    try {
      await deleteModelGlb(asset.storageRef)
    } catch (e) {
      // The row is gone, which is what the merchant asked for. A stranded
      // object is a storage cost, not a user-visible failure.
      console.error('model GLB delete failed', e)
    }
    return { deleted: true }
  }

  // Model upload (presign/finalize) lives in the api.model-upload resource
  // route: a raw fetch() POST here returns the rendered HTML document instead
  // of JSON. See app/routes/api.model-upload.jsx.
  return { error: 'Unknown action.' }
}
```

Add the storage import at the top:

```js
import { deleteModelGlb } from '../storage.server'
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run test/appModels.loader.test.js`
Expected: PASS.

- [ ] **Step 6: Delete the moved tests**

`test/appModels.unmap.test.js`, `test/appModels.metafield.test.js` and `test/appModels.limit.test.js` cover behaviour that now lives on the Products route and is covered by `test/appProducts.map.test.js`. Delete them:

```bash
git rm test/appModels.unmap.test.js test/appModels.metafield.test.js test/appModels.limit.test.js
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS with no orphaned failures.

- [ ] **Step 8: Commit**

```bash
git add app/routes/app.models.jsx test/appModels.loader.test.js
git commit -m "refactor(admin): reduce Models to the asset library with rename and delete"
```

---

### Task 10: Rename and delete in the Models UI

**Files:**
- Modify: `app/routes/app.models.jsx`
- Test: `test/appModels.manage.test.js`

**Interfaces:**
- Consumes: the `rename` and `delete` intents from Task 9

- [ ] **Step 1: Write the failing test**

Create `test/appModels.manage.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `mng-${tag}.myshopify.com`

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
        })),
      },
    }),
  },
}))
vi.mock('../app/storage.server.js', () => ({ deleteModelGlb: async () => {} }))

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/app.models.jsx')

const post = (fields) =>
  action({ request: new Request('https://x/app/models', { method: 'POST', body: new URLSearchParams(fields) }) })

let assetId
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  assetId = asset.id
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('models rename', () => {
  it('stores a merchant-supplied label', async () => {
    expect(await post({ intent: 'rename', modelAssetId: assetId, label: 'Pelmo black' })).toMatchObject({ renamed: true })
    expect((await prisma.modelAsset.findUnique({ where: { id: assetId } })).label).toBe('Pelmo black')
  })


  it('refuses a model from another shop', async () => {
    const other = await prisma.modelAsset.create({
      data: { shop: `other-${tag}.myshopify.com`, storageRef: `${tag}/o.glb`, fitMetadata: {} },
    })
    expect((await post({ intent: 'rename', modelAssetId: other.id, label: 'nope' })).error).toBeTruthy()
    expect((await prisma.modelAsset.findUnique({ where: { id: other.id } })).label).toBeNull()
    await prisma.modelAsset.delete({ where: { id: other.id } })
  })
})

describe('models delete', () => {
  it('deletes an unused model', async () => {
    expect(await post({ intent: 'delete', modelAssetId: assetId })).toMatchObject({ deleted: true })
    expect(await prisma.modelAsset.findUnique({ where: { id: assetId } })).toBeNull()
  })

  // The FK is ON DELETE RESTRICT; without this guard the merchant would get a
  // raw Prisma error, and a live product would be at risk.
  it('refuses to delete a model that products use', async () => {
    await prisma.productMapping.create({
      data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: assetId },
    })
    const res = await post({ intent: 'delete', modelAssetId: assetId })
    expect(res.error).toMatch(/1 product/)
    expect(await prisma.modelAsset.findUnique({ where: { id: assetId } })).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/appModels.manage.test.js`
Expected: PASS if Task 9 step 4 is complete. If it fails, fix the action before continuing — the UI below assumes these intents work.

- [ ] **Step 3: Replace the "Uploaded models" section**

In `app/routes/app.models.jsx`, replace the `Uploaded models` section with:

```jsx
      <s-section heading="Your models">
        {assets.length === 0 ? (
          <s-stack direction="block" gap="base">
            <s-text type="strong">Upload your first model</s-text>
            <s-paragraph>Add a .glb of your frames above to get started.</s-paragraph>
          </s-stack>
        ) : (
          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            {assets.map((a) => (
              <s-box key={a.id} padding="base" borderWidth="base" borderRadius="base">
                <s-stack direction="block" gap="small-500">
                  <ModelViewer src={`/models/${a.id}.glb`} alt={modelName(a)} />
                  <s-text-field
                    label="Name"
                    value={a.label ?? ''}
                    placeholder={a.filename ?? `Model ${a.id.slice(0, 8)}`}
                    onBlur={(e) => rename(a.id, e.currentTarget.value)}
                  ></s-text-field>
                  <s-stack direction="inline" gap="small-500" alignItems="center">
                    <s-badge tone={a.status === 'ready' ? 'success' : 'warning'}>
                      {a.status === 'ready' ? 'Ready' : 'Check fit'}
                    </s-badge>
                    {a.confidence != null && (
                      <s-text tone="subdued">fit confidence {Math.round(a.confidence * 100)}%</s-text>
                    )}
                  </s-stack>
                  {a.mappingCount > 0 ? (
                    <s-text tone="subdued">
                      Used by {a.mappingCount} product{a.mappingCount === 1 ? '' : 's'} --{' '}
                      <s-link href="/app/products">view</s-link>
                    </s-text>
                  ) : (
                    <s-button variant="tertiary" tone="critical" icon="delete" onClick={() => remove(a.id)}>
                      Delete
                    </s-button>
                  )}
                </s-stack>
              </s-box>
            ))}
          </s-grid>
        )}
      </s-section>
```

Add the handlers inside the component, after the existing fetchers:

```jsx
  const manageFetcher = useFetcher()
  const rename = (modelAssetId, label) =>
    manageFetcher.submit({ intent: 'rename', modelAssetId, label }, { method: 'POST' })
  const remove = (modelAssetId) =>
    manageFetcher.submit({ intent: 'delete', modelAssetId }, { method: 'POST' })

  useEffect(() => {
    if (manageFetcher.data?.renamed) shopify.toast.show('Name saved')
    if (manageFetcher.data?.deleted) shopify.toast.show('Model deleted')
    if (manageFetcher.data?.error) shopify.toast.show(manageFetcher.data.error, { isError: true })
  }, [manageFetcher.data, shopify])
```

Also delete the now-unused `Map a product to a model` and `Product mappings` sections, the `mapFetcher`/`unmapFetcher` state, `pickProduct`, `submitMapping`, `removeMapping`, and the `sourceLabel` import usage for mappings.

- [ ] **Step 4: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.models.jsx test/appModels.manage.test.js
git commit -m "feat(admin): rename and delete models, guarded by product usage"
```

---

## Phase E — Preview

### Task 11: QR and open-in-tab preview

**Files:**
- Create: `app/components/PreviewPanel.jsx`
- Modify: `app/routes/app.products.jsx`
- Modify: `package.json` (add `qrcode`)
- Test: `test/appProducts.preview.test.js`

**Interfaces:**
- Consumes: `previewUrl` (Task 4)
- Produces: loader adds `qr` — a data-URI PNG per mapping

The QR is generated server-side in the loader. Generating it client-side would need a CDN script, and the admin iframe's CSP is not ours to widen.

- [ ] **Step 1: Add the dependency**

Run: `npm install qrcode@^1.5.4`
Expected: added to `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `test/appProducts.preview.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `prev-${tag}.myshopify.com`

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: {
        graphql: async () => new Response(JSON.stringify({
          data: { currentAppInstallation: { activeSubscriptions: [{ name: 'Pro', status: 'ACTIVE' }] } },
        })),
      },
    }),
  },
}))
vi.mock('../app/tryonMetafield.server.js', () => ({
  publishMappings: async () => {},
  publishMapping: async () => {},
  unpublishMapping: async () => {},
}))
vi.mock('../app/products.server.js', () => ({ fetchProductsByIds: async () => new Map() }))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/app.products.jsx')

beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  const asset = await prisma.modelAsset.create({ data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: {} } })
  await prisma.productMapping.create({
    data: { shop, productId: `gid://shopify/Product/${tag}`, modelAssetId: asset.id },
  })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('products preview', () => {
  it('points the preview at this product, marked as preview traffic', async () => {
    const { mappings } = await loader({ request: new Request('https://x/app/products') })
    const url = new URL(mappings[0].previewUrl)
    expect(url.searchParams.get('productId')).toBe(`gid://shopify/Product/${tag}`)
    expect(url.searchParams.get('src')).toBe('preview')
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run test/appProducts.preview.test.js`
Expected: FAIL — `mappings[0].qr` is undefined.

- [ ] **Step 4: Generate the QR in the loader**

In `app/routes/app.products.jsx`, add the import:

```js
import QRCode from 'qrcode'
```

and replace the `mappings:` mapping in the returned object with:

```js
    mappings: await Promise.all(
      mappings.map(async (m) => {
        const url = previewUrl({ engineUrl: ENGINE_URL, shop: session.shop, productId: m.productId })
        return {
          ...m,
          product: products.get(m.productId) ?? null,
          status: productStatus(m),
          previewUrl: url,
          // Generated here, not in the browser: a client-side QR library would
          // need a CDN script and the admin iframe's CSP is not ours to widen.
          qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }),
        }
      }),
    ),
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run test/appProducts.preview.test.js`
Expected: PASS, 1 test.

- [ ] **Step 6: Build the preview panel**

Create `app/components/PreviewPanel.jsx`:

```jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */

// Try-on is a phone experience and the merchant is at a desktop, so the QR is
// the primary affordance. Camera cannot work inside the admin iframe -- Shopify
// does not delegate the permission -- so both routes here leave the iframe.
export default function PreviewPanel({ mapping }) {
  return (
    <s-stack direction="block" gap="base" alignItems="center">
      <s-paragraph>Scan to try it on your phone.</s-paragraph>
      <img src={mapping.qr} alt="QR code linking to the try-on preview" width="220" height="220" />
      <s-paragraph>
        <a href={mapping.previewUrl} target="_blank" rel="noreferrer">Open on this computer</a>
      </s-paragraph>
    </s-stack>
  )
}
```

- [ ] **Step 7: Swap the row action for a modal**

In `app/routes/app.products.jsx`, add the import:

```js
import PreviewPanel from '../components/PreviewPanel'
```

Replace the Preview `<s-button>` in the actions cell with:

```jsx
                      <s-button variant="tertiary" commandFor={`preview-${m.id}`} command="show">
                        Preview
                      </s-button>
```

and immediately after the `</s-table-row>`'s closing, outside the table, render one modal per mapping:

```jsx
        {mappings.map((m) => (
          <s-modal key={m.id} id={`preview-${m.id}`} heading={`Preview ${m.product?.title ?? 'try-on'}`}>
            <PreviewPanel mapping={m} />
          </s-modal>
        ))}
```

- [ ] **Step 8: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 9: Manual check**

Deploy and confirm: Preview opens a modal with a QR; scanning it on a phone loads the try-on with the camera working; and the product's status does **not** flip to "Live" as a result — `src=preview` must keep it excluded. This is the single most important manual check in the plan.

- [ ] **Step 10: Commit**

```bash
git add app/routes/app.products.jsx app/components/PreviewPanel.jsx package.json package-lock.json test/appProducts.preview.test.js
git commit -m "feat(admin): preview try-on by QR or in a new tab"
```

---

### Task 12: Mock-head fit preview

Camera-free, renders inside the admin. The only preview that works in the iframe, and it targets the known "glasses look too small" complaint.

**Files:**
- Create: `app/fitPreview.server.js`
- Create: `app/routes/models.$assetId.fit-preview[.]glb.jsx`
- Create: `public/mock-head.glb` (vendored, decimated)
- Modify: `app/components/PreviewPanel.jsx`
- Test: `test/fitPreview.server.test.js`

**Interfaces:**
- Consumes: `readModelGlb` from `app/storage.server.js`, `@gltf-transform/core`
- Produces: `composeFitPreview(headGlb, framesGlb, fitMetadata) -> Promise<Uint8Array>`; route `GET /models/:assetId/fit-preview.glb`

- [ ] **Step 1: Vendor a web-weight mock head**

The source head is `D:/AR Sunglasses/test-mock-head/head.glb` at 3.9 MB — untracked, outside the repo, and far too heavy to serve per model card. Decimate it first:

```bash
node scripts/compress-models.mjs "D:/AR Sunglasses/test-mock-head/head.glb" apps/shopify-app/public/mock-head.glb
```

Run from the repo root. Confirm the output is under 500 KB:

```bash
ls -la apps/shopify-app/public/mock-head.glb
```

If `scripts/compress-models.mjs` does not accept input/output arguments, read it and adapt the invocation — the requirement is a Draco- or meshopt-compressed head under 500 KB at `apps/shopify-app/public/mock-head.glb`, not a specific command.

- [ ] **Step 2: Write the failing test**

Create `test/fitPreview.server.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { composeFitPreview } from '../app/fitPreview.server.js'

const head = await readFile(new URL('../public/mock-head.glb', import.meta.url))
const frames = await readFile(new URL('../test-fixtures/tagged-sample.glb', import.meta.url))

describe('composeFitPreview', () => {
  it('returns a valid GLB containing both meshes', async () => {
    const out = await composeFitPreview(head, frames, { anchor: { position: [0, 0, 0], scale: 1 } })
    // glTF binary magic
    expect(Buffer.from(out.slice(0, 4)).toString()).toBe('glTF')
    expect(out.byteLength).toBeGreaterThan(head.byteLength)
  })

})
```

`test-fixtures/tagged-sample.glb` is the repo's existing calibration fixture and is already tracked. Note that `apps/shopify-app/public/models/` does not exist -- the bundled engine models live under `public/tryon/models/`.

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run test/fitPreview.server.test.js`
Expected: FAIL — cannot resolve `../app/fitPreview.server.js`.

- [ ] **Step 4: Implement the composer**

Create `app/fitPreview.server.js`:

```js
import { Document, NodeIO } from '@gltf-transform/core'

const io = new NodeIO()

/**
 * Merge the mock head and a merchant's frames into one GLB, with the frames
 * placed by the asset's calibrated anchor. This is the only preview that can
 * render inside the admin: camera access is impossible in Shopify's app iframe,
 * so the merchant checks scale and placement against a fixed head instead.
 *
 * @param {Uint8Array} headGlb decimated mock head
 * @param {Uint8Array} framesGlb the normalized, calibrated frames
 * @param {object} fitMetadata the asset's stored fit metadata
 * @returns {Promise<Uint8Array>}
 */
export async function composeFitPreview(headGlb, framesGlb, fitMetadata) {
  const headDoc = await io.readBinary(headGlb)
  const framesDoc = await io.readBinary(framesGlb)

  const merged = new Document()
  merged.merge(headDoc)
  merged.merge(framesDoc)

  // merge() concatenates scenes; collapse them into one so a viewer shows both.
  const root = merged.getRoot()
  const scenes = root.listScenes()
  const target = scenes[0]
  for (const extra of scenes.slice(1)) {
    for (const node of extra.listChildren()) {
      extra.removeChild(node)
      target.addChild(node)
      applyAnchor(node, fitMetadata)
    }
    extra.dispose()
  }
  root.setDefaultScene(target)
  return io.writeBinary(merged)
}

function applyAnchor(node, fitMetadata) {
  const anchor = fitMetadata?.anchor
  if (!anchor) return
  if (Array.isArray(anchor.position)) node.setTranslation(anchor.position)
  if (typeof anchor.scale === 'number') node.setScale([anchor.scale, anchor.scale, anchor.scale])
}
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `npx vitest run test/fitPreview.server.test.js`
Expected: PASS, 1 test.

If `anchor` is not the shape stored in `fitMetadata`, inspect a real row first:

```bash
node -e "const p=require('@prisma/client');const c=new p.PrismaClient();c.modelAsset.findFirst().then(a=>{console.log(JSON.stringify(a.fitMetadata,null,2));return c.\$disconnect()})"
```

and adjust `applyAnchor` plus the test fixtures to match. Do not guess the shape.

- [ ] **Step 6: Add the route**

Create `app/routes/models.$assetId.fit-preview[.]glb.jsx`, modelled on the existing `app/routes/models.$assetId[.]glb.jsx` (read that file first and match its auth and caching posture):

```jsx
import { readFile } from 'node:fs/promises'
import prisma from '../db.server'
import { readModelGlb } from '../storage.server'
import { composeFitPreview } from '../fitPreview.server'

export const loader = async ({ params }) => {
  const asset = await prisma.modelAsset.findUnique({ where: { id: params.assetId } })
  if (!asset) return new Response('not found', { status: 404 })
  const frames = await readModelGlb(asset.storageRef)
  if (!frames) return new Response('not found', { status: 404 })
  const head = await readFile(new URL('../../public/mock-head.glb', import.meta.url))
  const glb = await composeFitPreview(head, frames, asset.fitMetadata)
  return new Response(glb, {
    headers: {
      'Content-Type': 'model/gltf-binary',
      // Immutable: the composition is a pure function of an asset that never
      // changes in place -- a re-upload creates a new id.
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  })
}
```

- [ ] **Step 7: Show it in the preview panel**

In `app/components/PreviewPanel.jsx`, add the import and a fit section above the QR:

```jsx
import ModelViewer from './ModelViewer'
```

and inside the returned stack, before the QR paragraph:

```jsx
      <ModelViewer
        src={`/models/${mapping.modelAssetId}/fit-preview.glb`}
        alt="Your frames on a reference head"
      />
      <s-paragraph tone="subdued">
        If the frames look too small or too large here, adjust Glasses size in the
        block settings in your theme editor.
      </s-paragraph>
```

- [ ] **Step 8: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 9: Manual check**

Deploy and open a Preview modal. The frames should sit on the reference head at a plausible scale. If they float, are buried inside the head, or are wildly mis-scaled, the `applyAnchor` mapping is wrong — go back to step 5 and inspect the real `fitMetadata` shape rather than adjusting numbers by feel.

- [ ] **Step 10: Commit**

```bash
git add app/fitPreview.server.js app/routes/models.\$assetId.fit-preview\[.\]glb.jsx app/components/PreviewPanel.jsx public/mock-head.glb test/fitPreview.server.test.js
git commit -m "feat(admin): render a camera-free fit preview on a reference head"
```

---

## Phase F — Help and polish

### Task 13: Troubleshooting-led Help page

**Files:**
- Modify: `app/routes/app.additional.jsx`

- [ ] **Step 1: Rewrite the page**

Replace the whole of `app/routes/app.additional.jsx` with:

```jsx
export default function HelpPage() {
  return (
    <s-page heading="Help">
      <s-section heading="The glasses look too small or too large">
        <s-paragraph>
          Open your theme editor, select the AR Try-On block on the product page,
          and adjust Glasses size. 1 is the natural fit; try around 1.6 if they
          look small. The change applies to every product using that block.
        </s-paragraph>
      </s-section>

      <s-section heading="The Try on button doesn't appear">
        <s-paragraph>
          Two things have to be true. The product needs try-on added on the{' '}
          <s-link href="/app/products">Products</s-link> page, and the AR Try-On
          block needs to be on your product template in the theme editor. A
          product with no model stays hidden on purpose.
        </s-paragraph>
      </s-section>

      <s-section heading="The camera doesn't start">
        <s-paragraph>
          The shopper&apos;s browser asks for camera permission the first time.
          If they dismissed it, they&apos;ll need to allow the camera for your
          store in their browser settings. The camera also needs a secure
          connection, which your storefront already uses.
        </s-paragraph>
        <s-paragraph>
          Face tracking runs entirely in the shopper&apos;s browser. No photo or
          video is uploaded or stored.
        </s-paragraph>
      </s-section>

      <s-section heading="Preparing a model">
        <s-paragraph>
          Models are .glb files up to 25 MB. The app measures frame width, hinge
          points and lens placement from the geometry when you upload, so no
          manual setup is needed. A model marked Check fit still works, but it&apos;s
          worth previewing before you rely on it.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Resources">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/privacy" target="_blank">Privacy policy</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="mailto:ramy.sameh2@gmail.com">Contact support</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  )
}
```

- [ ] **Step 2: Run lint**

Run: `npx eslint app/routes/app.additional.jsx`
Expected: exits 0. Do NOT run `npm run lint` — 931 pre-existing repo-wide errors make it unpassable.

- [ ] **Step 3: Commit**

```bash
git add app/routes/app.additional.jsx
git commit -m "feat(admin): lead Help with the failures merchants actually hit"
```

---

### Task 14: One error surface per failure

Today a map failure shows both a toast and a banner. Pick one per class and remove the duplicate.

**Files:**
- Modify: `app/routes/app.products.jsx`
- Modify: `app/routes/app.models.jsx`

- [ ] **Step 1: Apply the rule**

The rule: an error attached to a form the merchant is looking at renders as an inline `<s-banner>` next to that form and **does not** toast. An error from a background action with no form on screen (unmap, delete, rename) toasts and has no banner.

In `app/routes/app.products.jsx`, remove `mapError` from any toast effect — it already renders as a banner inside the modal. Keep the unmap toast.

In `app/routes/app.models.jsx`, remove the upload-error toast (`shopify.toast.show(e.message, { isError: true })` inside the `upload` catch); `uploadErr` already renders as a banner. Keep `setUploadErr(e.message)`.

- [ ] **Step 2: Verify no path both toasts and banners**

Run: `grep -n "toast.show" app/routes/app.products.jsx app/routes/app.models.jsx`
Expected: every remaining call is a success message or an error with no matching banner. Read each hit and confirm.

- [ ] **Step 3: Run lint and the full suite**

Run: `npx eslint <the files you changed>` then the test files this task names.
Expected: eslint exits 0 on your files, tests PASS.

Do NOT run `npm run lint` (931 pre-existing repo-wide errors from a vendored Draco decoder and missing globals config — it can never pass) or the full `npm test` (slow, and flaky from a concurrent session sharing the database).

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.products.jsx app/routes/app.models.jsx
git commit -m "fix(admin): report each failure once, not as both a toast and a banner"
```

---

### Task 15: Final verification

- [ ] **Step 1: Full suite and lint**

Run: `npm run lint && npm test`
Expected: PASS, no skipped suites.

- [ ] **Step 2: Confirm no scope or camera regressions**

Run:

```bash
grep -n "scopes" shopify.app.toml
grep -rn "getUserMedia\|allow=\"camera\"" app/
```

Expected: scopes unchanged at `write_products,write_metaobjects,write_metaobject_definitions`; no camera usage anywhere under `app/`.

- [ ] **Step 3: Confirm no loader redirects to /app**

Run: `grep -n "redirect" app/routes/app*.jsx`
Expected: no redirect to `/app` or `/app/*` in any loader (App Store rejection Ref 127328).

- [ ] **Step 4: Confirm no jargon leaked to Home or Products**

Run: `grep -nEi "geometric|confidence|needs_manual|manual anchor" app/routes/app._index.jsx app/routes/app.products.jsx`
Expected: no matches. Confidence belongs on Models only.

- [ ] **Step 5: Deploy and walk the merchant path**

Run: `npm run deploy`

Then on the dev store, in order:
1. Home shows 0 of 3 (or the true count) with a working Add to theme link.
2. Upload a model on Models; it appears with a 3D preview and can be renamed.
3. Add try-on on Products, picking the model visually; the row reads "Not on your theme yet".
4. Preview by QR on a phone; try-on loads and the camera works; the row **stays** "Not on your theme yet".
5. Add the block via the theme deep link, then open the product on the storefront; within an hour the row reads "Live" and Home reaches 3 of 3.
6. Try to delete the model still in use; it refuses and names the product count.

- [ ] **Step 6: Commit any fixes and push**

```bash
git push -u origin feature/admin-ux
```

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task: IA → 7, 9; Home checklist and deep link → 4, 6; proof of life → 1, 5; plan usage → 3, 6, 8; Products table and status → 2, 7; add-try-on modal → 8; Models rename/delete → 9, 10; preview trio → 11, 12; Help → 13; single error surface → 14; schema → 1.

**Known open question, resolved in-plan rather than assumed.** Task 4 hard-codes the extension uid with an env override, and Task 15 step 5 is where a wrong uid surfaces. If the deep link 404s, set `SHOPIFY_THEME_EXTENSION_UID` from the Partner Dashboard; no code change is needed.

**Deliberate sequencing.** Phases A–B alone ship the churn fix (completable checklist, theme deep link, plan meter) and are independently deployable. If the work is cut short, stopping after Task 6 still leaves the app better than it started and in a consistent state.

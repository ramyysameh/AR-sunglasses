# Phase 5 — Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charge merchants via Shopify Managed Pricing across three tiers, and enforce each tier's product limit — blocking new products at the cap while grandfathering existing ones, and turning the storefront try-on off after a 7-day grace when a subscription lapses.

**Architecture:** Plans, prices, and the 7-day trial live in the Partner Dashboard (Managed Pricing); code only maps plan name → product limit. The admin reads the active plan **live** via the `currentAppInstallation.activeSubscriptions` GraphQL field (low traffic, authoritative, no webhook race). A local `ShopSubscription` row — kept current by the `app_subscriptions/update` webhook — is the source of truth for the **hot, edge-cached storefront path** (`api.tryon-config`), which must never call Shopify.

**Tech Stack:** React Router v7 + `@shopify/shopify-app-react-router` v1.1.0, Prisma 6 + Neon Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-26-phase5-billing-design.md`. Read it first.

## Global Constraints

- **Tiers, gated on `ProductMapping` rows per shop:** `Starter` → 10, `Growth` → 40, `Pro` → unlimited. These plan **names** must exactly match the Partner Dashboard plan names, or enforcement fails closed.
- **Fail closed:** an unknown/unmapped plan name yields limit `0` (everything blocked), never unlimited.
- **Prices and the 7-day trial are Partner Dashboard settings — never in code.** A trialing subscription reports status `ACTIVE`, so it needs no special handling.
- **The storefront path (`api.tryon-config`, `/models/:id.glb`) must not make live Shopify API calls** — it is edge-cached (Phase 4 Slice 1). Read the local `ShopSubscription` row only.
- **Over-limit = block new, grandfather existing.** `mapProductToModel` upserts on `(shop, productId)`; the limit check gates only genuinely new products (the create path), never a re-map.
- **On lapse:** admin gated immediately (status ≠ `ACTIVE` → redirect to pricing); storefront served for a 7-day grace, evaluated at read time (no cron), then off.
- **Shared Neon DB:** DB-backed tests use `randomUUID()`-tagged fixtures cleaned by exact name in `afterAll` (mirror `test/webhooks.server.test.js`). Pure-logic tests (Task 1) are DB-free. Do not run the whole app suite against production casually.
- **Migrations run through the direct endpoint** (`directUrl`). If a deploy build reports `P1002` advisory-lock timeout, clear it with `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory';` then redeploy once.
- **Claude does not enter secrets.** The operator sets `SHOPIFY_APP_HANDLE` in Vercel + `.env`, configures the three plans, and drives live billing verification (Task 8).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `apps/shopify-app/app/billing.server.js` | create | Pure: `PLAN_LIMITS`, `GRACE_PERIOD_DAYS`, `planLimit`, `isServable`. Persistence: `getShopSubscription`, `applySubscriptionUpdate`. Admin: `getActivePlanName`. |
| `apps/shopify-app/test/billing.server.test.js` | create | DB-free unit tests for the pure helpers |
| `apps/shopify-app/prisma/schema.prisma` | modify | `ShopSubscription` model |
| `apps/shopify-app/prisma/migrations/*/migration.sql` | create | The `ShopSubscription` migration |
| `apps/shopify-app/test/shopSubscription.server.test.js` | create | DB-backed persistence tests |
| `apps/shopify-app/app/routes/webhooks.app.subscriptions_update.jsx` | create | HMAC webhook → `applySubscriptionUpdate` |
| `apps/shopify-app/test/webhooks.subscriptions.test.js` | create | Webhook handler test |
| `apps/shopify-app/shopify.app.toml` | modify | Subscribe to `app_subscriptions/update` |
| `apps/shopify-app/app/routes/app.models.jsx` | modify | Limit check in the `map` action |
| `apps/shopify-app/test/appModels.limit.test.js` | create | Enforcement test |
| `apps/shopify-app/app/routes/api.tryon-config.jsx` | modify | Grace-aware servable gate |
| `apps/shopify-app/test/tryonConfig.billing.test.js` | create | Storefront gate test |
| `apps/shopify-app/app/routes/app.jsx` | modify | Admin subscription gate + redirect |
| `apps/shopify-app/app/webhooks.server.js` | modify | Purge `ShopSubscription` |
| `apps/shopify-app/test/webhooks.server.test.js` | modify | Extend purge test |
| `apps/shopify-app/.env.example` | modify | Document `SHOPIFY_APP_HANDLE` |

---

### Task 1: Pure billing helpers

**Files:**
- Create: `apps/shopify-app/app/billing.server.js`
- Create: `apps/shopify-app/test/billing.server.test.js`

**Interfaces:**
- Produces: `PLAN_LIMITS` (`{Starter:10, Growth:40, Pro:Infinity}`), `GRACE_PERIOD_DAYS` (7), `planLimit(name) → number`, `isServable(sub, now) → boolean`. Later tasks import these.

DB-free — safe to run anywhere. Run from `apps/shopify-app`.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/billing.server.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  PLAN_LIMITS,
  GRACE_PERIOD_DAYS,
  planLimit,
  isServable,
} from '../app/billing.server.js'

describe('planLimit', () => {
  it('maps each known plan name to its product cap', () => {
    expect(planLimit('Starter')).toBe(10)
    expect(planLimit('Growth')).toBe(40)
    expect(planLimit('Pro')).toBe(Infinity)
  })

  it('fails CLOSED for an unknown or missing plan name', () => {
    // A dashboard/code name mismatch must block everything, never unlock it.
    expect(planLimit('Enterprise')).toBe(0)
    expect(planLimit(undefined)).toBe(0)
    expect(planLimit(null)).toBe(0)
  })

  it('exposes the tier table and grace window as constants', () => {
    expect(PLAN_LIMITS).toEqual({ Starter: 10, Growth: 40, Pro: Infinity })
    expect(GRACE_PERIOD_DAYS).toBe(7)
  })
})

describe('isServable', () => {
  const now = new Date('2026-07-26T12:00:00Z')

  it('serves an ACTIVE subscription', () => {
    expect(isServable({ status: 'ACTIVE', graceEndsAt: null }, now)).toBe(true)
  })

  it('serves a lapsed subscription still inside its grace window', () => {
    const graceEndsAt = new Date(now.getTime() + 24 * 3600 * 1000)
    expect(isServable({ status: 'CANCELLED', graceEndsAt }, now)).toBe(true)
  })

  it('does NOT serve once the grace window has passed', () => {
    const graceEndsAt = new Date(now.getTime() - 1)
    expect(isServable({ status: 'CANCELLED', graceEndsAt }, now)).toBe(false)
  })

  it('does NOT serve a never-subscribed shop (no row)', () => {
    expect(isServable(null, now)).toBe(false)
    expect(isServable(undefined, now)).toBe(false)
  })

  it('does NOT serve a lapsed subscription with no grace timestamp', () => {
    expect(isServable({ status: 'FROZEN', graceEndsAt: null }, now)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/billing.server.test.js`
Expected: FAIL — cannot resolve `../app/billing.server.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/shopify-app/app/billing.server.js`:

```js
// Managed Pricing: plan NAMES + product limits are the only billing facts in
// code. Prices and the 7-day trial live in the Partner Dashboard. The names
// here MUST match the dashboard plan names exactly, or planLimit() fails closed.
export const PLAN_LIMITS = { Starter: 10, Growth: 40, Pro: Infinity }

// Days the storefront try-on keeps serving after a subscription lapses.
export const GRACE_PERIOD_DAYS = 7

/**
 * Product cap for a plan name. Unknown/missing name -> 0 (fail closed): a
 * dashboard/code name mismatch must block, never unlock.
 * @param {string|null|undefined} name
 * @returns {number}
 */
export function planLimit(name) {
  return Object.prototype.hasOwnProperty.call(PLAN_LIMITS, name)
    ? PLAN_LIMITS[name]
    : 0
}

/**
 * Whether the storefront try-on should serve for a shop's local subscription
 * row. True when ACTIVE, or lapsed but still inside the grace window.
 * @param {{status: string, graceEndsAt: Date|null}|null|undefined} sub
 * @param {Date} now
 * @returns {boolean}
 */
export function isServable(sub, now) {
  if (!sub) return false
  if (sub.status === 'ACTIVE') return true
  return Boolean(sub.graceEndsAt) && now < sub.graceEndsAt
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/billing.server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-app/app/billing.server.js apps/shopify-app/test/billing.server.test.js
git commit -m "feat(billing): plan-limit and grace-window helpers

PLAN_LIMITS (Starter 10 / Growth 40 / Pro unlimited), planLimit (fails
closed on unknown names), isServable (ACTIVE or within grace). Pure and
DB-free; the enforcement points build on these."
```

---

### Task 2: `ShopSubscription` model, migration, and persistence

**Files:**
- Modify: `apps/shopify-app/prisma/schema.prisma`
- Create: `apps/shopify-app/prisma/migrations/<timestamp>_shop_subscription/migration.sql`
- Modify: `apps/shopify-app/app/billing.server.js`
- Create: `apps/shopify-app/test/shopSubscription.server.test.js`

**Interfaces:**
- Consumes: `GRACE_PERIOD_DAYS` from Task 1.
- Produces: `getShopSubscription(prisma, shop) → {shop, planName, status, graceEndsAt}|null`; `applySubscriptionUpdate(prisma, shop, {name, status}, now) → row`. Grace is stamped on the first lapse and preserved across repeated non-ACTIVE updates; cleared on ACTIVE.

DB-backed — uses the shared Neon instance. Run from `apps/shopify-app`.

- [ ] **Step 1: Add the model**

In `apps/shopify-app/prisma/schema.prisma`, after the `ProductMapping` model, add:

```prisma
model ShopSubscription {
  shop        String    @id
  planName    String?
  status      String
  graceEndsAt DateTime?
  updatedAt   DateTime  @updatedAt
}
```

- [ ] **Step 2: Generate the migration SQL offline (no DB connection)**

The shared DB is production; generate the migration from the schema diff rather than `migrate dev` against it.

Run:
```bash
cd apps/shopify-app
mkdir -p "prisma/migrations/20260726000000_shop_subscription"
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DATABASE_URL" \
  --script > "prisma/migrations/20260726000000_shop_subscription/migration.sql"
cat "prisma/migrations/20260726000000_shop_subscription/migration.sql"
```
Expected: a `CREATE TABLE "ShopSubscription" (...)` script with `shop` PK. If the shadow-DB step is refused against Neon, generate with `--from-schema-datamodel`/`--to-schema-datamodel` against an empty baseline instead; the goal is a committed SQL file, not a live apply here (Vercel's `migrate deploy` applies it on deploy).

- [ ] **Step 3: Regenerate the client and validate**

Run: `npx prisma generate && npx prisma validate`
Expected: client generated; schema valid. Neither opens a DB connection.

- [ ] **Step 4: Write the failing persistence test**

Create `apps/shopify-app/test/shopSubscription.server.test.js`:

```js
import { describe, it, expect, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const prisma = (await import('../app/db.server.js')).default
const { getShopSubscription, applySubscriptionUpdate } = await import(
  '../app/billing.server.js'
)

const tag = randomUUID().slice(0, 8)
const shop = `sub-${tag}.myshopify.com`

afterAll(async () => {
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('ShopSubscription persistence', () => {
  it('returns null before any subscription exists', async () => {
    expect(await getShopSubscription(prisma, shop)).toBeNull()
  })

  it('records an ACTIVE subscription with no grace', async () => {
    const now = new Date('2026-07-26T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'ACTIVE' }, now)

    const row = await getShopSubscription(prisma, shop)
    expect(row.planName).toBe('Growth')
    expect(row.status).toBe('ACTIVE')
    expect(row.graceEndsAt).toBeNull()
  })

  it('stamps a grace window on the first lapse and preserves it on repeat', async () => {
    const t0 = new Date('2026-07-26T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'ACTIVE' }, t0)

    const lapse = new Date('2026-07-27T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'CANCELLED' }, lapse)
    const first = await getShopSubscription(prisma, shop)
    const expected = new Date(lapse.getTime() + 7 * 24 * 3600 * 1000)
    expect(first.graceEndsAt.getTime()).toBe(expected.getTime())

    // A later non-ACTIVE update must NOT push the deadline out.
    const later = new Date('2026-07-28T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'FROZEN' }, later)
    const second = await getShopSubscription(prisma, shop)
    expect(second.graceEndsAt.getTime()).toBe(expected.getTime())
    expect(second.status).toBe('FROZEN')
  })

  it('clears grace when a subscription becomes ACTIVE again', async () => {
    const lapse = new Date('2026-07-27T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Growth', status: 'CANCELLED' }, lapse)
    const active = new Date('2026-07-29T00:00:00Z')
    await applySubscriptionUpdate(prisma, shop, { name: 'Pro', status: 'ACTIVE' }, active)

    const row = await getShopSubscription(prisma, shop)
    expect(row.status).toBe('ACTIVE')
    expect(row.planName).toBe('Pro')
    expect(row.graceEndsAt).toBeNull()
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `npx vitest run test/shopSubscription.server.test.js`
Expected: FAIL — `getShopSubscription`/`applySubscriptionUpdate` are not exported.

- [ ] **Step 6: Add the persistence helpers**

Append to `apps/shopify-app/app/billing.server.js`:

```js
/**
 * The local subscription row for a shop, or null. Source of truth for the
 * edge-cached storefront path so it never calls Shopify.
 */
export async function getShopSubscription(prisma, shop) {
  return prisma.shopSubscription.findUnique({ where: { shop } })
}

/**
 * Apply an authoritative status update (from the app_subscriptions/update
 * webhook). ACTIVE clears grace; the first non-ACTIVE stamps graceEndsAt =
 * now + GRACE_PERIOD_DAYS and later non-ACTIVE updates preserve it.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} shop
 * @param {{name: string|null, status: string}} sub
 * @param {Date} now
 */
export async function applySubscriptionUpdate(prisma, shop, sub, now) {
  const status = sub.status
  let graceEndsAt = null
  if (status !== 'ACTIVE') {
    const existing = await prisma.shopSubscription.findUnique({ where: { shop } })
    graceEndsAt =
      existing?.graceEndsAt ??
      new Date(now.getTime() + GRACE_PERIOD_DAYS * 24 * 3600 * 1000)
  }
  return prisma.shopSubscription.upsert({
    where: { shop },
    update: { planName: sub.name, status, graceEndsAt },
    create: { shop, planName: sub.name, status, graceEndsAt },
  })
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run test/shopSubscription.server.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add apps/shopify-app/prisma/schema.prisma apps/shopify-app/prisma/migrations apps/shopify-app/app/billing.server.js apps/shopify-app/test/shopSubscription.server.test.js
git commit -m "feat(billing): ShopSubscription record + persistence

Local per-shop subscription row (planName, status, graceEndsAt), the source
of truth for the edge-cached storefront path. applySubscriptionUpdate stamps
grace on the first lapse, preserves it on repeat, and clears it on ACTIVE."
```

---

### Task 3: `app_subscriptions/update` webhook

**Files:**
- Create: `apps/shopify-app/app/routes/webhooks.app.subscriptions_update.jsx`
- Modify: `apps/shopify-app/shopify.app.toml`
- Create: `apps/shopify-app/test/webhooks.subscriptions.test.js`

**Interfaces:**
- Consumes: `applySubscriptionUpdate` from Task 2.
- Produces: an HMAC-verified route that maps the webhook payload's `app_subscription.{name,status}` into `applySubscriptionUpdate`.

Run from `apps/shopify-app`.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/webhooks.subscriptions.test.js`:

```js
import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `sub-wh-${tag}.myshopify.com`

// Stub the Shopify webhook authentication: return a parsed, "verified" payload.
const hoisted = vi.hoisted(() => ({ shop: '', payload: null }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    webhook: async () => ({
      topic: 'APP_SUBSCRIPTIONS_UPDATE',
      shop: hoisted.shop,
      payload: hoisted.payload,
    }),
  },
}))

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/webhooks.app.subscriptions_update.jsx')
const { getShopSubscription } = await import('../app/billing.server.js')

afterAll(async () => {
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('app_subscriptions/update webhook', () => {
  it('persists an ACTIVE subscription from the payload', async () => {
    hoisted.shop = shop
    hoisted.payload = { app_subscription: { name: 'Starter', status: 'ACTIVE' } }

    const res = await action({ request: new Request('https://x/webhooks/app/subscriptions_update', { method: 'POST' }) })
    expect(res.status).toBe(200)

    const row = await getShopSubscription(prisma, shop)
    expect(row.planName).toBe('Starter')
    expect(row.status).toBe('ACTIVE')
    expect(row.graceEndsAt).toBeNull()
  })

  it('records a lapse with a grace window', async () => {
    hoisted.shop = shop
    hoisted.payload = { app_subscription: { name: 'Starter', status: 'CANCELLED' } }

    await action({ request: new Request('https://x/webhooks/app/subscriptions_update', { method: 'POST' }) })

    const row = await getShopSubscription(prisma, shop)
    expect(row.status).toBe('CANCELLED')
    expect(row.graceEndsAt).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webhooks.subscriptions.test.js`
Expected: FAIL — the route module does not exist.

- [ ] **Step 3: Write the route**

Create `apps/shopify-app/app/routes/webhooks.app.subscriptions_update.jsx`:

```jsx
import { authenticate } from '../shopify.server'
import db from '../db.server'
import { applySubscriptionUpdate } from '../billing.server'

// Shopify fires app_subscriptions/update on subscribe, upgrade, downgrade,
// cancel, and payment failure. It is the authoritative source that keeps the
// local ShopSubscription row current for the edge-cached storefront path.
export const action = async ({ request }) => {
  const { payload, shop } = await authenticate.webhook(request)
  const sub = payload?.app_subscription
  if (sub && shop) {
    await applySubscriptionUpdate(
      db,
      shop,
      { name: sub.name ?? null, status: sub.status },
      new Date(),
    )
  }
  return new Response()
}
```

- [ ] **Step 4: Subscribe to the topic**

In `apps/shopify-app/shopify.app.toml`, in the `[webhooks]` section alongside the other `[[webhooks.subscriptions]]` blocks, add:

```toml
# Handled by: app/routes/webhooks.app.subscriptions_update.jsx
[[webhooks.subscriptions]]
topics = [ "app_subscriptions/update" ]
uri = "/webhooks/app/subscriptions_update"
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/webhooks.subscriptions.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify-app/app/routes/webhooks.app.subscriptions_update.jsx apps/shopify-app/shopify.app.toml apps/shopify-app/test/webhooks.subscriptions.test.js
git commit -m "feat(billing): app_subscriptions/update webhook keeps the local row current

HMAC-verified handler maps app_subscription.{name,status} into
applySubscriptionUpdate, so the storefront path reads a fresh local row
without calling Shopify. Subscribes to the topic in shopify.app.toml."
```

---

### Task 4: Enforce the tier limit on new products

**Files:**
- Modify: `apps/shopify-app/app/routes/app.models.jsx`
- Create: `apps/shopify-app/test/appModels.limit.test.js`

**Interfaces:**
- Consumes: `planLimit`, `getActivePlanName` (added here), `mapProductToModel`.
- Produces: the `map` action rejects a NEW product when the shop's mapping count is at the plan limit; re-mapping an existing product and Pro are always allowed.

The check reads the active plan **live** (admin context). Add `getActivePlanName(admin)` to `billing.server.js` using the `currentAppInstallation.activeSubscriptions` GraphQL field. Run from `apps/shopify-app`.

- [ ] **Step 1: Add `getActivePlanName` to billing.server.js**

Append to `apps/shopify-app/app/billing.server.js`:

```js
const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions { name status }
    }
  }`

/**
 * The name of the shop's ACTIVE subscription, read live from Shopify in admin
 * context. Returns null if there is no active subscription. Admin-only — never
 * call from the storefront path (it makes a live API call).
 * @param {{graphql: (q: string) => Promise<Response>}} admin
 * @returns {Promise<string|null>}
 */
export async function getActivePlanName(admin) {
  const res = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY)
  const body = await res.json()
  const subs = body?.data?.currentAppInstallation?.activeSubscriptions ?? []
  const active = subs.find((s) => s.status === 'ACTIVE')
  return active?.name ?? null
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/shopify-app/test/appModels.limit.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `limit-${tag}.myshopify.com`

const hoisted = vi.hoisted(() => ({ plan: 'Starter' }))
vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop },
      admin: { graphql: async () => new Response() },
    }),
  },
}))
// getActivePlanName is exercised for real elsewhere; here stub it to the tier
// under test so the test controls the limit without a live API call.
vi.mock('../app/billing.server.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getActivePlanName: async () => hoisted.plan }
})

const prisma = (await import('../app/db.server.js')).default
const { action } = await import('../app/routes/app.models.jsx')

async function seedAsset() {
  const a = await prisma.modelAsset.create({
    data: { shop, storageRef: `${tag}/m.glb`, fitMetadata: { version: 'eyewear-v1' } },
  })
  return a.id
}
function mapForm(productId, modelAssetId) {
  const fd = new FormData()
  fd.set('intent', 'map')
  fd.set('productId', productId)
  fd.set('modelAssetId', modelAssetId)
  return new Request('https://x/app/models', { method: 'POST', body: fd })
}

// Each case controls its own mapping count, so clear mappings first. Assets
// persist (harmless, referenced by id) and are removed in afterAll.
beforeEach(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
})

afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('map action tier limit', () => {
  it('blocks a NEW product once the Starter cap (10) is reached', async () => {
    hoisted.plan = 'Starter'
    const assetId = await seedAsset()
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await action({ request: mapForm(`gid://shopify/Product/${tag}-NEW`, assetId) })
    expect(res.error).toMatch(/limit/i)
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(10)
  })

  it('allows RE-mapping an already-mapped product at the cap', async () => {
    hoisted.plan = 'Starter'
    const assetId = await seedAsset()
    for (let i = 0; i < 10; i++) {
      await prisma.productMapping.create({
        data: { shop, productId: `gid://shopify/Product/${tag}-${i}`, modelAssetId: assetId },
      })
    }
    const res = await action({ request: mapForm(`gid://shopify/Product/${tag}-0`, assetId) })
    expect(res.mapped).toBe(true)
    expect(await prisma.productMapping.count({ where: { shop } })).toBe(10)
  })

  it('allows a new product on Pro (unlimited)', async () => {
    hoisted.plan = 'Pro'
    const assetId = await seedAsset()
    const res = await action({ request: mapForm(`gid://shopify/Product/${tag}-pro`, assetId) })
    expect(res.mapped).toBe(true)
  })
})
```

The `beforeEach` gives each case a clean mapping slate (they set their own counts); the `${tag}` scoping keeps fixtures off other shops in the shared DB.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/appModels.limit.test.js`
Expected: FAIL — no limit is enforced, so the "blocks a NEW product" case returns `{mapped:true}`.

- [ ] **Step 4: Add the limit check to the map action**

In `apps/shopify-app/app/routes/app.models.jsx`, update imports and the `map` branch. Change the import line:

```js
import { saveCalibratedModel, mapProductToModel, listMappings } from '../models.server'
```
to:
```js
import { saveCalibratedModel, mapProductToModel, listMappings } from '../models.server'
import { getActivePlanName, planLimit } from '../billing.server'
```

Then replace the `map` branch body:

```js
  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Enter a product ID and pick a model.' }
    }
    await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    return { mapped: true }
  }
```

with:

```js
  if (intent === 'map') {
    const productId = form.get('productId')?.toString().trim()
    const modelAssetId = form.get('modelAssetId')?.toString()
    if (!productId || !modelAssetId) {
      return { error: 'Enter a product ID and pick a model.' }
    }
    // Grandfather existing: only a genuinely NEW product counts against the cap.
    // mapProductToModel upserts on (shop, productId), so a re-map is not new.
    const existing = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop: session.shop, productId } },
    })
    if (!existing) {
      const limit = planLimit(await getActivePlanName(admin))
      const count = await prisma.productMapping.count({ where: { shop: session.shop } })
      if (count >= limit) {
        return {
          error:
            "You've reached your plan's product limit. Upgrade your plan to add try-on to more products.",
        }
      }
    }
    await mapProductToModel(prisma, session.shop, productId, modelAssetId)
    return { mapped: true }
  }
```

Also destructure `admin` from `authenticate.admin` at the top of the action:

```js
  const { session } = await authenticate.admin(request)
```
becomes:
```js
  const { session, admin } = await authenticate.admin(request)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/appModels.limit.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify-app/app/billing.server.js apps/shopify-app/app/routes/app.models.jsx apps/shopify-app/test/appModels.limit.test.js
git commit -m "feat(billing): enforce the tier product limit on new mappings

getActivePlanName reads the shop's live active plan (currentAppInstallation
.activeSubscriptions). The map action blocks a NEW product past the plan cap
and grandfathers existing ones -- a re-map on (shop, productId) is not new,
and Pro is unlimited."
```

---

### Task 5: Grace-aware storefront gate

**Files:**
- Modify: `apps/shopify-app/app/routes/api.tryon-config.jsx`
- Create: `apps/shopify-app/test/tryonConfig.billing.test.js`

**Interfaces:**
- Consumes: `getShopSubscription`, `isServable`.
- Produces: `api.tryon-config` returns 402 when the shop is not servable (no active sub and past grace), before touching the config — reading only the local row (no Shopify call), so the edge-cached path stays fast.

Run from `apps/shopify-app`.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/tryonConfig.billing.test.js`:

```js
import { describe, it, expect, vi, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const tag = randomUUID().slice(0, 8)
const shop = `tc-${tag}.myshopify.com`
const productId = `gid://shopify/Product/${tag}`

// Stub getTryonConfig so a servable shop reaches a 200 without needing real
// mapping data; the billing gate is what we are testing.
vi.mock('../app/tryonConfig.server.js', () => ({
  getTryonConfig: async () => ({ modelUrl: '/models/x.glb', fitMetadata: {} }),
}))

const prisma = (await import('../app/db.server.js')).default
const { loader } = await import('../app/routes/api.tryon-config.jsx')

function req() {
  return {
    request: new Request(
      `https://x/api/tryon-config?shop=${encodeURIComponent(shop)}&productId=${encodeURIComponent(productId)}`,
    ),
  }
}

afterAll(async () => {
  await prisma.shopSubscription.deleteMany({ where: { shop } })
})

describe('api.tryon-config billing gate', () => {
  it('402 when the shop has no subscription', async () => {
    const res = await loader(req())
    expect(res.status).toBe(402)
  })

  it('serves (200) for an ACTIVE shop', async () => {
    await prisma.shopSubscription.create({ data: { shop, planName: 'Starter', status: 'ACTIVE' } })
    const res = await loader(req())
    expect(res.status).toBe(200)
  })

  it('402 once the grace window has passed', async () => {
    await prisma.shopSubscription.update({
      where: { shop },
      data: { status: 'CANCELLED', graceEndsAt: new Date(Date.now() - 1000) },
    })
    const res = await loader(req())
    expect(res.status).toBe(402)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tryonConfig.billing.test.js`
Expected: FAIL — no gate yet, so the no-subscription case returns 404/200, not 402.

- [ ] **Step 3: Add the gate**

In `apps/shopify-app/app/routes/api.tryon-config.jsx`, add imports and the gate at the top of the loader, after the param check:

```js
import db from '../db.server'
import { getTryonConfig } from '../tryonConfig.server'
import { getShopSubscription, isServable } from '../billing.server'
```

In the loader, after the `if (!shop || !productId)` block and before `getTryonConfig`:

```js
  // Billing gate: a paid feature. Read only the local row (webhook-updated) so
  // this edge-cached path never calls Shopify. Grace is evaluated at read time.
  const sub = await getShopSubscription(db, shop)
  if (!isServable(sub, new Date())) {
    return new Response('subscription required', { status: 402 })
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tryonConfig.billing.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-app/app/routes/api.tryon-config.jsx apps/shopify-app/test/tryonConfig.billing.test.js
git commit -m "feat(billing): gate the storefront try-on config on an active subscription

Returns 402 when the shop is not servable (no active sub and past the 7-day
grace). Reads only the local ShopSubscription row -- no Shopify call -- so the
edge-cached storefront path stays fast."
```

---

### Task 6: Admin subscription gate + pricing redirect

**Files:**
- Modify: `apps/shopify-app/app/routes/app.jsx`
- Modify: `apps/shopify-app/.env.example`

**Interfaces:**
- Consumes: `getActivePlanName` from Task 4.
- Produces: the admin layout redirects a merchant with no active subscription to the Managed Pricing page.

This is the Shopify-integration-heavy task. The pricing page is an admin URL; from the embedded iframe it must open at the top level. `SHOPIFY_APP_HANDLE` is operator-provided (Partner Dashboard app handle). Run from `apps/shopify-app`.

- [ ] **Step 1: Document the env var**

In `apps/shopify-app/.env.example`, under the Shopify section, add:

```
# The app's handle (Partner Dashboard > app > it appears in the app's URLs).
# Used to build the Managed Pricing page URL merchants are sent to when they
# have no active subscription: admin.shopify.com/store/<store>/charges/<handle>/pricing_plans
SHOPIFY_APP_HANDLE=
```

- [ ] **Step 2: Add the gate to the admin loader**

In `apps/shopify-app/app/routes/app.jsx`, replace the loader and component. Update the loader:

```js
export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};
```

with:

```js
import { getActivePlanName } from "../billing.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const activePlan = await getActivePlanName(admin);
  // No active subscription (fresh install, or lapsed -- grace covers only the
  // storefront, not the merchant's own admin). Send them to Managed Pricing.
  let pricingUrl = null;
  if (!activePlan) {
    const store = session.shop.replace(/\.myshopify\.com$/, "");
    // eslint-disable-next-line no-undef
    const handle = process.env.SHOPIFY_APP_HANDLE || "";
    pricingUrl = `https://admin.shopify.com/store/${store}/charges/${handle}/pricing_plans`;
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", pricingUrl };
};
```

Then update the component to break out of the iframe to the pricing page when `pricingUrl` is set:

```jsx
export default function App() {
  const { apiKey, pricingUrl } = useLoaderData();

  useEffect(() => {
    if (pricingUrl) {
      // Top-level navigation: the pricing page is an admin URL, not embeddable.
      window.open(pricingUrl, "_top");
    }
  }, [pricingUrl]);

  if (pricingUrl) {
    return (
      <AppProvider embedded apiKey={apiKey}>
        <s-page>
          <s-section>
            <s-text>Redirecting you to choose a plan…</s-text>
          </s-section>
        </s-page>
      </AppProvider>
    );
  }

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/models">Models</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}
```

Add `useEffect` to the React import at the top:

```jsx
import { useEffect } from "react";
import { Outlet, useLoaderData, useRouteError } from "react-router";
```

- [ ] **Step 3: Verify the build compiles**

Run: `npm run build`
Expected: `react-router build` completes cleanly (only the pre-existing RR v8 future-flag warnings).

No unit test for this task: it is a thin redirect whose only logic (plan present → render app; absent → redirect) is driven by `getActivePlanName`, already tested in Task 4, and the live behavior is verified in Task 8. Do not add a test that just asserts the mock.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify-app/app/routes/app.jsx apps/shopify-app/.env.example
git commit -m "feat(billing): gate the admin behind an active subscription

The admin layout reads the live active plan; with none it sends the merchant
to the Managed Pricing page (top-level, since it is not embeddable). Grace
applies only to the storefront -- the merchant's admin is gated immediately on
lapse. Pricing URL uses the operator-set SHOPIFY_APP_HANDLE."
```

---

### Task 7: Purge `ShopSubscription` on shop redaction

**Files:**
- Modify: `apps/shopify-app/app/webhooks.server.js`
- Modify: `apps/shopify-app/test/webhooks.server.test.js`

**Interfaces:**
- Consumes: `purgeShopData(prisma, shop)`.
- Produces: `purgeShopData` also deletes the shop's `ShopSubscription` row, closing the compliance gap a new shop-keyed table would otherwise open.

Run from `apps/shopify-app`.

- [ ] **Step 1: Extend the purge test**

In `apps/shopify-app/test/webhooks.server.test.js`, extend the `seed` helper and the first assertion. In `seed`, after creating the session, add a subscription row:

```js
  await prisma.shopSubscription.create({
    data: { shop, planName: 'Starter', status: 'ACTIVE' },
  })
```

Extend `counts` to include subscriptions:

```js
async function counts(shop) {
  return {
    assets: await prisma.modelAsset.count({ where: { shop } }),
    mappings: await prisma.productMapping.count({ where: { shop } }),
    sessions: await prisma.session.count({ where: { shop } }),
    subscriptions: await prisma.shopSubscription.count({ where: { shop } }),
  }
}
```

Update `beforeEach` and `afterAll` cleanup loops to also clear subscriptions:

```js
    await prisma.shopSubscription.deleteMany({ where: { shop: s } })
```

And update the two `toEqual` expectations that currently read `{ assets: ..., mappings: ..., sessions: ... }` to include `subscriptions`: the post-purge shopA expectation becomes `{ assets: 0, mappings: 0, sessions: 0, subscriptions: 0 }`, and the "leaves other shops untouched" shopB expectation becomes `{ assets: 1, mappings: 1, sessions: 1, subscriptions: 1 }`. Also update the `it.each` invalid-shop assertion's expected object the same way (shopB seeded → `subscriptions: 1`).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/webhooks.server.test.js`
Expected: FAIL — post-purge `subscriptions` is 1, expected 0 (purge does not touch the new table yet).

- [ ] **Step 3: Add the delete to purgeShopData**

In `apps/shopify-app/app/webhooks.server.js`, in `purgeShopData`, after the `session` deleteMany, add the subscription delete and include it in the return:

```js
  const sessions = await prisma.session.deleteMany({ where: { shop } })
  const subscriptions = await prisma.shopSubscription.deleteMany({ where: { shop } })

  return {
    storageRefs: assets.length,
    mappings: mappings.count,
    assets: deletedAssets.count,
    sessions: sessions.count,
    subscriptions: subscriptions.count,
  }
```

`ShopSubscription` has no foreign keys, so its delete order is unconstrained; placing it after sessions keeps the existing FK-forced order intact.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/webhooks.server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-app/app/webhooks.server.js apps/shopify-app/test/webhooks.server.test.js
git commit -m "fix(billing): purge ShopSubscription on shop/redact

A new shop-keyed table must join purgeShopData or shop/redact leaves
merchant-identifiable billing data behind -- reopening the Phase 2 gap."
```

---

### Task 8: Configure plans, deploy, and verify live (OPERATOR + controller)

**Files:** none — Partner Dashboard config, deploy, and live checks.

**Interfaces:**
- Consumes: Tasks 1–7 merged.
- Produces: the Phase 5 exit criterion — a real test subscription charges, unlocks the admin, and gates at the tier limit.

- [ ] **Step 1: Run the DB-free suites**

Run (repo root): `cd apps/shopify-app && npx vitest run test/billing.server.test.js`
Expected: PASS. (The DB-backed billing suites hit the shared production database; run them deliberately, not as part of a blanket run.)

- [ ] **Step 2: OPERATOR — create the three Managed Pricing plans**

In the Partner Dashboard → app → Pricing, create three plans named **exactly** `Starter`, `Growth`, `Pro` (names are the contract with `PLAN_LIMITS`). Set each plan's price and a **7-day free trial**. Note the app handle for `SHOPIFY_APP_HANDLE`.

- [ ] **Step 3: OPERATOR — set `SHOPIFY_APP_HANDLE`**

Add `SHOPIFY_APP_HANDLE` (the app handle from Step 2) to Vercel (all three environments) and local `apps/shopify-app/.env`.

- [ ] **Step 4: Merge and deploy**

```bash
git checkout main && git merge --ff-only feat/phase5-billing && git push
```
Watch the Vercel build: `prisma migrate deploy` should apply the `ShopSubscription` migration via the direct endpoint. If it reports `P1002`, clear the advisory lock (Global Constraints) and redeploy once.

- [ ] **Step 5: OPERATOR + controller — live verification (the exit criterion)**

On the dev store:
1. Open the app with no subscription → confirm it redirects to the Managed Pricing page.
2. Subscribe to `Starter` (test charge) → confirm the admin unlocks and the `app_subscriptions/update` webhook populated `ShopSubscription` (status ACTIVE).
3. Map products up to 10, then attempt an 11th → confirm the limit message.
4. Open a product's storefront try-on → confirm `api.tryon-config` returns 200 (servable).
5. Cancel the subscription → confirm the admin re-gates to pricing immediately, and the storefront still serves during grace.

- [ ] **Step 6: Record completion in the spec**

Add a "Measured / verified (date)" note to the spec §6 with the observed results, commit, and push.

---

## Out of scope

- Usage-based (per-try-on) billing — no event tracking exists (spec §1).
- A free tier — locked as paid-at-launch.
- Custom pricing UI — Managed Pricing hosts it.
- Annual plans / multiple currencies — Partner Dashboard settings if wanted later, no code.

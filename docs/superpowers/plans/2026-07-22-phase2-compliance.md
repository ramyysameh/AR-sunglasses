# Phase 2 Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app pass Shopify's automated compliance check by subscribing to and correctly answering the three mandatory GDPR webhook topics, backed by a provably tenant-safe data purge.

**Architecture:** Five webhook routes delegate to one shared `purgeShopData(prisma, shop)` module. The purge deletes S3 objects before Postgres rows so a storage failure retries idempotently rather than orphaning GLBs whose only index is the rows being deleted. A hard argument guard prevents Prisma's undefined-filter semantics from degrading a single-tenant purge into an all-tenant wipe.

**Tech Stack:** React Router v7, `@shopify/shopify-app-react-router`, Prisma 6.19.3 → Neon Postgres, AWS S3 (`@aws-sdk/client-s3`), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-22-phase2-compliance-design.md`

## Global Constraints

- All work happens in `apps/shopify-app/`. Run all commands from that directory.
- Tests: `npm test` (vitest, `fileParallelism: false`, `.env` auto-loaded). DB tests hit the **live shared Neon instance**.
- **Every test fixture shop domain must be uniquely generated per run** (`` `x-${randomUUID()}.myshopify.com` ``) and cleaned up in `afterAll`. A predictable or real shop domain in a deletion test destroys live data.
- **Every "nothing was deleted" assertion must be non-vacuous:** seed a *second* shop's rows and assert that count is unchanged. Against an empty table these assertions are trivially true whether or not the code is correct.
- Prisma DI follows the existing codebase pattern: `fn(prisma, shop, ...)`, as in `mapProductToModel`.
- S3 is stubbed in tests by mocking `@aws-sdk/client-s3` — the pattern established in `test/storage.server.test.js`.
- Handlers must never reference `session`; compliance webhooks arrive after uninstall when no `Session` row exists. Use only `shop` from the verified payload.
- Commit after every task.

---

### Task 1: `deleteModelGlb` in the storage layer

**Files:**
- Modify: `app/storage.server.js`
- Test: `test/storage.server.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `deleteModelGlb(storageRef: string) => Promise<void>`. Task 2 calls this.

- [ ] **Step 1: Write the failing tests**

Add to `test/storage.server.test.js`. First extend the existing `vi.mock` factory to know about the delete command — replace the `return { S3Client: FakeClient, PutObjectCommand, GetObjectCommand }` line with:

```js
  class DeleteObjectCommand {
    constructor(input) {
      this.input = input
      this.type = 'Delete'
    }
  }
  return { S3Client: FakeClient, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
```

Change the import line to pull in the new function:

```js
const { saveModelGlb, readModelGlb, deleteModelGlb } = await import('../app/storage.server.js')
```

Then append:

```js
describe('deleteModelGlb', () => {
  it('deletes the object from the configured bucket', async () => {
    await deleteModelGlb('abc-123.glb')

    expect(hoisted.sent).toHaveLength(1)
    const cmd = hoisted.sent[0]
    expect(cmd.type).toBe('Delete')
    expect(cmd.input.Bucket).toBe('models-bucket')
    expect(cmd.input.Key).toBe('abc-123.glb')
  })

  it('treats an already-absent object as success so redact retries are idempotent', async () => {
    hoisted.nextError = Object.assign(new Error('missing'), { name: 'NoSuchKey' })
    await expect(deleteModelGlb('gone.glb')).resolves.toBeUndefined()
  })

  it('rethrows real failures so a purge aborts before touching the database', async () => {
    // AccessDenied is the expected error until s3:DeleteObject is granted.
    // It MUST propagate: swallowing it would let the DB purge proceed and
    // orphan the GLBs whose only index is the rows about to be deleted.
    hoisted.nextError = Object.assign(new Error('denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    })
    await expect(deleteModelGlb('x.glb')).rejects.toThrow('denied')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/storage.server.test.js`
Expected: FAIL — `deleteModelGlb is not a function`.

- [ ] **Step 3: Implement**

In `app/storage.server.js`, extend the import on line 1:

```js
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
```

Append at end of file:

```js
/**
 * Deletes one stored GLB. Used by the shop/redact purge.
 *
 * An absent object resolves successfully: S3 delete is idempotent by design and
 * a redact webhook can be delivered more than once.
 *
 * Every other failure rethrows. This is load-bearing — `purgeShopData` deletes
 * objects before database rows precisely so that a storage failure aborts the
 * purge with the rows still intact, leaving the retry able to recompute the
 * same object list. Swallowing an error here would defeat that.
 */
export async function deleteModelGlb(storageRef) {
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageRef }),
    )
  } catch (error) {
    const missing =
      error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404
    if (!missing) {
      throw error
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/storage.server.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add app/storage.server.js test/storage.server.test.js
git commit -m "feat(storage): add deleteModelGlb for the shop/redact purge"
```

---

### Task 2: `purgeShopData` with the invalid-shop guard

This is the highest-risk task in the phase. A bug here is a cross-tenant data destruction incident.

**Files:**
- Create: `app/webhooks.server.js`
- Test: `test/webhooks.server.test.js`

**Interfaces:**
- Consumes: `deleteModelGlb` from Task 1.
- Produces: `purgeShopData(prisma, shop) => Promise<{ storageRefs: number, mappings: number, assets: number, sessions: number }>`. **Task 3 (`shop/redact`) is the only caller.** Task 5 (`app/uninstalled`) must NOT call this — see D2.

- [ ] **Step 1: Write the failing tests**

Create `test/webhooks.server.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'

const hoisted = vi.hoisted(() => ({ sent: [], nextError: null }))

vi.mock('@aws-sdk/client-s3', () => {
  class FakeClient {
    async send(command) {
      hoisted.sent.push(command)
      if (hoisted.nextError) throw hoisted.nextError
      return null
    }
  }
  class PutObjectCommand { constructor(i) { this.input = i; this.type = 'Put' } }
  class GetObjectCommand { constructor(i) { this.input = i; this.type = 'Get' } }
  class DeleteObjectCommand { constructor(i) { this.input = i; this.type = 'Delete' } }
  return { S3Client: FakeClient, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
})

process.env.S3_BUCKET = 'models-bucket'

const prisma = (await import('../app/db.server.js')).default
const { purgeShopData } = await import('../app/webhooks.server.js')

// Unique per run: these tests DELETE, and a predictable domain could collide
// with real data in the shared Neon instance.
const tag = randomUUID().slice(0, 8)
const shopA = `purge-a-${tag}.myshopify.com`
const shopB = `purge-b-${tag}.myshopify.com`

async function seed(shop, refs) {
  const assets = []
  for (const ref of refs) {
    assets.push(
      await prisma.modelAsset.create({
        data: { shop, storageRef: ref, fitMetadata: { version: 'eyewear-v1' } },
      }),
    )
  }
  await prisma.productMapping.create({
    data: { shop, productId: `gid://shopify/Product/${shop}`, modelAssetId: assets[0].id },
  })
  await prisma.session.create({
    data: { id: `sess-${shop}`, shop, state: 'x', accessToken: 't' },
  })
  return assets
}

async function counts(shop) {
  return {
    assets: await prisma.modelAsset.count({ where: { shop } }),
    mappings: await prisma.productMapping.count({ where: { shop } }),
    sessions: await prisma.session.count({ where: { shop } }),
  }
}

beforeEach(async () => {
  hoisted.sent = []
  hoisted.nextError = null
  for (const s of [shopA, shopB]) {
    await prisma.productMapping.deleteMany({ where: { shop: s } })
    await prisma.modelAsset.deleteMany({ where: { shop: s } })
    await prisma.session.deleteMany({ where: { shop: s } })
  }
})

afterAll(async () => {
  for (const s of [shopA, shopB]) {
    await prisma.productMapping.deleteMany({ where: { shop: s } })
    await prisma.modelAsset.deleteMany({ where: { shop: s } })
    await prisma.session.deleteMany({ where: { shop: s } })
  }
})

describe('purgeShopData', () => {
  it('deletes every row for the shop, foreign key order included', async () => {
    await seed(shopA, [`${tag}/a1.glb`, `${tag}/a2.glb`])

    const result = await purgeShopData(prisma, shopA)

    expect(await counts(shopA)).toEqual({ assets: 0, mappings: 0, sessions: 0 })
    expect(result.assets).toBe(2)
    expect(result.mappings).toBe(1)
    expect(result.sessions).toBe(1)
  })

  it('leaves other shops completely untouched', async () => {
    await seed(shopA, [`${tag}/a1.glb`])
    await seed(shopB, [`${tag}/b1.glb`])

    await purgeShopData(prisma, shopA)

    expect(await counts(shopB)).toEqual({ assets: 1, mappings: 1, sessions: 1 })
    const deletedKeys = hoisted.sent.map((c) => c.input.Key)
    expect(deletedKeys).toEqual([`${tag}/a1.glb`])
  })

  it('deletes every storage ref belonging to the shop', async () => {
    await seed(shopA, [`${tag}/a1.glb`, `${tag}/a2.glb`, `${tag}/a3.glb`])

    await purgeShopData(prisma, shopA)

    expect(hoisted.sent.map((c) => c.input.Key).sort()).toEqual([
      `${tag}/a1.glb`, `${tag}/a2.glb`, `${tag}/a3.glb`,
    ])
  })

  it('is idempotent — a second purge succeeds', async () => {
    await seed(shopA, [`${tag}/a1.glb`])
    await purgeShopData(prisma, shopA)
    await expect(purgeShopData(prisma, shopA)).resolves.toBeTruthy()
  })

  it('aborts before deleting any row when storage fails', async () => {
    await seed(shopA, [`${tag}/a1.glb`])
    hoisted.nextError = Object.assign(new Error('denied'), { name: 'AccessDenied' })

    await expect(purgeShopData(prisma, shopA)).rejects.toThrow('denied')

    // Rows intact, so Shopify's retry recomputes the same object list.
    expect(await counts(shopA)).toEqual({ assets: 1, mappings: 1, sessions: 1 })
  })

  // D7. Prisma DROPS undefined filters: deleteMany({where:{shop: undefined}})
  // becomes deleteMany({}) and wipes every tenant. Empty string is a REAL
  // filter matching nothing, so it is harmless — only undefined is fatal.
  // Both must throw, but this test is only meaningful because shopB is seeded:
  // "deleted nothing" is trivially true against an empty table.
  it.each([undefined, null, '', 0, 123, {}])(
    'refuses to purge with invalid shop %p, deleting nothing',
    async (bad) => {
      await seed(shopB, [`${tag}/b1.glb`])

      await expect(purgeShopData(prisma, bad)).rejects.toThrow(TypeError)

      expect(await counts(shopB)).toEqual({ assets: 1, mappings: 1, sessions: 1 })
      expect(hoisted.sent).toHaveLength(0)
    },
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/webhooks.server.test.js`
Expected: FAIL — cannot resolve `../app/webhooks.server.js`.

- [ ] **Step 3: Implement**

Create `app/webhooks.server.js`:

```js
import { deleteModelGlb } from './storage.server.js'

/**
 * Erases every trace of a shop: S3 objects first, then database rows.
 *
 * ORDER IS LOAD-BEARING. `ModelAsset.storageRef` is the only record of which
 * S3 objects belong to a shop. Deleting rows first and then failing on storage
 * would permanently lose that index, orphaning the objects in the bucket with
 * no way to find them again. Deleting storage first inverts the failure into a
 * safe one: the error propagates, the route returns 500, Shopify retries, and
 * because no row was touched the retry recomputes an identical list. S3 delete
 * on an absent key and Prisma deleteMany on an empty match are both no-ops, so
 * repeated delivery is clean.
 *
 * Database order is forced by the ProductMapping -> ModelAsset foreign key.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} shop myshopify domain, from an HMAC-verified payload
 */
export async function purgeShopData(prisma, shop) {
  // D7. This function is reused outside the HMAC-verified webhook path
  // (support tooling, manual redaction), where `shop` carries no guarantee.
  // Prisma drops undefined filter values rather than matching nothing, so
  // deleteMany({ where: { shop: undefined } }) silently becomes
  // deleteMany({}) and deletes EVERY TENANT'S ROWS. Verified against Neon on
  // Prisma 6.19.3. Guard before any client call.
  if (!shop || typeof shop !== 'string') {
    throw new TypeError(
      `purgeShopData: refusing to purge with invalid shop: ${String(shop)}`,
    )
  }

  const assets = await prisma.modelAsset.findMany({
    where: { shop },
    select: { storageRef: true },
  })

  for (const { storageRef } of assets) {
    await deleteModelGlb(storageRef)
  }

  const mappings = await prisma.productMapping.deleteMany({ where: { shop } })
  const deletedAssets = await prisma.modelAsset.deleteMany({ where: { shop } })
  const sessions = await prisma.session.deleteMany({ where: { shop } })

  return {
    storageRefs: assets.length,
    mappings: mappings.count,
    assets: deletedAssets.count,
    sessions: sessions.count,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/webhooks.server.test.js`
Expected: PASS, 11 tests (5 + 6 parameterised guard cases).

- [ ] **Step 5: Commit**

```bash
git add app/webhooks.server.js test/webhooks.server.test.js
git commit -m "feat(webhooks): add purgeShopData with invalid-shop guard

Storage deletes precede database deletes so a failure aborts with rows
intact and Shopify's retry recomputes the same object list.

Guards the shop argument because Prisma drops undefined filters, turning
a single-tenant purge into deleteMany({}) across every tenant."
```

---

### Task 3: `shop/redact` route

**Files:**
- Create: `app/routes/webhooks.shop.redact.jsx`
- Test: `test/webhooks.routes.test.js`

**Interfaces:**
- Consumes: `purgeShopData` from Task 2.
- Produces: route at `/webhooks/shop/redact`.

- [ ] **Step 1: Write the failing test**

Create `test/webhooks.routes.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  webhookResult: null,
  webhookError: null,
  purgeCalls: [],
  purgeError: null,
}))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    webhook: async () => {
      if (hoisted.webhookError) throw hoisted.webhookError
      return hoisted.webhookResult
    },
  },
}))

vi.mock('../app/webhooks.server.js', () => ({
  purgeShopData: async (_prisma, shop) => {
    if (hoisted.purgeError) throw hoisted.purgeError
    hoisted.purgeCalls.push(shop)
    return { storageRefs: 1, mappings: 1, assets: 1, sessions: 1 }
  },
}))

vi.mock('../app/db.server.js', () => ({ default: {} }))

const shopRedact = await import('../app/routes/webhooks.shop.redact.jsx')

beforeEach(() => {
  hoisted.webhookResult = null
  hoisted.webhookError = null
  hoisted.purgeCalls = []
  hoisted.purgeError = null
})

const request = () => new Request('https://app.test/webhooks/shop/redact', { method: 'POST' })

describe('shop/redact route', () => {
  it('purges the shop and returns 200', async () => {
    hoisted.webhookResult = { shop: 'acme.myshopify.com', topic: 'SHOP_REDACT', payload: {} }

    const response = await shopRedact.action({ request: request() })

    expect(response.status).toBe(200)
    expect(hoisted.purgeCalls).toEqual(['acme.myshopify.com'])
  })

  it('does not purge when HMAC verification rejects', async () => {
    // authenticate.webhook throws a Response on bad HMAC, before the handler
    // body runs. Nothing may be deleted on an unverified request.
    hoisted.webhookError = new Response('Unauthorized', { status: 401 })

    await expect(shopRedact.action({ request: request() })).rejects.toBeInstanceOf(Response)
    expect(hoisted.purgeCalls).toEqual([])
  })

  it('propagates a purge failure so Shopify retries instead of seeing a false success', async () => {
    hoisted.webhookResult = { shop: 'acme.myshopify.com', topic: 'SHOP_REDACT', payload: {} }
    hoisted.purgeError = new Error('denied')

    // Must reject, not resolve. A 200 on a failed purge would tell Shopify the
    // data was erased when it was not.
    await expect(shopRedact.action({ request: request() })).rejects.toThrow('denied')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/webhooks.routes.test.js`
Expected: FAIL — cannot resolve `../app/routes/webhooks.shop.redact.jsx`.

- [ ] **Step 3: Implement**

Create `app/routes/webhooks.shop.redact.jsx`:

```jsx
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { purgeShopData } from "../webhooks.server";

/**
 * Mandatory GDPR topic. Shopify sends this ~48h after uninstall and expects
 * every trace of the shop to be gone.
 *
 * Deliberately does NOT read `session`: this fires after uninstall, when the
 * Session row is already gone and authenticate.webhook returns session as
 * undefined. Only `shop`, which comes from the HMAC-verified payload, is safe
 * to rely on.
 *
 * A purge failure propagates on purpose. Returning 200 on a failed purge would
 * tell Shopify the data was erased when it was not; a 500 makes Shopify retry
 * over ~48h, and the purge is idempotent under retry.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  const result = await purgeShopData(db, shop);

  console.log(
    JSON.stringify({
      event: "compliance_webhook",
      topic,
      shop,
      action: "purged",
      ...result,
      at: new Date().toISOString(),
    }),
  );

  return new Response();
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/webhooks.routes.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add app/routes/webhooks.shop.redact.jsx test/webhooks.routes.test.js
git commit -m "feat(webhooks): add shop/redact handler"
```

---

### Task 4: `customers/data_request` and `customers/redact` routes

**Files:**
- Create: `app/routes/webhooks.customers.data_request.jsx`
- Create: `app/routes/webhooks.customers.redact.jsx`
- Modify: `test/webhooks.routes.test.js`

**Interfaces:**
- Consumes: nothing beyond `authenticate`.
- Produces: routes at `/webhooks/customers/data_request` and `/webhooks/customers/redact`.

- [ ] **Step 1: Write the failing tests**

Append to `test/webhooks.routes.test.js`:

```js
describe('customers compliance routes', () => {
  it.each([
    ['webhooks.customers.data_request.jsx', 'CUSTOMERS_DATA_REQUEST'],
    ['webhooks.customers.redact.jsx', 'CUSTOMERS_REDACT'],
  ])('%s acknowledges with 200 and purges nothing', async (file, topic) => {
    hoisted.webhookResult = { shop: 'acme.myshopify.com', topic, payload: {} }
    const mod = await import(`../app/routes/${file}`)

    const response = await mod.action({
      request: new Request('https://app.test/webhooks', { method: 'POST' }),
    })

    expect(response.status).toBe(200)
    // The app stores no shopper data, so these must never touch shop data.
    expect(hoisted.purgeCalls).toEqual([])
  })

  it.each([
    'webhooks.customers.data_request.jsx',
    'webhooks.customers.redact.jsx',
  ])('%s rejects an unverified request', async (file) => {
    hoisted.webhookError = new Response('Unauthorized', { status: 401 })
    const mod = await import(`../app/routes/${file}`)

    await expect(
      mod.action({ request: new Request('https://app.test/webhooks', { method: 'POST' }) }),
    ).rejects.toBeInstanceOf(Response)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/webhooks.routes.test.js`
Expected: FAIL — cannot resolve the two route modules.

- [ ] **Step 3: Implement both routes**

Create `app/routes/webhooks.customers.data_request.jsx`:

```jsx
import { authenticate } from "../shopify.server";

/**
 * Mandatory GDPR topic: a shopper has asked what personal data we hold.
 *
 * THIS IS INTENTIONALLY A NO-OP, NOT AN UNIMPLEMENTED STUB.
 *
 * The app stores no shopper personal data. Face tracking runs entirely
 * client-side via MediaPipe; the camera feed never leaves the device and no
 * frame is ever transmitted. Verified against the schema on 2026-07-22: the
 * only tables are Session, ModelAsset and ProductMapping, holding the shop
 * domain, merchant STAFF identity from OAuth, uploaded GLBs and product
 * mappings. Nothing is keyed to a shopper.
 *
 * There is therefore nothing to return. Acknowledging with 200 is the correct
 * and complete response.
 *
 * If a shopper-keyed table is ever added — a try-on event log, per-visitor
 * analytics — this handler becomes non-compliant and must return real data.
 * See the spec's verification block and re-run it.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(
    JSON.stringify({
      event: "compliance_webhook",
      topic,
      shop,
      action: "acknowledged_no_data_stored",
      at: new Date().toISOString(),
    }),
  );

  return new Response();
};
```

Create `app/routes/webhooks.customers.redact.jsx` with the identical body, replacing the docblock's second paragraph opener with:

```jsx
/**
 * Mandatory GDPR topic: a shopper has asked us to erase their personal data.
 *
 * THIS IS INTENTIONALLY A NO-OP, NOT AN UNIMPLEMENTED STUB.
 *
 * The app stores no shopper personal data — see the note in
 * webhooks.customers.data_request.jsx for the full reasoning and the schema
 * verification. There is nothing to erase.
 *
 * Merchant staff data is covered by shop/redact, not this topic.
 */
export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(
    JSON.stringify({
      event: "compliance_webhook",
      topic,
      shop,
      action: "acknowledged_no_data_stored",
      at: new Date().toISOString(),
    }),
  );

  return new Response();
};
```

with `import { authenticate } from "../shopify.server";` at the top.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/webhooks.routes.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add app/routes/webhooks.customers.data_request.jsx app/routes/webhooks.customers.redact.jsx test/webhooks.routes.test.js
git commit -m "feat(webhooks): add customers/data_request and customers/redact

Both acknowledge with 200. The app stores no shopper personal data --
verified against the schema, and documented in each handler so the no-op
is not misread as unimplemented."
```

---

### Task 5: Document why `app/uninstalled` does not purge

**Files:**
- Modify: `app/routes/webhooks.app.uninstalled.jsx`

**Interfaces:** unchanged. Behavior is unchanged — this task adds only a comment.

- [ ] **Step 1: Add the comment**

Replace the body of `app/routes/webhooks.app.uninstalled.jsx` with:

```jsx
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Uninstall revokes access. It deliberately does NOT purge the merchant's
 * models.
 *
 * Shopify's model separates the two: uninstall means stop processing,
 * shop/redact (~48h later) means erase. Honouring that separation means a
 * merchant who uninstalls by accident and reinstalls within the window keeps
 * every calibrated model — and calibration is expensive to redo.
 *
 * Full erasure lives in webhooks.shop.redact.jsx via purgeShopData. Do not
 * "fix" this by deleting ModelAsset/ProductMapping here.
 */
export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
```

- [ ] **Step 2: Run the full suite to confirm no regression**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 3: Commit**

```bash
git add app/routes/webhooks.app.uninstalled.jsx
git commit -m "docs(webhooks): record why app/uninstalled does not purge models"
```

---

### Task 6: Restore webhook subscriptions and fix the API version

**Files:**
- Modify: `apps/shopify-app/shopify.app.toml:11-14`

**Interfaces:** produces the subscriptions Shopify's compliance check looks for.

- [ ] **Step 1: Replace the `[webhooks]` section**

Replace lines 11-14 of `shopify.app.toml`:

```toml
[webhooks]
# Must match the ApiVersion pinned in app/shopify.server.js (October25 = 2025-10).
# This previously read "2026-10", which is not a version the installed
# @shopify/shopify-api knows about at all -- its enum tops out at 2026-07.
# Webhook payload shapes are versioned, so the two must not drift.
api_version = "2025-10"

# Handled by: app/routes/webhooks.app.uninstalled.jsx
[[webhooks.subscriptions]]
topics = [ "app/uninstalled" ]
uri = "/webhooks/app/uninstalled"

# Handled by: app/routes/webhooks.app.scopes_update.jsx
[[webhooks.subscriptions]]
topics = [ "app/scopes_update" ]
uri = "/webhooks/app/scopes_update"

# Mandatory GDPR topics. Note these use `compliance_topics`, NOT `topics` --
# the CLI silently ignores compliance topics declared under `topics`.
# Handled by: app/routes/webhooks.customers.data_request.jsx
[[webhooks.subscriptions]]
compliance_topics = [ "customers/data_request" ]
uri = "/webhooks/customers/data_request"

# Handled by: app/routes/webhooks.customers.redact.jsx
[[webhooks.subscriptions]]
compliance_topics = [ "customers/redact" ]
uri = "/webhooks/customers/redact"

# Handled by: app/routes/webhooks.shop.redact.jsx
[[webhooks.subscriptions]]
compliance_topics = [ "shop/redact" ]
uri = "/webhooks/shop/redact"
```

- [ ] **Step 2: Verify the config parses**

Run: `npm run build`
Expected: clean build, no TOML parse error.

- [ ] **Step 3: Commit**

```bash
git add shopify.app.toml
git commit -m "config(app): restore lifecycle webhooks, add compliance topics

Also corrects api_version from 2026-10 -- a version absent from the
installed library's enum -- to 2025-10, matching the code's pin."
```

---

### Task 7: Public privacy policy route

**Files:**
- Create: `app/routes/privacy.jsx`

**Interfaces:** produces a public page at `/privacy` for the Phase 6 listing.

- [ ] **Step 1: Create the route**

Create `app/routes/privacy.jsx`:

```jsx
/**
 * Public privacy policy. Deliberately outside the `app.` route prefix so it
 * bypasses embedded auth -- the App Store listing needs a URL reachable by
 * anyone, and Shopify's reviewers check that it resolves.
 */
export const meta = () => [{ title: "Privacy Policy — AR Try-on" }];

const UPDATED = "22 July 2026";
const CONTACT = "ramy.sameh2@gmail.com";

export default function Privacy() {
  return (
    <main style={{ maxWidth: "42rem", margin: "0 auto", padding: "2rem 1.5rem", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: {UPDATED}</em></p>

      <h2>Camera and face data</h2>
      <p>
        AR Try-on renders eyewear on your face using your device camera. All face
        tracking runs entirely in your browser, on your device. The camera feed is
        never transmitted to our servers, never recorded, and never stored. No
        image, video frame, or biometric template of your face leaves your device
        at any point.
      </p>
      <p>
        When you close the try-on view, the camera stops and nothing about your
        face persists anywhere.
      </p>

      <h2>What we store</h2>
      <p>We store only data belonging to the merchant operating the store:</p>
      <ul>
        <li>The store&rsquo;s myshopify domain.</li>
        <li>
          Authentication credentials and the name and email of the staff member
          who installed the app, supplied by Shopify during installation.
        </li>
        <li>3D eyewear models uploaded by the merchant, and their fit measurements.</li>
        <li>Which model is shown on which product.</li>
      </ul>
      <p>
        We store no data about shoppers. We do not track visitors, log try-on
        sessions, or build profiles.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        Uninstalling the app immediately revokes our access to the store. All
        remaining store data is permanently deleted when Shopify notifies us of
        the uninstall, approximately 48 hours later. This includes uploaded
        models and their stored files.
      </p>

      <h2>Service providers</h2>
      <p>
        We use Vercel (application hosting), Neon (database), and Amazon Web
        Services S3 (storage of merchant-uploaded models). Merchant data as
        described above is processed by these providers on our behalf. No shopper
        or camera data is sent to any of them, because none is ever collected.
      </p>

      <h2>Your rights</h2>
      <p>
        Under the GDPR and similar laws you may request access to, correction of,
        deletion of, or a portable copy of your personal data. Contact us at{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will respond within 30
        days. Shoppers who submit a request through Shopify should note that we
        hold no shopper data to return or erase.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </main>
  );
}
```

- [ ] **Step 2: Verify it builds and renders**

Run: `npm run build`
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app/routes/privacy.jsx
git commit -m "feat(app): add public privacy policy at /privacy"
```

---

### Task 9: Attribute block-registered models to the real shop

**Added 2026-07-22 during execution.** Task 2's review surfaced that
`registerModelByUrl` stores every block-registered model under
`BLOCK_SHOP = '__block__'`, so `purgeShopData(shop)` never erases them. Those
rows carry `sourceUrl`, a Shopify CDN URL embedding the merchant's store ID, so
they are merchant-identifiable and would survive redaction permanently. This
task closes that hole; without it `shop/redact` is incomplete and the phase's
exit criteria are not met.

The live database has **zero** `ModelAsset` rows, so no backfill is required.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_model_asset_shop_source_url/migration.sql`
- Modify: `app/models.server.js:49-78`
- Modify: `app/routes/api.register-model.jsx`
- Test: `test/registerModelByUrl.server.test.js`, `test/api.register-model.test.js`

**Interfaces:**
- Consumes: `purgeShopData` from Task 2 (unchanged — it already filters on `shop`; this task makes the data match).
- Produces: `registerModelByUrl(prisma, url, shop) => Promise<{ modelUrl, fitMetadata }>` — **note the new third parameter.** Task 10's engine change supplies it over the wire.

- [ ] **Step 1: Change the schema**

In `prisma/schema.prisma`, drop the global unique on `sourceUrl` and add a
composite unique. Replace the `sourceUrl` line and add the index:

```prisma
model ModelAsset {
  id          String   @id @default(uuid())
  shop        String
  sourceUrl   String?
  storageRef  String
  fitMetadata Json
  confidence  Float?
  status      String   @default("ready")
  createdAt   DateTime @default(now())
  mappings    ProductMapping[]

  // Was @unique on sourceUrl alone, which shared one calibrated asset across
  // every shop. Attribution is now per-shop so shop/redact can erase a
  // merchant's block models, which means the same URL may legitimately exist
  // once per shop.
  @@unique([shop, sourceUrl])
}
```

- [ ] **Step 2: Generate the migration offline**

Do NOT run `prisma migrate dev` — it wants a shadow database. Use the same
offline diff approach Phase 1 used:

```bash
mkdir -p prisma/migrations/20260722000000_model_asset_shop_source_url
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$DATABASE_URL" \
  --script > prisma/migrations/20260722000000_model_asset_shop_source_url/migration.sql
cat prisma/migrations/20260722000000_model_asset_shop_source_url/migration.sql
```

Expected SQL, roughly:

```sql
DROP INDEX "ModelAsset_sourceUrl_key";
CREATE UNIQUE INDEX "ModelAsset_shop_sourceUrl_key" ON "ModelAsset"("shop", "sourceUrl");
```

Then apply and regenerate:

```bash
npx prisma migrate deploy && npx prisma generate
```

- [ ] **Step 3: Write the failing tests**

In `test/registerModelByUrl.server.test.js`, add a shop constant near `URL_A`:

```js
const SHOP = 'block-attr-test.myshopify.com'
```

Update the `afterAll` cleanup to also clear by shop:

```js
afterAll(async () => {
  vi.unstubAllGlobals()
  storage.objects.clear()
  await prisma.modelAsset.deleteMany({ where: { sourceUrl: { in: [URL_A, URL_B] } } })
  await prisma.modelAsset.deleteMany({ where: { shop: SHOP } })
})
```

Change both existing calls to pass the shop — `registerModelByUrl(prisma, URL_A, SHOP)` and both `URL_B` calls — and replace the `'__block__'` assertion:

```js
    expect(asset.shop).toBe(SHOP)
```

Then append:

```js
describe('registerModelByUrl shop attribution', () => {
  it('refuses to register without a valid shop, so no unattributable row is created', async () => {
    // An unattributed row can never be erased by shop/redact. Rejecting is the
    // only safe outcome.
    for (const bad of [undefined, null, '', 'not-a-shop', 123]) {
      await expect(registerModelByUrl(prisma, URL_A, bad)).rejects.toThrow(TypeError)
    }
    expect(await prisma.modelAsset.count({ where: { sourceUrl: URL_A } })).toBe(0)
  })

  it('purgeShopData erases a block-registered model', async () => {
    const bytes = await taggedGlbBytes()
    stubFetchReturning(bytes)
    await registerModelByUrl(prisma, URL_A, SHOP)
    expect(await prisma.modelAsset.count({ where: { shop: SHOP } })).toBe(1)

    const { purgeShopData } = await import('../app/webhooks.server.js')
    await purgeShopData(prisma, SHOP)

    // The whole point of this task.
    expect(await prisma.modelAsset.count({ where: { shop: SHOP } })).toBe(0)
  })
})
```

Note the second test runs the real `purgeShopData` with storage stubbed by this
file's existing mock, so `deleteModelGlb` must be added to that mock's return
object:

```js
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (ref, bytes) => {
    storage.objects.set(ref, Buffer.from(bytes))
  },
  readModelGlb: async (ref) => storage.objects.get(ref) ?? null,
  deleteModelGlb: async (ref) => {
    storage.objects.delete(ref)
  },
}))
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -- test/registerModelByUrl.server.test.js`
Expected: FAIL — `registerModelByUrl` ignores the third argument, so the shop
assertion sees `__block__` and the guard test does not throw.

- [ ] **Step 5: Implement**

In `app/models.server.js`, replace lines 49-57 (the `BLOCK_SHOP` constant, the
comment above it, and the function signature + dedupe lookup) with:

```js
// Block-level GLB: calibrate a merchant-hosted GLB once and cache it, keyed by
// (shop, sourceUrl).
//
// Previously keyed by sourceUrl alone under a synthetic '__block__' shop, which
// shared one calibrated asset across every shop. That made the row invisible to
// purgeShopData: a merchant's block models survived shop/redact permanently,
// even though sourceUrl embeds their CDN store ID. Attribution is per-shop so
// redaction can find them. The cost is that two shops pasting the same URL each
// get their own calibration, which is correct and effectively never happens —
// Shopify CDN URLs embed the store id.
export async function registerModelByUrl(prisma, url, shop) {
  // An unattributed row can never be erased by shop/redact, so refuse to create
  // one. NOTE: this route is public and unauthenticated, so `shop` is caller-
  // supplied and this check is a data-integrity guard, NOT a security boundary
  // — it does not prove the caller owns the shop. Authenticating this endpoint
  // is Phase 3 (register-model hardening).
  if (!shop || typeof shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
    throw new TypeError(`registerModelByUrl: invalid shop: ${String(shop)}`)
  }

  const existing = await prisma.modelAsset.findFirst({ where: { shop, sourceUrl: url } })
  if (existing) {
    return { modelUrl: `/models/${existing.id}.glb`, fitMetadata: existing.fitMetadata }
  }
```

and change the `create` data's shop (was `shop: BLOCK_SHOP`):

```js
      shop,
```

- [ ] **Step 6: Wire the route**

Replace the `loader` in `app/routes/api.register-model.jsx`:

```jsx
export const loader = async ({ request }) => {
  const url = new URL(request.url)
  const modelUrl = url.searchParams.get('url')
  const shop = url.searchParams.get('shop')
  if (!modelUrl || !/^https:\/\//i.test(modelUrl)) {
    return Response.json({ error: 'a valid https url is required' }, { status: 400, headers: CORS })
  }
  // Required so the resulting ModelAsset is attributable and therefore
  // erasable by shop/redact. The engine always has this — the theme block
  // passes shop.permanent_domain into the iframe URL.
  if (!shop) {
    return Response.json({ error: 'shop is required' }, { status: 400, headers: CORS })
  }
  try {
    const cfg = await registerModelByUrl(db, modelUrl, shop)
    return Response.json(cfg, { headers: CORS })
  } catch (err) {
    const message = err?.message ?? 'registration failed'
    const status = /^fetch failed/i.test(message) ? 502 : 422
    return Response.json({ error: message }, { status, headers: CORS })
  }
}
```

- [ ] **Step 7: Add the route test**

Append to `test/api.register-model.test.js`:

```js
it('rejects a request with no shop so no unattributable asset is created', async () => {
  const response = await loader({
    request: new Request('https://app.test/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fa.glb'),
  })
  expect(response.status).toBe(400)
  expect((await response.json()).error).toMatch(/shop is required/)
})
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations app/models.server.js app/routes/api.register-model.jsx test/registerModelByUrl.server.test.js test/api.register-model.test.js
git commit -m "fix(compliance): attribute block-registered models to the real shop

Block models were stored under a synthetic '__block__' shop, so
purgeShopData never erased them -- and sourceUrl embeds the merchant's
CDN store id, making those rows merchant-identifiable data that survived
shop/redact permanently.

Keys ModelAsset by (shop, sourceUrl) instead of sourceUrl alone and
requires shop at the public route. The shop check is a data-integrity
guard, not a security boundary; authenticating this endpoint is Phase 3."
```

---

### Task 10: Forward the shop from the engine to register-model

**Files:**
- Create: `src/tryon/registerModelUrl.js`
- Modify: `main.js:79`
- Test: `test/tryon/registerModelUrl.test.js`

Run from the **repo root**, not `apps/shopify-app` — this is the engine.

**Interfaces:**
- Consumes: Task 9's `?shop=` requirement on `/api/register-model`.
- Produces: `buildRegisterModelUrl(modelUrl, shop) => string`.

The theme block already passes `shop.permanent_domain` into the iframe URL and
`main.js:18` already parses it into `shop`. The only gap is that
`resolveBlockModelKey` does not forward it. Extracting a pure helper keeps the
change testable — `main.js` runs side effects at import and cannot be unit
tested directly.

- [ ] **Step 1: Write the failing test**

Create `test/tryon/registerModelUrl.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildRegisterModelUrl } from '../../src/tryon/registerModelUrl.js'

describe('buildRegisterModelUrl', () => {
  it('includes both the model url and the shop, encoded', () => {
    const url = buildRegisterModelUrl(
      'https://cdn.shopify.com/s/files/1/0868/a b.glb',
      'demo-shop.myshopify.com',
    )
    expect(url).toBe(
      '/api/register-model?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2F0868%2Fa%20b.glb&shop=demo-shop.myshopify.com',
    )
  })

  it('throws without a shop, since the app rejects an unattributed registration', () => {
    // Failing loudly here beats a 400 the engine would silently swallow into a
    // fallback, hiding the real cause.
    expect(() => buildRegisterModelUrl('https://cdn.shopify.com/a.glb', undefined)).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/tryon/registerModelUrl.test.js`
Expected: FAIL — cannot resolve `../../src/tryon/registerModelUrl.js`.

- [ ] **Step 3: Implement**

Create `src/tryon/registerModelUrl.js`:

```js
/**
 * Builds the register-model request URL.
 *
 * `shop` is required: the app stores the resulting ModelAsset under it so that
 * shop/redact can erase the merchant's block models. Registering without one
 * would create a row no redaction could ever find.
 */
export function buildRegisterModelUrl(modelUrl, shop) {
  if (!shop) {
    throw new Error('buildRegisterModelUrl: shop is required')
  }
  return `/api/register-model?url=${encodeURIComponent(modelUrl)}&shop=${encodeURIComponent(shop)}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- test/tryon/registerModelUrl.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it into main.js**

Add the import alongside the other `src/tryon` imports at the top of `main.js`:

```js
import { buildRegisterModelUrl } from './src/tryon/registerModelUrl.js'
```

(Match the exact relative path style used by the neighbouring imports in that
file — check them before writing.)

Replace line 79:

```js
    const response = await fetch(buildRegisterModelUrl(modelUrl, shop))
```

- [ ] **Step 6: Verify the engine still builds and the suite passes**

```bash
npm test
npm run build:engine
```

Expected: all engine tests pass, build clean.

- [ ] **Step 7: Commit**

```bash
git add src/tryon/registerModelUrl.js test/tryon/registerModelUrl.test.js main.js
git commit -m "fix(engine): forward shop to register-model

The app now requires shop so block-registered models are attributable
and erasable by shop/redact. The theme block already supplies it and
main.js already parses it -- it just was not being sent."
```

---

### Task 8: Deploy and verify against the live app

**Run this task LAST — after Tasks 9 and 10.**

**This task cannot be satisfied by unit tests.** Tasks 1-7 stub S3, so the whole suite passes green whether or not the IAM policy grants `s3:DeleteObject`. CI-green and exit-criteria-met are independent conditions here, and the gap is easy to forget precisely because nothing fails. Only a live 200 from a real purge closes it.

**Files:** none — deployment and verification.

**Prerequisite (manual, account owner):**

- [ ] **Step 1: Grant `s3:DeleteObject`**

In the AWS console, add `s3:DeleteObject` to the `artryon-app` IAM user's policy for `arn:aws:s3:::artryon-models-gripz/*`. Until this is done, `shop/redact` returns 500 and retries.

Verify from the repo root:

```bash
cd apps/shopify-app && node -e "
require('dotenv').config();
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const c = new S3Client({ region: process.env.AWS_REGION });
const Bucket = process.env.S3_BUCKET, Key = 'iam-probe.txt';
(async () => {
  await c.send(new PutObjectCommand({ Bucket, Key, Body: Buffer.from('probe') }));
  await c.send(new DeleteObjectCommand({ Bucket, Key }));
  console.log('s3:DeleteObject GRANTED');
})().catch(e => { console.error('FAILED:', e.name); process.exit(1); });
"
```

Expected: `s3:DeleteObject GRANTED`. If it prints `FAILED: AccessDenied`, the policy is not live yet — stop here.

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 3: Deploy**

```bash
npm run deploy
```

Then push to trigger the Vercel deploy:

```bash
git push
```

- [ ] **Step 4: Confirm the subscriptions registered**

In the Partner Dashboard (org 225135603, app client_id `f2a93eb007cec5748830afd8ccd04203`), open the app version and confirm all five subscriptions are listed, including the three compliance topics.

- [ ] **Step 5: Confirm the privacy policy is publicly reachable**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://ar-sunglasses-shopify-app.vercel.app/privacy
```

Expected: `200`.

- [ ] **Step 6: Confirm unverified webhooks are rejected in production**

```bash
for t in customers/data_request customers/redact shop/redact; do
  printf "%s -> " "$t"
  curl -s -o /dev/null -w "%{http_code}\n" -X POST \
    "https://ar-sunglasses-shopify-app.vercel.app/webhooks/$t" \
    -H "Content-Type: application/json" \
    -H "X-Shopify-Hmac-Sha256: bogus" \
    -d '{"shop_domain":"test.myshopify.com"}'
done
```

Expected: `401` for all three. A `200` here means HMAC verification is not running and is a release blocker.

- [ ] **Step 7: Confirm a real `shop/redact` purge returns 200, not 500**

This is the assertion the stubbed tests cannot make. Trigger a genuine compliance webhook:

```bash
cd apps/shopify-app && shopify app webhook trigger \
  --topic=shop/redact \
  --api-version=2025-10 \
  --delivery-method=http \
  --address=https://ar-sunglasses-shopify-app.vercel.app/webhooks/shop/redact
```

Expected: the CLI reports a successful delivery. Then confirm in the Vercel runtime logs that the request returned **200** and emitted a `compliance_webhook` log line with `"action":"purged"`.

A **500** with an `AccessDenied` in the log means Step 1 was not actually completed — the phase is not done.

- [ ] **Step 8: Commit the phase completion note**

Only after Steps 1-7 all pass:

```bash
git commit --allow-empty -m "chore(phase2): compliance verified live

Five webhook subscriptions registered, bad HMAC rejected with 401 in
production, /privacy reachable, and a real shop/redact purge returned 200
against S3 with s3:DeleteObject granted."
git push
```

---

## Exit Criteria

Mapped from the spec. The phase is done when every box is checked:

- [ ] `customers/data_request`, `customers/redact`, `shop/redact` subscribed in `shopify.app.toml` (Task 6) and answered with 200 by deployed routes (Tasks 3, 4; verified Task 8 Step 4).
- [ ] Lifecycle subscriptions `app/uninstalled` and `app/scopes_update` restored (Task 6).
- [ ] HMAC rejection demonstrated by test (Tasks 3, 4) **and** in production (Task 8 Step 6).
- [ ] `shop/redact` provably erases all shop data in Postgres and S3 (Task 2 tests; Task 8 Step 7 live).
- [ ] Block-registered models are attributed to the real shop and erased by `shop/redact` (Tasks 9, 10). Without this the redaction path is incomplete regardless of the tests above.
- [ ] Public privacy policy URL discloses camera-data handling (Task 7; verified Task 8 Step 5).
- [ ] `s3:DeleteObject` granted to `artryon-app` (Task 8 Step 1).

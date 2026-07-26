# Phase 4 Slice 1 — Caching & Connection Pooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop customers re-downloading 1.48 MB of try-on engine on every visit, and stop the serverless Prisma clients exhausting Neon's connection pool.

**Architecture:** Two coupled changes. The engine stops appending a per-page-load `?v=` query string to model URLs (which gave the CDN a fresh cache key every visit, making any cache header useless), and cache headers are added in two places — a new `vercel.json` for the static `/tryon/*` tiers, and the `/models/:id.glb` route loader for merchant models. Separately, Prisma gains a `directUrl` so migrations bypass PgBouncer, which is the precondition for capping the runtime pool at one connection.

**Tech Stack:** Vite 5 (engine), React Router v7 + Vercel (`@vercel/react-router`), Prisma 6 + Neon Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-25-phase4-slice1-design.md`. Read it first — the *why* behind every header value is there.

## Global Constraints

- **`immutable` only on content-addressed paths.** `/tryon/assets/*` (Vite-hashed) and `/models/:id.glb` (UUID) qualify. `/tryon/models/*` and `/tryon/draco/gltf/*` have stable filenames and must NOT get `immutable` — a re-export would be stale for a year.
- **`vercel.json` lives at `apps/shopify-app/vercel.json`.** Vercel's Root Directory is `apps/shopify-app`, not the monorepo root.
- **The try-on engine is a committed artifact** at `apps/shopify-app/public/tryon`. Any engine source change requires re-running `npm run build:engine` from the repo root and committing the result, or the change never reaches production. Do NOT re-add a Vercel-side engine build.
- **Do not run the test suite against production.** Local `DATABASE_URL` points at the same Neon endpoint as production (`ep-solitary-breeze-as0s37zn`). The engine tests (repo root) are DB-free and safe; the app tests are not.
- **DB phase ordering is mandatory** (spec §6.2): Phase 1 (operator adds `DIRECT_URL`) → Phase 2 (Task 5, schema change) → Phase 3 (operator adds `connection_limit=1`). **Phase 1 is already complete as of 2026-07-26.** Never do Phase 3 before Phase 2.
- **Claude does not enter DB URLs, credentials, or secrets.** Tasks 5 and 8 contain operator steps; stop and hand over.
- Keep `vite.config` free of application runtime imports.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/config/arConfig.js` | modify (~line 284) | Gate the model cache-buster to dev |
| `test/tryon/glassesModelUrl.test.js` | create | Unit-test both branches, incl. the merchant path |
| `apps/shopify-app/vercel.json` | create | Cache-Control tiers for static `/tryon/*` |
| `apps/shopify-app/test/vercelConfig.test.js` | create | Guard the "immutable only where content-addressed" invariant |
| `apps/shopify-app/app/routes/models.$assetId[.]glb.jsx` | modify (line 22) | Merchant model cache header |
| `apps/shopify-app/test/modelsGlb.route.test.js` | modify (line 27) | Assert the new header |
| `apps/shopify-app/prisma/schema.prisma` | modify (datasource block) | `directUrl` for migrations |
| `scripts/verify-cache-headers.mjs` | create | Repeatable live header + `x-vercel-cache` verification |
| `apps/shopify-app/public/tryon/**` | regenerate | Rebuilt engine artifact (Task 2) |

---

### Task 1: Gate the model cache-buster to dev

**Files:**
- Create: `test/tryon/glassesModelUrl.test.js`
- Modify: `src/config/arConfig.js:284`

**Interfaces:**
- Consumes: `getGlassesModelUrl(key)`, `registerRuntimeGlassesConfig(key, engineModelConfig)` from `src/config/arConfig.js`; `toEngineModelConfig(fit, url)` from `src/tryon/fitMetadataAdapter.js`.
- Produces: `getGlassesModelUrl` returns a bare URL when `import.meta.env.DEV` is false, and `` `${url}?v=${MODEL_CACHE_BUST}` `` when true. Signature unchanged.

Run all commands in this task from the **repo root** (`D:\AR Sunglasses\ar-tryon-prototype`).

- [ ] **Step 1: Write the failing test**

Create `test/tryon/glassesModelUrl.test.js`:

```js
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getGlassesModelUrl,
  registerRuntimeGlassesConfig,
} from '../../src/config/arConfig.js'
import { toEngineModelConfig } from '../../src/tryon/fitMetadataAdapter.js'

// A merchant model URL as the app serves it: an unguessable UUID.
const MERCHANT_URL = '/models/2f1c6c1e-0e3a-4f6b-9d2a-8c7b5a4e3d21.glb'

const fit = {
  version: 'eyewear-v1',
  frameWidthMeters: 0.145,
  bridgeAnchor: { x: 0, y: 0, z: 0.02 },
  leftHinge: { x: -0.069, y: -0.024, z: -0.01 },
  rightHinge: { x: 0.069, y: -0.024, z: -0.01 },
  frontFramePlaneZ: 0.02,
  lensCenterOffset: { x: 0, y: 0, z: 0 },
  scaleLimits: { min: 0.85, max: 1.15 },
  provenance: { source: 'tagged', confidence: null },
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getGlassesModelUrl', () => {
  it('returns a bare url in production so the CDN can cache it', () => {
    vi.stubEnv('DEV', false)

    expect(getGlassesModelUrl()).not.toContain('?v=')
  })

  it('appends a cache-buster in dev so a re-exported GLB is refetched', () => {
    vi.stubEnv('DEV', true)

    expect(getGlassesModelUrl()).toMatch(/\?v=\d+$/)
  })

  it('returns a bare url for MERCHANT models in production', () => {
    // This is the customer-facing path and it does NOT go through
    // runtimeModelPath. registerRuntimeGlassesConfig sets useNormalizedModel
    // and useOptimizedModel to false, so getGlassesModelUrl resolves via its
    // else-branch and returns config.modelPath. A test that only covered the
    // default SKU would leave this branch unverified.
    vi.stubEnv('DEV', false)
    const key = registerRuntimeGlassesConfig(
      '__merchant_cache_test__',
      toEngineModelConfig(fit, MERCHANT_URL),
    )

    // Exact equality, not a substring check: proves nothing was appended.
    expect(getGlassesModelUrl(key)).toBe(MERCHANT_URL)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tryon/glassesModelUrl.test.js
```

Expected: 2 of 3 FAIL. The dev test passes (current behaviour always appends). The two production tests fail — the first with a received value ending in `?v=1769...`, the third with `expected '/models/2f1c...glb' but got '/models/2f1c...glb?v=1769...'`.

- [ ] **Step 3: Write the minimal implementation**

In `src/config/arConfig.js`, replace the return statement at line 284:

```js
  return `${url}?v=${MODEL_CACHE_BUST}`
```

with:

```js
  // Production returns a BARE url. A per-page-load query string hands the CDN a
  // fresh cache key on every visit, so no Cache-Control header can ever produce
  // a hit -- including the `immutable` one on the merchant /models/:id.glb
  // route, which is the highest-value header in this slice. Vite statically
  // replaces import.meta.env.DEV, so this suffix compiles out of the production
  // bundle entirely.
  return import.meta.env.DEV ? `${url}?v=${MODEL_CACHE_BUST}` : url
```

Leave `MODEL_CACHE_BUST` where it is at line 270. It must stay module-level so the value is stable for the whole page load — moving it inside the function would give every call a different value and defeat the dev behaviour it exists for.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/tryon/glassesModelUrl.test.js
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full engine suite for regressions**

```bash
npm test
```

Expected: PASS. These tests are DB-free, so they are safe to run.

- [ ] **Step 6: Commit**

```bash
git add test/tryon/glassesModelUrl.test.js src/config/arConfig.js
git commit -m "fix(perf): stop busting the model cache in production

The ?v=Date.now() suffix gave the CDN a new cache key on every page load,
so no Cache-Control header could ever produce a hit. Gated to dev, where
it still forces a freshly re-exported GLB to be refetched.

Covers the merchant path explicitly: registerRuntimeGlassesConfig leaves
useNormalizedModel false, so merchant models resolve through the else-branch
via config.modelPath rather than runtimeModelPath."
```

---

### Task 2: Rebuild and commit the engine artifact

**Files:**
- Regenerate: `apps/shopify-app/public/tryon/**`

**Interfaces:**
- Consumes: the Task 1 source change.
- Produces: a rebuilt `public/tryon` whose `assets/main-*.js` no longer contains the model cache-buster. Asset filenames change (content hashes), so `index.html` changes too.

This task exists separately because the engine is a **committed artifact** — Task 1's source change reaches production only via this rebuild. A reviewer can meaningfully approve Task 1 and reject a bad rebuild.

- [ ] **Step 1: Record the before state**

```bash
grep -c '?v=' apps/shopify-app/public/tryon/assets/main-*.js apps/shopify-app/public/tryon/assets/MediaPipeThreeProvider-*.js
```

Expected: `main-*.js:1` and `MediaPipeThreeProvider-*.js:2`.

The 1 in `main` is the model cache-buster and must go to 0. The 2 in `MediaPipeThreeProvider` are `/mock-turn/frame-N.png?v=` and `/mock-face.png?v=` (`MediaPipeThreeProvider.js:231,238`) — dev-only mock-camera assets, **out of scope for this slice**, and they must stay at 2. Do not "fix" them.

- [ ] **Step 2: Rebuild the engine**

```bash
npm run build:engine
```

Expected: `vite build` completes, writing to `apps/shopify-app/public/tryon`.

- [ ] **Step 3: Verify the cache-buster is gone from the bundle**

```bash
grep -c '?v=' apps/shopify-app/public/tryon/assets/main-*.js
```

Expected: **`0`** — or grep exits 1 with no output, which also means zero matches.

This is the assertion that matters. The Task 1 unit test can pass while Vite still emits the string; only this proves the static elimination actually happened.

- [ ] **Step 4: Confirm the mock-camera matches are untouched**

```bash
grep -c '?v=' apps/shopify-app/public/tryon/assets/MediaPipeThreeProvider-*.js
```

Expected: `2`.

- [ ] **Step 5: Commit the rebuilt artifact**

```bash
git add apps/shopify-app/public/tryon
git commit -m "build(engine): rebuild try-on engine without the cache-buster

The engine is a committed artifact, so the Task 1 source change only
reaches production through this rebuild. Asset content hashes and
index.html change as a result.

Verified: assets/main-*.js now contains zero '?v=' matches. The two in
MediaPipeThreeProvider are the dev-only mock-camera image paths and are
deliberately unchanged."
```

---

### Task 3: Cache header for the merchant model route

**Files:**
- Modify: `apps/shopify-app/test/modelsGlb.route.test.js:27`
- Modify: `apps/shopify-app/app/routes/models.$assetId[.]glb.jsx:22`

**Interfaces:**
- Consumes: the existing `loader({ params })` export from `models.$assetId[.]glb.jsx`.
- Produces: a 200 response carrying `Cache-Control: public, max-age=31536000, s-maxage=31536000, immutable`. `Content-Type: model/gltf-binary` and the absence of `Access-Control-Allow-Origin` are unchanged.

This is the highest-value header in the slice — but only because Task 1 removed the query string that would otherwise bypass it. Run commands from `apps/shopify-app`.

- [ ] **Step 1: Update the test to assert the new header**

The existing test already pins the old value, so this is an edit, not a new file. In `apps/shopify-app/test/modelsGlb.route.test.js`, replace line 27:

```js
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600')
```

with:

```js
    // immutable is safe here and ONLY here among model routes: assetId is a
    // ModelAsset.id, @default(uuid()) and unguessable, and a re-upload gets a
    // new id -- so this url's bytes can never change. s-maxage as well as
    // max-age because Vercel's edge keys function-response caching off
    // s-maxage; with max-age alone every cold browser would still run the
    // loader, costing a findUnique plus a storage fetch.
    expect(res.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, s-maxage=31536000, immutable',
    )
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/modelsGlb.route.test.js
```

Expected: FAIL — `expected 'public, max-age=31536000, s-maxage=31536000, immutable' but got 'public, max-age=3600'`.

This test mocks `db.server.js` and `storage.server.js`, so it makes no database connection and is safe to run despite the shared-endpoint constraint.

- [ ] **Step 3: Write the implementation**

In `apps/shopify-app/app/routes/models.$assetId[.]glb.jsx`, replace line 22:

```js
      'Cache-Control': 'public, max-age=3600',
```

with:

```js
      // One year, immutable, and cached at the edge as well as in the browser.
      // Safe because the url is content-addressed: assetId is ModelAsset.id,
      // @default(uuid()), and a re-upload produces a new id rather than new
      // bytes at the same url. s-maxage is what makes Vercel's edge cache the
      // function response -- without it we would still hit the database and
      // object storage for every cold browser.
      'Cache-Control': 'public, max-age=31536000, s-maxage=31536000, immutable',
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/modelsGlb.route.test.js
```

Expected: PASS, 1 test.

- [ ] **Step 5: Commit**

```bash
git add test/modelsGlb.route.test.js app/routes/models.\$assetId\[.\]glb.jsx
git commit -m "perf(models): cache merchant GLBs for a year at the edge

The url is content-addressed -- assetId is an unguessable uuid and a
re-upload gets a new id -- so the bytes behind it can never change.
Raised from one hour to one year and marked immutable.

s-maxage as well as max-age: Vercel's edge keys function-response caching
off s-maxage, so max-age alone would still run the loader (a findUnique
plus a storage read) for every cold browser."
```

---

### Task 4: `vercel.json` cache tiers for the static engine

**Files:**
- Create: `apps/shopify-app/vercel.json`
- Create: `apps/shopify-app/test/vercelConfig.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `apps/shopify-app/vercel.json` with a `headers` array of four rules keyed by `source`. Later verification (Task 7) asserts these appear on live responses.

No `vercel.json` currently exists anywhere in the repo — this creates it. Run commands from `apps/shopify-app`.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/vercelConfig.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
)

const HASHED_ASSETS = '/tryon/assets/(.*)'

const cacheControlFor = (source) =>
  config.headers
    .find((rule) => rule.source === source)
    ?.headers.find((header) => header.key === 'Cache-Control')?.value

describe('vercel.json cache tiers', () => {
  it('marks the content-hashed engine bundles immutable', () => {
    expect(cacheControlFor(HASHED_ASSETS)).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('gives the stable-named models a bounded, revalidating ttl', () => {
    expect(cacheControlFor('/tryon/models/(.*)')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    )
  })

  it('gives the stable-named draco decoder the same bounded ttl', () => {
    // Covers /tryon/draco/gltf/* -- the decoder lives one level deeper than
    // the models do.
    expect(cacheControlFor('/tryon/draco/(.*)')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    )
  })

  it('keeps the entry point revalidating so it can point at new bundles', () => {
    expect(cacheControlFor('/tryon/index.html')).toBe(
      'public, max-age=0, must-revalidate',
    )
  })

  it('never marks a non-content-addressed path immutable', () => {
    // The invariant that makes the whole scheme safe. Only Vite-hashed
    // filenames change when their bytes change; marking a stable name
    // immutable would serve a stale model or decoder for a year after a
    // re-export -- the same stale-asset defect the cache-buster existed to
    // prevent, inverted.
    for (const rule of config.headers) {
      const value =
        rule.headers.find((header) => header.key === 'Cache-Control')?.value ?? ''
      if (value.includes('immutable')) {
        expect(rule.source).toBe(HASHED_ASSETS)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/vercelConfig.test.js
```

Expected: FAIL at module load — `ENOENT: no such file or directory, open '.../apps/shopify-app/vercel.json'`.

- [ ] **Step 3: Create the config**

Create `apps/shopify-app/vercel.json`:

```json
{
  "headers": [
    {
      "source": "/tryon/assets/(.*)",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
      ]
    },
    {
      "source": "/tryon/models/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=86400, stale-while-revalidate=604800"
        }
      ]
    },
    {
      "source": "/tryon/draco/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=86400, stale-while-revalidate=604800"
        }
      ]
    },
    {
      "source": "/tryon/index.html",
      "headers": [
        { "key": "Cache-Control", "value": "public, max-age=0, must-revalidate" }
      ]
    }
  ]
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/vercelConfig.test.js
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Confirm the local build still succeeds**

```bash
npm run build
```

Expected: `react-router build` completes cleanly. A `vercel.json` containing only `headers` is additive and must not disturb framework detection — if this fails, stop and report rather than working around it.

- [ ] **Step 6: Commit**

```bash
git add vercel.json test/vercelConfig.test.js
git commit -m "perf(tryon): cache the static engine assets

Adds vercel.json (none existed) at the app root, which is Vercel's Root
Directory. Four tiers, split by whether the filename is content-addressed:
Vite-hashed bundles get a year and immutable; the stable-named models and
draco decoder get a bounded, revalidating day; index.html keeps
revalidating so it can always resolve to the current bundles.

The test pins the invariant rather than just the values: no rule outside
/tryon/assets/* may carry immutable."
```

---

### Task 5: Prisma `directUrl` (DB Phase 2)

**Files:**
- Modify: `apps/shopify-app/prisma/schema.prisma` (datasource block, ~lines 15-19)

**Interfaces:**
- Consumes: `DIRECT_URL` env var — **already set** by the operator in Vercel (all three environments) and in local `apps/shopify-app/.env`, verified 2026-07-26.
- Produces: a datasource with both `url` and `directUrl`. No client API change.

> **STOP AND CHECK before starting.** This is DB Phase 2 and it depends on Phase 1 being done. If `DIRECT_URL` is missing from Vercel, merging this **fails the build outright** with `Environment variable not found: DIRECT_URL`, because the Vercel Build Command runs `prisma migrate deploy`. Spec §6.2 records Phase 1 as complete; confirm before proceeding.

- [ ] **Step 1: Confirm the environment variable exists locally**

```bash
node -e "require('dotenv').config({path:'apps/shopify-app/.env'});console.log(process.env.DIRECT_URL?'DIRECT_URL present':'DIRECT_URL MISSING')"
```

Expected: `DIRECT_URL present`. If it prints `MISSING`, stop — Phase 1 is incomplete and this task must not proceed.

- [ ] **Step 2: Add `directUrl` to the datasource**

In `apps/shopify-app/prisma/schema.prisma`, replace:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

with:

```prisma
datasource db {
  provider = "postgresql"
  // Pooled (PgBouncer) endpoint, used at runtime by the app.
  url       = env("DATABASE_URL")
  // Direct endpoint, used ONLY by prisma migrate/generate. Migrations take
  // session-level advisory locks that PgBouncer's transaction pooling cannot
  // hold, and the runtime connection_limit=1 would throttle them to a single
  // connection. The Vercel build command runs `prisma migrate deploy`, so this
  // is load-bearing for every deploy, not just for local migrations.
  directUrl = env("DIRECT_URL")
}
```

- [ ] **Step 3: Validate the schema**

```bash
cd apps/shopify-app && npx prisma validate
```

Expected: `The schema at prisma/schema.prisma is valid 🚀`.

This resolves both env vars without opening a connection, so it does not touch the shared database.

- [ ] **Step 4: Regenerate the client**

```bash
cd apps/shopify-app && npx prisma generate
```

Expected: `Generated Prisma Client ... in NNms`. No database connection is made.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-app/prisma/schema.prisma
git commit -m "fix(db): route migrations through the direct endpoint

DB phase 2 of 3. directUrl points prisma migrate/generate at Neon's
non-pooler endpoint. Migrations need session-level advisory locks that
PgBouncer's transaction pooling cannot hold, and the connection_limit=1
coming in phase 3 would otherwise throttle them to one connection.

Load-bearing for deploys, not just local work: the Vercel build command
runs prisma migrate deploy. DIRECT_URL was set in Vercel across all three
environments in phase 1 (2026-07-26) -- merging this without it would fail
the build."
```

---

### Task 6: Live verification script

**Files:**
- Create: `scripts/verify-cache-headers.mjs`

**Interfaces:**
- Consumes: a deployed base URL (argv or default).
- Produces: a script exiting 0 when every tier matches and the second fetch is an edge hit, non-zero otherwise. Run from the repo root.

This is written before deploying so Task 7 has something repeatable to run.

- [ ] **Step 1: Write the script**

Create `scripts/verify-cache-headers.mjs`:

```js
// Verifies the Phase 4 Slice 1 cache tiers against a live deployment.
//
//   node scripts/verify-cache-headers.mjs [baseUrl] [merchantAssetId]
//
// Checks two independent things per path:
//   1. Cache-Control matches the tier the spec assigns it.
//   2. A second fetch is served from Vercel's edge (x-vercel-cache: HIT, or
//      an age above zero). This is the part that actually proves caching --
//      a correct header on a never-cached response would pass check 1 alone.

const baseUrl = (process.argv[2] ?? 'https://ar-sunglasses-shopify-app.vercel.app').replace(/\/$/, '')
const merchantAssetId = process.argv[3] ?? null

const IMMUTABLE = 'public, max-age=31536000, immutable'
const BOUNDED = 'public, max-age=86400, stale-while-revalidate=604800'
const REVALIDATE = 'public, max-age=0, must-revalidate'

// Discover a hashed bundle from index.html rather than hardcoding a filename
// that changes on every engine rebuild.
async function findHashedAsset() {
  const res = await fetch(`${baseUrl}/tryon/index.html`)
  const html = await res.text()
  const match = html.match(/\/tryon\/assets\/[A-Za-z0-9._-]+\.js/)
  if (!match) throw new Error('no hashed asset found in /tryon/index.html')
  return match[0]
}

async function check({ path, expected, expectEdgeHit }) {
  const url = `${baseUrl}${path}`
  const first = await fetch(url)
  const actual = first.headers.get('cache-control')

  const failures = []
  if (first.status !== 200) failures.push(`status ${first.status}, expected 200`)
  if (actual !== expected) failures.push(`cache-control "${actual}", expected "${expected}"`)

  if (expectEdgeHit) {
    const second = await fetch(url)
    const cacheState = second.headers.get('x-vercel-cache')
    const age = Number(second.headers.get('age') ?? '0')
    if (cacheState !== 'HIT' && !(age > 0)) {
      failures.push(`not served from the edge on refetch (x-vercel-cache: ${cacheState}, age: ${age})`)
    }
  }

  const label = failures.length === 0 ? 'PASS' : 'FAIL'
  console.log(`${label}  ${path}`)
  for (const failure of failures) console.log(`      - ${failure}`)
  return failures.length === 0
}

const hashedAsset = await findHashedAsset()

const targets = [
  { path: hashedAsset, expected: IMMUTABLE, expectEdgeHit: true },
  { path: '/tryon/models/sunglasses-draco.glb', expected: BOUNDED, expectEdgeHit: true },
  { path: '/tryon/draco/gltf/draco_decoder.wasm', expected: BOUNDED, expectEdgeHit: true },
  { path: '/tryon/index.html', expected: REVALIDATE, expectEdgeHit: false },
]

if (merchantAssetId) {
  targets.push({
    path: `/models/${merchantAssetId}.glb`,
    expected: 'public, max-age=31536000, s-maxage=31536000, immutable',
    expectEdgeHit: true,
  })
} else {
  console.log('NOTE  no merchant assetId given; skipping /models/:id.glb')
  console.log('      pass one as the 2nd argument to cover the highest-value header')
}

const results = []
for (const target of targets) results.push(await check(target))

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it against the CURRENT deployment to confirm it detects the unfixed state**

```bash
node scripts/verify-cache-headers.mjs
```

Expected: FAIL on the three `/tryon/*` tiers, reporting `cache-control "public, max-age=0, must-revalidate"` where `immutable` or the bounded ttl was expected. `/tryon/index.html` should PASS — it already carries the revalidating value.

A script that cannot fail proves nothing; this step is what shows it can.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-cache-headers.mjs
git commit -m "test(perf): script the live cache-header verification

Asserts each path's Cache-Control against its tier AND that a second
fetch is served from the edge (x-vercel-cache: HIT or age > 0). The
second check is the one that matters: a correct header on a
never-cached response would satisfy the first on its own.

Discovers the hashed bundle from index.html so it survives engine
rebuilds. Confirmed it fails against the current deployment."
```

---

### Task 7: Deploy and verify the caching half

**Files:** none — this task deploys and observes.

**Interfaces:**
- Consumes: Tasks 1-6, all committed on `feat/phase4-slice1-caching`.
- Produces: a live deployment with the tiers in effect, evidenced by `scripts/verify-cache-headers.mjs` exiting 0.

- [ ] **Step 1: Run the full test suites**

```bash
npm test
```

Expected: PASS (engine, DB-free).

```bash
cd apps/shopify-app && npx vitest run test/vercelConfig.test.js test/modelsGlb.route.test.js
```

Expected: PASS, 6 tests. Scoped to the two DB-free files deliberately — the wider app suite hits the shared production database.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/phase4-slice1-caching
```

- [ ] **Step 3: Wait for the Vercel preview deploy, then verify against it**

Take the preview URL from the Vercel dashboard.

```bash
node scripts/verify-cache-headers.mjs https://<preview-url>
```

Expected: all `/tryon/*` tiers PASS. Note that the first request to any path is a MISS by definition; the script already refetches to check for the edge hit.

**If the `/tryon/*` headers still read `max-age=0, must-revalidate`, stop.** That means `vercel.json` did not engage for `public/` content copied into the client build — a real finding, not something to work around. Report it; the fallback (serving the engine through a splat resource route) is a meaningful downgrade and needs a decision, not an improvisation.

- [ ] **Step 4: Merge to main and deploy to production**

```bash
git checkout main && git merge --ff-only feat/phase4-slice1-caching && git push
```

- [ ] **Step 5: Verify production, including a merchant model**

Get a real `ModelAsset.id` from the operator or the admin Models page.

```bash
node scripts/verify-cache-headers.mjs https://ar-sunglasses-shopify-app.vercel.app <assetId>
```

Expected: all PASS, including `/models/<assetId>.glb` showing `x-vercel-cache: HIT` on the refetch. That hit is the proof that Tasks 1 and 3 together did what the slice set out to do.

- [ ] **Step 6: Record the result in the spec**

Append to §7 of `docs/superpowers/specs/2026-07-25-phase4-slice1-design.md`, filling in the values actually observed:

```markdown
### 7.4 Measured result (YYYY-MM-DD)

Verified with `node scripts/verify-cache-headers.mjs <url> <assetId>`.

| Path | Before | After | Edge hit on refetch |
|---|---|---|---|
| `/tryon/assets/main-*.js` | `max-age=0, must-revalidate` | `max-age=31536000, immutable` | |
| `/tryon/models/sunglasses-draco.glb` | `max-age=0, must-revalidate` | `max-age=86400, stale-while-revalidate=604800` | |
| `/tryon/draco/gltf/draco_decoder.wasm` | `max-age=0, must-revalidate` | `max-age=86400, stale-while-revalidate=604800` | |
| `/tryon/index.html` | `max-age=0, must-revalidate` | unchanged (intended) | n/a |
| `/models/:id.glb` | `max-age=3600` | `max-age=31536000, s-maxage=31536000, immutable` | |

Bundle check: `assets/main-*.js` `?v=` matches went 1 → 0.
```

Then:

```bash
git add docs/superpowers/specs/2026-07-25-phase4-slice1-design.md
git commit -m "docs(phase4): record measured cache verification results" && git push
```

---

### Task 8: DB Phase 3 — cap the runtime pool (OPERATOR)

**Files:** none in this repo — this is a Vercel environment-variable change.

**Interfaces:**
- Consumes: Task 5 deployed to production (so migrations already route via `directUrl`).
- Produces: a runtime pool capped at one connection per instance.

> **This task is the operator's.** Claude does not enter DB URLs, credentials, or secrets. Hand over and wait.

- [ ] **Step 1: Confirm Task 5 is live in production**

Task 5 must be deployed before this runs. If `connection_limit=1&pgbouncer=true` lands while migrations still route through PgBouncer, `prisma migrate deploy` can fail on advisory locks it cannot acquire.

- [ ] **Step 2: Operator edits `DATABASE_URL` in Vercel**

Vercel → `ar-sunglasses-shopify-app` → Settings → Environment Variables → `DATABASE_URL`.

Append to the existing value:

```
&connection_limit=1&pgbouncer=true
```

**With `&`, not `?`** — the string already ends in `?sslmode=require&channel_binding=require`.

Leave the host as the `-pooler` one. `connection_limit=1` is correct only against the pooled endpoint; on the direct endpoint it would over-throttle.

- [ ] **Step 3: Redeploy**

Env var changes apply to the next deployment. Trigger a redeploy from the Vercel dashboard.

- [ ] **Step 4: Verify via Neon's metrics, not by load-testing**

Neon Console → project `artryon` → branch `production` → **Monitoring**.

Expected: connection count settles at roughly one per active instance, well below the previous ceiling.

Spec §7.3 deliberately makes this the primary evidence. The obvious alternative — reproducing the concurrent load — is the same activity that caused the pool exhaustion in the first place, against a database local dev shares with production. If a load reproduction is wanted anyway, it comes after this metric check, bounded, and run once.

- [ ] **Step 5: Confirm the app still serves**

Load a product page with the try-on block and open the try-on. Expected: the model loads, no `Timed out fetching a new connection` and no `Prisma session table does not exist` in the Vercel runtime logs. That second error is what Shopify's session storage reports when the *connection* fails, so its absence is a real signal.

- [ ] **Step 6: Record completion in the spec**

In the §6.2 phase table of `docs/superpowers/specs/2026-07-25-phase4-slice1-design.md`, change the Phase 3 status cell from `pending` to `✅ done YYYY-MM-DD`, and add below the table:

```markdown
Phase 3 verification (YYYY-MM-DD): Neon Monitoring showed <N> connections on
branch `production` after redeploy, against a previous ceiling of 5 per
instance. No `Timed out fetching a new connection` or `Prisma session table
does not exist` in Vercel runtime logs over <period> of normal traffic.
```

Then commit:

```bash
git add docs/superpowers/specs/2026-07-25-phase4-slice1-design.md
git commit -m "docs(phase4): DB phase 3 complete, pool capped and verified" && git push
```

---

## Out of scope

- Workstream C (payload trim) — cut; the 1.48 MB measurement removed its rationale.
- D (monitoring), E (device matrix), F (accessibility) — later slices.
- The `?v=` cache-busters on `/mock-turn/*` and `/mock-face.png` in `MediaPipeThreeProvider.js:231,238` — dev-only mock-camera assets, not customer-facing.
- Content-hashing the engine model and draco filenames — considered and rejected in spec §10.
- Pointing local `DATABASE_URL` at the Neon `dev` branch — logged in spec §9 as a follow-up.

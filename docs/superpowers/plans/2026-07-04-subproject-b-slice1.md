# B Slice 1 — Shopify App + one model + PDP try-on — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution reality:** Tasks 1, 4, 6, 9 are pure units — full TDD, buildable/testable with no external services. Tasks 2, 5, 7, 8, 10 need the **Shopify CLI + a Partner dev store** (interactive) and are verified by running the app, not unit tests. Do the pure units first; gate the Shopify-environment tasks on the operator having the CLI + dev store.

**Goal:** On a Shopify dev store, a merchant installs the app, uploads one GLB (calibrated server-side by A1) and maps it to one product, and that product's PDP shows a "Try on" button that opens the working try-on with the calibrated model.

**Architecture:** An npm-workspaces monorepo. `packages/calibration` (extracted A1) is shared. `apps/engine` is the existing Vite try-on app. `apps/shopify-app` is a Shopify Remix app (Prisma/Postgres) whose admin runs A1 on upload, persists fit-metadata, maps products→models, and serves `/models/:id.glb` + `/api/tryon-config`. A Theme App Extension opens the hosted engine in a camera-permitted iframe; the engine fetches its config and adapts A1 fit-metadata into its runtime config.

**Tech Stack:** npm workspaces, Node ESM, Vitest, Shopify Remix app template, Prisma, PostgreSQL, `@gltf-transform/core`, existing MediaPipe+Three engine.

## Global Constraints

- Code style: **ES modules, no semicolons, single quotes, 2-space indent** — match existing `src/`.
- The shared **`packages/calibration`** modules stay Node- and browser-runnable (no DOM/Three.js); they are A1 moved verbatim.
- **Stack (spec-locked):** Shopify official Remix template + Prisma + PostgreSQL. Dev runs via the **Shopify CLI dev tunnel** (`shopify app dev`); no production host this slice.
- **No real access control this slice:** `/models/:assetId.glb` and `/api/tryon-config` are public; `assetId` is an unguessable UUID; authorization is deferred to Sub-project D.
- **Happy path uses a tagged/spec-compliant GLB** (A1 `source:'tagged'`, `confidence:null`, `needsManual:false`); the in-admin manual anchor tool is deferred to the next slice.
- **Try-on delivery:** Theme App Extension → `<iframe allow="camera">` to the hosted engine, passing `shop`+`productId`; the engine fetches `/api/tryon-config`.
- Fit-metadata record shape (from A1, `eyewear-v1`): `{ version, frameWidthMeters, bridgeAnchor{x,y,z}, leftHinge{x,y,z}, rightHinge{x,y,z}, frontFramePlaneZ, lensCenterOffset{x,y,z}, scaleLimits{min,max}, provenance{source,confidence} }`.

---

### Task 1: Extract A1 into a shared workspace package

**Files:**
- Create: `package.json` (root, workspaces) — or modify existing root `package.json`
- Move: `src/calibration/*` → `packages/calibration/src/*`; `test/calibration/*` → `packages/calibration/test/*`
- Create: `packages/calibration/package.json`
- Move: the existing Vite app into `apps/engine/` (or keep at root and add the workspace) — see Step 1
- Test: existing calibration tests, now under `packages/calibration`

**Interfaces:**
- Produces: workspace package `@artryon/calibration` exporting the A1 modules (`calibrator`, `validator`, `normalizer`, `spec`, `fitMetadata`, `glbAccess`, `geometry`, `tagReader`, `geometricEstimator`, `confidence`) from `packages/calibration/src/index.js`.

- [ ] **Step 1: Decide the smallest-move layout**

To avoid churning the Vite app, keep it where it is and introduce workspaces around it. Root `package.json` gets a `workspaces` array pointing at `packages/*` (and later `apps/shopify-app`). The engine app stays at the repo root for now; only `calibration` is extracted. Confirm this with the operator if the repo layout matters to them.

- [ ] **Step 2: Create the shared package**

Move `src/calibration/` to `packages/calibration/src/` and `test/calibration/` to `packages/calibration/test/`. Create `packages/calibration/package.json`:

```json
{
  "name": "@artryon/calibration",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js" },
  "scripts": { "test": "vitest run" },
  "devDependencies": { "vitest": "^3.2.4" },
  "dependencies": { "@gltf-transform/core": "^4.4.0" }
}
```

Create `packages/calibration/src/index.js` re-exporting the public API:

```js
export * from './spec.js'
export * from './fitMetadata.js'
export * from './geometry.js'
export * from './glbAccess.js'
export * from './validator.js'
export * from './normalizer.js'
export * from './tagReader.js'
export * from './geometricEstimator.js'
export * from './confidence.js'
export * from './calibrator.js'
```

- [ ] **Step 3: Wire the root workspace**

In the root `package.json`, add:

```json
"workspaces": ["packages/*", "apps/shopify-app"]
```

Then run `npm install` at the root so workspaces link.

- [ ] **Step 4: Update the engine app's imports**

Anywhere the Vite engine imported `./src/calibration/...` (none today — the engine doesn't yet consume A1), no change is needed. The engine will consume calibration only via the adapter in Task 9, importing from `@artryon/calibration`.

- [ ] **Step 5: Run the moved tests, then commit**

Run: `npm test --workspace @artryon/calibration`
Expected: the A1 suite passes unchanged (31 tests).

```bash
git add -A
git commit -m "refactor: extract A1 calibration into @artryon/calibration workspace package"
```

---

### Task 2: Scaffold the Shopify Remix app  *(needs Shopify CLI + Partner dev store)*

**Files:**
- Create: `apps/shopify-app/` (generated by the Shopify CLI)
- Modify: `apps/shopify-app/shopify.app.toml` (scopes), root `package.json` workspaces (already includes `apps/shopify-app`)

**Interfaces:**
- Produces: a running Shopify app installable on a dev store, with Prisma session storage and a Postgres connection.

- [ ] **Step 1: Generate the app**

From the repo root:

```bash
npm init @shopify/app@latest -- --template remix apps/shopify-app
```

Follow the CLI prompts (log in to the Partner account, select/create an app). This generates OAuth, App Bridge, Prisma session storage, webhook scaffolding, and an admin shell.

- [ ] **Step 2: Point Prisma at Postgres**

In `apps/shopify-app/prisma/schema.prisma`, set the datasource provider to `postgresql` and `url = env("DATABASE_URL")`. Put a local `DATABASE_URL` (a local Postgres) in `apps/shopify-app/.env`. Run `npx prisma migrate dev --name init` inside `apps/shopify-app`.

- [ ] **Step 3: Set access scopes**

In `apps/shopify-app/shopify.app.toml`, set `scopes = "read_products"` (needed for the product-mapping picker). Redeploy config: `shopify app deploy` (or it applies on next `dev`).

- [ ] **Step 4: Verify it installs**

Run `shopify app dev` (from `apps/shopify-app`), open the preview URL, install on the dev store.
Expected: the app installs and the default admin page renders.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shopify): scaffold Remix app with Postgres session storage"
```

---

### Task 3: Prisma data model (ModelAsset, ProductMapping)

**Files:**
- Modify: `apps/shopify-app/prisma/schema.prisma`
- Create: `apps/shopify-app/app/db.server.js` (if not generated) exporting the Prisma client
- Test: `apps/shopify-app/test/models.test.js`

**Interfaces:**
- Produces: Prisma models `ModelAsset { id, shop, storageRef, fitMetadata Json, confidence Float?, status String, createdAt }` and `ProductMapping { id, shop, productId, modelAssetId, createdAt }` with a unique `(shop, productId)`.

- [ ] **Step 1: Add the models**

In `schema.prisma`:

```prisma
model ModelAsset {
  id          String   @id @default(uuid())
  shop        String
  storageRef  String
  fitMetadata Json
  confidence  Float?
  status      String   @default("ready")
  createdAt   DateTime @default(now())
  mappings    ProductMapping[]
}

model ProductMapping {
  id           String     @id @default(uuid())
  shop         String
  productId    String
  modelAsset   ModelAsset @relation(fields: [modelAssetId], references: [id])
  modelAssetId String
  createdAt    DateTime   @default(now())
  @@unique([shop, productId])
}
```

- [ ] **Step 2: Migrate**

Run inside `apps/shopify-app`: `npx prisma migrate dev --name model-assets`
Expected: migration applies; client regenerates.

- [ ] **Step 3: Write a persistence test**

Create `apps/shopify-app/test/models.test.js` (uses the Prisma client against the dev/test DB):

```js
import { describe, it, expect } from 'vitest'
import prisma from '../app/db.server.js'

describe('ModelAsset + ProductMapping', () => {
  it('persists a model asset and maps a product to it', async () => {
    const asset = await prisma.modelAsset.create({
      data: { shop: 'test.myshopify.com', storageRef: 'ref1', fitMetadata: { version: 'eyewear-v1' }, confidence: null },
    })
    const mapping = await prisma.productMapping.create({
      data: { shop: 'test.myshopify.com', productId: 'gid://shopify/Product/1', modelAssetId: asset.id },
    })
    const found = await prisma.productMapping.findUnique({
      where: { shop_productId: { shop: 'test.myshopify.com', productId: 'gid://shopify/Product/1' } },
      include: { modelAsset: true },
    })
    expect(found.modelAsset.id).toBe(asset.id)
    await prisma.productMapping.delete({ where: { id: mapping.id } })
    await prisma.modelAsset.delete({ where: { id: asset.id } })
  })
})
```

- [ ] **Step 4: Run + commit**

Run: `npm test --workspace apps/shopify-app -- models` (with `DATABASE_URL` set).
Expected: PASS.

```bash
git add -A && git commit -m "feat(shopify): add ModelAsset + ProductMapping models"
```

---

### Task 4: A1-integration service (GLB → fit-metadata)

**Files:**
- Create: `apps/shopify-app/app/calibration.server.js`
- Test: `apps/shopify-app/test/calibration.server.test.js`

**Interfaces:**
- Consumes: `@artryon/calibration` (`WebIO`-free — uses `@gltf-transform/core` NodeIO), `validateModel`, `normalizeModel`, `calibrate`, `MODELING_SPEC`, plus `KHRONOS_EXTENSIONS`.
- Produces: `calibrateUpload(glbBuffer: Uint8Array) -> Promise<{ validation, fitMetadata, confidence, needsManual, normalizedGlb: Uint8Array }>`. Throws if validation status is `fail`.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/calibration.server.test.js` (build an in-memory GLB with the shared `buildDoc` helper, write it to bytes with NodeIO, feed the service):

```js
import { describe, it, expect } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import { calibrateUpload } from '../app/calibration.server.js'

async function glbBytes(doc) {
  return new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc)
}

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('calibrateUpload', () => {
  it('calibrates a tagged GLB and returns fit-metadata (no manual)', async () => {
    const doc = buildDoc(GOOD, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const res = await calibrateUpload(await glbBytes(doc))
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(res.fitMetadata.provenance.source).toBe('tagged')
    expect(res.needsManual).toBe(false)
    expect(res.normalizedGlb).toBeInstanceOf(Uint8Array)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace apps/shopify-app -- calibration.server`
Expected: FAIL — cannot find `app/calibration.server.js`.

- [ ] **Step 3: Implement the service**

Create `apps/shopify-app/app/calibration.server.js`:

```js
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { validateModel, normalizeModel, calibrate, MODELING_SPEC } from '@artryon/calibration'

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

export async function calibrateUpload(glbBuffer) {
  const doc = await io.readBinary(glbBuffer)
  const validation = validateModel(doc, MODELING_SPEC)
  if (validation.status === 'fail') {
    throw new Error(`model rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
  }
  const { doc: normalized } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(normalized, MODELING_SPEC)
  const normalizedGlb = await io.writeBinary(normalized)
  return {
    validation,
    fitMetadata: calibration.fitMetadata,
    confidence: calibration.confidence,
    needsManual: calibration.needsManual,
    normalizedGlb,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --workspace apps/shopify-app -- calibration.server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(shopify): add A1-integration service (GLB -> fit-metadata)"
```

---

### Task 5: Upload + calibrate admin route  *(needs Shopify CLI to view UI; logic is testable)*

**Files:**
- Create: `apps/shopify-app/app/routes/app.models.jsx` (Polaris upload UI + Remix action)
- Modify: `apps/shopify-app/app/routes/app._index.jsx` (link to Models page)

**Interfaces:**
- Consumes: `calibrateUpload` (Task 4), Prisma client (Task 3).
- Produces: a `POST` action that accepts a GLB file, calls `calibrateUpload`, persists a `ModelAsset` (storageRef = the saved normalized GLB), and returns the validation/confidence/needsManual for display.

- [ ] **Step 1: Implement the route**

Create `apps/shopify-app/app/routes/app.models.jsx` with a Remix `action` (multipart upload → `calibrateUpload` → persist `ModelAsset`; store `normalizedGlb` under `storageRef`, e.g. write to `apps/shopify-app/storage/<uuid>.glb` for the dev slice) and a Polaris page: a file input, an upload button, and a results panel showing `validation.status`, issues, and either "tagged (exact)" or the confidence % + `needsManual`. Authenticate via the generated `authenticate.admin(request)`; use `session.shop` for the `shop` field.

(Follow the template's existing route conventions for `loader`/`action`/`authenticate`. The persistence + `calibrateUpload` call is the app-specific logic; the Polaris scaffolding mirrors the generated `app._index.jsx`.)

- [ ] **Step 2: Verify (manual, dev store)**

Run `shopify app dev`, open the app → Models, upload a tagged GLB.
Expected: the page shows `validation: pass`, "tagged (exact)", `needsManual: false`, and a `ModelAsset` row exists (check via `npx prisma studio`).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(shopify): admin route to upload + calibrate a model"
```

---

### Task 6: Serving endpoints (`/models/:id.glb`, `/api/tryon-config`)

**Files:**
- Create: `apps/shopify-app/app/routes/models.$assetId[.]glb.jsx` (raw GLB loader)
- Create: `apps/shopify-app/app/routes/api.tryon-config.jsx` (JSON loader)
- Create: `apps/shopify-app/app/tryonConfig.server.js` (pure lookup logic)
- Test: `apps/shopify-app/test/tryonConfig.server.test.js`

**Interfaces:**
- Produces: `getTryonConfig(prisma, shop, productId) -> Promise<{ modelUrl, fitMetadata } | null>` (pure, testable). The routes are thin wrappers: the GLB route streams the stored file for `:assetId`; `api.tryon-config` calls `getTryonConfig` and returns JSON (or 404 when null).

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/tryonConfig.server.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import prisma from '../app/db.server.js'
import { getTryonConfig } from '../app/tryonConfig.server.js'

const shop = 'cfg-test.myshopify.com'
const productId = 'gid://shopify/Product/42'
let assetId

beforeAll(async () => {
  const a = await prisma.modelAsset.create({ data: { shop, storageRef: 'r', fitMetadata: { version: 'eyewear-v1' }, confidence: null } })
  assetId = a.id
  await prisma.productMapping.create({ data: { shop, productId, modelAssetId: assetId } })
})
afterAll(async () => {
  await prisma.productMapping.deleteMany({ where: { shop } })
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('getTryonConfig', () => {
  it('returns modelUrl + fitMetadata for a mapped product', async () => {
    const cfg = await getTryonConfig(prisma, shop, productId)
    expect(cfg.modelUrl).toBe(`/models/${assetId}.glb`)
    expect(cfg.fitMetadata.version).toBe('eyewear-v1')
  })
  it('returns null for an unmapped product', async () => {
    expect(await getTryonConfig(prisma, shop, 'gid://shopify/Product/999')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test --workspace apps/shopify-app -- tryonConfig.server`
Expected: FAIL — cannot find `app/tryonConfig.server.js`.

- [ ] **Step 3: Implement the lookup**

Create `apps/shopify-app/app/tryonConfig.server.js`:

```js
export async function getTryonConfig(prisma, shop, productId) {
  const mapping = await prisma.productMapping.findUnique({
    where: { shop_productId: { shop, productId } },
    include: { modelAsset: true },
  })
  if (!mapping) return null
  return {
    modelUrl: `/models/${mapping.modelAsset.id}.glb`,
    fitMetadata: mapping.modelAsset.fitMetadata,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test --workspace apps/shopify-app -- tryonConfig.server`
Expected: PASS.

- [ ] **Step 5: Add the route wrappers**

Create the two route files. `api.tryon-config.jsx` reads `shop`+`productId` from the query, calls `getTryonConfig`, returns `json(cfg)` or a 404. The GLB route reads `:assetId`, resolves its `storageRef`, and streams the file with `Content-Type: model/gltf-binary` and permissive CORS (`Access-Control-Allow-Origin: *`) so the iframe engine can fetch it cross-origin. Both are public (per the no-access-control constraint).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(shopify): serve GLB + tryon-config endpoints"
```

---

### Task 7: Theme App Extension (PDP "Try on" button)  *(needs Shopify CLI + dev store)*

**Files:**
- Create: `apps/shopify-app/extensions/tryon-button/` (generated by `shopify app generate extension`)
- Create/modify: the extension's `blocks/*.liquid` + `assets/*.js`

**Interfaces:**
- Produces: a theme app block a merchant adds to the product page: a "Try on" button opening a dialog with an `<iframe allow="camera">` to the hosted engine, URL `…/?shop={{ shop.permanent_domain }}&productId={{ product.id }}`.

- [ ] **Step 1: Generate the extension**

Run `shopify app generate extension` → Theme app extension, name `tryon-button`.

- [ ] **Step 2: Implement the block**

In the block liquid, render the button + a `<dialog>` with the iframe (port the existing `shopify/sections/ar-try-on.liquid` markup/JS). The iframe `src` points at the hosted engine origin (a block setting `engine_url`) with `?shop=`+`productId=` query params. `allow="camera; fullscreen"`.

- [ ] **Step 3: Verify (manual, dev store)**

`shopify app dev`, add the block to the product page in the theme editor, view the PDP.
Expected: the "Try on" button renders and opens the dialog/iframe. (Camera works on the dev store; the Permissions-Policy risk from the spec is the known untested-on-real-themes caveat.)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(shopify): theme app extension with PDP try-on button"
```

---

### Task 8: Engine adapter (fit-metadata → runtime config)

**Files:**
- Create: `src/tryon/fitMetadataAdapter.js` (in the existing engine app)
- Modify: `main.js` (read `shop`+`productId`, fetch config, feed the adapter)
- Test: `test/tryon/fitMetadataAdapter.test.js`

**Interfaces:**
- Consumes: an A1 fit-metadata record + a `modelUrl`.
- Produces: `toEngineModelConfig(fitMetadata, modelUrl) -> { modelUrl, frameWidthMeters, bridgePivot:{x,y,z}, leftHingePoint:{x,y,z}, rightHingePoint:{x,y,z}, scaleLimits:{min,max}, ... }` — the shape the engine's fit path consumes (mirrors the fields today hand-authored in `arConfig.js`).

- [ ] **Step 1: Write the failing test**

Create `test/tryon/fitMetadataAdapter.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { toEngineModelConfig } from '../../src/tryon/fitMetadataAdapter.js'

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

describe('toEngineModelConfig', () => {
  it('maps A1 fit-metadata into the engine model config', () => {
    const cfg = toEngineModelConfig(fit, '/models/abc.glb')
    expect(cfg.modelUrl).toBe('/models/abc.glb')
    expect(cfg.frameWidthMeters).toBe(0.145)
    expect(cfg.bridgePivot).toEqual({ x: 0, y: 0, z: 0.02 })
    expect(cfg.leftHingePoint).toEqual({ x: -0.069, y: -0.024, z: -0.01 })
    expect(cfg.scaleLimits).toEqual({ min: 0.85, max: 1.15 })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- fitMetadataAdapter`
Expected: FAIL — cannot find the module.

- [ ] **Step 3: Implement the adapter**

Create `src/tryon/fitMetadataAdapter.js`:

```js
export function toEngineModelConfig(fitMetadata, modelUrl) {
  return {
    modelUrl,
    frameWidthMeters: fitMetadata.frameWidthMeters,
    bridgePivot: fitMetadata.bridgeAnchor,
    leftHingePoint: fitMetadata.leftHinge,
    rightHingePoint: fitMetadata.rightHinge,
    frontFramePlaneZ: fitMetadata.frontFramePlaneZ,
    lensCenterOffset: fitMetadata.lensCenterOffset,
    scaleLimits: fitMetadata.scaleLimits,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -- fitMetadataAdapter`
Expected: PASS.

- [ ] **Step 5: Wire it into the app entry**

In `main.js`, on startup read `shop`+`productId` from `window.location.search`; if present, `fetch` the app's `/api/tryon-config?shop=&productId=`, pass the result through `toEngineModelConfig`, and hand that config to the engine's model-loading path in place of a hardcoded SKU config. Fall back to the existing default when the params are absent (keeps the standalone app working). Keep this change small and behind the presence of the query params.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(engine): adapt A1 fit-metadata into runtime model config"
```

---

### Task 9: Product-mapping admin route  *(needs Shopify CLI + dev store)*

**Files:**
- Create/modify: `apps/shopify-app/app/routes/app.models.jsx` (add a product picker + mapping action)

**Interfaces:**
- Consumes: Prisma client; the Shopify Admin GraphQL API (via the generated `authenticate.admin`) to list/pick products.
- Produces: a `ProductMapping` row linking the picked `productId` to a `ModelAsset`.

- [ ] **Step 1: Implement mapping**

Add a resource picker (App Bridge `ResourcePicker`) or a simple product-ID input to the Models page. On submit, `upsert` a `ProductMapping { shop, productId, modelAssetId }`. Show existing mappings.

- [ ] **Step 2: Verify (manual, dev store)**

`shopify app dev`, upload a model, map it to a product.
Expected: the mapping persists; `GET /api/tryon-config?shop=&productId=<mapped>` returns the model URL + fit-metadata.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(shopify): map a product to a calibrated model"
```

---

### Task 10: End-to-end verification on a dev store  *(operator + Shopify CLI)*

**Files:** none (verification task).

- [ ] **Step 1: Run the full loop**

With `shopify app dev` running and the engine app hosted (dev tunnel or local), on the dev store:
1. Install the app.
2. Upload a tagged GLB → confirm `pass` / tagged / no-manual.
3. Map it to a product.
4. Open that product's PDP → click "Try on" → the try-on opens in the iframe and renders the calibrated model.

Expected: the whole loop works. Record any theme camera-permission issues (the known risk).

- [ ] **Step 2: Confirm unit/integration suites still green**

Run `npm test` in `packages/calibration`, `apps/shopify-app`, and the engine app.
Expected: all green.

---

## Self-review

**Spec coverage:** app shell (T2) ✓; data model (T3) ✓; admin upload+calibrate (T5) ✓; A1 server integration (T4) ✓; model+config serving (T6) ✓; product mapping (T9) ✓; Theme App Extension (T7) ✓; engine adapter (T8) ✓; E2E (T10) ✓; shared A1 consumption (T1) ✓. Error handling — validator fail throws in T4, surfaced in T5; unmapped → null in T6/hidden button; tagged-confidence note honored in T5. Deferred items (manual tool, billing, CDN, prod host, GDPR hardening, analytics) correctly absent.

**Placeholder scan:** pure-unit tasks (T1, T4, T6, T8) carry full test + code. Framework/scaffold tasks (T2, T5, T7, T9, T10) give exact commands + specific edits + a concrete run-to-verify — the correct "complete" for CLI-generated code and Polaris UI (you don't reproduce generated template code in a plan). No TBD/TODO.

**Type consistency:** `calibrateUpload` return shape consistent T4↔T5; `getTryonConfig` shape (`{modelUrl, fitMetadata}`) consistent T6↔T8↔engine; fit-metadata field names match the A1 record (Global Constraints) in T4/T6/T8; `ModelAsset`/`ProductMapping` fields consistent T3↔T5↔T6↔T9.

## Open items (resolve with operator during execution)

- Exact repo layout for the workspace move (engine app stays at root vs. moves to `apps/engine`) — Task 1 Step 1.
- Local Postgres availability for `apps/shopify-app` tests (Tasks 3/6 need `DATABASE_URL`).
- Hosting the engine app for the iframe during dev (Shopify dev tunnel vs. local `vite`) — Task 7/10.

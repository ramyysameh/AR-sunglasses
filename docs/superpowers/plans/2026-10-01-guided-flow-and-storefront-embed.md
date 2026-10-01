# Guided flow, storefront embed, bulk AI generation and tutorial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchants go from opening the app to a live try-on in three moves — generate 3D models (several products at once), save them, switch the storefront embed on once — with zoomable previews, product-named models, usage bars and an annotated tutorial.

**Architecture:** Server logic stays in the existing `.server.js` modules (`generations.server.js` gains a start queue; `adminLinks.server.js` the embed deep link; `workspace.server.js` a three-step setup model). A new theme app embed shares one Liquid snippet with the existing app block. UI changes are React components rendered inside Polaris web components (`s-*`), tested through pure helpers and `renderToStaticMarkup`.

**Tech Stack:** React Router 7, React 18, Polaris web components, App Bridge, Prisma 6 (Neon Postgres), Vitest, Shopify theme app extension (Liquid), `@google/model-viewer` 4.x.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-10-01-guided-flow-and-storefront-embed-design.md`. All paths below are relative to `apps/shopify-app/` unless they start with `docs/`.
- **Never run the full test suite, DB-backed tests, `prisma migrate dev|deploy` or `prisma db push` locally** — dev and prod share one Neon database. Run only the test files named in each task (`npx vitest run <files>`), all of which use fakes.
- Migrations are applied by the Vercel build (`prisma migrate deploy`), never locally.
- React 18 drops `onChange` and custom events on `s-*` elements: use `onClick`/`onInput`, or native elements, or `addEventListener` via a ref.
- Shopify admin destinations (theme editor, pricing) are opened with the existing `TopLevelAdminAction` component, never `s-link`/`s-button href`.
- Canonical app API key for deep links: `be1db9d64c7c617dcd67f6add58f4824` (the `CANONICAL_API_KEY` in `app/adminLinks.server.js`).
- Bulk: at most **5** products per request; at most **5** generations running per shop; daily cap stays **20** (`LIMITS.perDay`).
- Embed block handle: **`tryon_embed`**; shared snippet: **`tryon_core`**.
- Tutorial screenshots show generic demo sunglasses only — no Gripz products, names or logos.
- Copy rules: sentence case, no exclamation marks, merchant-facing errors never show raw exception text.
- Commit after every task with a `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer. Work in the worktree `D:\AR Sunglasses\wt-ai-model-gen` on branch `feature/ai-model-generation`.

## File map

| File | Change | Responsibility |
|---|---|---|
| `app/models.server.js` | modify | `saveCalibratedModel` accepts a `label` |
| `app/generations.server.js` | modify | product-named saves, start queue, 5-slot limit |
| `prisma/migrations/20261002000000_ai_model_product_labels/migration.sql` | create | one-off label backfill |
| `test/helpers/fakePrisma.js` | modify | `modelAsset.findMany` for label lookup |
| `app/components/ModelViewer.jsx` | modify | zoom, height, +/−/reset controls |
| `app/components/AiModelUsage.jsx` | create | free-AI-models bar |
| `app/routes/app.models.jsx` | modify | usage bars at the top |
| `app/routes/api.generations.jsx` | modify | `create-from-products` intent |
| `app/components/AiProductSource.jsx` | modify | multi-product rows |
| `app/components/AiModelFlow.jsx` | modify | bulk state/requests, queued copy, zoomable review |
| `extensions/tryon-button/snippets/tryon_core.liquid` | create | shared button/dialog/ping/script/styles |
| `extensions/tryon-button/blocks/tryon_button.liquid` | modify | renders the snippet |
| `extensions/tryon-button/blocks/tryon_embed.liquid` | create | app embed + placement script |
| `app/adminLinks.server.js` | modify | `embedActivationUrl` |
| `app/tryonStatus.server.js` | modify | store-wide "on theme" signal |
| `app/workspace.server.js` | modify | three-step setup + embed links |
| `app/components/SetupSteps.jsx` | create | guided three steps |
| `app/routes/app._index.jsx` | modify | guide + Create with AI on home |
| `app/routes/app.additional.jsx` | modify | Help text for the embed |
| `app/components/AnnotatedScreenshot.jsx` | create | screenshot + SVG marks |
| `app/tutorialSteps.js` | create | tutorial content + mark coordinates |
| `app/routes/app.tutorial.jsx` | create | Tutorial page |
| `app/routes/app.jsx` | modify | nav link |
| `public/tutorial/*.png` | create | screenshots (Task 11) |

---

# Part A — quick wins (deploy after Task 3)

### Task 1: Saved AI models are named after their product

**Files:**
- Modify: `app/models.server.js:13-28`
- Modify: `app/generations.server.js` (function `assetForGeneration`, ~line 349)
- Modify: `test/helpers/fakePrisma.js` (the `modelAsset` object, ~line 145)
- Create: `prisma/migrations/20261002000000_ai_model_product_labels/migration.sql`
- Test: `test/generations.server.test.js`

**Interfaces:**
- Produces: `saveCalibratedModel(prisma, shop, glbBytes, filename = null, { id, label } = {})`; `uniqueAssetLabel(prisma, shop, base): Promise<string>` exported from `generations.server.js`.

- [ ] **Step 1: Extend the fake Prisma.** In `test/helpers/fakePrisma.js`, add `findMany` to `modelAsset` (supports `where` equality via the existing `matches`, ignores `select`):

```js
  const modelAsset = {
    assets,
    async findUnique({ where }) {
      const id = idOnly(where, 'modelAsset.findUnique')
      return copy(assets.get(id))
    },
    async findMany({ where } = {}) {
      return [...assets.values()].filter((asset) => matches(asset, where)).map(copy)
    },
  }
```

Also update the header comment's first line to read `(modelGeneration, plus modelAsset.findUnique by id and findMany)`.

- [ ] **Step 2: Write the failing tests** (append inside `describe('saveGeneration', …)` in `test/generations.server.test.js`; `row`, `SHOP`, `NOW`, `deps` already exist there; `deps.saveCalibratedModel` is the mocked asset creator — check the file's existing save tests for how it is stubbed and mirror that):

```js
  it('names a product-sourced model after its product', async () => {
    const prisma = createFakePrisma()
    deps.objects.set('generations/p.glb', Buffer.from('glb'))
    const g = await prisma.modelGeneration.create({
      data: row({ status: 'ready', glbRef: 'generations/p.glb', photoSource: 'product', productTitle: 'Aviator Gold' }),
    })
    deps.saveCalibratedModel.mockResolvedValue({ assetId: g.id })
    await generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW })
    expect(deps.saveCalibratedModel).toHaveBeenCalledWith(prisma, SHOP, expect.anything(), 'AI model', { id: g.id, label: 'Aviator Gold' })
  })

  it('adds (2) when the shop already has a model with that name', async () => {
    const prisma = createFakePrisma()
    prisma.modelAsset.assets.set('a1', { id: 'a1', shop: SHOP, label: 'Aviator Gold' })
    prisma.modelAsset.assets.set('a2', { id: 'a2', shop: 'other.myshopify.com', label: 'Aviator Gold (2)' })
    expect(await generations.uniqueAssetLabel(prisma, SHOP, 'Aviator Gold')).toBe('Aviator Gold (2)')
    prisma.modelAsset.assets.set('a3', { id: 'a3', shop: SHOP, label: 'Aviator Gold (2)' })
    expect(await generations.uniqueAssetLabel(prisma, SHOP, 'Aviator Gold')).toBe('Aviator Gold (3)')
  })

  it('keeps an uploaded-photo model unlabelled', async () => {
    const prisma = createFakePrisma()
    deps.objects.set('generations/u.glb', Buffer.from('glb'))
    const g = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/u.glb' }) })
    deps.saveCalibratedModel.mockResolvedValue({ assetId: g.id })
    await generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW })
    expect(deps.saveCalibratedModel).toHaveBeenCalledWith(prisma, SHOP, expect.anything(), 'AI model', { id: g.id, label: null })
  })
```

- [ ] **Step 3: Run and see them fail.** `npx vitest run test/generations.server.test.js` → the three new tests FAIL (`uniqueAssetLabel is not a function`, wrong call args).

- [ ] **Step 4: Implement.** In `app/models.server.js` change the signature and the create data:

```js
export async function saveCalibratedModel(prisma, shop, glbBytes, filename = null, { id, label = null } = {}) {
```
```js
      filename: filename || null,
      label: label || null,
```

In `app/generations.server.js`, above `assetForGeneration`, add:

```js
/**
 * The library name for a model generated from a product: the product's title,
 * or "Title (2)", "(3)", ... when the shop already has a model called that.
 */
export async function uniqueAssetLabel(prisma, shop, base) {
  const assets = await prisma.modelAsset.findMany({ where: { shop }, select: { label: true } })
  const taken = new Set(assets.map((asset) => asset.label).filter(Boolean))
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`
    if (!taken.has(candidate)) return candidate
  }
}
```

and in `assetForGeneration` replace the `saveCalibratedModel` call with:

```js
  const label = generation.photoSource === 'product' && generation.productTitle
    ? await uniqueAssetLabel(prisma, shop, generation.productTitle)
    : null
  try {
    return await saveCalibratedModel(prisma, shop, bytes, 'AI model', { id: generation.id, label })
```

- [ ] **Step 5: Backfill migration.** Create `prisma/migrations/20261002000000_ai_model_product_labels/migration.sql`:

```sql
-- One-off: models generated from a product before 2026-10-02 were all called
-- "AI model". Name them after their product (only where the merchant hasn't
-- renamed them).
UPDATE "ModelAsset" AS a
SET "label" = g."productTitle"
FROM "ModelGeneration" AS g
WHERE g."modelAssetId" = a."id"
  AND g."photoSource" = 'product'
  AND g."productTitle" IS NOT NULL
  AND a."label" IS NULL
  AND a."filename" = 'AI model';
```

Do NOT run it locally.

- [ ] **Step 6: Run the tests.** `npx vitest run test/generations.server.test.js test/models.server.test.js` → all PASS. (If `test/models.server.test.js` is DB-backed — it imports `db.server` without a mock — skip it and say so in the report.)

- [ ] **Step 7: Commit.** `git add -A app/models.server.js app/generations.server.js test/helpers/fakePrisma.js test/generations.server.test.js prisma/migrations/20261002000000_ai_model_product_labels && git commit -m "feat(ai-gen): name saved models after their product"`

---

### Task 2: Zoomable 3D preview

> **Amended 2026-10-01 (owner):** large preview window / full screen instead of zoom buttons. See `.superpowers/sdd/2026-10-01-guided-flow-and-storefront-embed/task-2-amendment.md`; it supersedes the +/−/reset parts below.

**Files:**
- Modify: `app/components/ModelViewer.jsx`
- Modify: `app/components/AiModelFlow.jsx:140` (the `ModelViewer` in `GenerationRow`)
- Test: `test/modelViewer.ui.test.js` (create)

**Interfaces:**
- Produces: `<ModelViewer src alt height={160} controls={false} />`; exported pure `zoomStep(direction: 'in'|'out'): number` (+1 / −1).

- [ ] **Step 1: Write the failing test** `test/modelViewer.ui.test.js`:

```js
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ModelViewer, { zoomStep } from '../app/components/ModelViewer.jsx'

global.React = React

const render = (props) => renderToStaticMarkup(React.createElement(ModelViewer, { src: '/m.glb', ...props }))

describe('ModelViewer', () => {
  it('defaults to a 160px viewer without zoom buttons', () => {
    const html = render({})
    expect(html).toContain('height:160px')
    expect(html).not.toContain('Zoom in')
  })

  it('renders zoom in, zoom out and reset buttons when asked', () => {
    const html = render({ height: 320, controls: true })
    expect(html).toContain('height:320px')
    expect(html).toContain('aria-label="Zoom in"')
    expect(html).toContain('aria-label="Zoom out"')
    expect(html).toContain('aria-label="Reset view"')
  })

  it('maps zoom directions to model-viewer key presses', () => {
    expect(zoomStep('in')).toBe(1)
    expect(zoomStep('out')).toBe(-1)
  })
})
```

- [ ] **Step 2: Run it.** `npx vitest run test/modelViewer.ui.test.js` → FAIL (`zoomStep` not exported, no buttons).

- [ ] **Step 3: Implement** — replace `app/components/ModelViewer.jsx` with:

```jsx
// app/components/ModelViewer.jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useRef, useState } from "react";

/** model-viewer's zoom() takes "key presses": positive zooms in. */
export function zoomStep(direction) {
  return direction === "in" ? 1 : -1;
}

const controlStyle = {
  width: "32px",
  height: "32px",
  border: "1px solid #d4d4d4",
  borderRadius: "8px",
  background: "#fff",
  font: "inherit",
  fontSize: "16px",
  lineHeight: "1",
  cursor: "pointer",
};

export default function ModelViewer({ src, alt = "3D model preview", height = 160, controls = false }) {
  const holderRef = useRef(null);
  const viewerRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  // Mount only when scrolled near the viewport (long lists stay fast).
  useEffect(() => {
    const el = holderRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // Client-only dynamic import — never runs during SSR.
  useEffect(() => {
    if (!visible || ready) return;
    let cancelled = false;
    import("@google/model-viewer").then(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [visible, ready]);

  function zoom(direction) {
    const viewer = viewerRef.current;
    if (viewer && typeof viewer.zoom === "function") viewer.zoom(zoomStep(direction));
  }

  function reset() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.cameraOrbit = "auto auto auto";
    viewer.fieldOfView = "auto";
    if (typeof viewer.jumpCameraToGoal === "function") viewer.jumpCameraToGoal();
  }

  return (
    <div ref={holderRef} style={{ position: "relative", width: "100%", height: `${height}px` }}>
      {ready ? (
        <model-viewer
          ref={viewerRef}
          src={src}
          alt={alt}
          camera-controls
          style={{ width: "100%", height: "100%", backgroundColor: "transparent" }}
        ></model-viewer>
      ) : (
        <s-stack direction="block" alignItems="center" justifyContent="center">
          <s-spinner accessibilityLabel="Loading 3D preview"></s-spinner>
        </s-stack>
      )}
      {controls && (
        <div style={{ position: "absolute", right: "8px", bottom: "8px", display: "flex", gap: "6px" }}>
          <button type="button" aria-label="Zoom in" style={controlStyle} onClick={() => zoom("in")}>+</button>
          <button type="button" aria-label="Zoom out" style={controlStyle} onClick={() => zoom("out")}>−</button>
          <button type="button" aria-label="Reset view" style={controlStyle} onClick={reset}>↺</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Use it on review cards.** In `app/components/AiModelFlow.jsx` `GenerationRow`, change the viewer line to:

```jsx
        {generation.previewUrl && <ModelViewer src={generation.previewUrl} alt="AI-generated model preview" height={320} controls />}
```

- [ ] **Step 5: Run.** `npx vitest run test/modelViewer.ui.test.js test/aiModelFlow.ui.test.js test/appModels.ui.test.js` → PASS.

- [ ] **Step 6: Commit.** `git add app/components/ModelViewer.jsx app/components/AiModelFlow.jsx test/modelViewer.ui.test.js && git commit -m "feat(models): zoomable 3D preview with zoom buttons on review cards"`

---

### Task 3: Usage bars on the Models page

**Files:**
- Create: `app/components/AiModelUsage.jsx`
- Modify: `app/routes/app.models.jsx` (loader return ~line 76; page body top; add `links`)
- Test: `test/aiModelUsage.ui.test.js` (create)

**Interfaces:**
- Consumes: `usagePercent({used, limit})` and default `PlanUsage` from `app/components/PlanUsage.jsx`; loader's existing `getAllowance` result `{allowance, used, unlimited, freeRemaining}`.
- Produces: `<AiModelUsage allowance={…} />`; Models loader returns `usage` (the full `planUsage(...)` object) in addition to existing fields.

- [ ] **Step 1: Failing test** `test/aiModelUsage.ui.test.js`:

```js
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AiModelUsage from '../app/components/AiModelUsage.jsx'

global.React = React

const render = (allowance) => renderToStaticMarkup(React.createElement(AiModelUsage, { allowance }))

describe('AiModelUsage', () => {
  it('shows used of allowance with a bar', () => {
    const html = render({ allowance: 10, used: 3, unlimited: false, freeRemaining: 7 })
    expect(html).toContain('3 of 10 free AI models used')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('width:30%')
  })

  it('says what happens after the free models run out', () => {
    const html = render({ allowance: 10, used: 12, unlimited: false, freeRemaining: 0 })
    expect(html).toContain('10 of 10 free AI models used')
    expect(html).toContain('then $5 each')
    expect(html).toContain('width:100%')
  })

  it('has no bar on an unlimited plan', () => {
    const html = render({ allowance: null, used: 4, unlimited: true, freeRemaining: null })
    expect(html).toContain('Unlimited AI models · 4 created')
    expect(html).not.toContain('progressbar')
  })

  it('renders nothing when the feature is off', () => {
    expect(render(null)).toBe('')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run test/aiModelUsage.ui.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** `app/components/AiModelUsage.jsx`:

```jsx
/* eslint-disable react/prop-types -- loader-shaped data, same as PlanUsage */
import { usagePercent } from './PlanUsage'

/**
 * The free-AI-models meter for the Models page. Uses the same track/fill
 * classes as PlanUsage (styles/workspace.css).
 * @param {{allowance: {allowance: number|null, used: number, unlimited: boolean, freeRemaining: number|null}|null}} props
 */
export default function AiModelUsage({ allowance }) {
  if (!allowance) return null
  if (allowance.unlimited) {
    return <s-text color="subdued">Unlimited AI models · {allowance.used} created</s-text>
  }
  const shown = Math.min(allowance.used, allowance.allowance)
  const full = allowance.used >= allowance.allowance
  return (
    <s-stack direction="block" gap="small-200">
      <s-text type="strong">{shown} of {allowance.allowance} free AI models used</s-text>
      <div
        className="workspace-plan-track"
        role="progressbar"
        aria-label={`${shown} of ${allowance.allowance} free AI models used`}
        aria-valuemin={0}
        aria-valuemax={allowance.allowance}
        aria-valuenow={shown}
      >
        <div
          className={full ? 'workspace-plan-fill is-full' : 'workspace-plan-fill'}
          style={{ width: `${usagePercent({ used: allowance.used, limit: allowance.allowance })}%` }}
        />
      </div>
      {full && <s-text color="subdued">Free models used up, then $5 each, added to your Shopify bill.</s-text>}
    </s-stack>
  )
}
```

- [ ] **Step 4: Wire into the Models page.** In `app/routes/app.models.jsx`:
  - import: `import PlanUsage from '../components/PlanUsage'`, `import AiModelUsage from '../components/AiModelUsage'`, `import workspaceStyles from '../styles/workspace.css?url'`
  - add `export const links = () => [{ rel: 'stylesheet', href: workspaceStyles }]`
  - in the loader's subscribed branch return `usage` too: `return { ai, usage, atLimit: usage.atLimit, … }`; in the no-plan branch return `usage: null`.
  - at the very top of the page body (before the Create with AI section), render:

```jsx
      {data.usage && (
        <s-section heading="Usage">
          <s-stack direction="block" gap="base">
            {data.ai && <AiModelUsage allowance={data.ai.allowance} />}
            <PlanUsage usage={data.usage} />
          </s-stack>
        </s-section>
      )}
```

  (Use whatever the component already calls the loader data — read the default export first; if it destructures `useLoaderData()`, add `usage` there.) `PlanUsage` renders its own `s-section`; if nesting sections looks wrong in the admin, render `PlanUsage` directly after the AI section instead — note the choice in the report.

- [ ] **Step 5: Run** `npx vitest run test/aiModelUsage.ui.test.js test/planUsage.ui.test.js test/appModels.ui.test.js test/appModels.loader.test.js` → PASS (if `appModels.loader.test.js` asserts the exact loader return shape, add `usage` to its expectations).

- [ ] **Step 6: Commit.** `git add app/components/AiModelUsage.jsx app/routes/app.models.jsx test/aiModelUsage.ui.test.js test/appModels.loader.test.js && git commit -m "feat(models): usage bars for free AI models and products with try-on"`

**Part A release (controller, not a subagent):** `npx react-router build` passes → `git push origin HEAD:main` → wait for Vercel production READY (check the migration ran: `SELECT label FROM "ModelAsset" WHERE id='111222f5-6b71-49ae-9b93-f539cbb1acfc'` = `Gripz Pelmo Sunglasses`) → screenshot the Models page.

---

# Part B — bulk generation, storefront embed, guided flow (deploy after Task 9)

### Task 4: Start queue and five running slots

**Files:**
- Modify: `app/generations.server.js` (`LIMITS`, `assertCanStartGeneration`, `toClientGeneration`, `createGeneration`, `advanceByProviderJob`, `listGenerations`; new `startQueued`, `startRow`)
- Modify: `app/components/AiModelFlow.jsx` (`generationView` `queued` case)
- Test: `test/generations.server.test.js`, `test/aiModelFlow.ui.test.js`

**Interfaces:**
- Produces: `LIMITS.running === 5`; `startQueued(prisma, shop, now): Promise<number>` (rows started); client status `'queued'` = waiting for a slot (a row that is starting reads `'running'`).
- Slot rule: a row holds a slot when `status in ('running','collecting')` OR (`status = 'queued'` AND `startedAt` is not null). A waiting row is `queued` with `startedAt = null`.

- [ ] **Step 1: Failing tests** (append to `test/generations.server.test.js`; `deps.start` is the mocked `startGeneration`):

```js
describe('start queue', () => {
  const t = (min) => new Date(NOW.getTime() - min * 60_000)

  it('starts up to 5 at once and queues the rest without calling OpenAI', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_x' })
    for (let i = 0; i < 5; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `s${i}` }) })
    }
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g.status).toBe('queued')
    expect(g.startedAt).toBeNull()
    expect(deps.start).not.toHaveBeenCalled()
    expect(generations.toClientGeneration(g).status).toBe('queued')
  })

  it('counts a row that is mid-start as holding a slot', async () => {
    const prisma = createFakePrisma()
    for (let i = 0; i < 4; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `s${i}` }) })
    }
    await prisma.modelGeneration.create({ data: row({ status: 'queued', startedAt: NOW, photoSetId: 'starting' }) })
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g.status).toBe('queued')
    expect(g.startedAt).toBeNull()
  })

  it('startQueued starts the oldest waiting rows while slots are free', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_q' })
    for (let i = 0; i < 3; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `s${i}` }) })
    }
    const older = await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(3), photoSetId: 'q1' }) })
    const middle = await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(2), photoSetId: 'q2' }) })
    const newest = await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(1), photoSetId: 'q3' }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(2)
    expect((await prisma.modelGeneration.findUnique({ where: { id: older.id } })).status).toBe('running')
    expect((await prisma.modelGeneration.findUnique({ where: { id: middle.id } })).status).toBe('running')
    expect((await prisma.modelGeneration.findUnique({ where: { id: newest.id } })).status).toBe('queued')
  })

  it('a queued row whose start fails is failed, free', async () => {
    const prisma = createFakePrisma()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    deps.start.mockRejectedValue(new Error('openai down'))
    const q = await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'q' }) })
    await generations.startQueued(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: q.id } })).toMatchObject({ status: 'failed', error: 'start_failed' })
  })

  it('fails a row stuck mid-start for over 5 minutes so it frees its slot', async () => {
    const prisma = createFakePrisma()
    const stuck = await prisma.modelGeneration.create({ data: row({ status: 'queued', startedAt: t(6), photoSetId: 'x' }) })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: stuck.id } })).toMatchObject({ status: 'failed', error: 'start_failed' })
  })

  it('listGenerations starts waiting rows', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_l' })
    const q = await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'q' }) })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect((await prisma.modelGeneration.findUnique({ where: { id: q.id } })).status).toBe('running')
  })

  it('still refuses past the daily limit, counting waiting rows', async () => {
    const prisma = createFakePrisma()
    for (let i = 0; i < 20; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(10), photoSetId: `d${i}` }) })
    }
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }))
      .rejects.toMatchObject({ code: 'DAILY_LIMIT' })
  })
})
```

Find the existing test that expects `TOO_MANY_RUNNING` (search the file) and change it to expect a queued row instead (the cap is now 5 and never throws). Add to `test/aiModelFlow.ui.test.js`:

```js
  it('says a queued model is waiting for a free slot', () => {
    expect(generationView({ status: 'queued', retriesLeft: 3 })).toMatchObject({ label: expect.stringMatching(/Waiting to start/), actions: [] })
  })
```

and replace the existing "shows queued the same as running" test with that one.

- [ ] **Step 2: Run** `npx vitest run test/generations.server.test.js test/aiModelFlow.ui.test.js` → new tests FAIL.

- [ ] **Step 3: Implement in `app/generations.server.js`.**

`LIMITS.running: 5`.

Replace `assertCanStartGeneration` with a daily-only guard (keep the exported name; the presign and route callers keep working) plus a slot counter:

```js
// Rows holding one of the shop's running slots: running, collecting, or queued
// and already being started (startedAt set). A waiting row has startedAt null.
async function slotsInUse(prisma, shop) {
  const [active, starting] = await Promise.all([
    prisma.modelGeneration.count({ where: { shop, status: { in: ['running', 'collecting'] } } }),
    prisma.modelGeneration.count({ where: { shop, status: 'queued', startedAt: { not: null } } }),
  ])
  return active + starting
}

/**
 * The cost guard: at most LIMITS.perDay starts (plus automatic retries) in 24
 * hours. Concurrency is no longer refused: over LIMITS.running, new rows wait
 * in the queue (startQueued). The photo presign runs this first, unlocked, so
 * a start that would be refused doesn't leave uploaded photos behind.
 */
export async function assertCanStartGeneration(prisma, shop, now = new Date()) {
  const since = new Date(now.getTime() - DAY_MS)
  const [started, autoRetries] = await Promise.all([
    prisma.modelGeneration.count({ where: { shop, createdAt: { gte: since } } }),
    prisma.modelGeneration.count({ where: { shop, createdAt: { gte: since }, autoRetried: true } }),
  ])
  if (started + autoRetries >= LIMITS.perDay) {
    throw tagged('DAILY_LIMIT', `shop started ${started + autoRetries} generations in 24h`)
  }
}
```

In `toClientGeneration`, replace the status line with:

```js
  const waiting = generation.status === 'queued' && !generation.startedAt
  const status = waiting
    ? 'queued'
    : ['queued', 'collecting'].includes(generation.status) ? 'running' : generation.status
```

Extract the start-and-mark-running code into a helper used by both `createGeneration` and `startQueued`:

```js
// Slow network call: never inside a transaction. Failing to reach OpenAI is
// not an exception: the row comes back `failed` (free).
async function startRow(prisma, generation, now) {
  let providerJobId
  try {
    const started = await startGeneration({
      images: await photoUrls(generation.photoRefs),
      source: generation.photoSource,
    })
    providerJobId = started.providerJobId
  } catch (error) {
    console.error('AI generation start failed', generation.id, error)
    return prisma.modelGeneration.update({
      where: { id: generation.id },
      data: { status: 'failed', error: 'start_failed' },
    })
  }
  // A database error here must surface, not mark a live OpenAI job as failed.
  return prisma.modelGeneration.update({
    where: { id: generation.id },
    data: { status: 'running', providerJobId, startedAt: now },
  })
}
```

In `createGeneration`'s transaction, after `await assertCanStartGeneration(tx, shop, now)`:

```js
    const startNow = (await slotsInUse(tx, shop)) < LIMITS.running
    const created = await tx.modelGeneration.create({
      data: {
        shop, shopGid, photoRefs: refs, photoSetId, retryIndex, ...source,
        status: 'queued', startedAt: startNow ? now : null, createdAt: now,
      },
    })
    return { generation: created, parent: parentRow }
```

and replace everything after the transaction with:

```js
  // Waiting for a slot: startQueued starts it when one frees up.
  if (!generation.startedAt) return generation
  const result = await startRow(prisma, generation, now)
  // The unsaved result is only thrown away once its replacement is running.
  if (result.status === 'running' && parent?.status === 'ready') await discardGeneration(prisma, shop, parent.id)
  return result
```

(Behaviour note: a retry that has to wait no longer discards its parent at once — the parent's ready result stays visible until the retry actually runs. Mention in the report.)

Add `startQueued`:

```js
/**
 * Start waiting rows, oldest first, while the shop has free slots. Each row is
 * claimed by setting startedAt (conditional on it still being null), so the
 * webhook and a page poll can't start the same row twice.
 * @returns {Promise<number>} how many rows were started
 */
export async function startQueued(prisma, shop, now = new Date()) {
  let started = 0
  while ((await slotsInUse(prisma, shop)) < LIMITS.running) {
    const waiting = await prisma.modelGeneration.findMany({
      where: { shop, status: 'queued', startedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    const next = waiting.at(-1)
    if (!next) break
    const claim = await prisma.modelGeneration.updateMany({
      where: { id: next.id, status: 'queued', startedAt: null },
      data: { startedAt: now },
    })
    if (claim.count === 0) continue
    await startRow(prisma, { ...next, startedAt: now }, now)
    started += 1
  }
  return started
}
```

In `listGenerations`, right after the `collecting` hand-back `updateMany`, fail rows stuck mid-start:

```js
  // A crash between claiming a queued row and starting it leaves it holding a
  // slot forever; after 5 minutes give up on it (free).
  await prisma.modelGeneration.updateMany({
    where: { shop, status: 'queued', startedAt: { lt: new Date(now.getTime() - LIMITS.stuckMs) } },
    data: { status: 'failed', error: 'start_failed' },
  })
```

and after the `running` advance loop:

```js
  try {
    await startQueued(prisma, shop, now)
  } catch (error) {
    console.error('AI generation queue start failed', shop, error)
  }
```

In `advanceByProviderJob`:

```js
export async function advanceByProviderJob(prisma, providerJobId, now = new Date()) {
  const generation = await prisma.modelGeneration.findFirst({ where: { providerJobId, status: 'running' } })
  if (!generation) return null
  const advanced = await advanceGeneration(prisma, generation, now)
  if (advanced?.status !== 'running') {
    try {
      await startQueued(prisma, generation.shop, now)
    } catch (error) {
      console.error('AI generation queue start failed', generation.shop, error)
    }
  }
  return advanced
}
```

Update the comment in `advanceGeneration` that says "the shop's two running slots" → "the shop's running slots".

- [ ] **Step 4: UI copy.** In `app/components/AiModelFlow.jsx` `generationView`, split the `queued` case:

```js
    case 'queued':
      return { label: 'Waiting to start. It begins when another model finishes.', tone: 'neutral', actions: [] }
    case 'running':
      return { label: 'Generating… this takes a few minutes. You can leave this page.', tone: 'info', actions: [] }
```

In `app/routes/api.generations.jsx`, change `MESSAGES.TOO_MANY_RUNNING` to `'Too many models are being generated. Wait for one to finish.'` (kept for safety; nothing throws it now).

- [ ] **Step 5: Run** `npx vitest run test/generations.server.test.js test/aiModelFlow.ui.test.js test/apiGenerations.route.test.js` → PASS.

- [ ] **Step 6: Commit.** `git add app/generations.server.js app/components/AiModelFlow.jsx app/routes/api.generations.jsx test/generations.server.test.js test/aiModelFlow.ui.test.js && git commit -m "feat(ai-gen): five running slots and a start queue"`

---

### Task 5: `create-from-products` API intent

**Files:**
- Modify: `app/routes/api.generations.jsx`
- Test: `test/apiGenerations.route.test.js`

**Interfaces:**
- Consumes: `importProductPhotos({admin, shop, productId, imageIds}) → {photoRefs, productId, title, handle}`, `createGeneration`, `assertCanStartGeneration`.
- Produces: `POST /api/generations` with `intent=create-from-products`, `items=JSON [{productId, imageIds:[…]}]` (1–5). Response 200 `{ results: [{ productId, generation? , error?, code? }] }` in request order; 400 `{ error: 'Choose 1 to 5 products.', code: 'BAD_PRODUCTS' }` for a malformed list.

- [ ] **Step 1: Failing tests** (append to `test/apiGenerations.route.test.js`, mirroring the existing `create-from-product` tests' setup of `h.gen.guard`, `h.gen.create`, `h.products.import`, `h.deleteGlb`):

```js
describe('create-from-products', () => {
  beforeEach(() => {
    h.gen.guard = vi.fn(async () => {})
    h.deleteGlb.mockReset()
    h.products.import.mockReset()
    h.products.import.mockImplementation(async ({ productId }) => ({
      photoRefs: [`p/${productId}/1.jpg`, `p/${productId}/2.jpg`, `p/${productId}/3.jpg`],
      productId,
      title: `Title ${productId}`,
      handle: `handle-${productId}`,
    }))
    h.gen.create = vi.fn(async (_prisma, input) => ({ id: `gen-${input.productId}`, status: 'running' }))
  })

  const items = (ids) => JSON.stringify(ids.map((productId) => ({ productId, imageIds: ['i1', 'i2', 'i3'] })))

  it('creates one generation per product, in order', async () => {
    const res = await api.action(post({ intent: 'create-from-products', items: items(['A', 'B']) }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toEqual([
      { productId: 'A', generation: { id: 'gen-A', status: 'running' } },
      { productId: 'B', generation: { id: 'gen-B', status: 'running' } },
    ])
    expect(h.gen.create.mock.calls[1][1]).toMatchObject({ photoSource: 'product', productTitle: 'Title B', productHandle: 'handle-B' })
  })

  it('reports a failing product without stopping the others', async () => {
    h.products.import.mockImplementationOnce(async () => { throw tagged('PRODUCT_NOT_FOUND') })
    const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A', 'B']) }))).json()
    expect(body.results[0]).toMatchObject({ productId: 'A', code: 'PRODUCT_NOT_FOUND', error: expect.any(String) })
    expect(body.results[1]).toMatchObject({ productId: 'B', generation: { id: 'gen-B' } })
  })

  it('deletes imported photos when the row was never created', async () => {
    h.gen.create = vi.fn(async () => { throw tagged('DAILY_LIMIT') })
    const body = await (await api.action(post({ intent: 'create-from-products', items: items(['A']) }))).json()
    expect(body.results[0]).toMatchObject({ code: 'DAILY_LIMIT' })
    expect(h.deleteGlb.mock.calls.map(([ref]) => ref)).toEqual(['p/A/1.jpg', 'p/A/2.jpg', 'p/A/3.jpg'])
  })

  it('refuses an empty list or more than 5 products', async () => {
    for (const ids of [[], ['1', '2', '3', '4', '5', '6']]) {
      const res = await api.action(post({ intent: 'create-from-products', items: items(ids) }))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_PRODUCTS')
    }
  })

  it('checks the daily limit before importing anything', async () => {
    h.gen.guard = vi.fn(async () => { throw tagged('DAILY_LIMIT') })
    const res = await api.action(post({ intent: 'create-from-products', items: items(['A']) }))
    expect(res.status).toBe(429)
    expect(h.products.import).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run** `npx vitest run test/apiGenerations.route.test.js` → FAIL.

- [ ] **Step 3: Implement.** In `app/routes/api.generations.jsx`:
  - `STATUS_BY_CODE.BAD_PRODUCTS = 400`, `MESSAGES.BAD_PRODUCTS = 'Choose 1 to 5 products.'`.
  - Extract the existing `create-from-product` body (import + create + cleanup) into a helper and reuse it:

```js
async function deletePhotos(refs) {
  for (const ref of refs) {
    try {
      await deleteModelGlb(ref)
    } catch (cleanupError) {
      console.error('Failed to clean up imported product photo', ref, cleanupError)
    }
  }
}

// Import a product's chosen photos and start (or queue) its generation.
async function generateFromProduct({ admin, shop, shopGid, productId, imageIds }) {
  const imported = await importProductPhotos({ admin, shop, productId, imageIds })
  try {
    return await createGeneration(prisma, {
      shop,
      shopGid,
      photoRefs: imported.photoRefs,
      photoSource: 'product',
      productId: imported.productId,
      productTitle: imported.title,
      productHandle: imported.handle,
    })
  } catch (error) {
    // Only when the error says no row was created: createGeneration throws these
    // before its insert. Anything else (a dropped connection after the insert)
    // may have left a row pointing at these photos, so they stay.
    if (PRE_INSERT_CODES.has(error?.code)) await deletePhotos(imported.photoRefs)
    throw error
  }
}
```

  - `create-from-product` becomes:

```js
    if (intent === 'create-from-product') {
      // Same reasoning as presign-photos: refuse before anything is stored.
      await assertCanStartGeneration(prisma, shop)
      const generation = await generateFromProduct({
        admin,
        shop,
        shopGid: await shopGidFor(admin),
        productId: form.get('productId')?.toString(),
        imageIds: parseJson(form.get('imageIds')),
      })
      return Response.json({ generation: toClientGeneration(generation) })
    }
```

  - new intent (one product after another, so each row's queue decision sees the previous one):

```js
    if (intent === 'create-from-products') {
      let items
      try {
        items = JSON.parse(form.get('items')?.toString() ?? '')
      } catch {
        items = null
      }
      if (!Array.isArray(items) || items.length < 1 || items.length > 5) {
        throw Object.assign(new Error('bad product list'), { code: 'BAD_PRODUCTS' })
      }
      await assertCanStartGeneration(prisma, shop)
      const shopGid = await shopGidFor(admin)
      const results = []
      for (const item of items) {
        const productId = item?.productId?.toString() ?? null
        try {
          const generation = await generateFromProduct({ admin, shop, shopGid, productId, imageIds: item?.imageIds })
          results.push({ productId, generation: toClientGeneration(generation) })
        } catch (error) {
          const known = STATUS_BY_CODE[error?.code]
          if (!known) console.error('AI bulk generation item failed', productId, error)
          results.push({
            productId,
            code: known ? error.code : 'UNKNOWN',
            error: known ? MESSAGES[error.code] : 'Something went wrong. Try again.',
          })
        }
      }
      return Response.json({ results })
    }
```

- [ ] **Step 4: Run** `npx vitest run test/apiGenerations.route.test.js` → PASS (existing `create-from-product` tests too).

- [ ] **Step 5: Commit.** `git add app/routes/api.generations.jsx test/apiGenerations.route.test.js && git commit -m "feat(ai-gen): generate from up to 5 products in one request"`

---

### Task 6: Bulk "From products" UI

**Files:**
- Modify: `app/components/AiProductSource.jsx` (multi-product rendering)
- Modify: `app/components/AiModelFlow.jsx` (state, picker, request, results)
- Test: `test/aiModelFlow.ui.test.js`, `test/aiProductSource.ui.test.js` (create)

**Interfaces:**
- Consumes: `create-from-products` (Task 5), `product-images` intent (existing, returns `{product:{id,title}, images:[{id,thumbnailUrl,altText}]}`).
- Produces (exported from `AiModelFlow.jsx`): `MAX_PRODUCTS = 5`; `pickedFromLookup(product, images) → {id, title, images, selected}`; `bulkItems(picked) → [{productId, imageIds}]` (only products with 3–4 ticked); `generateLabel(count) → string`; `bulkResultMessage(results, picked) → string|null`.
- `AiProductSource` props become `{ picked, disabled, onChoose, onToggle(productId, imageId), onRemove(productId) }`.

- [ ] **Step 1: Failing tests** — add to `test/aiModelFlow.ui.test.js` (import the new names):

```js
describe('bulk product generation', () => {
  const images = (n) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, thumbnailUrl: `t${i}`, altText: '' }))

  it('pre-ticks the first 4 photos of each picked product', () => {
    expect(pickedFromLookup({ id: 'P', title: 'Aviator' }, images(6))).toEqual({
      id: 'P', title: 'Aviator', images: images(6), selected: ['i0', 'i1', 'i2', 'i3'],
    })
  })

  it('sends only products with 3 or 4 ticked photos', () => {
    const picked = [
      { id: 'A', selected: ['1', '2', '3'] },
      { id: 'B', selected: ['1', '2'] },
      { id: 'C', selected: ['1', '2', '3', '4'] },
    ]
    expect(bulkItems(picked)).toEqual([
      { productId: 'A', imageIds: ['1', '2', '3'] },
      { productId: 'C', imageIds: ['1', '2', '3', '4'] },
    ])
  })

  it('labels the button with how many models will be made', () => {
    expect(generateLabel(0)).toBe('Generate 3D models')
    expect(generateLabel(1)).toBe('Generate 3D model')
    expect(generateLabel(3)).toBe('Generate 3D models (3)')
  })

  it('names the products that could not start', () => {
    const picked = [{ id: 'A', title: 'Aviator' }, { id: 'B', title: 'Round' }]
    expect(bulkResultMessage([{ productId: 'A', generation: {} }, { productId: 'B', error: 'That product is no longer available. Pick another one.' }], picked))
      .toBe("Round: That product is no longer available. Pick another one.")
    expect(bulkResultMessage([{ productId: 'A', generation: {} }], picked)).toBeNull()
  })

  it('allows at most 5 products', () => {
    expect(MAX_PRODUCTS).toBe(5)
  })
})
```

and create `test/aiProductSource.ui.test.js`:

```js
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AiProductSource from '../app/components/AiProductSource.jsx'

global.React = React

const product = (id, n, selected) => ({
  id,
  title: `Product ${id}`,
  images: Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}`, thumbnailUrl: `https://cdn/${id}${i}.jpg`, altText: '' })),
  selected,
})
const render = (picked) => renderToStaticMarkup(React.createElement(AiProductSource, {
  picked, disabled: false, onChoose: () => {}, onToggle: () => {}, onRemove: () => {},
}))

describe('AiProductSource', () => {
  it('offers Choose products when nothing is picked', () => {
    expect(render([])).toContain('Choose products')
  })

  it('shows a row per product with its photos and a remove action', () => {
    const html = render([product('A', 5, ['A-0', 'A-1', 'A-2', 'A-3']), product('B', 4, ['B-0', 'B-1', 'B-2'])])
    expect(html).toContain('Product A')
    expect(html).toContain('Product B')
    expect(html).toContain('4 of 4 selected')
    expect(html).toContain('3 of 4 selected')
    expect(html).toContain('aria-label="Remove Product A"')
    expect(html).toContain('Change products')
  })

  it('marks a product with fewer than 3 photos as skipped', () => {
    const html = render([product('C', 2, ['C-0', 'C-1'])])
    expect(html).toContain('Needs at least 3 photos')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run test/aiModelFlow.ui.test.js test/aiProductSource.ui.test.js` → FAIL.

- [ ] **Step 3: Rewrite `app/components/AiProductSource.jsx`:**

```jsx
/* eslint-disable react/prop-types -- lightweight props, same as the other flows */

export function productTooFewPhotos(count) {
  return `This product has only ${count} ${count === 1 ? 'photo' : 'photos'}. Add more to the product, or use Upload photos instead.`
}

function PhotoToggle({ image, index, isSelected, atLimit, disabled, onToggle }) {
  return (
    <button
      type="button"
      aria-pressed={isSelected}
      aria-label={image.altText || `Product photo ${index + 1}`}
      {...(atLimit ? { 'aria-disabled': 'true' } : {})}
      disabled={disabled}
      onClick={onToggle}
      style={{
        position: 'relative',
        padding: 0,
        background: 'transparent',
        cursor: disabled || atLimit ? 'default' : 'pointer',
        opacity: atLimit ? 0.6 : 1,
        borderRadius: '8px',
        overflow: 'hidden',
        border: `3px solid ${isSelected ? '#005bd3' : 'transparent'}`,
      }}
    >
      <img
        src={image.thumbnailUrl}
        alt={image.altText || ''}
        style={{ display: 'block', width: '100%', aspectRatio: '1', objectFit: 'contain' }}
      />
      {isSelected && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute', top: '4px', right: '4px', width: '20px', height: '20px',
            lineHeight: '20px', borderRadius: '50%', background: '#005bd3', color: '#fff',
            fontSize: '13px', textAlign: 'center',
          }}
        >
          ✓
        </span>
      )}
    </button>
  )
}

function ProductRow({ product, disabled, onToggle, onRemove }) {
  const tooFew = product.images.length < 3
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center" justifyContent="space-between">
          <s-text type="strong">{product.title}</s-text>
          <button
            type="button"
            aria-label={`Remove ${product.title}`}
            disabled={disabled}
            onClick={onRemove}
            style={{ border: 0, background: 'transparent', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}
          >
            ×
          </button>
        </s-stack>
        {tooFew ? (
          <s-text color="subdued">Needs at least 3 photos. {productTooFewPhotos(product.images.length)}</s-text>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))', gap: '8px' }}>
              {product.images.map((image, index) => {
                const isSelected = product.selected.includes(image.id)
                return (
                  <PhotoToggle
                    key={image.id}
                    image={image}
                    index={index}
                    isSelected={isSelected}
                    atLimit={!isSelected && product.selected.length >= 4}
                    disabled={disabled}
                    onToggle={() => onToggle(image.id)}
                  />
                )
              })}
            </div>
            <s-text color="subdued">{product.selected.length} of 4 selected</s-text>
          </>
        )}
      </s-stack>
    </s-box>
  )
}

// Presentational half of the "From products" source: picked products, each
// with its photos as keyboard-accessible toggles. State and requests live in
// AiModelFlow. Native <button>s, because React 18 drops onChange/custom events
// on s-* elements but onClick on a native button works.
export default function AiProductSource({ picked, disabled, onChoose, onToggle, onRemove }) {
  return (
    <s-stack direction="block" gap="base">
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-button variant={picked.length ? 'secondary' : 'primary'} disabled={disabled} onClick={onChoose}>
          {picked.length ? 'Change products' : 'Choose products'}
        </s-button>
        <s-text color="subdued">Up to 5 products at a time.</s-text>
      </s-stack>
      {picked.length > 0 && (
        <s-text color="subdued">
          For each product, tick 3 or 4 clear photos of the frame from different angles. Skip lifestyle or worn photos if you can.
        </s-text>
      )}
      {picked.map((product) => (
        <ProductRow
          key={product.id}
          product={product}
          disabled={disabled}
          onToggle={(imageId) => onToggle(product.id, imageId)}
          onRemove={() => onRemove(product.id)}
        />
      ))}
    </s-stack>
  )
}
```

- [ ] **Step 4: Update `app/components/AiModelFlow.jsx`.**
  - Add exports next to the other helpers (keep `defaultImageSelection`, `toggleImage`, `canGenerateFromProduct`):

```js
export const MAX_PRODUCTS = 5

export function pickedFromLookup(product, images) {
  return { id: product.id, title: product.title, images, selected: defaultImageSelection(images) }
}

export function bulkItems(picked) {
  return picked
    .filter((product) => canGenerateFromProduct(product.selected))
    .map((product) => ({ productId: product.id, imageIds: product.selected }))
}

export function generateLabel(count) {
  if (count === 1) return 'Generate 3D model'
  return count > 1 ? `Generate 3D models (${count})` : 'Generate 3D models'
}

export function bulkResultMessage(results, picked) {
  const failed = (results ?? []).filter((result) => result.error)
  if (!failed.length) return null
  return failed
    .map((result) => `${picked.find((p) => p.id === result.productId)?.title ?? 'A product'}: ${result.error}`)
    .join(' ')
}
```

  - Replace the `product`, `productImages`, `selectedImages` state with `const [picked, setPicked] = useState([])`.
  - Replace `chooseProduct` with:

```js
  async function chooseProducts() {
    setBusy(true)
    setError(null)
    try {
      const selection = await shopify.resourcePicker({
        type: 'product',
        action: 'select',
        multiple: MAX_PRODUCTS,
        selectionIds: picked.map((p) => ({ id: p.id })),
      })
      if (!selection) return
      const ids = selection.slice(0, MAX_PRODUCTS).map((item) => item.id)
      // Keep ticks the merchant already changed; look up only new products.
      const kept = picked.filter((p) => ids.includes(p.id))
      const fresh = await Promise.all(ids.filter((id) => !kept.some((p) => p.id === id)).map(async (id) => {
        const res = await postForm({ intent: 'product-images', productId: id })
        if (!res.ok) throw new ShownError(res.body.error ?? GENERIC_ERROR)
        return pickedFromLookup(res.body.product, Array.isArray(res.body.images) ? res.body.images : [])
      }))
      setPicked(ids.map((id) => kept.find((p) => p.id === id) ?? fresh.find((p) => p.id === id)).filter(Boolean))
    } catch (e) {
      reportFailure(e, 'AI product photos failed')
    } finally {
      setBusy(false)
    }
  }
```

  - Replace `generateFromProduct` with:

```js
  async function generateFromProducts() {
    setBusy(true)
    setGenerating(true)
    setError(null)
    try {
      const items = bulkItems(picked)
      const created = await postForm({ intent: 'create-from-products', items: JSON.stringify(items) })
      if (!created.ok) throw new ShownError(created.body.error ?? GENERIC_ERROR)
      const message = bulkResultMessage(created.body.results, picked)
      // Keep only the products that didn't start, so the merchant can fix and resend them.
      const startedIds = (created.body.results ?? []).filter((r) => r.generation).map((r) => r.productId)
      setPicked((current) => current.filter((p) => !startedIds.includes(p.id)))
      if (message) setError(message)
      await refresh()
    } catch (e) {
      reportFailure(e, 'AI generation from products failed')
    } finally {
      setBusy(false)
      setGenerating(false)
    }
  }
```

  - In the JSX `source === 'product'` branch: paragraph copy → `Pick products from your store and we'll build their 3D models from the product photos.`; render

```jsx
            <AiProductSource
              picked={picked}
              disabled={busy}
              onChoose={chooseProducts}
              onToggle={(productId, imageId) => setPicked((current) => current.map((p) => (
                p.id === productId ? { ...p, selected: toggleImage(p.selected, imageId) } : p
              )))}
              onRemove={(productId) => setPicked((current) => current.filter((p) => p.id !== productId))}
            />
            <s-stack direction="inline">
              <s-button
                variant="primary"
                disabled={busy || bulkItems(picked).length === 0}
                {...(generating ? { loading: true } : {})}
                onClick={generateFromProducts}
              >
                {generateLabel(bulkItems(picked).length)}
              </s-button>
            </s-stack>
```

  - Change the "From a product" tab label to "From products".
  - Update the import/export line `export { productTooFewPhotos } from './AiProductSource'` (unchanged name, still exported).

- [ ] **Step 5: Run** `npx vitest run test/aiModelFlow.ui.test.js test/aiProductSource.ui.test.js` → PASS. Then `npx react-router build` → succeeds.

- [ ] **Step 6: Commit.** `git add app/components/AiProductSource.jsx app/components/AiModelFlow.jsx test/aiModelFlow.ui.test.js test/aiProductSource.ui.test.js && git commit -m "feat(ai-gen): pick up to 5 products and generate them in one click"`

---

### Task 7: Storefront app embed sharing one snippet with the block

**Files:**
- Create: `extensions/tryon-button/snippets/tryon_core.liquid`
- Modify: `extensions/tryon-button/blocks/tryon_button.liquid`
- Create: `extensions/tryon-button/blocks/tryon_embed.liquid`
- Modify: `test/tryonBlockDedupe.test.js`
- Test: `test/tryonEmbedPlacement.test.js` (create)

**Interfaces:**
- Snippet parameters: `product` (product object), `engine_url`, `model_url` (may be blank), `gscale`, `button_label`, `dialog_id`, `attributes` (string, `block.shopify_attributes`), `placement` (`'block'` | `'embed'`).
- The root element keeps class `ar-tryon` and gains `data-ar-tryon-placement="{{ placement }}"`. Existing first-instance-wins dedupe means a block placed earlier in the page always beats the embed (which renders at the end of `body`).

- [ ] **Step 1: Create the snippet.** Move lines from `tryon_button.liquid` into `snippets/tryon_core.liquid`: everything from `{% assign product_gid … %}` through the closing `</style>` of the mapped branch, with these substitutions:
  - `block.settings.product` → `product`; `block.settings.engine_url` → `engine_url`; `block.settings.model_url` → `model_url`; `block.settings.gscale` → `gscale`; `block.settings.button_label` → `button_label`; `{{ block.shopify_attributes }}` → `{{ attributes }}`; `dialog_id` comes in as a parameter (delete its `assign`).
  - The root div gets `data-ar-tryon-placement="{{ placement }}"`.
  - Wrap the snippet's body in `{% if tryon_enabled %} … {% endif %}` exactly as the block does today (the unmapped design-mode notice stays in the block file, not the snippet).
  - In the `<script>`, change the duplicate branch so the embed never shows the "more than once" notice:

```js
    if (instances.length > 1 && instances[0] !== root) {
      if (root.dataset.arTryonDesignMode && root.dataset.arTryonPlacement !== 'embed') {
```

  - Add embed styles to the `<style>`:

```css
  .ar-tryon[data-ar-tryon-placement="embed"] {
    margin-top: 10px;
  }
  .ar-tryon--floating {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 50;
    margin: 0;
  }
  .ar-tryon--floating .ar-tryon__open {
    width: auto;
    border-radius: 999px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  }
```

- [ ] **Step 2: Shrink the block** `blocks/tryon_button.liquid` to: its header comments, then

```liquid
{% assign tryon_enabled = block.settings.product.metafields["$app:tryon"].enabled.value %}
{% assign dialog_id = 'ar-tryon-dialog-' | append: section.id | append: '-' | append: block.id %}
{% if tryon_enabled %}
  {% render 'tryon_core',
    product: block.settings.product,
    engine_url: block.settings.engine_url,
    model_url: block.settings.model_url,
    gscale: block.settings.gscale,
    button_label: block.settings.button_label,
    dialog_id: dialog_id,
    attributes: block.shopify_attributes,
    placement: 'block'
  %}
{% elsif request.design_mode %}
  … (the existing unmapped notice + its <style>, unchanged) …
{% endif %}

{% schema %} … unchanged … {% endschema %}
```

  Inside the snippet, compute `tryon_enabled` again from `product` (render scope does not inherit variables) and keep the `{% if tryon_enabled %}` wrapper so the snippet is safe on its own.

- [ ] **Step 3: Create the embed** `blocks/tryon_embed.liquid`:

```liquid
{% comment %}
  AR Try-on app embed. Switched on once for the whole store (the admin's "Turn
  on try-on" deep link opens the theme editor with it active), it adds the
  Try-on button to every product page whose product has a model -- no placing
  blocks in templates. Same markup and script as the app block (snippet
  tryon_core); if a page also has the block, the block (earlier in the DOM)
  wins the first-instance dedupe and this copy removes itself.
{% endcomment %}
{% if request.page_type == 'product' and product %}
  {% assign dialog_id = 'ar-tryon-dialog-embed-' | append: product.id %}
  {% render 'tryon_core',
    product: product,
    engine_url: block.settings.engine_url,
    model_url: '',
    gscale: block.settings.gscale,
    button_label: block.settings.button_label,
    dialog_id: dialog_id,
    attributes: block.shopify_attributes,
    placement: 'embed'
  %}
  <script>
    (() => {
      // Runs after tryon_core's own script (dedupe + ping). If the block won,
      // there is no embed root left and nothing to place.
      const root = document.querySelector('.ar-tryon[data-ar-tryon-placement="embed"]')
      if (!root) return
      const submit = document.querySelector(
        'main form[action*="/cart/add"] [type="submit"], main form[action*="/cart/add"] button[name="add"]',
      )
      if (submit) {
        submit.insertAdjacentElement('afterend', root)
      } else {
        root.classList.add('ar-tryon--floating')
      }
    })()
  </script>
{% endif %}

{% schema %}
{
  "name": "AR Try-on",
  "target": "body",
  "settings": [
    { "type": "text", "id": "button_label", "label": "Button label", "default": "Try on" },
    { "type": "range", "id": "gscale", "label": "Glasses size", "min": 0.5, "max": 2.5, "step": 0.1, "unit": "x", "default": 1, "info": "Scales the glasses on the face. 1 = natural fit; higher = larger. Try ~1.6 if they look too small." },
    { "type": "text", "id": "engine_url", "label": "Try-on engine URL", "default": "https://ar-sunglasses-tryon.vercel.app/tryon/index.html", "info": "Pre-filled with the hosted try-on engine -- only change this if you're running your own instance." }
  ]
}
{% endschema %}
```

- [ ] **Step 4: Point the existing script test at the snippet.** In `test/tryonBlockDedupe.test.js`, read `../extensions/tryon-button/snippets/tryon_core.liquid` instead of the block. Add a test that an embed instance in design mode that loses the dedupe is removed, not replaced with the notice (use the file's existing `makeRoot`/`makePage` helpers; give the root `dataset.arTryonPlacement = 'embed'`):

```js
  it('removes a losing embed copy even in the theme editor, without the duplicate notice', () => {
    // The embed renders at the end of <body>, so a placed block always comes first.
    const block = makeRoot({ designMode: true })
    const embed = makeRoot({ designMode: true })
    embed.dataset.arTryonPlacement = 'embed'
    const roots = [block, embed]
    roots.forEach((_, i) => runFor(i, roots))

    expect(block.removed).toBe(false)
    expect(embed.removed).toBe(true)
    expect(embed.innerHTML).toBe('')
  })

  it('keeps the embed when it is the only copy', () => {
    const embed = makeRoot()
    embed.dataset.arTryonPlacement = 'embed'
    runFor(0, [embed])
    expect(embed.removed).toBe(false)
  })
```

(Place both inside `describe('try-on block duplicate handling', …)`; `makeRoot`, `runFor` are the file's existing helpers.)

- [ ] **Step 5: Placement test** `test/tryonEmbedPlacement.test.js` — extract the embed's inline script the same way the dedupe test does (slice between `<script>` and `</script>` of `blocks/tryon_embed.liquid`) and run it with a fake `document`:

```js
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const liquid = readFileSync(new URL('../extensions/tryon-button/blocks/tryon_embed.liquid', import.meta.url), 'utf8')
const scriptBody = liquid.slice(liquid.indexOf('<script>') + '<script>'.length, liquid.indexOf('</script>'))

function run({ root, submit }) {
  const document = {
    querySelector: (sel) => (sel.includes('data-ar-tryon-placement') ? root : sel.includes('/cart/add') ? submit : null),
  }
  new Function('document', scriptBody)(document)
}

describe('embed placement', () => {
  it('puts the button right after Add to cart', () => {
    const root = { classList: { add: () => { throw new Error('should not float') } } }
    const calls = []
    const submit = { insertAdjacentElement: (where, el) => calls.push([where, el]) }
    run({ root, submit })
    expect(calls).toEqual([['afterend', root]])
  })

  it('floats the button when the theme has no Add to cart form', () => {
    const added = []
    const root = { classList: { add: (c) => added.push(c) } }
    run({ root, submit: null })
    expect(added).toEqual(['ar-tryon--floating'])
  })

  it('does nothing when the block already won', () => {
    expect(() => run({ root: null, submit: null })).not.toThrow()
  })
})
```

- [ ] **Step 6: Run** `npx vitest run test/tryonBlockDedupe.test.js test/tryonEmbedPlacement.test.js` → PASS. Validate the extension builds: `npx shopify app build` from `apps/shopify-app` (if it needs login/interactive input, skip and say so — the deploy step in the Part B release covers it).

- [ ] **Step 7: Commit.** `git add extensions/tryon-button test/tryonBlockDedupe.test.js test/tryonEmbedPlacement.test.js && git commit -m "feat(storefront): app embed that adds the try-on button without editing templates"`

---

### Task 8: Embed deep link, store-wide live signal, three-step setup model

**Files:**
- Modify: `app/adminLinks.server.js`, `app/tryonStatus.server.js`, `app/workspace.server.js`
- Test: `test/adminLinks.server.test.js`, `test/tryonStatus.server.test.js` (if absent, add the cases to whichever test file covers `productStatus` — search for it), `test/workspace.server.test.js`

**Interfaces:**
- Produces:
  - `embedActivationUrl(shop): string` → `https://<shop>/admin/themes/current/editor?context=apps&activateAppId=be1db9d64c7c617dcd67f6add58f4824/tryon_embed`
  - `productStatus(mapping, { storeLive = false } = {})` — `storeLive` true counts as on-theme.
  - `setupSteps({ assets, mappings, storeLive }) → { done: boolean, steps: [{ id: 'create'|'save'|'turn-on', title, state: 'done'|'current'|'upcoming' }] }` exported from `workspace.server.js`.
  - `loadWorkspace` returns, additionally: `setup` (from `setupSteps`), `embedUrl` (`embedActivationUrl(shop)`), `storefrontUrl` (`https://<shop>/products/<handle>` of the newest mapping with a handle, else `https://<shop>`); every mapping's `themeUrl` is now `embedUrl`.

- [ ] **Step 1: Failing tests.**

`test/adminLinks.server.test.js`:

```js
describe('embedActivationUrl', () => {
  it('opens the theme editor with the try-on embed switched on', () => {
    const url = new URL(embedActivationUrl('demo-shop.myshopify.com'))
    expect(url.origin + url.pathname).toBe('https://demo-shop.myshopify.com/admin/themes/current/editor')
    expect(url.searchParams.get('context')).toBe('apps')
    expect(url.searchParams.get('activateAppId')).toBe('be1db9d64c7c617dcd67f6add58f4824/tryon_embed')
  })
})
```

`productStatus` test (add next to the existing ones):

```js
  it('counts a mapping as on the theme once the store has try-on on', () => {
    const mapping = { blockSeenAt: null, lastSeenLiveAt: null, modelAsset: { status: 'ready', confidence: 0.9 } }
    expect(productStatus(mapping).id).toBe('not_on_theme')
    expect(productStatus(mapping, { storeLive: true }).id).toBe('live')
  })
```

`test/workspace.server.test.js`:

```js
describe('setupSteps', () => {
  const asset = { id: 'a', status: 'ready' }
  it('starts at creating models', () => {
    expect(setupSteps({ assets: [], mappings: [], storeLive: false }).steps.map((s) => s.state)).toEqual(['current', 'upcoming', 'upcoming'])
  })
  it('moves to saving once a model exists, then to turning on', () => {
    expect(setupSteps({ assets: [asset], mappings: [], storeLive: false }).steps.map((s) => s.state)).toEqual(['done', 'current', 'upcoming'])
    expect(setupSteps({ assets: [asset], mappings: [{ id: 'm' }], storeLive: false }).steps.map((s) => s.state)).toEqual(['done', 'done', 'current'])
  })
  it('is done when the store has try-on on', () => {
    const setup = setupSteps({ assets: [asset], mappings: [{ id: 'm' }], storeLive: true })
    expect(setup.done).toBe(true)
    expect(setup.steps.every((s) => s.state === 'done')).toBe(true)
  })
  it('counts only ready (or reviewed) models for step one', () => {
    expect(setupSteps({ assets: [{ id: 'x', status: 'needs_manual' }], mappings: [], storeLive: false }).steps[0].state).toBe('current')
  })
})
```

Also update the existing `workspaceGuide` "Add to theme" test expectations: action label `'Turn on try-on'`, href = the mapping's `themeUrl` (now the embed URL).

- [ ] **Step 2: Run** `npx vitest run test/adminLinks.server.test.js test/workspace.server.test.js` (+ the productStatus test file) → FAIL. If `test/workspace.server.test.js` imports `loadWorkspace` with DB access, only run its pure `describe` blocks via `-t "setupSteps|workspace data"`.

- [ ] **Step 3: Implement.**

`app/adminLinks.server.js`:

```js
const EMBED_HANDLE = 'tryon_embed'

/**
 * Deep link that opens the theme editor with the AR Try-on app embed switched
 * on; the merchant only clicks Save. Embeds are store-wide, so no template or
 * product is needed. Not embeddable: open top-level.
 * @param {string} shop myshopify domain
 */
export function embedActivationUrl(shop) {
  const domain = String(shop).replace(/^https?:\/\//, '').replace(/\/$/, '')
  const url = new URL(`https://${domain}/admin/themes/current/editor`)
  url.searchParams.set('context', 'apps')
  url.searchParams.set('activateAppId', `${apiKey()}/${EMBED_HANDLE}`)
  return url.toString()
}
```

`app/tryonStatus.server.js` — `productStatus(mapping, { storeLive = false } = {})` and replace `if (!isOnTheme(mapping))` with `if (!storeLive && !isOnTheme(mapping))`. Add to the doc comment: "`storeLive`: the shop's try-on has rendered on some product page. With the app embed the button is store-wide, so one sighting covers every mapped product."

`app/workspace.server.js`:

```js
const isReadyAsset = (asset) => Boolean(asset.fitReviewedAt) || String(asset.status).toLowerCase() === 'ready'

/**
 * The three setup steps on the home page: create models, save one (which maps
 * it to its product), switch try-on on in the store. Each is done/current/upcoming.
 */
export function setupSteps({ assets, mappings, storeLive }) {
  const done = [assets.some(isReadyAsset), mappings.length > 0, storeLive]
  const current = done.indexOf(false)
  const titles = [
    ['create', 'Create 3D models'],
    ['save', 'Review and save'],
    ['turn-on', 'Turn on try-on in your store'],
  ]
  return {
    done: current === -1,
    steps: titles.map(([id, title], i) => ({
      id,
      title,
      state: done[i] ? 'done' : i === current ? 'current' : 'upcoming',
    })),
  }
}
```

In `loadWorkspace` (subscribed path):

```js
  const storeLive = rawMappings.some((mapping) => isOnTheme(mapping))
  const embedUrl = embedActivationUrl(shop)
```

pass `productStatus(mapping, { storeLive })`, set each mapping's `themeUrl: embedUrl`, and return `setup: setupSteps({ assets, mappings, storeLive })`, `embedUrl`, `storefrontUrl` computed as:

```js
  const handle = rawMappings.find((mapping) => mapping.productHandle)?.productHandle
    ?? enriched.find((mapping) => mapping.product?.handle)?.product.handle
  const storefrontUrl = handle ? `https://${shop}/products/${handle}` : `https://${shop}`
```

`emptyWorkspace(shop)` returns `setup: setupSteps({ assets, mappings, storeLive: false })`, `embedUrl: embedActivationUrl(shop)`, `storefrontUrl: \`https://${shop}\``. Import `isOnTheme` from `./tryonStatus.server` and `embedActivationUrl` from `./adminLinks.server`.

In `workspaceGuide`, the `add-to-theme` branch becomes:

```js
    return {
      kind: 'recovery',
      title: 'Turn on try-on in your store',
      detail: 'In the theme editor, click Save.',
      action: { id: 'theme', href: theme.themeUrl, label: 'Turn on try-on' },
    }
```

In `app/components/ProductOperationsList.jsx` change the row action label `'Add to theme'` → `'Turn on try-on'` and the badge `'Not on theme'` → `'Not live yet'` (update `test/appProducts.ui.test.js`/whatever pins those strings — search `grep -rn "Add to theme\|Not on theme" test`).

- [ ] **Step 4: Run** the test files from Step 2 plus any updated by the string search → PASS.

- [ ] **Step 5: Commit.** `git add app/adminLinks.server.js app/tryonStatus.server.js app/workspace.server.js app/components/ProductOperationsList.jsx test && git commit -m "feat(workspace): embed deep link, store-wide live signal, three setup steps"`

---

### Task 9: Guided home page and Help text

**Files:**
- Create: `app/components/SetupSteps.jsx`
- Modify: `app/routes/app._index.jsx`, `app/routes/app.additional.jsx`
- Test: `test/setupSteps.ui.test.js` (create)

**Interfaces:**
- Consumes: loader fields `setup`, `embedUrl`, `storefrontUrl`, `aiModels` (allowance or null) from Task 8; `AiModelFlow` (`initialAllowance` prop); `TopLevelAdminAction`.
- Produces: `<SetupSteps setup embedUrl storefrontUrl aiEnabled onUploadModel onCheckAgain>{createPanel}</SetupSteps>` where `children` is the Create with AI panel rendered inside step 1/2.

- [ ] **Step 1: Failing test** `test/setupSteps.ui.test.js`:

```js
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SetupSteps from '../app/components/SetupSteps.jsx'

global.React = React

const steps = (states) => ({
  done: states.every((s) => s === 'done'),
  steps: [
    { id: 'create', title: 'Create 3D models', state: states[0] },
    { id: 'save', title: 'Review and save', state: states[1] },
    { id: 'turn-on', title: 'Turn on try-on in your store', state: states[2] },
  ],
})
const render = (states, extra = {}) => renderToStaticMarkup(React.createElement(SetupSteps, {
  setup: steps(states),
  embedUrl: 'https://s.myshopify.com/admin/themes/current/editor?context=apps',
  storefrontUrl: 'https://s.myshopify.com/products/aviator',
  aiEnabled: true,
  onUploadModel: () => {},
  onCheckAgain: () => {},
  ...extra,
}, React.createElement('div', { id: 'create-panel' })))

describe('SetupSteps', () => {
  it('numbers the three steps and marks the current one', () => {
    const html = render(['current', 'upcoming', 'upcoming'])
    expect(html).toContain('Create 3D models')
    expect(html).toContain('Review and save')
    expect(html).toContain('Turn on try-on in your store')
    expect(html).toContain('aria-current="step"')
    expect(html).toContain('id="create-panel"')
  })

  it('offers the one-click switch and a storefront link on the last step', () => {
    const html = render(['done', 'done', 'current'])
    expect(html).toContain('Turn on try-on')
    expect(html).toContain('In the theme editor, click Save')
    expect(html).toContain('View on your store')
    expect(html).toContain('Check again')
  })

  it('renders nothing once setup is done', () => {
    expect(render(['done', 'done', 'done'])).toBe('')
  })

  it('offers uploading a .glb when AI is off', () => {
    expect(render(['current', 'upcoming', 'upcoming'], { aiEnabled: false })).toContain('Upload a .glb model')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run test/setupSteps.ui.test.js` → FAIL.

- [ ] **Step 3: Implement** `app/components/SetupSteps.jsx`:

```jsx
/* eslint-disable react/prop-types -- loader-shaped data */
import TopLevelAdminAction from './TopLevelAdminAction'

const MARK = { done: '✓', current: '', upcoming: '' }

function StepHeader({ index, step }) {
  const done = step.state === 'done'
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      <span
        aria-hidden="true"
        style={{
          width: '24px', height: '24px', borderRadius: '50%', display: 'inline-grid', placeItems: 'center',
          fontSize: '13px', fontWeight: 650,
          background: done ? '#29845a' : step.state === 'current' ? '#303030' : '#e3e3e3',
          color: done || step.state === 'current' ? '#fff' : '#616161',
        }}
      >
        {MARK[step.state] || index + 1}
      </span>
      <s-text type="strong" {...(step.state === 'current' ? { 'aria-current': 'step' } : {})}>{step.title}</s-text>
      {done && <s-badge tone="success">Done</s-badge>}
    </s-stack>
  )
}

/**
 * The home page's guided setup: create models -> review and save -> turn try-on
 * on in the store. `children` is the Create with AI panel, shown while step 1
 * or 2 is current. Hidden once all three are done.
 */
export default function SetupSteps({ setup, embedUrl, storefrontUrl, aiEnabled, onUploadModel, onCheckAgain, children }) {
  if (!setup || setup.done) return null
  const [create, save, turnOn] = setup.steps
  const creating = create.state === 'current' || save.state === 'current'
  return (
    <s-section heading="Get try-on live in 3 steps">
      <s-stack direction="block" gap="base">
        <StepHeader index={0} step={create} />
        <StepHeader index={1} step={save} />
        {creating && (
          <s-stack direction="block" gap="small-200">
            {aiEnabled ? (
              <s-paragraph>
                Pick your products and we&apos;ll build their 3D models from the product photos. Saving a model adds try-on to its product.
              </s-paragraph>
            ) : (
              <s-paragraph>Upload a 3D model of your frame to get started.</s-paragraph>
            )}
            {aiEnabled && children}
            <s-stack direction="inline">
              <s-button variant={aiEnabled ? 'tertiary' : 'primary'} onClick={onUploadModel}>Upload a .glb model</s-button>
            </s-stack>
          </s-stack>
        )}
        <StepHeader index={2} step={turnOn} />
        {turnOn.state === 'current' && (
          <s-stack direction="block" gap="small-200">
            <s-paragraph>
              One switch adds the Try-on button to every product with a model. In the theme editor, click Save.
            </s-paragraph>
            <s-stack direction="inline" gap="small-200">
              <TopLevelAdminAction href={embedUrl} variant="primary" accessibilityLabel="Turn on try-on">
                Turn on try-on
              </TopLevelAdminAction>
              <TopLevelAdminAction href={storefrontUrl} variant="secondary" accessibilityLabel="View on your store">
                View on your store
              </TopLevelAdminAction>
              <s-button variant="tertiary" onClick={onCheckAgain}>Check again</s-button>
            </s-stack>
            <s-text color="subdued">
              We notice the button once a product page with try-on has been viewed. Open one with View on your store.
            </s-text>
          </s-stack>
        )}
      </s-stack>
    </s-section>
  )
}
```

(Check `TopLevelAdminAction`'s props — it already takes `href`, `variant`, `accessibilityLabel`, children. If it only accepts Shopify-admin URLs, the storefront link is still a plain top-level navigation and works the same.)

- [ ] **Step 4: Home page.** In `app/routes/app._index.jsx`:
  - import `SetupSteps` and `AiModelFlow`.
  - Render, directly after `<PlanUsage …/>`:

```jsx
        <SetupSteps
          setup={data.setup}
          embedUrl={data.embedUrl}
          storefrontUrl={data.storefrontUrl}
          aiEnabled={Boolean(data.aiModels)}
          onUploadModel={openAddTryOn}
          onCheckAgain={refreshWorkspace}
        >
          <AiModelFlow initialAllowance={data.aiModels} />
        </SetupSteps>
        {data.setup?.done && <WorkspaceGuide guide={data.guide} onAction={handleGuideAction} />}
```

  and remove the old unconditional `<WorkspaceGuide …/>` line. `AiModelFlow` renders its own `s-section`; inside `SetupSteps` it nests — acceptable; if the admin renders nested sections badly, wrap it in `<s-box>` instead and note it.
  - `openAddTryOn` and `refreshWorkspace` are already defined in the component before `return`; use them as is.

- [ ] **Step 5: Help page.** In `app/routes/app.additional.jsx` loader also return `embedUrl: embedActivationUrl(session.shop)`; replace the "Try on button is missing" section body with:

```jsx
        <s-paragraph>
          Save a model for the product (or add try-on to it in Workspace), then turn on
          try-on in your store: it adds the button to every product with a model. In the
          theme editor, click Save.
        </s-paragraph>
        <TopLevelAdminAction href={embedUrl} accessibilityLabel="Turn on try-on in the theme editor">
          Turn on try-on
        </TopLevelAdminAction>
        <s-paragraph>
          Want the button somewhere specific? Place the AR Try-On block on your product template instead.
        </s-paragraph>
        <TopLevelAdminAction href={themeEditorUrl} accessibilityLabel="Place the AR Try-On block yourself" variant="tertiary">
          Place the button yourself
        </TopLevelAdminAction>
```

  and in "Fit is too small or too large" say "Open the theme editor, open App embeds, select AR Try-on (or the AR Try-On block if you placed it), and adjust Glasses size."

- [ ] **Step 6: Run** `npx vitest run test/setupSteps.ui.test.js test/appIndex.loader.test.js test/appIndex.workspace.test.js test/appAdditional.test.js` → PASS (update their expectations for the new loader fields and help copy; do NOT run any of them if they hit the DB — check imports first). Then `npx react-router build`.

- [ ] **Step 7: Commit.** `git add app/components/SetupSteps.jsx app/routes/app._index.jsx app/routes/app.additional.jsx test && git commit -m "feat(workspace): guided three-step home page with one-click storefront switch"`

**Part B release (controller):**
1. `npx react-router build` passes; `git push origin HEAD:main`; wait for Vercel READY.
2. `cd apps/shopify-app && npx shopify app deploy --allow-updates` (releases the embed). Confirm the new app version in the output.
3. Dev store checks (Chrome): Workspace shows the 3 steps; "Turn on try-on" opens the theme editor with AR Try-on under App embeds switched on (owner clicks Save if Chrome can't); open a mapped product page → button sits under Add to cart, opens the try-on; DB `blockSeenAt` set; step 3 shows done after Check again.
4. Bulk: owner picks 3+ products (picker is an App Bridge overlay Chrome can't open) → rows start, 6th+ shows "Waiting to start".

---

# Part C — tutorial (after Part B is live)

### Task 10: Tutorial page with annotated screenshots

**Files:**
- Create: `app/components/AnnotatedScreenshot.jsx`, `app/tutorialSteps.js`, `app/routes/app.tutorial.jsx`
- Modify: `app/routes/app.jsx` (nav), `app/routes/app.additional.jsx` (point to Tutorial), `app/routes/app._index.jsx` (Support aside link)
- Test: `test/annotatedScreenshot.ui.test.js` (create)

**Interfaces:**
- `AnnotatedScreenshot({ src, alt, width, height, marks })`, `marks: Array<{ n: number, kind: 'circle'|'arrow'|'box', x, y, w?, h?, toX?, toY?, caption }>` — all coordinates are percentages (0–100) of the image.
- `TUTORIAL_STEPS: Array<{ id, title, intro, image: { src, alt, width, height }, marks }>` in `app/tutorialSteps.js`.

- [ ] **Step 1: Failing test** `test/annotatedScreenshot.ui.test.js`:

```js
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import AnnotatedScreenshot from '../app/components/AnnotatedScreenshot.jsx'
import { TUTORIAL_STEPS } from '../app/tutorialSteps.js'

global.React = React

const marks = [
  { n: 1, kind: 'circle', x: 20, y: 30, w: 10, h: 6, caption: 'Choose products' },
  { n: 2, kind: 'arrow', x: 60, y: 70, toX: 45, toY: 55, caption: 'Tick 3 or 4 photos' },
  { n: 3, kind: 'box', x: 10, y: 80, w: 30, h: 8, caption: 'Generate' },
]

describe('AnnotatedScreenshot', () => {
  const html = renderToStaticMarkup(React.createElement(AnnotatedScreenshot, {
    src: '/tutorial/create.png', alt: 'Create with AI', width: 1280, height: 800, marks,
  }))

  it('draws the screenshot with an SVG overlay in percentage space', () => {
    expect(html).toContain('src="/tutorial/create.png"')
    expect(html).toContain('viewBox="0 0 100 100"')
    expect(html).toContain('preserveAspectRatio="none"')
  })

  it('draws circles, arrows and boxes with numbered markers', () => {
    expect(html).toContain('<ellipse')
    expect(html).toContain('marker-end')
    expect(html).toContain('<rect')
    for (const n of ['1', '2', '3']) expect(html).toContain(`>${n}</`)
  })

  it('lists a caption per marker number', () => {
    expect(html).toContain('Choose products')
    expect(html).toContain('Tick 3 or 4 photos')
  })
})

describe('TUTORIAL_STEPS', () => {
  it('covers the four steps in order with marks inside the image', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['create', 'save', 'turn-on', 'check'])
    for (const step of TUTORIAL_STEPS) {
      expect(step.image.src).toMatch(/^\/tutorial\/.+\.png$/)
      for (const m of step.marks) {
        expect(m.x).toBeGreaterThanOrEqual(0)
        expect(m.x).toBeLessThanOrEqual(100)
        expect(m.y).toBeGreaterThanOrEqual(0)
        expect(m.y).toBeLessThanOrEqual(100)
        expect(m.caption).toBeTruthy()
      }
    }
  })
})
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `app/components/AnnotatedScreenshot.jsx`:

```jsx
/* eslint-disable react/prop-types -- static tutorial data */
const ACCENT = '#e5484d'

function Mark({ mark }) {
  const label = (
    <g>
      <circle cx={mark.x} cy={mark.y} r="2.2" fill={ACCENT} />
      <text x={mark.x} y={mark.y + 0.9} textAnchor="middle" fontSize="2.6" fontWeight="700" fill="#fff">{mark.n}</text>
    </g>
  )
  if (mark.kind === 'circle') {
    return (
      <g>
        <ellipse cx={mark.x} cy={mark.y} rx={mark.w / 2} ry={mark.h / 2} fill="none" stroke={ACCENT} strokeWidth="0.5" vectorEffect="non-scaling-stroke" style={{ strokeWidth: 3 }} />
        <g transform={`translate(${mark.w / 2 + 1.5} ${-mark.h / 2})`}>{label}</g>
      </g>
    )
  }
  if (mark.kind === 'box') {
    return (
      <g>
        <rect x={mark.x} y={mark.y} width={mark.w} height={mark.h} rx="1" fill="none" stroke={ACCENT} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 3 }} />
        <g transform={`translate(${-1.5} ${-1.5})`}>{label}</g>
      </g>
    )
  }
  return (
    <g>
      <line x1={mark.x} y1={mark.y} x2={mark.toX} y2={mark.toY} stroke={ACCENT} vectorEffect="non-scaling-stroke" style={{ strokeWidth: 3 }} markerEnd="url(#tutorial-arrow)" />
      {label}
    </g>
  )
}

/**
 * A screenshot with numbered circles, boxes and arrows drawn over it. Marks
 * are in percentages of the image, so they stay put at any width; captions
 * under the image repeat each number for screen readers and skimmers.
 */
export default function AnnotatedScreenshot({ src, alt, width, height, marks }) {
  return (
    <figure style={{ margin: 0 }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: `${width} / ${height}`, border: '1px solid #e3e3e3', borderRadius: '8px', overflow: 'hidden' }}>
        <img src={src} alt={alt} width={width} height={height} style={{ display: 'block', width: '100%', height: '100%' }} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <defs>
            <marker id="tutorial-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={ACCENT} />
            </marker>
          </defs>
          {marks.map((mark) => <Mark key={mark.n} mark={mark} />)}
        </svg>
      </div>
      <figcaption>
        <ol style={{ margin: '12px 0 0', paddingLeft: '20px' }}>
          {marks.map((mark) => <li key={mark.n} value={mark.n}>{mark.caption}</li>)}
        </ol>
      </figcaption>
    </figure>
  )
}
```

Note: `preserveAspectRatio="none"` stretches circles with the image; because the container keeps the image's own aspect ratio, a circle drawn with `w`/`h` in percentages lands on the right element. The numbered marker circles are tiny and the slight stretch is acceptable.

`app/tutorialSteps.js` — content with starting coordinates (Task 11 re-measures them against the real screenshots):

```js
// Tutorial content. Mark coordinates are percentages of each screenshot
// (public/tutorial/*.png, 2560x1600 captures of a 1280x800 admin viewport).
export const TUTORIAL_STEPS = [
  {
    id: 'create',
    title: '1. Create 3D models',
    intro: 'On Workspace, choose up to 5 products. We build each 3D model from the product photos.',
    image: { src: '/tutorial/create.png', alt: 'Create with AI on the Workspace page', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'box', x: 27, y: 36, w: 14, h: 6, caption: 'Choose products: pick up to 5 from your store.' },
      { n: 2, kind: 'arrow', x: 75, y: 58, toX: 55, toY: 52, caption: 'Tick 3 or 4 clear photos per product. The first 4 are ticked for you.' },
      { n: 3, kind: 'circle', x: 33, y: 86, w: 16, h: 7, caption: 'Generate. Each model takes a few minutes; you can leave the page.' },
    ],
  },
  {
    id: 'save',
    title: '2. Review and save',
    intro: 'Check each model, zoom in on the details, then save it. Saving adds try-on to its product.',
    image: { src: '/tutorial/review.png', alt: 'A generated model ready to review', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'box', x: 30, y: 30, w: 50, h: 40, caption: 'Drag to rotate, scroll or use + and − to zoom.' },
      { n: 2, kind: 'circle', x: 33, y: 80, w: 12, h: 6, caption: 'Save model. Free models left are shown at the top of the Models page.' },
      { n: 3, kind: 'arrow', x: 70, y: 82, toX: 50, toY: 80, caption: 'Not right? Try again (3 free retries) or Discard.' },
    ],
  },
  {
    id: 'turn-on',
    title: '3. Turn on try-on in your store',
    intro: 'One switch adds the Try-on button to every product with a model.',
    image: { src: '/tutorial/turn-on.png', alt: 'The theme editor with the AR Try-on app embed switched on', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'circle', x: 14, y: 40, w: 22, h: 8, caption: 'AR Try-on is already switched on under App embeds.' },
      { n: 2, kind: 'circle', x: 93, y: 5, w: 8, h: 6, caption: 'Click Save. That is the only step in the theme editor.' },
    ],
  },
  {
    id: 'check',
    title: '4. Check your store',
    intro: 'Open a product with a model. The Try-on button sits under Add to cart.',
    image: { src: '/tutorial/storefront.png', alt: 'A product page with the Try on button under Add to cart', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'box', x: 58, y: 62, w: 34, h: 8, caption: 'The Try on button opens the camera try-on.' },
      { n: 2, kind: 'arrow', x: 40, y: 90, toX: 57, toY: 66, caption: 'Back in the app, Workspace shows the product as Live.' },
    ],
  },
]
```

`app/routes/app.tutorial.jsx`:

```jsx
import { authenticate } from '../shopify.server'
import AnnotatedScreenshot from '../components/AnnotatedScreenshot'
import { TUTORIAL_STEPS } from '../tutorialSteps'

export const loader = async ({ request }) => {
  await authenticate.admin(request)
  return null
}

export default function TutorialPage() {
  return (
    <s-page heading="Tutorial">
      {TUTORIAL_STEPS.map((step) => (
        <s-section key={step.id} heading={step.title}>
          <s-stack direction="block" gap="base">
            <s-paragraph>{step.intro}</s-paragraph>
            <AnnotatedScreenshot {...step.image} marks={step.marks} />
          </s-stack>
        </s-section>
      ))}
      <s-section heading="Troubleshooting">
        <s-paragraph>
          Fit, a missing button or a blocked camera: see <s-link href="/app/additional">Help</s-link>.
        </s-paragraph>
      </s-section>
    </s-page>
  )
}
```

- [ ] **Step 4: Nav and links.** `app/routes/app.jsx`: add `<s-link href="/app/tutorial">Tutorial</s-link>` between Models and Help. `app/routes/app._index.jsx` Support aside: first line `<s-paragraph><s-link href="/app/tutorial">Tutorial</s-link></s-paragraph>`. `app/routes/app.additional.jsx`: add at the top a section "New here?" with `<s-link href="/app/tutorial">Follow the tutorial</s-link>`. (The spec says troubleshooting moves to the tutorial; this plan keeps it on Help and links both ways instead, so the existing Help tests and deep links stay valid — record this in the report.)

Part C is released only after Task 11 adds the screenshots, so the page never ships with missing images.

- [ ] **Step 5: Run** `npx vitest run test/annotatedScreenshot.ui.test.js test/appNavigation.ui.test.js` (update the nav test for the new link) → PASS; `npx react-router build`.

- [ ] **Step 6: Commit.** `git add app/components/AnnotatedScreenshot.jsx app/tutorialSteps.js app/routes/app.tutorial.jsx app/routes/app.jsx app/routes/app._index.jsx app/routes/app.additional.jsx test && git commit -m "feat(tutorial): tutorial page with annotated screenshots"`

---

### Task 11: Demo content, screenshots, mark positions (controller-run, uses Chrome + dev store)

Not a code task for a subagent: it needs the browser, the dev store, OpenAI credit and owner clicks.

- [ ] **Step 1: Demo products.** On `ar-tryon-dev-xbqbnjhd`, create 3 products ("Classic Aviator", "Round Tortoise", "Square Black") through the Shopify MCP `create-product`, with 3–4 images each taken from the generic product photos in `D:\AR Sunglasses\marketing\` (upload via the MCP's media upload). No Gripz names or images.
- [ ] **Step 2: Models.** Owner: Workspace → Choose products → the 3 demo products → Generate. Wait for ready (DB check), save each (the dev store has 9 free).
- [ ] **Step 3: Capture** at a 1280×800 viewport (device scale 2) with Chrome: `create.png` (picker results with photos ticked, before Generate), `review.png` (a ready card), `turn-on.png` (theme editor App embeds panel with AR Try-on on), `storefront.png` (demo product page with the button). Hide or avoid any Gripz product in lists (filter Workspace search to "Classic" etc.). Save to `apps/shopify-app/public/tutorial/`.
- [ ] **Step 4: Measure marks.** For each screenshot, read the target element boxes (Chrome `getBoundingClientRect` ÷ viewport size × 100) and update `app/tutorialSteps.js` coordinates. Re-run `npx vitest run test/annotatedScreenshot.ui.test.js`.
- [ ] **Step 5: Visual check.** Render the Tutorial page on a local preview or after deploy; screenshot it; every mark sits on its element.
- [ ] **Step 6: Commit and release.** `git add public/tutorial app/tutorialSteps.js && git commit -m "feat(tutorial): screenshots and mark positions"`; build; `git push origin HEAD:main`; verify `/app/tutorial` in the dev store admin.

---

## Self-review notes

- Spec coverage: A1 → Task 1; A2 → Task 2; A3 → Task 3; B1 → Tasks 4–6; B2 → Task 7; B3 → Tasks 8–9; C → Tasks 10–11. Deviations recorded inline: the dialog stays inside the button root (top-layer `showModal` makes its DOM position irrelevant) instead of moving to `body`; per-row live status uses the store-wide signal; troubleshooting stays on Help with cross-links.
- Types: `startQueued`, `setupSteps`, `embedActivationUrl`, `bulkItems`, `pickedFromLookup`, `generateLabel`, `bulkResultMessage`, `uniqueAssetLabel`, `zoomStep` are each defined once and used with the same signatures.

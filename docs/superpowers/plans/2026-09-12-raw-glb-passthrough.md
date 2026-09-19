# Raw GLB Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve merchants the exact GLB bytes they uploaded, so no model ever loses shading quality to the calibration pipeline.

**Architecture:** Normalization stops being a rewrite of the stored file and becomes a measurement-only pass over a throwaway in-memory copy. The one transform that genuinely has to survive — the uniform rescale for non-metre models — moves out of the vertex data and into a `modelScale` number in the fit metadata, which the engine applies to the loaded scene. Because the engine's loader already re-origins every model from its own bounding box, the normalizer's recentring was always redundant, and dropping it changes nothing about final placement.

**Tech Stack:** `@gltf-transform/core` (NodeIO), `@artryon/calibration` workspace package, three.js `GLTFLoader`, Vitest.

## Global Constraints

- The bytes persisted by `saveModelGlb` MUST be byte-identical to the bytes the merchant uploaded. This is the point of the change; a test asserts it.
- `fitMetadata` rows already in the database predate `modelScale` and `modelBoundsCenter`. Every read path MUST tolerate their absence and fall back to today's behaviour. Do not write a migration that assumes the new fields exist.
- `FIT_PROFILE_VERSION` stays `'eyewear-v1'`. Nothing reads it today (audit finding), and bumping it without a reader would be theatre. Task 8 addresses recalibration separately.
- No change to texture handling, material handling, triangle counts, or accessor types anywhere in this plan. If a diff touches those, it is wrong.
- The three real merchant fixtures live at `public/models/_m-larsson.glb`, `_m-willow.glb`, `_m-gripz.glb`. They are untracked scratch copies — use them for verification, do not commit them.

---

## Why each normalizer step is safe to drop

Established by measurement before this plan was written. Recorded here so the
implementer does not have to re-derive it:

| Step | Kept? | Reason |
|---|---|---|
| `flatten` (bake node transforms) | Measurement copy only | Baking does not change world-space positions, so it cannot change any measured anchor. It *does* rewrite `POSITION` without transforming `NORMAL`, which inverts shading. Measured: Willow 22 nodes, mean normal error 102.7°, 79.6% of normals ending up inward-facing; gripzpelmo 5 nodes, 91.3° mean, 98.9% inward. `mergedPositions` reads raw accessor arrays and ignores node matrices, so the measurement copy still needs this. |
| `recenter` | Measurement copy only | A rigid translation. `GlassesModelLoader` re-origins from the model's own bbox (`useNormalizedModel: false`), so the loader's final frame is identical with or without it. `bridgePivot` is computed as a *difference* of two points in the same frame, so the translation cancels exactly. |
| `rescale` | **Must survive** as `modelScale` | Changes real-world size. A non-metre model served raw would render at its authored scale. Uniform scale is the one transform that does not corrupt normals, but we move it to metadata anyway so the stored bytes stay untouched. |

## File Structure

**`packages/calibration/src/normalizer.js`** — `rescaleToRealWorld` returns the factor it applied instead of a boolean; `normalizeModel` surfaces it as `scale`. No behavioural change to the doc it produces.

**`packages/calibration/src/fitMetadata.js`** — record gains `modelScale` and `modelBoundsCenter`.

**`packages/calibration/src/calibrator.js`** — `calibrate` accepts `{ modelScale }` and records it plus the measured bounds centre.

**`apps/shopify-app/app/calibration.server.js`** — normalizes a copy purely to measure; returns the caller's original buffer as `storedGlb`.

**`apps/shopify-app/app/models.server.js`** — two call sites rename `normalizedGlb` → `storedGlb`.

**`src/tryon/fitMetadataAdapter.js`** — re-expresses `bridgeAnchor` in the loader's recentred frame and passes `modelScale` through. This is the engine-side boundary, so the coupling to `depthPivot: 'frontMaxZ'` lives here rather than inside the calibration package.

**`src/models/GlassesModelLoader.js`** — applies `modelScale` to the loaded scene before any bounds are measured.

**`harness/mock-server.config.mjs`** — runs the same validate → normalize → calibrate sequence production runs, so local measurements stop diverging from production.

---

### Task 1: `normalizeModel` reports the scale it applied

**Files:**
- Modify: `packages/calibration/src/normalizer.js:74-96` (`rescaleToRealWorld`), `:101-145` (`normalizeModel`)
- Test: `packages/calibration/test/normalizer.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `normalizeModel(doc, spec)` returns `{ doc: Document, transforms: string[], scale: number }`. `scale` is `1` when no rescale was applied, otherwise the uniform factor that was baked into the copy. Tasks 2 and 3 depend on this field.

- [ ] **Step 1: Write the failing tests**

Append to `packages/calibration/test/normalizer.test.js`:

```js
describe('normalizeModel scale reporting', () => {
  it('reports scale 1 for a model already in metres', () => {
    const doc = buildDoc([-0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, -0.13])
    const { transforms, scale } = normalizeModel(doc, MODELING_SPEC)
    expect(scale).toBe(1)
    expect(transforms).not.toContain('rescale')
  })

  it('reports the factor applied to a large-coordinate model', () => {
    // 3-unit-wide front slab: a raw Blender-scene export.
    const doc = buildDoc([-1.5, 0, 0.4, 1.5, 0, 0.4, 0, 0.5, -2.6])
    const { transforms, scale } = normalizeModel(doc, MODELING_SPEC)
    expect(transforms).toContain('rescale')
    // CANONICAL_FRONT_WIDTH_M (0.145) / 3
    expect(scale).toBeCloseTo(0.145 / 3, 6)
  })

  it('reports scale 1 for a model with no geometry', () => {
    const doc = buildDoc([])
    expect(normalizeModel(doc, MODELING_SPEC).scale).toBe(1)
  })
})
```

Confirm the file's existing imports already cover `normalizeModel`, `MODELING_SPEC`, and `buildDoc`; add whichever are missing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/calibration && npx vitest run test/normalizer.test.js`
Expected: FAIL — `expected undefined to be 1`.

- [ ] **Step 3: Make `rescaleToRealWorld` return the factor**

In `packages/calibration/src/normalizer.js`, change the two early returns and the tail of `rescaleToRealWorld`:

```js
// Uniformly scale the geometry and any anchor-tag translations so the frame front
// is real-world size. Returns the factor applied, or 1 when the model was already
// in metres. The caller records it as fitMetadata.modelScale so the engine can
// apply the same factor to the UNMODIFIED file it serves.
function rescaleToRealWorld(doc, positions) {
  const slab = frontSlabX(positions)
  const width = slab.max - slab.min
  if (!(width > 0) || (width >= REAL_WORLD_MIN_WIDTH && width <= REAL_WORLD_MAX_WIDTH)) {
    return 1
  }
  const s = CANONICAL_FRONT_WIDTH_M / width
  // ... body unchanged ...
  return s
}
```

- [ ] **Step 4: Surface it from `normalizeModel`**

```js
export function normalizeModel(doc, spec) {
  const transforms = []
  let scale = 1
  if (bakeNodeTransforms(doc)) transforms.push('flatten')
  let positions = mergedPositions(doc)
  if (positions.length === 0) return { doc, transforms, scale }

  scale = rescaleToRealWorld(doc, positions)
  if (scale !== 1) {
    transforms.push('rescale')
    positions = mergedPositions(doc)
  }

  // ... recenter body unchanged ...

  return { doc, transforms, scale }
}
```

- [ ] **Step 5: Run the full calibration suite**

Run: `cd packages/calibration && npx vitest run`
Expected: PASS, 40 tests (37 existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add packages/calibration/src/normalizer.js packages/calibration/test/normalizer.test.js
git commit -m "feat(calibration): report the rescale factor from normalizeModel

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Record `modelScale` and `modelBoundsCenter` in fit metadata

**Files:**
- Modify: `packages/calibration/src/fitMetadata.js:3-14` (`REQUIRED_FIELDS`), `:16-40` (`createFitMetadata`)
- Modify: `packages/calibration/src/calibrator.js:52-66` (`buildRecord`), `:68-88` (`calibrate`)
- Test: `packages/calibration/test/fitMetadata.test.js`, `packages/calibration/test/calibrator.test.js`

**Interfaces:**
- Consumes: `normalizeModel(...).scale` from Task 1.
- Produces: `calibrate(doc, spec, { modelScale = 1 } = {})`. `fitMetadata` gains `modelScale: number` and `modelBoundsCenter: {x, y, z}` (the centre of the measured model's bounding box, in the measured doc's own frame). Task 3 passes `modelScale`; Task 5 reads both.

- [ ] **Step 1: Write the failing tests**

Append to `packages/calibration/test/fitMetadata.test.js`:

```js
it('requires modelScale and modelBoundsCenter', () => {
  expect(() => createFitMetadata({
    frameWidthMeters: 0.14,
    bridgeAnchor: { x: 0, y: 0, z: 0 },
    leftHinge: { x: -0.07, y: 0, z: 0 },
    rightHinge: { x: 0.07, y: 0, z: 0 },
    frontFramePlaneZ: 0.02,
    lensCenterOffset: { x: 0, y: 0, z: 0 },
    scaleLimits: { min: 0.6, max: 1.6 },
    provenance: { source: 'tagged', confidence: null },
  })).toThrow(/modelScale, modelBoundsCenter/)
})
```

Append to `packages/calibration/test/calibrator.test.js`:

```js
describe('calibrate scale + bounds reporting', () => {
  const GEOM = [
    -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
    -0.069, -0.04, -0.13, 0.069, -0.04, -0.13, 0, -0.02, 0.02,
  ]

  it('defaults modelScale to 1 when the caller passes nothing', () => {
    const { fitMetadata } = calibrate(buildDoc(GEOM), MODELING_SPEC)
    expect(fitMetadata.modelScale).toBe(1)
  })

  it('records the modelScale the caller measured', () => {
    const { fitMetadata } = calibrate(buildDoc(GEOM), MODELING_SPEC, { modelScale: 0.0483 })
    expect(fitMetadata.modelScale).toBeCloseTo(0.0483, 6)
  })

  it('records the bounding-box centre of the measured geometry', () => {
    const { fitMetadata } = calibrate(buildDoc(GEOM), MODELING_SPEC)
    // x spans -0.069..0.069, y spans -0.04..0.024, z spans -0.13..0.02
    expect(fitMetadata.modelBoundsCenter.x).toBeCloseTo(0, 6)
    expect(fitMetadata.modelBoundsCenter.y).toBeCloseTo(-0.008, 6)
    expect(fitMetadata.modelBoundsCenter.z).toBeCloseTo(-0.055, 6)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/calibration && npx vitest run test/fitMetadata.test.js test/calibrator.test.js`
Expected: FAIL — `expected undefined to be 1`, and the `createFitMetadata` case does not throw.

- [ ] **Step 3: Add the fields to the record**

In `packages/calibration/src/fitMetadata.js`, add both names to `REQUIRED_FIELDS` after `'scaleLimits'`:

```js
export const REQUIRED_FIELDS = [
  'frameWidthMeters',
  'bridgeAnchor',
  'leftHinge',
  'rightHinge',
  'frontFramePlaneZ',
  'lensCenterOffset',
  'scaleLimits',
  'modelScale',
  'modelBoundsCenter',
  'provenance',
]
```

and to the returned object, after `scaleLimits`:

```js
    scaleLimits: fields.scaleLimits,
    // Uniform factor the ENGINE must apply to the served file. The stored GLB is
    // the merchant's original, so any rescale the measurement pass needed lives
    // here as a number instead of as rewritten vertex data.
    modelScale: fields.modelScale,
    // Centre of the measured bounding box. The engine's loader re-origins every
    // model from its own bbox, so anchors have to be expressed relative to this
    // to land in the same frame. See fitMetadataAdapter.
    modelBoundsCenter: fields.modelBoundsCenter,
```

- [ ] **Step 4: Thread `modelScale` through the calibrator**

In `packages/calibration/src/calibrator.js`:

```js
function buildRecord(doc, anchors, width, provenance, modelScale) {
  const bounds = computeBounds(mergedPositions(doc))
  return createFitMetadata({
    frameWidthMeters: width,
    bridgeAnchor: anchors.bridge,
    leftHinge: anchors.leftHinge,
    rightHinge: anchors.rightHinge,
    frontFramePlaneZ: bounds.max.z,
    lensCenterOffset: { x: 0, y: anchors.bridge.y * 0.5, z: 0 },
    scaleLimits: scaleLimitsFor(width),
    modelScale,
    modelBoundsCenter: bounds.center,
    provenance,
  })
}

export function calibrate(doc, spec, { modelScale = 1 } = {}) {
  const tags = readTags(doc, spec)
  const width = measureFrontWidth(mergedPositions(doc))

  if (tags.found) {
    const fitMetadata = buildRecord(doc, tags.anchors, width, { source: 'tagged', confidence: null }, modelScale)
    return { fitMetadata, confidence: null, source: 'tagged', needsManual: false }
  }

  const { anchors, signals } = estimateAnchors(doc, spec)
  const confidence = scoreConfidence(signals, spec)
  const fitMetadata = buildRecord(doc, anchors, signals.frameWidthMeters, {
    source: 'geometric',
    confidence,
  }, modelScale)
  return {
    fitMetadata,
    confidence,
    source: 'geometric',
    needsManual: !isConfident(confidence.overall),
  }
}
```

- [ ] **Step 5: Run the full calibration suite**

Run: `cd packages/calibration && npx vitest run`
Expected: PASS. If `pipeline.integration.test.js` asserts an exact `fitMetadata` shape, extend its expectation with the two new fields rather than loosening the assertion.

- [ ] **Step 6: Commit**

```bash
git add packages/calibration/src/fitMetadata.js packages/calibration/src/calibrator.js packages/calibration/test/
git commit -m "feat(calibration): record modelScale and modelBoundsCenter in fit metadata

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Store the merchant's original bytes

This is the task that fixes the quality loss. Everything before it was groundwork.

**Files:**
- Modify: `apps/shopify-app/app/calibration.server.js` (whole `calibrateUpload` body)
- Modify: `apps/shopify-app/app/models.server.js:13` and `:152` (`result.normalizedGlb` → `result.storedGlb`)
- Test: `apps/shopify-app/test/calibration.server.test.js`

**Interfaces:**
- Consumes: `normalizeModel(...).scale` (Task 1), `calibrate(doc, spec, { modelScale })` (Task 2).
- Produces: `calibrateUpload(glbBuffer)` returns `{ validation, fitMetadata, confidence, needsManual, storedGlb }`. `storedGlb` is the caller's buffer, unmodified. The `normalizedGlb` property is gone — any consumer still reading it must be updated in this task.

- [ ] **Step 1: Write the failing test**

Append to `apps/shopify-app/test/calibration.server.test.js`:

```js
describe('calibrateUpload byte fidelity', () => {
  it('returns the caller\'s bytes untouched', async () => {
    const doc = buildDoc(GOOD)
    const bytes = await glbBytes(doc)
    const res = await calibrateUpload(bytes)
    expect(res.storedGlb).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(res.storedGlb).equals(Buffer.from(bytes))).toBe(true)
  })

  it('measures a rotated node without rewriting its normals', async () => {
    // A node carrying rotation is exactly the case the old bake corrupted:
    // POSITION was transformed, NORMAL was not. Nothing may be rewritten now.
    const doc = buildDoc(GOOD)
    doc.getRoot().listNodes()[0].setRotation([0, 1, 0, 0]) // 180 deg about Y
    const bytes = await glbBytes(doc)
    const res = await calibrateUpload(bytes)
    expect(Buffer.from(res.storedGlb).equals(Buffer.from(bytes))).toBe(true)
  })

  it('reports modelScale 1 for a model already in metres', async () => {
    const res = await calibrateUpload(await glbBytes(buildDoc(GOOD)))
    expect(res.fitMetadata.modelScale).toBe(1)
  })
})
```

Also update the existing `calibrateUpload` test in that file: `expect(res.normalizedGlb)` → `expect(res.storedGlb)`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/shopify-app && npx vitest run test/calibration.server.test.js`
Expected: FAIL — `expected undefined to be an instance of Uint8Array`.

- [ ] **Step 3: Rewrite `calibrateUpload`**

Replace the body in `apps/shopify-app/app/calibration.server.js`:

```js
/**
 * Server-side A1 integration: validate a raw GLB upload, measure its anchors,
 * and return fit-metadata plus THE CALLER'S OWN BYTES to persist.
 *
 * Normalization is a measurement pass over an in-memory copy, never a rewrite of
 * what we store. bakeNodeTransforms rewrites POSITION without transforming
 * NORMAL, so a model with any rotated mesh node came out the far side with its
 * shading inverted -- measured at 102.7 deg mean normal error across 22 nodes on
 * one real merchant file, and 98.9% of normals facing inward on another. Nothing
 * downstream needed the rewritten file: three.js applies node transforms itself,
 * the recentring is redone by GlassesModelLoader from the model's own bounds, and
 * the only transform that changes real-world size now travels as
 * fitMetadata.modelScale instead of as rewritten vertices.
 *
 * Throws when the model fails validation.
 */
export async function calibrateUpload(glbBuffer) {
  const doc = await io.readBinary(glbBuffer)
  const validation = validateModel(doc, MODELING_SPEC)
  if (validation.status === 'fail') {
    throw new Error(`model rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
  }
  // normalizeModel mutates `doc` in place. That is fine precisely because this
  // doc is never serialised -- it exists only to be measured.
  const { doc: measured, scale } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(measured, MODELING_SPEC, { modelScale: scale })
  return {
    validation,
    fitMetadata: calibration.fitMetadata,
    confidence: calibration.confidence,
    needsManual: calibration.needsManual,
    storedGlb: glbBuffer,
  }
}
```

- [ ] **Step 4: Update both persistence call sites**

In `apps/shopify-app/app/models.server.js`, line 13 and line 152 both read:

```js
  await saveModelGlb(storageRef, result.normalizedGlb)
```

Change both to:

```js
  await saveModelGlb(storageRef, result.storedGlb)
```

- [ ] **Step 5: Verify nothing else reads the old name**

Run: `grep -rn "normalizedGlb" apps/ packages/ src/ harness/ --include=*.js --include=*.jsx --include=*.mjs | grep -v node_modules`
Expected: no output. Any hit is a consumer this task must update.

- [ ] **Step 6: Run the app suite**

Run: `cd apps/shopify-app && npx vitest run`
Expected: PASS. If the Prisma client is stale (`Unknown argument 'filename'`), run `npx prisma generate` first — that is a local codegen issue, not a code defect.

- [ ] **Step 7: Commit**

```bash
git add apps/shopify-app/app/calibration.server.js apps/shopify-app/app/models.server.js apps/shopify-app/test/calibration.server.test.js
git commit -m "fix(calibration): serve merchants their original GLB bytes

bakeNodeTransforms rewrote POSITION without transforming NORMAL, inverting
shading on every model with a rotated mesh node: 102.7 deg mean normal error
across 22 nodes on one merchant file, 98.9% of normals inward on another.
Normalization is now a measurement pass over a throwaway copy and the stored
bytes are the upload, unmodified.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Engine applies `modelScale` to the served file

Without this, a non-metre model served raw renders at its authored scale.

**Files:**
- Modify: `src/models/GlassesModelLoader.js:77-86` (just after the `if (!model)` guard)
- Test: `test/tryon/glassesScale.test.js`

**Interfaces:**
- Consumes: `modelConfig.modelScale` (a plain number, supplied by Task 5's adapter and passed through `registerRuntimeGlassesConfig`'s `...rest` spread).
- Produces: `applyModelScale(model, modelScale)` exported from `src/models/GlassesModelLoader.js`. Exported rather than inlined so the rule is testable without standing up a `GLTFLoader` and a real file — a copy of the logic living in the test would pass whether or not the loader ever calls it.

- [ ] **Step 1: Write the failing test**

Append to `test/tryon/glassesScale.test.js`:

```js
import { applyModelScale } from '../../src/models/GlassesModelLoader.js'

describe('modelScale', () => {
  function sceneWithChildAt(x) {
    const root = new THREE.Group()
    const child = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial())
    child.position.set(x, 0, 0)
    root.add(child)
    root.updateMatrixWorld(true)
    return root
  }

  it('scales a large-coordinate model down to metres', () => {
    const root = sceneWithChildAt(1.5)
    applyModelScale(root, 0.145 / 3)
    const box = new THREE.Box3().setFromObject(root)
    expect(box.getSize(new THREE.Vector3()).x).toBeCloseTo(0.145 / 3, 4)
    expect(root.children[0].position.x).toBeCloseTo(1.5 * (0.145 / 3), 6)
  })

  it('leaves a metre-scale model untouched at modelScale 1', () => {
    const root = sceneWithChildAt(0.069)
    applyModelScale(root, 1)
    expect(root.children[0].position.x).toBeCloseTo(0.069, 6)
    expect(root.children[0].scale.x).toBeCloseTo(1, 6)
  })

  it('ignores a missing or non-finite modelScale', () => {
    const root = sceneWithChildAt(0.069)
    applyModelScale(root, undefined)
    expect(root.children[0].scale.x).toBeCloseTo(1, 6)
  })
})
```

Add `import * as THREE from 'three'` to the file if it is not already imported.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tryon/glassesScale.test.js`
Expected: FAIL — `does not provide an export named 'applyModelScale'`.

- [ ] **Step 3: Add the exported helper and call it from the loader**

At module scope in `src/models/GlassesModelLoader.js` (above the class):

```js
/**
 * Scales a freshly loaded scene to metres.
 *
 * The served GLB is the merchant's original, so a model authored in a non-metre
 * space arrives at its authored size. The calibration pass measured the factor
 * and put it in fitMetadata rather than rewriting every vertex -- a uniform
 * scale is the one transform that would not have corrupted normals, but the
 * stored bytes stay untouched regardless.
 *
 * Scales the direct children (a uniform scale about the scene origin) rather
 * than the root, so the caller's own transform on the root stays free.
 *
 * Exported for test: standing up a GLTFLoader and a real non-metre file to
 * cover three lines is not worth it, and a copy of this logic in the test would
 * pass whether or not load() ever calls it.
 */
export function applyModelScale(model, modelScale) {
  if (!Number.isFinite(modelScale) || modelScale === 1) return
  for (const child of model.children) {
    child.position.multiplyScalar(modelScale)
    child.scale.multiplyScalar(modelScale)
  }
  model.updateMatrixWorld(true)
}
```

Then, immediately after:

```js
    if (!model) {
      throw new Error(`No scene found in model: ${url}`)
    }
```

insert:

```js
    // BEFORE any bounds are taken, so the recentring below and the reported
    // natural size are both in metres.
    applyModelScale(model, modelConfig.modelScale)
```

- [ ] **Step 4: Run the engine suite**

Run: `npx vitest run`
Expected: PASS, 90 existing + 3 new.

- [ ] **Step 5: Commit**

```bash
git add src/models/GlassesModelLoader.js test/tryon/glassesScale.test.js
git commit -m "feat(engine): apply fitMetadata.modelScale to the loaded scene

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Express `bridgePivot` in the loader's recentred frame

This is the separable pitch fix. It is correct independently of Tasks 1-4 and can be
reviewed or reverted on its own.

**Problem, measured:** `normalizeModel` moves the origin *to* the bridge, then
`estimateAnchors` measures the bridge in that same frame and gets `(0, ~0, max.z)`
— a tautology. The loader then re-origins to `(bboxCenterX, bboxCenterY, bboxMaxZ)`,
so the real nose-bridge contact sits ~20 mm above the runtime origin while the solver
is handed ~zero. `(I−R)·pivot` therefore evaluates to zero and the frame rotates about
mid-lens height instead of the nose bridge.

| model | pitch 15° | pitch 30° | yaw |
|---|---|---|---|
| Larsson | 6.4 mm | 12.6 mm | 0.0 mm |
| Willow | 5.1 mm | 10.1 mm | 0.3 mm |
| GRIPZ | 5.4 mm | 10.7 mm | 0.0 mm |
| gripzpelmo | 5.6 mm | 11.2 mm | 1.4 mm |

Yaw is mathematically immune (a pure-Y pivot is invariant under Y rotation), which is
why the yaw-only mock sweep never caught it.

**Files:**
- Modify: `src/tryon/fitMetadataAdapter.js` (whole file)
- Test: `test/tryon/fitMetadataAdapter.test.js`

**Interfaces:**
- Consumes: `fitMetadata.modelBoundsCenter`, `fitMetadata.frontFramePlaneZ`, `fitMetadata.modelScale` (Task 2).
- Produces: `toEngineModelConfig` output gains `modelScale`; `bridgePivot` is now relative to the loader's recentre pivot.

- [ ] **Step 1: Write the failing tests**

Append to `test/tryon/fitMetadataAdapter.test.js`:

```js
describe('bridgePivot frame', () => {
  const base = {
    frameWidthMeters: 0.146,
    bridgeAnchor: { x: 0, y: 0, z: 0 },
    leftHinge: { x: -0.073, y: 0, z: -0.038 },
    rightHinge: { x: 0.073, y: 0, z: -0.038 },
    frontFramePlaneZ: 0,
    lensCenterOffset: { x: 0, y: 0, z: 0 },
    scaleLimits: { min: 0.6, max: 1.6 },
    modelScale: 1,
    modelBoundsCenter: { x: 0, y: -0.0208, z: -0.078 },
    provenance: { source: 'geometric', confidence: null },
  }

  it('offsets the anchor by the pivot the loader will re-origin to', () => {
    const cfg = toEngineModelConfig(base, '/models/x.glb')
    // Loader pivot is (centerX, centerY, maxZ) -- depthPivot 'frontMaxZ'.
    expect(cfg.bridgePivot.x).toBeCloseTo(0, 6)
    expect(cfg.bridgePivot.y).toBeCloseTo(0.0208, 6)
    expect(cfg.bridgePivot.z).toBeCloseTo(0, 6)
  })

  it('is immune to where the normalizer happened to put the origin', () => {
    // A rigid translation of the whole measurement frame must cancel: the pivot
    // is a difference of two points measured in the same frame.
    const shifted = {
      ...base,
      bridgeAnchor: { x: 0.5, y: 0.5, z: 0.5 },
      frontFramePlaneZ: 0.5,
      modelBoundsCenter: { x: 0.5, y: 0.4792, z: 0.422 },
    }
    const cfg = toEngineModelConfig(shifted, '/models/x.glb')
    expect(cfg.bridgePivot.y).toBeCloseTo(0.0208, 4)
  })

  it('passes modelScale through', () => {
    expect(toEngineModelConfig({ ...base, modelScale: 0.0483 }, '/x.glb').modelScale)
      .toBeCloseTo(0.0483, 6)
  })

  it('falls back to the raw anchor for rows written before modelBoundsCenter', () => {
    const { modelBoundsCenter, modelScale, ...legacy } = base
    const cfg = toEngineModelConfig({ ...legacy, bridgeAnchor: { x: 0, y: 0.004, z: 0 } }, '/x.glb')
    expect(cfg.bridgePivot).toEqual({ x: 0, y: 0.004, z: 0 })
    expect(cfg.modelScale).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tryon/fitMetadataAdapter.test.js`
Expected: FAIL — `expected 0 to be close to 0.0208`.

- [ ] **Step 3: Rewrite the adapter**

Replace `src/tryon/fitMetadataAdapter.js` entirely:

```js
/**
 * Maps calibration output onto the engine's model-config shape.
 *
 * This is where the engine's rendering conventions meet the calibration
 * package's pure geometry, so the knowledge that GlassesModelLoader re-origins
 * every model to (bboxCenterX, bboxCenterY, bboxMaxZ) -- depthPivot
 * 'frontMaxZ' -- lives HERE rather than inside @artryon/calibration.
 */

/**
 * The bridge anchor, restated relative to the origin the loader will give the
 * model.
 *
 * The solver rotates the frame about this point, so it has to be in the same
 * frame as the geometry the solver is moving. It was not: calibration measures
 * in the normalizer's frame (origin at the bridge, which makes the anchor
 * ~zero by construction) while the loader re-origins to the bounding box. The
 * solver was handed ~zero, so (I - R)*pivot vanished and the frame rotated
 * about mid-lens height instead of the nose bridge -- 5-6 mm of drift at 15
 * degrees of pitch, 10-13 mm at 30, and nothing at all at yaw, which is why a
 * yaw-only sweep never showed it.
 *
 * Both points are measured in the same frame, so any rigid translation the
 * normalizer applied cancels here.
 */
function bridgePivotFor(fitMetadata) {
  const center = fitMetadata.modelBoundsCenter
  const anchor = fitMetadata.bridgeAnchor
  // Rows written before modelBoundsCenter existed keep the old behaviour rather
  // than being silently re-framed against a centre we do not have.
  if (!center) return anchor
  return {
    x: anchor.x - center.x,
    y: anchor.y - center.y,
    z: anchor.z - fitMetadata.frontFramePlaneZ,
  }
}

export function toEngineModelConfig(fitMetadata, modelUrl) {
  return {
    modelUrl,
    frameWidthMeters: fitMetadata.frameWidthMeters,
    bridgePivot: bridgePivotFor(fitMetadata),
    leftHingePoint: fitMetadata.leftHinge,
    rightHingePoint: fitMetadata.rightHinge,
    frontFramePlaneZ: fitMetadata.frontFramePlaneZ,
    lensCenterOffset: fitMetadata.lensCenterOffset,
    scaleLimits: fitMetadata.scaleLimits,
    // Uniform factor for a model authored outside metre space. Absent on rows
    // written before the raw-passthrough change, where the rescale was baked
    // into the stored file instead.
    modelScale: fitMetadata.modelScale ?? 1,
  }
}
```

- [ ] **Step 4: Run the engine suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tryon/fitMetadataAdapter.js test/tryon/fitMetadataAdapter.test.js
git commit -m "fix(fit): express bridgePivot in the loader's recentred frame

The solver rotates about bridgePivot, but calibration measured it in the
normalizer's frame while the loader re-origins to the bounding box, so the
solver got ~zero and the frame pivoted about mid-lens height. 5-6 mm of drift
at 15 deg pitch, 10-13 mm at 30; yaw was unaffected, which is why the yaw-only
mock sweep never caught it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Make the harness run production's pipeline

The harness stub calls `calibrate` on the raw doc with no validate and no normalize,
and serves the raw file. Production validates, normalizes, calibrates, and (after
Task 3) also serves the raw file. After this task the two agree, which retroactively
makes local fit and occlusion measurements meaningful.

**Files:**
- Modify: `harness/mock-server.config.mjs:81-100` (the `/api/register-model` stub)

**Interfaces:**
- Consumes: `normalizeModel(...).scale` (Task 1), `calibrate(doc, spec, { modelScale })` (Task 2).
- Produces: nothing later tasks consume.

- [ ] **Step 1: Replace the stub body**

```js
    server.middlewares.use('/api/register-model', async (req, res) => {
      try {
        const url = new URL(req.url ?? '', 'http://localhost')
        const modelUrl = url.searchParams.get('url')
        if (!modelUrl) throw new Error('missing ?url')

        const { NodeIO } = await import('@gltf-transform/core')
        const { KHRONOS_EXTENSIONS } = await import('@gltf-transform/extensions')
        const { validateModel, normalizeModel, calibrate, MODELING_SPEC } =
          await import('@artryon/calibration')

        const rel = modelUrl.startsWith('/') ? modelUrl.slice(1) : modelUrl
        const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
        const doc = await io.read(path.join(ROOT, 'public', rel))

        // Same sequence as apps/shopify-app/app/calibration.server.js. It used to
        // be a bare calibrate() on the un-normalized doc, which meant every
        // measurement taken through this harness described a pipeline production
        // does not run.
        const validation = validateModel(doc, MODELING_SPEC)
        if (validation.status === 'fail') {
          throw new Error(`model rejected: ${validation.issues.map((i) => i.message).join('; ')}`)
        }
        const { doc: measured, scale } = normalizeModel(doc, MODELING_SPEC)
        const { fitMetadata } = calibrate(measured, MODELING_SPEC, { modelScale: scale })

        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ fitMetadata, modelUrl }))
      } catch (error) {
        res.statusCode = 500
        res.end(JSON.stringify({ error: String(error?.message ?? error) }))
      }
    })
```

Also update the file's header comment: the claim "The fit metadata it produces is
identical to production's; only the delivery path differs" is now true and should say
so explicitly rather than by implication.

- [ ] **Step 2: Verify the harness serves a config**

Run: `npm run harness` in one shell, then in another:
`curl -s "http://localhost:5175/api/register-model?url=/models/_m-willow.glb" | head -c 400`
Expected: JSON containing `fitMetadata` with `modelScale`, `modelBoundsCenter`, and a `bridgeAnchor`.

- [ ] **Step 3: Commit**

```bash
git add harness/mock-server.config.mjs
git commit -m "fix(harness): run production's validate/normalize/calibrate sequence

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Verify against the three real merchant models

**Files:**
- Create: `scripts/verify-raw-passthrough.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: a runnable check, kept in the repo so the byte-fidelity property can be re-asserted after any future calibration change.

- [ ] **Step 1: Write the script**

```js
/**
 * Asserts the properties the raw-passthrough change exists to guarantee:
 * the bytes we would persist are the bytes we were given, and nothing in the
 * mesh data moved.
 *
 * Run against the real merchant fixtures:
 *   node scripts/verify-raw-passthrough.mjs public/models/_m-willow.glb ...
 */
import fs from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { calibrateUpload } from '../apps/shopify-app/app/calibration.server.js'

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node scripts/verify-raw-passthrough.mjs <file.glb>...')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  const raw = fs.readFileSync(file)
  const res = await calibrateUpload(raw)
  const identical = Buffer.from(res.storedGlb).equals(raw)

  // Normals must be bit-identical to the source: the bug this replaces rewrote
  // POSITION and left NORMAL stale, inverting shading on rotated nodes.
  const src = await io.readBinary(raw)
  const out = await io.readBinary(Buffer.from(res.storedGlb))
  const normalsOf = (d) => d.getRoot().listMeshes()
    .flatMap((m) => m.listPrimitives())
    .map((p) => p.getAttribute('NORMAL'))
    .filter(Boolean)
    .map((a) => Buffer.from(new Float32Array(a.getArray()).buffer).toString('base64'))
  const normalsSame = JSON.stringify(normalsOf(src)) === JSON.stringify(normalsOf(out))

  const m = res.fitMetadata
  const ok = identical && normalsSame
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${file}\n` +
    `   bytes identical=${identical}  normals identical=${normalsSame}\n` +
    `   modelScale=${m.modelScale}  frameWidth=${(m.frameWidthMeters * 1000).toFixed(1)}mm  ` +
    `source=${m.provenance.source}  needsManual=${res.needsManual}`
  )
}
process.exit(failed ? 1 : 0)
```

- [ ] **Step 2: Run it**

Run: `node scripts/verify-raw-passthrough.mjs public/models/_m-larsson.glb public/models/_m-willow.glb public/models/_m-gripz.glb`
Expected: three `PASS` lines, `bytes identical=true`, `normals identical=true`, `modelScale=1` on all three.

- [ ] **Step 3: Confirm on-face rendering in the harness**

Run `npm run harness`, load `?model=/models/_m-willow.glb`, and step the mock through
yaw with `window.__mock.step()`. Willow is the model with 22 rotated nodes, so its
shading is the visible before/after. Capture a frame with `__probe.shot('willow-raw')`
and compare against `../test-shots/` from the previous session.

Expected: occlusion harness still PASS 4/4; Willow's metal parts no longer read as
flat or inside-out.

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-raw-passthrough.mjs
git commit -m "test: assert byte and normal fidelity through calibrateUpload

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Recalibrate rows written by the old pipeline (decide before shipping)

Not code-complete in this plan on purpose — it needs a decision from you first.

Every `ModelAsset` already in the database holds a `fitMetadata` written by the old
code and a `storageRef` pointing at an **already-rewritten** GLB. Tasks 1-7 change
what happens to *new* uploads only. `registerModelByUrl` dedupes on
`(shop, sourceUrl)` and returns `existing.fitMetadata`, and there is no recalibration
path anywhere in the repo, so existing models keep:

- the corrupted normals baked into their stored file,
- `scaleLimits` of `{0.85, 1.15}` from before this was widened to `{0.6, 1.6}`,
- no `modelScale` / `modelBoundsCenter`, so they take the adapter's legacy branch and
  keep the pitch bug.

Three options, in increasing order of effort:

1. **Leave them.** New uploads are correct; existing models stay as they are. Zero
   risk, but the shading bug stays live on every model already registered.
2. **Invalidate and re-register.** Delete `ModelAsset` rows whose `fitMetadata` lacks
   `modelScale`; the next storefront hit re-fetches from the merchant's Shopify CDN
   URL and recalibrates. Only works for the block path — admin-uploaded models have no
   `sourceUrl` to re-fetch from and would have to be re-uploaded by the merchant.
3. **Backfill in place.** A script that re-fetches each `sourceUrl`, runs the new
   `calibrateUpload`, and rewrites both the S3 object and the `fitMetadata` row. Covers
   the block path fully; admin uploads still cannot be recovered, because the original
   bytes were never kept.

Option 3 is the only complete one, and it is worth noting that **it is only possible
for models with a `sourceUrl`** — for admin uploads the pre-bake original is gone. That
is an argument for doing this sooner rather than later.

---

## Rollout notes

- **This changes how every merchant model renders**, including the live Gripz Pelmo if
  it is ever routed through the calibration path. Shading on Willow and gripzpelmo will
  visibly change — that is the fix landing, not a regression. Eyeball both before deploy.
- Tasks 1-4 are one coherent change (raw passthrough). Task 5 is independent and can
  ship or revert separately. Task 6 is test-infrastructure only.
- Everything in this repo is currently uncommitted — 8 modified files and ~12 untracked
  from the previous session. Commit or stash that work before starting, so this plan's
  commits are reviewable on their own.
- `public/models/_test-*.glb` and `_m-*.glb` are scratch fixtures. Delete before any
  push; the two `*-taper.glb` files are obsolete (the taper was a workaround for the
  depth-scale unit bug, which is fixed).

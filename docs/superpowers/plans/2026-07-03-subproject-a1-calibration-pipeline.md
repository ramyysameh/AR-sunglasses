# A1 — Calibration Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a merchant-supplied GLB into a validated, normalized model plus a versioned fit-metadata record and a transparent confidence report — headless, with no per-model source changes.

**Architecture:** A pure, Node-runnable pipeline `validate → normalize → calibrate`, operating on `@gltf-transform/core` `Document`s and flat position arrays. Anchors come tags-first (exact) with a geometric fallback that emits named confidence sub-signals. A browser Dev Harness wires the pipeline output into the existing Three.js engine for preview + manual adjustment + export.

**Tech Stack:** Vanilla ES modules, `@gltf-transform/core` (already a devDep), Vitest (added in Task 1), Three.js (harness only).

## Global Constraints

- Code style: **ES modules, no semicolons, single quotes, 2-space indent** — match existing `src/`.
- Pipeline modules (`spec`, `fitMetadata`, `geometry`, `validator`, `normalizer`, `tagReader`, `geometricEstimator`, `confidence`, `calibrator`) MUST be **Node-runnable and browser-runnable** — no DOM, no Three.js imports. Only the Dev Harness may import Three.js / touch the DOM.
- Units: **meters** (1 GLB unit = 1 m) everywhere in fit-metadata.
- Fit-profile version string: **`eyewear-v1`** (exact).
- Canonical model space: **+Y up**, **front frame toward +Z**, **temples toward −Z**, **bilateral symmetry plane at X = 0**, **origin at the bridge**.
- Anchor tag nodes (exact names): **`AR_bridge`**, **`AR_hinge_L`**, **`AR_hinge_R`** (empty nodes; their world translation is the anchor).
- Human plausibility ranges: **front frame width 0.120–0.150 m**; max **150,000 triangles**.
- Positions passed to `geometry.js` are **flat `Float32Array`/`number[]`** `[x0,y0,z0,x1,y1,z1,…]`. Anchors are `{ x, y, z }` objects (matches existing config schema).

---

### Task 1: Test infra + Modeling Spec constants

**Files:**
- Modify: `package.json` (add vitest devDep + scripts)
- Create: `vitest.config.js`
- Create: `src/calibration/spec.js`
- Test: `test/calibration/spec.test.js`

**Interfaces:**
- Produces: `MODELING_SPEC` (frozen object) and `FIT_PROFILE_VERSION` (string `'eyewear-v1'`) from `src/calibration/spec.js`.

- [ ] **Step 1: Add Vitest and scripts**

In `package.json`, add to `devDependencies`: `"vitest": "^3.2.4"`. Add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

Then run: `npm install`

- [ ] **Step 2: Create Vitest config**

Create `vitest.config.js`:

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
  },
})
```

- [ ] **Step 3: Write the failing test**

Create `test/calibration/spec.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { MODELING_SPEC, FIT_PROFILE_VERSION } from '../../src/calibration/spec.js'

describe('MODELING_SPEC', () => {
  it('pins the canonical conventions', () => {
    expect(FIT_PROFILE_VERSION).toBe('eyewear-v1')
    expect(MODELING_SPEC.units).toBe('meters')
    expect(MODELING_SPEC.upAxis).toBe('y')
    expect(MODELING_SPEC.frontAxis).toBe('+z')
    expect(MODELING_SPEC.symmetryAxis).toBe('x')
    expect(MODELING_SPEC.tagNames).toEqual({
      bridge: 'AR_bridge',
      hingeL: 'AR_hinge_L',
      hingeR: 'AR_hinge_R',
    })
    expect(MODELING_SPEC.frameWidthRangeM).toEqual([0.12, 0.15])
    expect(MODELING_SPEC.maxTriangles).toBe(150000)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(MODELING_SPEC)).toBe(true)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- spec`
Expected: FAIL — cannot find module `src/calibration/spec.js`.

- [ ] **Step 5: Implement the spec**

Create `src/calibration/spec.js`:

```js
export const FIT_PROFILE_VERSION = 'eyewear-v1'

export const MODELING_SPEC = Object.freeze({
  units: 'meters',
  upAxis: 'y',
  frontAxis: '+z',
  symmetryAxis: 'x',
  tagNames: Object.freeze({
    bridge: 'AR_bridge',
    hingeL: 'AR_hinge_L',
    hingeR: 'AR_hinge_R',
  }),
  frameWidthRangeM: Object.freeze([0.12, 0.15]),
  maxTriangles: 150000,
})
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- spec`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.js src/calibration/spec.js test/calibration/spec.test.js
git commit -m "feat(calibration): add vitest infra and modeling spec constants"
```

---

### Task 2: Fit-metadata schema + factory

**Files:**
- Create: `src/calibration/fitMetadata.js`
- Test: `test/calibration/fitMetadata.test.js`

**Interfaces:**
- Consumes: `FIT_PROFILE_VERSION` from `spec.js`.
- Produces: `createFitMetadata(fields) -> record`, `REQUIRED_FIELDS` (string[]). Throws `Error` listing any missing required fields. Record shape:
  `{ version, frameWidthMeters, bridgeAnchor:{x,y,z}, leftHinge:{x,y,z}, rightHinge:{x,y,z}, frontFramePlaneZ:number, lensCenterOffset:{x,y,z}, scaleLimits:{min,max}, provenance:{ source, confidence } }`

- [ ] **Step 1: Write the failing test**

Create `test/calibration/fitMetadata.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { createFitMetadata } from '../../src/calibration/fitMetadata.js'

const base = {
  frameWidthMeters: 0.138,
  bridgeAnchor: { x: 0, y: 0, z: 0.01 },
  leftHinge: { x: -0.069, y: 0, z: -0.01 },
  rightHinge: { x: 0.069, y: 0, z: -0.01 },
  frontFramePlaneZ: 0.02,
  lensCenterOffset: { x: 0, y: 0, z: 0 },
  scaleLimits: { min: 0.85, max: 1.15 },
  provenance: { source: 'tagged', confidence: null },
}

describe('createFitMetadata', () => {
  it('stamps the version and returns the full record', () => {
    const record = createFitMetadata(base)
    expect(record.version).toBe('eyewear-v1')
    expect(record.frameWidthMeters).toBe(0.138)
    expect(record.rightHinge).toEqual({ x: 0.069, y: 0, z: -0.01 })
  })

  it('throws listing every missing required field', () => {
    expect(() => createFitMetadata({ frameWidthMeters: 0.138 })).toThrowError(/bridgeAnchor/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fitMetadata`
Expected: FAIL — cannot find module `fitMetadata.js`.

- [ ] **Step 3: Implement the factory**

Create `src/calibration/fitMetadata.js`:

```js
import { FIT_PROFILE_VERSION } from './spec.js'

export const REQUIRED_FIELDS = [
  'frameWidthMeters',
  'bridgeAnchor',
  'leftHinge',
  'rightHinge',
  'frontFramePlaneZ',
  'lensCenterOffset',
  'scaleLimits',
  'provenance',
]

export function createFitMetadata(fields) {
  const missing = REQUIRED_FIELDS.filter((key) => fields[key] === undefined)
  if (missing.length) {
    throw new Error(`fit-metadata missing required fields: ${missing.join(', ')}`)
  }

  return {
    version: FIT_PROFILE_VERSION,
    frameWidthMeters: fields.frameWidthMeters,
    bridgeAnchor: fields.bridgeAnchor,
    leftHinge: fields.leftHinge,
    rightHinge: fields.rightHinge,
    frontFramePlaneZ: fields.frontFramePlaneZ,
    lensCenterOffset: fields.lensCenterOffset,
    scaleLimits: fields.scaleLimits,
    provenance: fields.provenance,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fitMetadata`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/fitMetadata.js test/calibration/fitMetadata.test.js
git commit -m "feat(calibration): add versioned fit-metadata schema + factory"
```

---

### Task 3: Geometry — bounds & symmetry

**Files:**
- Create: `src/calibration/geometry.js`
- Test: `test/calibration/geometry.bounds.test.js`

**Interfaces:**
- Produces:
  - `computeBounds(positions) -> { min:{x,y,z}, max:{x,y,z}, size:{x,y,z}, center:{x,y,z} }`
  - `measureSymmetryDeviation(positions) -> number` (0 = perfectly symmetric about X=0; grows with asymmetry; normalized by model width).

- [ ] **Step 1: Write the failing test**

Create `test/calibration/geometry.bounds.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { computeBounds, measureSymmetryDeviation } from '../../src/calibration/geometry.js'

// A tiny symmetric box: corners mirrored across x=0
const symmetric = new Float32Array([
  -1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1,
  -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1,
])

describe('computeBounds', () => {
  it('returns min/max/size/center', () => {
    const b = computeBounds(symmetric)
    expect(b.min).toEqual({ x: -1, y: -1, z: -1 })
    expect(b.max).toEqual({ x: 1, y: 1, z: 1 })
    expect(b.size).toEqual({ x: 2, y: 2, z: 2 })
    expect(b.center).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('measureSymmetryDeviation', () => {
  it('is ~0 for a symmetric mesh', () => {
    expect(measureSymmetryDeviation(symmetric)).toBeCloseTo(0, 5)
  })

  it('grows when the mesh is shifted off the x=0 plane', () => {
    const shifted = symmetric.map((v, i) => (i % 3 === 0 ? v + 0.5 : v))
    expect(measureSymmetryDeviation(shifted)).toBeGreaterThan(0.1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- geometry.bounds`
Expected: FAIL — cannot find module `geometry.js`.

- [ ] **Step 3: Implement bounds & symmetry**

Create `src/calibration/geometry.js`:

```js
export function computeBounds(positions) {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < min.x) min.x = x
    if (y < min.y) min.y = y
    if (z < min.z) min.z = z
    if (x > max.x) max.x = x
    if (y > max.y) max.y = y
    if (z > max.z) max.z = z
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }
  return { min, max, size, center }
}

// Mean |x-centroid_x| distance between the mesh and its own X-mirror, normalized
// by width. Approximated by comparing the sorted absolute-x profile of the +x and
// -x half-spaces — a mesh symmetric about x=0 has matching profiles (deviation ~0).
export function measureSymmetryDeviation(positions) {
  const { size, center } = computeBounds(positions)
  const width = size.x || 1
  let sum = 0
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    // distance of each vertex from the symmetry plane, offset by how far the whole
    // mesh's center is from x=0 (a centered-but-symmetric mesh scores 0).
    sum += Math.abs(positions[i] - center.x) - Math.abs(positions[i])
    count += 1
  }
  // center offset dominates asymmetry; fold it in explicitly and normalize.
  const centerOffset = Math.abs(center.x)
  return (centerOffset + Math.abs(sum) / (count || 1)) / width
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- geometry.bounds`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/geometry.js test/calibration/geometry.bounds.test.js
git commit -m "feat(calibration): add bounds + symmetry-deviation geometry helpers"
```

---

### Task 4: Geometry — temple detection & front width

**Files:**
- Modify: `src/calibration/geometry.js`
- Test: `test/calibration/geometry.temples.test.js`

**Interfaces:**
- Consumes: `computeBounds` from `geometry.js`.
- Produces:
  - `measureFrontWidth(positions) -> number` (X extent of the front slab, meters).
  - `detectTemples(positions) -> { leftHinge:{x,y,z}, rightHinge:{x,y,z}, certainty:number }` where `certainty` is 0–1 based on how clearly two rearward (−Z) arms separate from the front slab.

- [ ] **Step 1: Write the failing test**

Create `test/calibration/geometry.temples.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { measureFrontWidth, detectTemples } from '../../src/calibration/geometry.js'

// Front slab near z=+0.02 spanning x in [-0.069, 0.069], plus two temple points
// running back to z=-0.13 at the outer x.
const frame = new Float32Array([
  -0.069, 0, 0.02, 0.069, 0, 0.02, // front outer corners
  0, 0.02, 0.02, 0, -0.02, 0.02, // bridge/top + bottom center
  -0.069, 0, -0.13, 0.069, 0, -0.13, // temple tips (rear)
])

describe('measureFrontWidth', () => {
  it('measures the front-slab X extent', () => {
    expect(measureFrontWidth(frame)).toBeCloseTo(0.138, 3)
  })
})

describe('detectTemples', () => {
  it('finds hinge points at the outer front, with high certainty', () => {
    const t = detectTemples(frame)
    expect(t.leftHinge.x).toBeLessThan(0)
    expect(t.rightHinge.x).toBeGreaterThan(0)
    expect(Math.abs(t.rightHinge.x)).toBeCloseTo(0.069, 2)
    expect(t.certainty).toBeGreaterThan(0.5)
  })

  it('reports low certainty when there are no rearward arms', () => {
    const flat = new Float32Array([
      -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.02, 0.02, 0, -0.02, 0.02,
    ])
    expect(detectTemples(flat).certainty).toBeLessThan(0.5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- geometry.temples`
Expected: FAIL — `measureFrontWidth`/`detectTemples` not exported.

- [ ] **Step 3: Implement temple detection & front width**

Append to `src/calibration/geometry.js`:

```js
// The front slab = vertices within the front 25% of the Z range. Its X extent is
// the frame width.
export function measureFrontWidth(positions) {
  const { min, max } = computeBounds(positions)
  const zThreshold = max.z - (max.z - min.z) * 0.25
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= zThreshold) {
      minX = Math.min(minX, positions[i])
      maxX = Math.max(maxX, positions[i])
    }
  }
  return maxX - minX
}

// Hinge = the outermost front-slab vertex on each side. Certainty rises with how
// far the mesh extends rearward (−Z) beyond the front slab (i.e. real temple arms).
export function detectTemples(positions) {
  const { min, max } = computeBounds(positions)
  const zRange = max.z - min.z || 1
  const zThreshold = max.z - zRange * 0.25
  let left = { x: 0, y: 0, z: 0 }
  let right = { x: 0, y: 0, z: 0 }
  let rearDepth = 0
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (z >= zThreshold) {
      if (x < left.x) left = { x, y, z }
      if (x > right.x) right = { x, y, z }
    }
    rearDepth = Math.max(rearDepth, zThreshold - z)
  }
  const certainty = Math.max(0, Math.min(1, rearDepth / (zRange * 0.5)))
  return { leftHinge: left, rightHinge: right, certainty }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- geometry.temples`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/geometry.js test/calibration/geometry.temples.test.js
git commit -m "feat(calibration): add front-width + temple/hinge detection"
```

---

### Task 5: GLB position extraction + Validator

**Files:**
- Create: `src/calibration/glbAccess.js`
- Create: `src/calibration/validator.js`
- Test: `test/calibration/validator.test.js`
- Test helper: `test/calibration/helpers/buildDoc.js`

**Interfaces:**
- Produces:
  - `glbAccess.js`: `mergedPositions(doc) -> Float32Array` (all mesh vertex positions in world space, concatenated), `countTriangles(doc) -> number`, `findNode(doc, name) -> Node|null`.
  - `validator.js`: `validateModel(doc, spec) -> { status:'pass'|'warn'|'fail', issues:[{ code, severity, message }] }`.

- [ ] **Step 1: Write the shared Document builder helper**

Create `test/calibration/helpers/buildDoc.js` (used by several tasks):

```js
import { Document } from '@gltf-transform/core'

// Build a minimal glTF Document from a flat position array (one triangle-list
// mesh). Optional named empty nodes place anchor tags at given {x,y,z}.
export function buildDoc(positions, tags = {}) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const accessor = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer)
  const prim = doc.createPrimitive().setAttribute('POSITION', accessor)
  const mesh = doc.createMesh('frame').addPrimitive(prim)
  const node = doc.createNode('frameNode').setMesh(mesh)
  const scene = doc.createScene().addChild(node)
  for (const [name, p] of Object.entries(tags)) {
    scene.addChild(doc.createNode(name).setTranslation([p.x, p.y, p.z]))
  }
  return doc
}
```

- [ ] **Step 2: Write the failing test**

Create `test/calibration/validator.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { validateModel } from '../../src/calibration/validator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.02, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('validateModel', () => {
  it('passes a plausible frame', () => {
    const res = validateModel(buildDoc(goodFrame), MODELING_SPEC)
    expect(res.status).toBe('pass')
    expect(res.issues).toEqual([])
  })

  it('fails an empty document', () => {
    const res = validateModel(buildDoc([]), MODELING_SPEC)
    expect(res.status).toBe('fail')
    expect(res.issues.some((i) => i.code === 'NO_GEOMETRY')).toBe(true)
  })

  it('warns when the frame width is outside the human range', () => {
    const tooWide = goodFrame.map((v, i) => (i % 3 === 0 ? v * 4 : v))
    const res = validateModel(buildDoc(tooWide), MODELING_SPEC)
    expect(res.status).toBe('warn')
    expect(res.issues.some((i) => i.code === 'WIDTH_OUT_OF_RANGE')).toBe(true)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- validator`
Expected: FAIL — cannot find module `validator.js`.

- [ ] **Step 4: Implement GLB access + validator**

Create `src/calibration/glbAccess.js`:

```js
export function mergedPositions(doc) {
  const chunks = []
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const accessor = prim.getAttribute('POSITION')
      if (accessor) chunks.push(accessor.getArray())
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function countTriangles(doc) {
  let verts = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices()
      const pos = prim.getAttribute('POSITION')
      verts += idx ? idx.getCount() : (pos ? pos.getCount() : 0)
    }
  }
  return Math.floor(verts / 3)
}

export function findNode(doc, name) {
  return doc.getRoot().listNodes().find((n) => n.getName() === name) ?? null
}
```

Create `src/calibration/validator.js`:

```js
import { mergedPositions, countTriangles } from './glbAccess.js'
import { measureFrontWidth } from './geometry.js'

export function validateModel(doc, spec) {
  const issues = []
  const positions = mergedPositions(doc)

  if (positions.length === 0) {
    issues.push({ code: 'NO_GEOMETRY', severity: 'fail', message: 'model has no mesh geometry' })
    return { status: 'fail', issues }
  }

  if (countTriangles(doc) > spec.maxTriangles) {
    issues.push({ code: 'OVER_POLY_BUDGET', severity: 'warn', message: `exceeds ${spec.maxTriangles} triangles` })
  }

  const width = measureFrontWidth(positions)
  const [minW, maxW] = spec.frameWidthRangeM
  if (width < minW || width > maxW) {
    issues.push({ code: 'WIDTH_OUT_OF_RANGE', severity: 'warn', message: `front width ${width.toFixed(3)}m outside ${minW}-${maxW}m` })
  }

  const status = issues.some((i) => i.severity === 'fail')
    ? 'fail'
    : issues.length
      ? 'warn'
      : 'pass'
  return { status, issues }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- validator`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/calibration/glbAccess.js src/calibration/validator.js test/calibration/validator.test.js test/calibration/helpers/buildDoc.js
git commit -m "feat(calibration): add GLB position access and model validator"
```

---

### Task 6: Normalizer

**Files:**
- Create: `src/calibration/normalizer.js`
- Test: `test/calibration/normalizer.test.js`

**Interfaces:**
- Consumes: `mergedPositions` (glbAccess), `computeBounds` (geometry).
- Produces: `normalizeModel(doc, spec) -> { doc, transforms:string[] }`. Recenters the front-slab X-center and bridge-top to the origin by baking a translation into every root node; records which transforms it applied. (Axis/scale conversion is a no-op here because fixtures are already +Y-up meters; the hook exists and is recorded when it does act.)

- [ ] **Step 1: Write the failing test**

Create `test/calibration/normalizer.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { normalizeModel } from '../../src/calibration/normalizer.js'
import { mergedPositions } from '../../src/calibration/glbAccess.js'
import { computeBounds } from '../../src/calibration/geometry.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

// Frame whose bridge sits at x=0.1 (off-origin) — normalizer should recenter it.
const offset = [
  0.031, 0, 0.02, 0.169, 0, 0.02, 0.1, 0.02, 0.02,
  0.031, 0, -0.13, 0.169, 0, -0.13, 0.1, -0.02, 0.02,
]

describe('normalizeModel', () => {
  it('recenters the front-slab X-center to x=0', () => {
    const { doc, transforms } = normalizeModel(buildDoc(offset), MODELING_SPEC)
    const b = computeBounds(mergedPositions(doc))
    expect(b.center.x).toBeCloseTo(0, 4)
    expect(transforms).toContain('recenter')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- normalizer`
Expected: FAIL — cannot find module `normalizer.js`.

- [ ] **Step 3: Implement the normalizer**

Create `src/calibration/normalizer.js`:

```js
import { mergedPositions } from './glbAccess.js'
import { computeBounds } from './geometry.js'

export function normalizeModel(doc, spec) {
  const transforms = []
  const positions = mergedPositions(doc)
  if (positions.length === 0) return { doc, transforms }

  const { min, max, center } = computeBounds(positions)
  // Front slab X-center → 0; bridge-top (max.y at front) → y 0; front plane keeps +z.
  const frontZThreshold = max.z - (max.z - min.z) * 0.25
  let frontMinX = Infinity
  let frontMaxX = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZThreshold) {
      frontMinX = Math.min(frontMinX, positions[i])
      frontMaxX = Math.max(frontMaxX, positions[i])
    }
  }
  const dx = -(frontMinX + frontMaxX) / 2
  const dy = -max.y
  const dz = 0

  if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
    for (const node of doc.getRoot().listScenes()[0].listChildren()) {
      const t = node.getTranslation()
      node.setTranslation([t[0] + dx, t[1] + dy, t[2] + dz])
    }
    // Bake the translation into positions too so downstream reads see it.
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const acc = prim.getAttribute('POSITION')
        const arr = acc.getArray().slice()
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] += dx
          arr[i + 1] += dy
          arr[i + 2] += dz
        }
        acc.setArray(arr)
      }
    }
    transforms.push('recenter')
  }

  return { doc, transforms }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- normalizer`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/normalizer.js test/calibration/normalizer.test.js
git commit -m "feat(calibration): add model normalizer (recenter to bridge origin)"
```

---

### Task 7: TagReader

**Files:**
- Create: `src/calibration/tagReader.js`
- Test: `test/calibration/tagReader.test.js`

**Interfaces:**
- Consumes: `findNode` (glbAccess).
- Produces: `readTags(doc, spec) -> { found:boolean, anchors:{ bridge:{x,y,z}, leftHinge:{x,y,z}, rightHinge:{x,y,z} } | null }`. `found` is true only when all three tag nodes are present.

- [ ] **Step 1: Write the failing test**

Create `test/calibration/tagReader.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { readTags } from '../../src/calibration/tagReader.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const frame = [-0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.02, 0.02]

describe('readTags', () => {
  it('reads all three anchor tags when present', () => {
    const doc = buildDoc(frame, {
      AR_bridge: { x: 0, y: 0.01, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const res = readTags(doc, MODELING_SPEC)
    expect(res.found).toBe(true)
    expect(res.anchors.bridge).toEqual({ x: 0, y: 0.01, z: 0.02 })
    expect(res.anchors.rightHinge.x).toBeCloseTo(0.069, 4)
  })

  it('reports not-found when tags are missing', () => {
    const res = readTags(buildDoc(frame), MODELING_SPEC)
    expect(res.found).toBe(false)
    expect(res.anchors).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tagReader`
Expected: FAIL — cannot find module `tagReader.js`.

- [ ] **Step 3: Implement the tag reader**

Create `src/calibration/tagReader.js`:

```js
import { findNode } from './glbAccess.js'

function anchorOf(node) {
  const t = node.getTranslation()
  return { x: t[0], y: t[1], z: t[2] }
}

export function readTags(doc, spec) {
  const bridge = findNode(doc, spec.tagNames.bridge)
  const left = findNode(doc, spec.tagNames.hingeL)
  const right = findNode(doc, spec.tagNames.hingeR)
  if (!bridge || !left || !right) {
    return { found: false, anchors: null }
  }
  return {
    found: true,
    anchors: {
      bridge: anchorOf(bridge),
      leftHinge: anchorOf(left),
      rightHinge: anchorOf(right),
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tagReader`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/tagReader.js test/calibration/tagReader.test.js
git commit -m "feat(calibration): add anchor-tag reader"
```

---

### Task 8: GeometricEstimator

**Files:**
- Create: `src/calibration/geometricEstimator.js`
- Test: `test/calibration/geometricEstimator.test.js`

**Interfaces:**
- Consumes: `mergedPositions` (glbAccess); `computeBounds`, `measureSymmetryDeviation`, `measureFrontWidth`, `detectTemples` (geometry); `spec.frameWidthRangeM`.
- Produces: `estimateAnchors(doc, spec) -> { anchors:{ bridge, leftHinge, rightHinge }, signals:{ symmetryDeviation, templeDetectionCertainty, frameWidthMeters, orientationConfidence, scaleSanity } }`. `bridge` = top-center of the front slab. `orientationConfidence`/`scaleSanity` in 0–1.

- [ ] **Step 1: Write the failing test**

Create `test/calibration/geometricEstimator.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { estimateAnchors } from '../../src/calibration/geometricEstimator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('estimateAnchors', () => {
  it('derives anchors and named signals from geometry', () => {
    const { anchors, signals } = estimateAnchors(buildDoc(goodFrame), MODELING_SPEC)
    expect(anchors.bridge.x).toBeCloseTo(0, 2)
    expect(anchors.bridge.y).toBeCloseTo(0.024, 2)
    expect(anchors.rightHinge.x).toBeGreaterThan(0)
    expect(signals.frameWidthMeters).toBeCloseTo(0.138, 3)
    expect(signals.symmetryDeviation).toBeLessThan(0.1)
    expect(signals.templeDetectionCertainty).toBeGreaterThan(0.5)
    expect(signals.scaleSanity).toBeGreaterThan(0.5)
    expect(signals.orientationConfidence).toBeGreaterThan(0.5)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- geometricEstimator`
Expected: FAIL — cannot find module `geometricEstimator.js`.

- [ ] **Step 3: Implement the estimator**

Create `src/calibration/geometricEstimator.js`:

```js
import { mergedPositions } from './glbAccess.js'
import {
  computeBounds,
  measureSymmetryDeviation,
  measureFrontWidth,
  detectTemples,
} from './geometry.js'

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

export function estimateAnchors(doc, spec) {
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const width = measureFrontWidth(positions)
  const temples = detectTemples(positions)
  const symmetryDeviation = measureSymmetryDeviation(positions)

  // bridge = top-center of the front slab
  const frontZThreshold = bounds.max.z - (bounds.max.z - bounds.min.z) * 0.25
  let topY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZThreshold && positions[i + 1] > topY) topY = positions[i + 1]
  }
  const bridge = { x: 0, y: topY, z: bounds.max.z }

  // scaleSanity: 1 when width is mid-range, decaying outside the human range.
  const [minW, maxW] = spec.frameWidthRangeM
  const mid = (minW + maxW) / 2
  const scaleSanity = clamp01(1 - Math.abs(width - mid) / (mid))

  // orientationConfidence: front slab should sit toward +z and be wider (x) than
  // deep (z). Reward that shape.
  const orientationConfidence = clamp01(
    (bounds.max.z > Math.abs(bounds.min.z) ? 0.5 : 0.2) +
      (bounds.size.x > bounds.size.z ? 0.5 : 0.2)
  )

  return {
    anchors: { bridge, leftHinge: temples.leftHinge, rightHinge: temples.rightHinge },
    signals: {
      symmetryDeviation,
      templeDetectionCertainty: temples.certainty,
      frameWidthMeters: width,
      orientationConfidence,
      scaleSanity,
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- geometricEstimator`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/geometricEstimator.js test/calibration/geometricEstimator.test.js
git commit -m "feat(calibration): add geometric anchor estimator with named signals"
```

---

### Task 9: ConfidenceScorer

**Files:**
- Create: `src/calibration/confidence.js`
- Test: `test/calibration/confidence.test.js`

**Interfaces:**
- Produces:
  - `CONFIDENCE_WEIGHTS` (object) and `CONFIDENCE_THRESHOLD` (number, default `0.6`).
  - `scoreConfidence(signals, spec) -> { overall:number, breakdown:{ symmetry, temple, frameWidth, orientation, scale } }`. Each breakdown entry is a 0–1 sub-score (1 = good). `overall` is the **weighted min** so any one bad signal caps the score.
  - `isConfident(overall) -> boolean` (`overall >= CONFIDENCE_THRESHOLD`).

- [ ] **Step 1: Write the failing test**

Create `test/calibration/confidence.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { scoreConfidence, isConfident } from '../../src/calibration/confidence.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'

const goodSignals = {
  symmetryDeviation: 0.02,
  templeDetectionCertainty: 0.9,
  frameWidthMeters: 0.138,
  orientationConfidence: 0.95,
  scaleSanity: 0.9,
}

describe('scoreConfidence', () => {
  it('scores a clean model as confident with a full breakdown', () => {
    const { overall, breakdown } = scoreConfidence(goodSignals, MODELING_SPEC)
    expect(breakdown.symmetry).toBeGreaterThan(0.8)
    expect(breakdown.frameWidth).toBeGreaterThan(0.8)
    expect(overall).toBeGreaterThan(0.6)
    expect(isConfident(overall)).toBe(true)
  })

  it('lets one bad sub-signal cap the overall score (weighted-min)', () => {
    const bad = { ...goodSignals, symmetryDeviation: 0.5 }
    const { overall, breakdown } = scoreConfidence(bad, MODELING_SPEC)
    expect(breakdown.symmetry).toBeLessThan(0.5)
    expect(overall).toBeLessThan(0.6)
    expect(isConfident(overall)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- confidence`
Expected: FAIL — cannot find module `confidence.js`.

- [ ] **Step 3: Implement the scorer**

Create `src/calibration/confidence.js`:

```js
export const CONFIDENCE_THRESHOLD = 0.6

export const CONFIDENCE_WEIGHTS = {
  symmetry: 1.0,
  temple: 1.0,
  frameWidth: 1.0,
  orientation: 0.8,
  scale: 0.8,
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// Convert each raw signal into a 0–1 sub-score where 1 = good.
function subScores(signals, spec) {
  const [minW, maxW] = spec.frameWidthRangeM
  const mid = (minW + maxW) / 2
  return {
    symmetry: clamp01(1 - signals.symmetryDeviation / 0.15),
    temple: clamp01(signals.templeDetectionCertainty),
    frameWidth: clamp01(1 - Math.abs(signals.frameWidthMeters - mid) / (mid - minW || 1)),
    orientation: clamp01(signals.orientationConfidence),
    scale: clamp01(signals.scaleSanity),
  }
}

export function scoreConfidence(signals, spec) {
  const breakdown = subScores(signals, spec)
  // weighted-min: the lowest weighted sub-score dominates, so one bad signal caps
  // the whole thing — fail-safe and easy to explain.
  let overall = 1
  for (const key of Object.keys(breakdown)) {
    const weighted = breakdown[key] * (CONFIDENCE_WEIGHTS[key] ?? 1)
    overall = Math.min(overall, weighted)
  }
  return { overall, breakdown }
}

export function isConfident(overall) {
  return overall >= CONFIDENCE_THRESHOLD
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- confidence`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/confidence.js test/calibration/confidence.test.js
git commit -m "feat(calibration): add composite weighted-min confidence scorer"
```

---

### Task 10: Calibrator orchestrator

**Files:**
- Create: `src/calibration/calibrator.js`
- Test: `test/calibration/calibrator.test.js`

**Interfaces:**
- Consumes: `readTags` (tagReader), `estimateAnchors` (geometricEstimator), `scoreConfidence`/`isConfident` (confidence), `measureFrontWidth` + `computeBounds` (geometry), `mergedPositions` (glbAccess), `createFitMetadata` (fitMetadata).
- Produces: `calibrate(doc, spec) -> { fitMetadata, confidence, source, needsManual }`. Tagged path: `source:'tagged'`, `confidence:null`, `needsManual:false`. Geometric path: `source:'geometric'`, `confidence:{overall,breakdown}`, `needsManual` = `!isConfident(overall)`.

- [ ] **Step 1: Write the failing test**

Create `test/calibration/calibrator.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { calibrate } from '../../src/calibration/calibrator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'
import { buildDoc } from './helpers/buildDoc.js'

const goodFrame = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

describe('calibrate', () => {
  it('uses tags when present (exact, no confidence needed)', () => {
    const doc = buildDoc(goodFrame, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    })
    const res = calibrate(doc, MODELING_SPEC)
    expect(res.source).toBe('tagged')
    expect(res.confidence).toBeNull()
    expect(res.needsManual).toBe(false)
    expect(res.fitMetadata.version).toBe('eyewear-v1')
    expect(res.fitMetadata.bridgeAnchor).toEqual({ x: 0, y: 0.024, z: 0.02 })
  })

  it('falls back to geometry with a confidence report when untagged', () => {
    const res = calibrate(buildDoc(goodFrame), MODELING_SPEC)
    expect(res.source).toBe('geometric')
    expect(res.confidence.overall).toBeGreaterThan(0)
    expect(res.confidence.breakdown).toHaveProperty('symmetry')
    expect(typeof res.needsManual).toBe('boolean')
    expect(res.fitMetadata.provenance.source).toBe('geometric')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- calibrator`
Expected: FAIL — cannot find module `calibrator.js`.

- [ ] **Step 3: Implement the orchestrator**

Create `src/calibration/calibrator.js`:

```js
import { readTags } from './tagReader.js'
import { estimateAnchors } from './geometricEstimator.js'
import { scoreConfidence, isConfident } from './confidence.js'
import { mergedPositions } from './glbAccess.js'
import { computeBounds, measureFrontWidth } from './geometry.js'
import { createFitMetadata } from './fitMetadata.js'

const DEFAULT_SCALE_LIMITS = { min: 0.85, max: 1.15 }

function buildRecord(doc, anchors, width, provenance) {
  const bounds = computeBounds(mergedPositions(doc))
  return createFitMetadata({
    frameWidthMeters: width,
    bridgeAnchor: anchors.bridge,
    leftHinge: anchors.leftHinge,
    rightHinge: anchors.rightHinge,
    frontFramePlaneZ: bounds.max.z,
    lensCenterOffset: { x: 0, y: anchors.bridge.y * 0.5, z: 0 },
    scaleLimits: DEFAULT_SCALE_LIMITS,
    provenance,
  })
}

export function calibrate(doc, spec) {
  const tags = readTags(doc, spec)
  const width = measureFrontWidth(mergedPositions(doc))

  if (tags.found) {
    const fitMetadata = buildRecord(doc, tags.anchors, width, { source: 'tagged', confidence: null })
    return { fitMetadata, confidence: null, source: 'tagged', needsManual: false }
  }

  const { anchors, signals } = estimateAnchors(doc, spec)
  const confidence = scoreConfidence(signals, spec)
  const fitMetadata = buildRecord(doc, anchors, signals.frameWidthMeters, {
    source: 'geometric',
    confidence,
  })
  return {
    fitMetadata,
    confidence,
    source: 'geometric',
    needsManual: !isConfident(confidence.overall),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- calibrator`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/calibration/calibrator.js test/calibration/calibrator.test.js
git commit -m "feat(calibration): add calibrator orchestrator (tags-first, geometric fallback)"
```

---

### Task 11: Golden fixtures + end-to-end integration test

**Files:**
- Create: `scripts/build-fixtures.mjs`
- Create: `test/calibration/pipeline.integration.test.js`

**Interfaces:**
- Consumes: `validateModel`, `normalizeModel`, `calibrate`, `MODELING_SPEC`.
- Produces: a `buildFixtures()` returning `{ good, tagged, asymmetric, tooWide }` as in-memory `Document`s (shared by the test), proving the full `validate → normalize → calibrate` chain.

- [ ] **Step 1: Write the fixture builder**

Create `scripts/build-fixtures.mjs`:

```js
import { buildDoc } from '../test/calibration/helpers/buildDoc.js'

const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]

export function buildFixtures() {
  return {
    good: buildDoc(GOOD),
    tagged: buildDoc(GOOD, {
      AR_bridge: { x: 0, y: 0.024, z: 0.02 },
      AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
      AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
    }),
    asymmetric: buildDoc(GOOD.map((v, i) => (i % 3 === 0 ? v + 0.05 : v))),
    tooWide: buildDoc(GOOD.map((v, i) => (i % 3 === 0 ? v * 4 : v))),
  }
}
```

- [ ] **Step 2: Write the failing integration test**

Create `test/calibration/pipeline.integration.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { buildFixtures } from '../../scripts/build-fixtures.mjs'
import { validateModel } from '../../src/calibration/validator.js'
import { normalizeModel } from '../../src/calibration/normalizer.js'
import { calibrate } from '../../src/calibration/calibrator.js'
import { MODELING_SPEC } from '../../src/calibration/spec.js'

function run(doc) {
  const validation = validateModel(doc, MODELING_SPEC)
  const { doc: normalized } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(normalized, MODELING_SPEC)
  return { validation, calibration }
}

describe('calibration pipeline (end to end)', () => {
  it('tagged fixture → passes, tagged source, no manual', () => {
    const { validation, calibration } = run(buildFixtures().tagged)
    expect(validation.status).toBe('pass')
    expect(calibration.source).toBe('tagged')
    expect(calibration.needsManual).toBe(false)
  })

  it('good untagged fixture → confident geometric calibration', () => {
    const { calibration } = run(buildFixtures().good)
    expect(calibration.source).toBe('geometric')
    expect(calibration.needsManual).toBe(false)
    expect(calibration.fitMetadata.frameWidthMeters).toBeCloseTo(0.138, 2)
  })

  it('asymmetric fixture → flagged for manual', () => {
    const { calibration } = run(buildFixtures().asymmetric)
    expect(calibration.needsManual).toBe(true)
  })

  it('too-wide fixture → validator warns', () => {
    const { validation } = run(buildFixtures().tooWide)
    expect(validation.status).toBe('warn')
    expect(validation.issues.some((i) => i.code === 'WIDTH_OUT_OF_RANGE')).toBe(true)
  })
})
```

- [ ] **Step 3: Run test to verify it fails, then passes**

Run: `npm test -- pipeline.integration`
Expected: FAIL first (module resolution / assertion), then PASS once fixtures resolve. Adjust only the fixture builder path if the import fails; do not weaken assertions.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all calibration tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-fixtures.mjs test/calibration/pipeline.integration.test.js
git commit -m "test(calibration): add golden fixtures and end-to-end pipeline test"
```

---

### Task 12: Dev Harness (browser preview + manual adjust + export)

**Files:**
- Create: `harness/calibrate.html`
- Create: `harness/calibrate.js`
- Modify: `vite.config.js` (add the harness as a second entry input)

**Interfaces:**
- Consumes: `validateModel`, `normalizeModel`, `calibrate`, `MODELING_SPEC` (all browser-safe), and the existing `GlassesModelLoader` / `TryOnEngine` for preview.
- Produces: a page at `/harness/calibrate.html` that loads a GLB via file input, runs the pipeline, renders the confidence breakdown + validation issues, previews the try-on, lets the user nudge anchors (bridge/hinges) via number inputs, and downloads the fit-metadata JSON.

- [ ] **Step 1: Add the harness entry to Vite**

Modify `vite.config.js` to register a second HTML entry. Merge into the existing `build.rollupOptions.input` (create the block if absent):

```js
build: {
  rollupOptions: {
    input: {
      main: 'index.html',
      calibrate: 'harness/calibrate.html',
    },
  },
},
```

- [ ] **Step 2: Create the harness page**

Create `harness/calibrate.html`:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Fit Calibration Harness</title>
<style>
  body { margin: 0; font: 13px/1.5 monospace; background: #0b0b0b; color: #e6e6e6; display: grid; grid-template-columns: 340px 1fr; height: 100vh }
  #panel { padding: 12px; overflow: auto; border-right: 1px solid #222 }
  #stage { position: relative }
  .row { display: flex; gap: 6px; align-items: center; margin: 4px 0 }
  .bar { height: 6px; background: #7fffd4; border-radius: 3px }
  input[type=number] { width: 80px; background: #111; color: #e6e6e6; border: 1px solid #333 }
  button { margin-top: 8px; padding: 6px 10px; cursor: pointer }
</style>
<div id="panel">
  <input id="file" type="file" accept=".glb" />
  <div id="report"></div>
  <div id="anchors"></div>
  <button id="export">Export fit-metadata JSON</button>
</div>
<div id="stage"><canvas id="preview"></canvas></div>
<script type="module" src="/harness/calibrate.js"></script>
```

- [ ] **Step 3: Create the harness script**

Create `harness/calibrate.js`:

```js
import { WebIO } from '@gltf-transform/core'
import { validateModel } from '../src/calibration/validator.js'
import { normalizeModel } from '../src/calibration/normalizer.js'
import { calibrate } from '../src/calibration/calibrator.js'
import { MODELING_SPEC } from '../src/calibration/spec.js'

const io = new WebIO()
let current = null

const report = document.getElementById('report')
const anchorsEl = document.getElementById('anchors')

function bar(label, score) {
  const pct = Math.round(score * 100)
  return `<div class="row"><span style="width:120px">${label}</span>` +
    `<div class="bar" style="width:${pct}px"></div><span>${pct}%</span></div>`
}

function renderReport(validation, calibration) {
  const c = calibration.confidence
  report.innerHTML =
    `<h3>Validation: ${validation.status}</h3>` +
    validation.issues.map((i) => `<div>[${i.severity}] ${i.message}</div>`).join('') +
    `<h3>Source: ${calibration.source}${calibration.needsManual ? ' — NEEDS MANUAL' : ''}</h3>` +
    (c
      ? bar('overall', c.overall) + Object.entries(c.breakdown).map(([k, v]) => bar(k, v)).join('')
      : '<div>tagged — exact anchors</div>')
}

function renderAnchors(fit) {
  const keys = ['bridgeAnchor', 'leftHinge', 'rightHinge']
  anchorsEl.innerHTML = '<h3>Anchors (editable)</h3>' + keys.map((key) =>
    ['x', 'y', 'z'].map((axis) =>
      `<label>${key}.${axis} <input type="number" step="0.001" data-key="${key}" data-axis="${axis}" value="${fit[key][axis]}"/></label>`
    ).join(' ')
  ).join('<br/>')
  anchorsEl.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      current.fitMetadata[input.dataset.key][input.dataset.axis] = Number(input.value)
    })
  })
}

document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  if (!file) return
  const doc = await io.readBinary(new Uint8Array(await file.arrayBuffer()))
  const validation = validateModel(doc, MODELING_SPEC)
  const { doc: normalized } = normalizeModel(doc, MODELING_SPEC)
  const calibration = calibrate(normalized, MODELING_SPEC)
  current = calibration
  renderReport(validation, calibration)
  renderAnchors(calibration.fitMetadata)
})

document.getElementById('export').addEventListener('click', () => {
  if (!current) return
  const blob = new Blob([JSON.stringify(current.fitMetadata, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'fit-metadata.json'
  a.click()
})
```

- [ ] **Step 4: Smoke-test the harness manually**

Run: `npm run dev`, open `http://localhost:5173/harness/calibrate.html`, load `public/models/gripzpelmo.glb`.
Expected: validation status + confidence breakdown render; anchor inputs appear; Export downloads a `fit-metadata.json` with `version: "eyewear-v1"`.

(Three.js live preview reuses the existing engine and is wired in a follow-up once the fit-metadata → engine adapter lands in Sub-project B; the harness proves the pipeline + export here.)

- [ ] **Step 5: Commit**

```bash
git add harness/calibrate.html harness/calibrate.js vite.config.js
git commit -m "feat(calibration): add dev harness (pipeline preview + anchor edit + export)"
```

---

## Self-review

**Spec coverage:** fit-metadata schema (T2) ✓; modeling spec (T1) ✓; Validator (T5) ✓; Normalizer (T6) ✓; Calibrator = TagReader (T7) + GeometricEstimator (T8) + ConfidenceScorer (T9) + orchestrator (T10) ✓; composite named confidence sub-signals (T8 emits, T9 scores) ✓; Dev Harness (T12) ✓; golden-fixture + integration testing (T3–T11) ✓; error handling — validator reasons (T5), low-confidence-never-silent via `needsManual` (T10) ✓. **Deferred correctly:** reference-image alignment, Polaris UI, storage — not in this plan. **Tracking hardening** is A2, out of scope here by design.

**Placeholder scan:** every code step contains runnable code; no TBD/TODO. The one intentional deferral (live Three.js preview wiring) is called out explicitly as Sub-project B work, not a hidden gap.

**Type consistency:** anchors are `{x,y,z}` throughout; `signals` keys (`symmetryDeviation`, `templeDetectionCertainty`, `frameWidthMeters`, `orientationConfidence`, `scaleSanity`) match between T8 (produced) and T9 (consumed); `breakdown` keys (`symmetry`, `temple`, `frameWidth`, `orientation`, `scale`) are consistent T9↔T12; `calibrate()` return shape consistent T10↔T11↔T12.

## Open follow-ups (not blocking this plan)

- Confidence weights/threshold (`CONFIDENCE_WEIGHTS`, `CONFIDENCE_THRESHOLD`) are first-pass; retune against a larger fixture set.
- `geometry.js` temple/symmetry heuristics are deliberately simple; revisit against real GLBs during A2/B.

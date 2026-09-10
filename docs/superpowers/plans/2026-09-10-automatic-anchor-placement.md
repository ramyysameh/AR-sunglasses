# Automatic Eyewear Anchor Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `estimateAnchors` accurate enough that hand-authoring `AR_bridge` / `AR_hinge_L` / `AR_hinge_R` empties in Blender is no longer necessary — within 3 mm of hand placement on both reference models.

**Architecture:** The front frame is located by finding the **vertex-density cliff** at its rear edge (a 49x/15x collapse at -12 mm on both reference models) instead of assuming it occupies the front 25% of the model's Z range. Every anchor, plus frame width and symmetry, is then measured within that segmented band. When no cliff is found, each anchor independently falls back to a canonical proportion of frame width.

**Tech Stack:** JavaScript (ESM), `@gltf-transform/core` v4, vitest. Package: `packages/calibration` (`@artryon/calibration`), consumed by `apps/shopify-app/app/calibration.server.js`.

## Global Constraints

- **Worktree:** all work happens in `D:\AR Sunglasses\wt-auto-anchors` on branch `feature/auto-anchor-placement`. Never `cd` to the main checkout.
- **Do not deploy.** No `shopify app deploy`, no push to `origin`, no Vercel deploy. The user tests locally and may drop the branch entirely.
- **No Prisma schema change**, no `apps/shopify-app` source change, no admin UI change.
- **`AR_*` tags keep absolute precedence** — the tagged path in `calibrator.js` is not modified.
- **`provenance.source` keeps its current values** (`'tagged'` / `'geometric'`). `saveCalibratedModel` (`models.server.js`) and the admin's `sourceLabel` (`app.models.jsx`) both read it. New keys are added alongside it, never replacing it.
- **`CONFIDENCE_THRESHOLD` stays 0.6.**
- **Reference models** (not in the repo, read-only, never modified):
  - `D:\Downloads\Larsson_Sunglasses_AR.glb`
  - `D:\Downloads\GRIPZ_Sunglasses_anchored_widened.glb`
- **Acceptance bar:** every anchor within **3 mm** of the file's own `AR_*` tags on both reference models. No exemptions. (Larsson was re-exported 2026-09-10 03:27 with `AR_bridge` raised 6.85 mm, so it now follows the same bridge-centre rule as GRIPZ — 1.9 mm from its bridge-bar midpoint, against GRIPZ's 0.4 mm. If a future re-export moves a tag again, re-run Task 2 to re-establish the baseline before fitting anything.)
- Run tests with `npx vitest run --root packages/calibration` from the worktree root.
- Baseline at plan time: **37 tests, 11 files, all passing.**

---

### Task 1: Dense synthetic frame fixture

The existing fixtures are six-vertex point clouds. A density-cliff detector cannot be exercised on six vertices — there is no density to profile. This task adds a procedural generator with known ground truth.

**Files:**
- Create: `packages/calibration/test/helpers/buildFrame.js`
- Test: `packages/calibration/test/helpers/buildFrame.test.js`

**Interfaces:**
- Consumes: `buildDoc(positions, tags)` from `./buildDoc.js` (existing).
- Produces:
  - `buildFramePositions(options) -> Float32Array`
  - `buildFrameDoc(options) -> Document`
  - `FRAME_DEFAULTS` — the option defaults, so tests can compute expected anchor values without duplicating numbers.
  - Options: `{ frameWidth, frontDepth, frontHeight, bridgeHalfWidth, bridgeBarTop, bridgeBarBottom, hingeXRatio, hingeY, templeLength, bandSteps, templeSteps }`

- [ ] **Step 1: Write the failing test**

```javascript
// packages/calibration/test/helpers/buildFrame.test.js
import { describe, it, expect } from 'vitest'
import { buildFramePositions, FRAME_DEFAULTS } from './buildFrame.js'
import { computeBounds } from '../../src/geometry.js'

describe('buildFramePositions', () => {
  it('produces a dense front band and sparse temples with known bounds', () => {
    const pos = buildFramePositions()
    const { min, max } = computeBounds(pos)

    expect(pos.length / 3).toBeGreaterThan(2000)
    expect(max.z).toBeCloseTo(0, 6)
    expect(min.z).toBeCloseTo(-FRAME_DEFAULTS.templeLength, 6)
    expect(max.x).toBeCloseTo(FRAME_DEFAULTS.frameWidth / 2, 6)
    expect(max.y).toBeCloseTo(0, 6)
    expect(min.y).toBeCloseTo(-FRAME_DEFAULTS.frontHeight, 6)
  })

  it('is far denser in the front band than behind it', () => {
    const pos = buildFramePositions()
    let front = 0
    let behind = 0
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 2] >= -FRAME_DEFAULTS.frontDepth) front += 1
      else behind += 1
    }
    expect(front / behind).toBeGreaterThan(10)
  })

  it('has a bridge bar column whose vertical midpoint is known', () => {
    const pos = buildFramePositions()
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i]) <= FRAME_DEFAULTS.bridgeHalfWidth && pos[i + 2] >= -FRAME_DEFAULTS.frontDepth) {
        lo = Math.min(lo, pos[i + 1])
        hi = Math.max(hi, pos[i + 1])
      }
    }
    expect(hi).toBeCloseTo(-FRAME_DEFAULTS.bridgeBarTop, 6)
    expect(lo).toBeCloseTo(-FRAME_DEFAULTS.bridgeBarBottom, 6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/helpers/buildFrame.test.js`
Expected: FAIL — `Failed to resolve import "./buildFrame.js"`

- [ ] **Step 3: Write the generator**

```javascript
// packages/calibration/test/helpers/buildFrame.js
import { buildDoc } from './buildDoc.js'

// A procedural eyewear-shaped point cloud, dense enough to have a Z-density
// profile. Real frames are a dense front slab with two sparse arms trailing
// back; the cliff between the two is what segmentFrontFrame keys on.
export const FRAME_DEFAULTS = Object.freeze({
  frameWidth: 0.146,
  frontDepth: 0.012,
  frontHeight: 0.042,
  bridgeHalfWidth: 0.003,
  bridgeBarTop: 0.007,
  bridgeBarBottom: 0.017,
  hingeXRatio: 0.905,
  hingeY: -0.010,
  templeLength: 0.150,
  bandSteps: 12,
  templeSteps: 40,
})

export function buildFramePositions(options = {}) {
  const o = { ...FRAME_DEFAULTS, ...options }
  const half = o.frameWidth / 2
  const out = []
  const push = (x, y, z) => out.push(x, y, z)

  // Front band: a dense grid over X and Z. Two vertices per (x, z) column —
  // the top and bottom edges of the frame at that x. Inside the bridge column
  // those edges are the bridge bar instead of the lens opening.
  const X_STEPS = 80
  for (let zi = 0; zi <= o.bandSteps; zi += 1) {
    const z = -(o.frontDepth * zi) / o.bandSteps
    for (let xi = 0; xi <= X_STEPS; xi += 1) {
      const x = -half + (o.frameWidth * xi) / X_STEPS
      if (Math.abs(x) <= o.bridgeHalfWidth) {
        push(x, -o.bridgeBarTop, z)
        push(x, -o.bridgeBarBottom, z)
      } else {
        push(x, 0, z)
        push(x, -o.frontHeight, z)
      }
    }
  }

  // Temples: two sparse arms running rearward from the hinge, one vertex per
  // step per side — deliberately ~100x sparser than the band.
  const hingeX = half * o.hingeXRatio
  for (let ti = 1; ti <= o.templeSteps; ti += 1) {
    const z = -o.frontDepth - ((o.templeLength - o.frontDepth) * ti) / o.templeSteps
    push(-hingeX, o.hingeY, z)
    push(hingeX, o.hingeY, z)
  }

  return new Float32Array(out)
}

export function buildFrameDoc(options = {}, tags = {}) {
  return buildDoc(buildFramePositions(options), tags)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/calibration test/helpers/buildFrame.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/calibration/test/helpers/buildFrame.js packages/calibration/test/helpers/buildFrame.test.js
git commit -m "test(calibration): add dense procedural frame fixture

The six-vertex fixtures cannot exercise a density-based detector. This
generator emits a dense front band, a bridge bar column, and two sparse
temples, with anchor ground truth known by construction."
```

---

### Task 2: Anchor audit script

Build the measurement tool **before** changing any algorithm, so every later task can be checked against the real models rather than only against synthetic fixtures. On the current code it should reproduce the 17–32 mm errors recorded in the spec.

**Files:**
- Create: `scripts/anchor-audit.mjs`

**Interfaces:**
- Consumes: `@artryon/calibration` (`validateModel`, `normalizeModel`, `readTags`, `estimateAnchors`, `scoreConfidence`, `mergedPositions`, `computeBounds`, `measureFrontWidth`, `MODELING_SPEC`).
- Produces: a CLI. `node scripts/anchor-audit.mjs <file.glb> [...]` prints per-anchor Δ in millimetres against the file's own `AR_*` tags, and exits non-zero if any Δ exceeds the tolerance.

- [ ] **Step 1: Write the script**

```javascript
// scripts/anchor-audit.mjs
//
// Measures the geometric estimator against a GLB's own hand-placed AR_* tags.
// The reference models are too large to commit, so this is a local tool, not a
// CI test. It is how the estimator's constants are fitted and verified.
//
//   node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb"
//
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import {
  validateModel, normalizeModel, readTags, estimateAnchors, scoreConfidence,
  mergedPositions, computeBounds, measureFrontWidth, MODELING_SPEC,
} from '@artryon/calibration'

const TOLERANCE_MM = 3
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
const mm = (v) => (v * 1000).toFixed(1)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/anchor-audit.mjs <model.glb> [...]')
  process.exit(2)
}

let worst = 0

for (const file of files) {
  const doc = await io.read(file)
  const validation = validateModel(doc, MODELING_SPEC)
  const { transforms } = normalizeModel(doc, MODELING_SPEC)
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const tags = readTags(doc, MODELING_SPEC)
  const { anchors, signals } = estimateAnchors(doc, MODELING_SPEC)
  const confidence = scoreConfidence(signals, MODELING_SPEC)

  console.log(`\n=== ${file}`)
  console.log(`validation=${validation.status} transforms=[${transforms.join(', ')}]`)
  console.log(`frameWidth=${mm(measureFrontWidth(positions))}mm ` +
    `zRange=${mm(bounds.max.z - bounds.min.z)}mm`)
  console.log(`confidence=${confidence.overall.toFixed(3)} ` +
    Object.entries(confidence.breakdown).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '))

  if (!tags.found) {
    console.log('no AR_* tags — nothing to compare against')
    continue
  }

  for (const key of ['bridge', 'leftHinge', 'rightHinge']) {
    const hand = tags.anchors[key]
    const auto = anchors[key]
    const delta = dist(hand, auto)
    worst = Math.max(worst, delta)
    const flag = delta > TOLERANCE_MM ? ' <-- OVER' : ''
    console.log(
      `  ${key.padEnd(11)} hand(${mm(hand.x)}, ${mm(hand.y)}, ${mm(hand.z)}) ` +
      `auto(${mm(auto.x)}, ${mm(auto.y)}, ${mm(auto.z)}) ` +
      `delta=${delta.toFixed(1)}mm${flag}`
    )
  }
}

console.log(`\nworst delta: ${worst.toFixed(1)}mm (tolerance ${TOLERANCE_MM}mm)`)
process.exit(worst > TOLERANCE_MM ? 1 : 0)
```

- [ ] **Step 2: Run it against both reference models to capture the baseline**

```bash
node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

Expected: exits **1**. Larsson bridge ≈10.2 mm, hinges ≈29 mm; GRIPZ bridge ≈11.9 mm, hinges ≈32 mm; Larsson confidence 0.000. This failing baseline is the point of the task — record the printed output in the commit message.

- [ ] **Step 3: Commit**

```bash
git add scripts/anchor-audit.mjs
git commit -m "tools(calibration): add anchor audit script

Measures estimated anchors against a GLB's own AR_* tags. Records the
current baseline: 17-32mm error on both reference models, and confidence
0.000 on Larsson."
```

---

### Task 3: Front-frame segmentation

**Files:**
- Create: `packages/calibration/src/frontFrame.js`
- Create: `packages/calibration/test/frontFrame.test.js`
- Modify: `packages/calibration/src/index.js` (add one export line)

**Interfaces:**
- Consumes: `computeBounds` from `./geometry.js`.
- Produces: `segmentFrontFrame(positions) -> { frontZMin, frontZMax, halfWidth, sharpness }`
  - `frontZMax` — `bounds.max.z`.
  - `frontZMin` — Z of the rear edge of the dense band (always `<= frontZMax`).
  - `halfWidth` — max `abs(x)` among vertices with `z >= frontZMin`.
  - `sharpness` — `0` when no cliff was found, otherwise `density before / density after`, capped at 100.

- [ ] **Step 1: Write the failing test**

```javascript
// packages/calibration/test/frontFrame.test.js
import { describe, it, expect } from 'vitest'
import { segmentFrontFrame } from '../src/frontFrame.js'
import { buildFramePositions, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('segmentFrontFrame', () => {
  it('finds the rear edge of the dense front band', () => {
    const band = segmentFrontFrame(buildFramePositions())
    expect(band.frontZMax).toBeCloseTo(0, 4)
    expect(band.frontZMin).toBeGreaterThan(-FRAME_DEFAULTS.frontDepth - 0.002)
    expect(band.frontZMin).toBeLessThan(-FRAME_DEFAULTS.frontDepth + 0.002)
    expect(band.sharpness).toBeGreaterThan(10)
  })

  it('measures half-width from the band, excluding temple flare', () => {
    // Temples flare 20mm wider than the front frame; the band must ignore them.
    const flared = buildFramePositions({ hingeXRatio: 1.3 })
    const band = segmentFrontFrame(flared)
    expect(band.halfWidth).toBeCloseTo(FRAME_DEFAULTS.frameWidth / 2, 3)
  })

  it('falls back to a clamped proportional depth when there is no cliff', () => {
    // A uniformly dense block: no density collapse anywhere.
    const solid = []
    for (let zi = 0; zi <= 60; zi += 1) {
      for (let xi = 0; xi <= 60; xi += 1) {
        solid.push(-0.073 + (0.146 * xi) / 60, 0, -(0.15 * zi) / 60)
        solid.push(-0.073 + (0.146 * xi) / 60, -0.04, -(0.15 * zi) / 60)
      }
    }
    const band = segmentFrontFrame(new Float32Array(solid))
    expect(band.sharpness).toBe(0)
    expect(band.frontZMin).toBeLessThan(0)
    expect(band.frontZMin).toBeGreaterThanOrEqual(-0.025)
  })

  it('returns a degenerate band for empty input rather than throwing', () => {
    const band = segmentFrontFrame(new Float32Array([]))
    expect(Number.isFinite(band.frontZMin)).toBe(true)
    expect(Number.isFinite(band.halfWidth)).toBe(true)
    expect(band.sharpness).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/frontFrame.test.js`
Expected: FAIL — `Failed to resolve import "../src/frontFrame.js"`

- [ ] **Step 3: Write the implementation**

```javascript
// packages/calibration/src/frontFrame.js
import { computeBounds } from './geometry.js'

// Vertices are binned by Z at a fixed real-world resolution rather than as a
// fraction of the model's Z extent: the feature being detected (the rear edge
// of the frame front) sits at a fixed millimetre depth, so a fraction-of-extent
// bin would change size with temple length — the exact bug this replaces.
const BIN_METERS = 0.001
const MAX_BINS = 400
// A bin holding less than this share of the band's running median density is
// the cliff. The reference models collapse by 15x and 49x, so there is a wide
// margin; a tighter ratio would start firing on ordinary tessellation noise.
const CLIFF_RATIO = 0.25
// Require a few bins of band first, so a sparse leading edge (an antireflective
// coating shell, a decal plane sitting proud of the lens) cannot be mistaken
// for the whole front frame.
const MIN_BAND_BINS = 3
const MAX_SHARPNESS = 100

// No-cliff fallback: frames whose temples blend continuously into the front
// (rimless, heavy wraparound) have no density collapse to find.
const FALLBACK_DEPTH_RATIO = 0.09
const MIN_FALLBACK_DEPTH = 0.006
const MAX_FALLBACK_DEPTH = 0.025

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function halfWidthOfBand(positions, frontZMin) {
  let halfWidth = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZMin) {
      halfWidth = Math.max(halfWidth, Math.abs(positions[i]))
    }
  }
  return halfWidth
}

export function segmentFrontFrame(positions) {
  if (positions.length === 0) {
    return { frontZMin: 0, frontZMax: 0, halfWidth: 0, sharpness: 0 }
  }

  const bounds = computeBounds(positions)
  const zRange = bounds.max.z - bounds.min.z
  const frontZMax = bounds.max.z

  // A model with no measurable depth cannot be segmented; treat the whole thing
  // as the band rather than dividing by zero.
  if (!(zRange > 0)) {
    return {
      frontZMin: bounds.min.z,
      frontZMax,
      halfWidth: halfWidthOfBand(positions, bounds.min.z),
      sharpness: 0,
    }
  }

  const binCount = Math.min(MAX_BINS, Math.max(1, Math.ceil(zRange / BIN_METERS)))
  const binSize = zRange / binCount
  const counts = new Array(binCount).fill(0)
  for (let i = 0; i < positions.length; i += 3) {
    const depth = frontZMax - positions[i + 2]
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor(depth / binSize)))
    counts[bin] += 1
  }

  for (let bin = MIN_BAND_BINS; bin < binCount; bin += 1) {
    const bandMedian = median(counts.slice(0, bin))
    if (bandMedian <= 0) continue
    if (counts[bin] < CLIFF_RATIO * bandMedian) {
      const frontZMin = frontZMax - bin * binSize
      const sharpness = counts[bin] > 0
        ? Math.min(MAX_SHARPNESS, bandMedian / counts[bin])
        : MAX_SHARPNESS
      return { frontZMin, frontZMax, halfWidth: halfWidthOfBand(positions, frontZMin), sharpness }
    }
  }

  const fallbackDepth = clamp(
    FALLBACK_DEPTH_RATIO * bounds.size.x,
    MIN_FALLBACK_DEPTH,
    MAX_FALLBACK_DEPTH,
  )
  const frontZMin = Math.max(bounds.min.z, frontZMax - fallbackDepth)
  return { frontZMin, frontZMax, halfWidth: halfWidthOfBand(positions, frontZMin), sharpness: 0 }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/calibration test/frontFrame.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Export it**

Add to `packages/calibration/src/index.js`, after the `./geometry.js` line:

```javascript
export * from './frontFrame.js'
```

- [ ] **Step 6: Verify the whole suite is still green**

Run: `npx vitest run --root packages/calibration`
Expected: PASS — 41 tests (37 baseline + 4 new). Nothing else consumes `segmentFrontFrame` yet.

- [ ] **Step 7: Verify against the real models**

```bash
node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

Expected: unchanged from Task 2's baseline (still ~17–32 mm) — segmentation is not wired into the estimator yet. If the numbers moved, something was wired up by accident; stop and find it.

- [ ] **Step 8: Commit**

```bash
git add packages/calibration/src/frontFrame.js packages/calibration/test/frontFrame.test.js packages/calibration/src/index.js
git commit -m "feat(calibration): segment the front frame by vertex-density cliff

Bins vertices by Z at 1mm resolution and finds where density collapses,
which is the rear edge of the frame front. Fixed real-world bin size, not
a fraction of the model's Z extent -- the feature sits at a fixed depth,
so fraction-of-extent binning is what made the old front-slab estimate
scale with temple length."
```

---

### Task 4: Band-aware width and symmetry

**Files:**
- Modify: `packages/calibration/src/geometry.js` (`measureFrontWidth`, `measureSymmetryDeviation`)
- Modify: `packages/calibration/test/geometry.temples.test.js` (re-baseline)
- Test: `packages/calibration/test/geometry.band.test.js` (new)

**Interfaces:**
- Consumes: `segmentFrontFrame` from `./frontFrame.js`.
- Produces:
  - `measureFrontWidth(positions, band?) -> number` — `band` optional; segments internally when omitted. Backward compatible at the call site.
  - `measureSymmetryDeviation(positions, band?) -> number` — when a band is given (or segmented internally), only vertices with `z >= band.frontZMin` are considered.

**Note:** `geometry.js` imports from `frontFrame.js`, which imports `computeBounds` from `geometry.js`. This is a cycle. ESM handles it here because both are function-level references resolved at call time, not module-evaluation time — but keep `computeBounds` free of imports from `frontFrame.js` or it will break.

- [ ] **Step 1: Write the failing test**

```javascript
// packages/calibration/test/geometry.band.test.js
import { describe, it, expect } from 'vitest'
import { measureFrontWidth, measureSymmetryDeviation } from '../src/geometry.js'
import { segmentFrontFrame } from '../src/frontFrame.js'
import { buildFramePositions, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('measureFrontWidth (band-aware)', () => {
  it('ignores temple flare wider than the frame front', () => {
    const flared = buildFramePositions({ hingeXRatio: 1.3 })
    expect(measureFrontWidth(flared)).toBeCloseTo(FRAME_DEFAULTS.frameWidth, 3)
  })

  it('accepts a precomputed band without re-segmenting', () => {
    const pos = buildFramePositions()
    const band = segmentFrontFrame(pos)
    expect(measureFrontWidth(pos, band)).toBeCloseTo(measureFrontWidth(pos), 6)
  })
})

describe('measureSymmetryDeviation (band-aware)', () => {
  it('ignores asymmetry that lives behind the front band', () => {
    // One temple only: a large rear asymmetry that must not count.
    const pos = Array.from(buildFramePositions())
    const kept = []
    for (let i = 0; i < pos.length; i += 3) {
      const isRearRightTemple = pos[i + 2] < -FRAME_DEFAULTS.frontDepth && pos[i] > 0
      if (!isRearRightTemple) kept.push(pos[i], pos[i + 1], pos[i + 2])
    }
    const oneArmed = new Float32Array(kept)
    expect(measureSymmetryDeviation(oneArmed)).toBeLessThan(0.05)
  })

  it('still detects asymmetry inside the front band', () => {
    const pos = Array.from(buildFramePositions())
    const kept = []
    for (let i = 0; i < pos.length; i += 3) {
      const isFrontRightHalf = pos[i + 2] >= -FRAME_DEFAULTS.frontDepth && pos[i] > 0.02
      if (!isFrontRightHalf) kept.push(pos[i], pos[i + 1], pos[i + 2])
    }
    expect(measureSymmetryDeviation(new Float32Array(kept))).toBeGreaterThan(0.1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/geometry.band.test.js`
Expected: FAIL — `measureFrontWidth` returns the flared temple width (~0.19), and `measureSymmetryDeviation` counts the missing temple.

- [ ] **Step 3: Rewrite the two functions**

Replace `measureSymmetryDeviation` and `measureFrontWidth` in `packages/calibration/src/geometry.js` with:

```javascript
import { segmentFrontFrame } from './frontFrame.js'

// Voxel-occupancy mirror symmetry about the X=0 plane, measured on the FRONT
// BAND only. Measuring the whole model let rear-of-frame asymmetry dominate:
// a branding decal on one temple returned 0.155 on a well-authored reference
// model, which zeroed its confidence score.
export function measureSymmetryDeviation(positions, band = null) {
  const front = band ?? segmentFrontFrame(positions)
  const { size } = computeBounds(positions)
  const width = size.x || 1
  const voxel = Math.max(width / 32, 1e-9)
  const key = (x, y, z) =>
    `${Math.round(x / voxel)},${Math.round(y / voxel)},${Math.round(z / voxel)}`

  const occupied = new Set()
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < front.frontZMin) continue
    occupied.add(key(positions[i], positions[i + 1], positions[i + 2]))
  }

  let mismatched = 0
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < front.frontZMin) continue
    count += 1
    if (!occupied.has(key(-positions[i], positions[i + 1], positions[i + 2]))) {
      mismatched += 1
    }
  }
  return count ? mismatched / count : 0
}

// The frame front's X extent, measured within the segmented band. The band is
// found by density cliff rather than by taking the front 25% of the Z range --
// on a real frame the temples make that 25% about 39mm deep, which swallowed
// the temple flare and over-measured the width by up to 15mm.
export function measureFrontWidth(positions, band = null) {
  const front = band ?? segmentFrontFrame(positions)
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= front.frontZMin) {
      minX = Math.min(minX, positions[i])
      maxX = Math.max(maxX, positions[i])
    }
  }
  return maxX - minX === -Infinity ? 0 : maxX - minX
}
```

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run --root packages/calibration test/geometry.band.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Re-baseline the existing sparse-fixture tests**

Run: `npx vitest run --root packages/calibration`

`geometry.temples.test.js` asserts `measureFrontWidth(frame)` is `0.138` on a
seven-vertex fixture. With 1 mm binning that cloud has no meaningful density
profile, so the fallback path applies. **Do not weaken the new behaviour to
satisfy it** — port the assertion onto a dense fixture instead:

```javascript
// packages/calibration/test/geometry.temples.test.js — replace the
// measureFrontWidth describe block with this; leave the detectTemples blocks
// untouched (detectTemples still supplies the templeDetectionCertainty signal).
import { buildFramePositions, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('measureFrontWidth', () => {
  it('measures the front-frame X extent on a dense frame', () => {
    expect(measureFrontWidth(buildFramePositions())).toBeCloseTo(FRAME_DEFAULTS.frameWidth, 3)
  })
})
```

Then re-run and confirm every other file is still green. If `validator.test.js`
or `pipeline.integration.test.js` fail on a width assertion, they are hitting
the same sparse-fixture issue — port them to `buildFramePositions` the same way
rather than reverting the algorithm.

- [ ] **Step 6: Verify against the real models**

```bash
node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

Expected: `frameWidth` for GRIPZ drops from ~160.8 mm to ~146 mm, Larsson stays ~146 mm, and Larsson's `symmetry` sub-score rises off 0.00. Anchor deltas are still large — the estimator is rewritten in Task 6.

- [ ] **Step 7: Commit**

```bash
git add packages/calibration/src/geometry.js packages/calibration/test/geometry.band.test.js packages/calibration/test/geometry.temples.test.js
git commit -m "fix(calibration): measure width and symmetry on the segmented band

measureFrontWidth over-measured GRIPZ by 15mm by including temple flare,
and that value feeds frameWidthMeters -- the denominator of the runtime
fit scale. measureSymmetryDeviation counted rear branding asymmetry,
which zeroed confidence on a well-authored model."
```

---

### Task 5: Canonical anchor prior

**Files:**
- Create: `packages/calibration/src/anchorPrior.js`
- Create: `packages/calibration/test/anchorPrior.test.js`
- Modify: `packages/calibration/src/index.js` (add one export line)

**Interfaces:**
- Produces:
  - `canonicalAnchors(frameWidth, band) -> { bridge, leftHinge, rightHinge }` — all three as proportions of frame width, positioned relative to `band.frontZMax`.
  - `applyPrior(anchor, prior, frameWidth) -> { anchor, source }` — returns the detected anchor when it is inside the sanity window, otherwise the prior. `source` is `'detected'` or `'prior'`.
  - `SANITY_WINDOW_RATIO` — the window half-size as a fraction of frame width.

- [ ] **Step 1: Write the failing test**

```javascript
// packages/calibration/test/anchorPrior.test.js
import { describe, it, expect } from 'vitest'
import { canonicalAnchors, applyPrior } from '../src/anchorPrior.js'

const band = { frontZMin: -0.012, frontZMax: 0, halfWidth: 0.073, sharpness: 30 }

describe('canonicalAnchors', () => {
  it('places anatomically plausible anchors from frame width alone', () => {
    const a = canonicalAnchors(0.146, band)
    expect(a.bridge.x).toBe(0)
    expect(a.bridge.y).toBeLessThan(0)
    expect(a.bridge.y).toBeGreaterThan(-0.025)
    expect(a.bridge.z).toBeLessThan(band.frontZMax)
    expect(a.rightHinge.x).toBeGreaterThan(0.05)
    expect(a.rightHinge.x).toBeLessThan(0.073)
    expect(a.leftHinge.x).toBeCloseTo(-a.rightHinge.x, 6)
  })

  it('scales with frame width', () => {
    const small = canonicalAnchors(0.120, band)
    const large = canonicalAnchors(0.150, band)
    expect(large.rightHinge.x).toBeGreaterThan(small.rightHinge.x)
  })
})

describe('applyPrior', () => {
  it('keeps a detected anchor that is close to the prior', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    const detected = { x: 0.067, y: -0.011, z: -0.012 }
    const result = applyPrior(detected, prior, 0.146)
    expect(result.source).toBe('detected')
    expect(result.anchor).toBe(detected)
  })

  it('substitutes the prior when the detected anchor is implausible', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    const detected = { x: 0.066, y: -0.010, z: -0.090 }
    const result = applyPrior(detected, prior, 0.146)
    expect(result.source).toBe('prior')
    expect(result.anchor).toBe(prior)
  })

  it('substitutes the prior for a non-finite detected anchor', () => {
    const prior = { x: 0.066, y: -0.010, z: -0.012 }
    const result = applyPrior({ x: NaN, y: 0, z: 0 }, prior, 0.146)
    expect(result.source).toBe('prior')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/anchorPrior.test.js`
Expected: FAIL — `Failed to resolve import "../src/anchorPrior.js"`

- [ ] **Step 3: Write the implementation**

```javascript
// packages/calibration/src/anchorPrior.js
//
// Anchors expressed as proportions of frame width, for models whose geometry
// cannot be read confidently. A plausible placement derived from size alone
// beats a precise-looking placement derived from a misread mesh.
//
// Ratios are seeded from the two hand-tagged reference models (both ~146mm
// frames) and re-fitted in Task 6 against the audit script.

// Hinge X as a fraction of the band half-width: 0.912 on Larsson, 0.897 on GRIPZ.
export const HINGE_X_RATIO = 0.905
// Hinge Y below the frame top, as a fraction of frame width (-9.1mm, -10.6mm).
const HINGE_Y_RATIO = 0.067
// Bridge centre below the frame top, as a fraction of frame width (-11.4mm).
const BRIDGE_Y_RATIO = 0.078
// Both anchors sit a little behind the front face: 3.6mm and 3.7mm.
const BRIDGE_Z_INSET_RATIO = 0.025
// A detected anchor further than this from the prior is not believed.
export const SANITY_WINDOW_RATIO = 0.12

function finite(p) {
  return p != null && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
}

export function canonicalAnchors(frameWidth, band) {
  const hingeX = (band.halfWidth || frameWidth / 2) * HINGE_X_RATIO
  const hingeY = -HINGE_Y_RATIO * frameWidth
  return {
    bridge: {
      x: 0,
      y: -BRIDGE_Y_RATIO * frameWidth,
      z: band.frontZMax - BRIDGE_Z_INSET_RATIO * frameWidth,
    },
    leftHinge: { x: -hingeX, y: hingeY, z: band.frontZMin },
    rightHinge: { x: hingeX, y: hingeY, z: band.frontZMin },
  }
}

export function applyPrior(detected, prior, frameWidth) {
  if (!finite(detected)) {
    return { anchor: prior, source: 'prior' }
  }
  const limit = SANITY_WINDOW_RATIO * frameWidth
  const offset = Math.hypot(
    detected.x - prior.x,
    detected.y - prior.y,
    detected.z - prior.z,
  )
  return offset <= limit
    ? { anchor: detected, source: 'detected' }
    : { anchor: prior, source: 'prior' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/calibration test/anchorPrior.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Export it**

Add to `packages/calibration/src/index.js`:

```javascript
export * from './anchorPrior.js'
```

- [ ] **Step 6: Commit**

```bash
git add packages/calibration/src/anchorPrior.js packages/calibration/test/anchorPrior.test.js packages/calibration/src/index.js
git commit -m "feat(calibration): canonical anchor prior with per-anchor sanity gate

A plausible placement from frame width alone beats a precise-looking one
derived from a misread mesh. Applied per anchor, so a frame with a
readable bridge and a mushy hinge region keeps the good bridge."
```

---

### Task 6: Rewrite the estimator and fit the constants

The task that actually moves the numbers. It ends with the audit script passing at 3 mm.

**Files:**
- Modify: `packages/calibration/src/geometricEstimator.js`
- Modify: `packages/calibration/test/geometricEstimator.test.js` (re-baseline)
- Modify: `packages/calibration/src/anchorPrior.js` (constants only, if fitting requires it)

**Interfaces:**
- Consumes: `segmentFrontFrame`, `canonicalAnchors`, `applyPrior`, `HINGE_X_RATIO`, `measureFrontWidth`, `measureSymmetryDeviation`, `detectTemples`.
- Produces: `estimateAnchors(doc, spec) -> { anchors, signals, anchorSources }`
  - `anchors` — `{ bridge, leftHinge, rightHinge }`, unchanged shape.
  - `signals` — existing five keys plus `bandSharpness`.
  - `anchorSources` — `{ bridge, leftHinge, rightHinge }`, each `'detected'` or `'prior'`. **New third return key**; Task 7 and Task 8 consume it.

- [ ] **Step 1: Write the failing test**

```javascript
// packages/calibration/test/geometricEstimator.test.js — replace the file
import { describe, it, expect } from 'vitest'
import { estimateAnchors } from '../src/geometricEstimator.js'
import { MODELING_SPEC } from '../src/spec.js'
import { buildDoc } from './helpers/buildDoc.js'
import { buildFrameDoc, FRAME_DEFAULTS } from './helpers/buildFrame.js'

describe('estimateAnchors', () => {
  it('places the bridge at the vertical centre of the bridge bar', () => {
    const { anchors } = estimateAnchors(buildFrameDoc(), MODELING_SPEC)
    const expectedY = -(FRAME_DEFAULTS.bridgeBarTop + FRAME_DEFAULTS.bridgeBarBottom) / 2
    expect(anchors.bridge.x).toBeCloseTo(0, 3)
    expect(anchors.bridge.y).toBeCloseTo(expectedY, 3)
    expect(anchors.bridge.z).toBeLessThan(0)
  })

  it('places hinges at the rear edge of the front band, not the temple tips', () => {
    const { anchors } = estimateAnchors(buildFrameDoc(), MODELING_SPEC)
    expect(anchors.rightHinge.z).toBeGreaterThan(-FRAME_DEFAULTS.frontDepth - 0.003)
    expect(anchors.rightHinge.z).toBeLessThan(0)
    expect(anchors.rightHinge.x).toBeGreaterThan(0)
    expect(anchors.leftHinge.x).toBeCloseTo(-anchors.rightHinge.x, 3)
    // Nowhere near the -150mm temple tips the old estimator drifted toward.
    expect(anchors.rightHinge.z).toBeGreaterThan(-0.05)
  })

  it('reports band sharpness and per-anchor sources', () => {
    const { signals, anchorSources } = estimateAnchors(buildFrameDoc(), MODELING_SPEC)
    expect(signals.bandSharpness).toBeGreaterThan(10)
    expect(anchorSources.bridge).toBe('detected')
    expect(anchorSources.leftHinge).toBe('detected')
    expect(anchorSources.rightHinge).toBe('detected')
  })

  it('falls back to the prior when the bridge column is missing', () => {
    // No bridge bar: a rimless-style front with nothing at x ~ 0.
    const pos = Array.from(buildFrameDoc().getRoot().listMeshes()[0]
      .listPrimitives()[0].getAttribute('POSITION').getArray())
    const kept = []
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(pos[i]) > 0.02) kept.push(pos[i], pos[i + 1], pos[i + 2])
    }
    const { anchorSources, anchors } = estimateAnchors(
      buildDoc(new Float32Array(kept)), MODELING_SPEC,
    )
    expect(anchorSources.bridge).toBe('prior')
    expect(Number.isFinite(anchors.bridge.y)).toBe(true)
  })

  it('scores orientation low for a mis-oriented (taller-than-wide) model', () => {
    const misOriented = new Float32Array([
      -0.02, -0.069, 0.02, 0.02, -0.069, 0.02, 0, 0.069, 0.02,
      -0.02, -0.069, -0.13, 0.02, 0.069, -0.13,
    ])
    const { signals } = estimateAnchors(buildDoc(misOriented), MODELING_SPEC)
    expect(signals.orientationConfidence).toBeLessThan(0.6)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/geometricEstimator.test.js`
Expected: FAIL — bridge `y` comes back as the top of the front slab (0), hinges come back near the temple tips, and `signals.bandSharpness` / `anchorSources` are `undefined`.

- [ ] **Step 3: Rewrite the estimator**

Replace `packages/calibration/src/geometricEstimator.js` with:

```javascript
import { mergedPositions } from './glbAccess.js'
import {
  computeBounds,
  measureSymmetryDeviation,
  measureFrontWidth,
  detectTemples,
} from './geometry.js'
import { segmentFrontFrame } from './frontFrame.js'
import { canonicalAnchors, applyPrior, HINGE_X_RATIO } from './anchorPrior.js'

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// The bridge column: the narrow strip of front-band geometry at x ~ 0, whose
// vertical midpoint is the anchor. 2% of frame width is ~3mm on a 146mm frame,
// wide enough to catch a real bridge bar and narrow enough to exclude the lens.
const BRIDGE_COLUMN_RATIO = 0.02

// Vertical extent of the front band within a slab around the hinge X, used for
// the hinge Y. Half-width of that slab, as a fraction of frame width.
const HINGE_COLUMN_RATIO = 0.03

function verticalExtentOf(positions, band, xCentre, xHalfSpan) {
  let lo = Infinity
  let hi = -Infinity
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < band.frontZMin) continue
    if (Math.abs(positions[i] - xCentre) > xHalfSpan) continue
    count += 1
    lo = Math.min(lo, positions[i + 1])
    hi = Math.max(hi, positions[i + 1])
  }
  return count > 0 ? { lo, hi, midpoint: (lo + hi) / 2, count } : null
}

// Rear face of the bridge column: how far behind the front plane the bridge
// bar actually ends. Falls back to the prior's inset when unmeasurable.
function bridgeDepthOf(positions, band, xHalfSpan) {
  let rearZ = Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] < band.frontZMin) continue
    if (Math.abs(positions[i]) > xHalfSpan) continue
    rearZ = Math.min(rearZ, positions[i + 2])
  }
  return Number.isFinite(rearZ) ? rearZ : null
}

export function estimateAnchors(doc, spec) {
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const band = segmentFrontFrame(positions)
  const width = measureFrontWidth(positions, band)
  const temples = detectTemples(positions)
  const symmetryDeviation = measureSymmetryDeviation(positions, band)

  const prior = canonicalAnchors(width, band)

  // Bridge: vertical centre of the bridge-bar column at x ~ 0. The two hand
  // placements disagreed on height by 5mm; the centre rule is the chosen
  // target (it predicts the GRIPZ anchor to 0.4mm).
  const bridgeHalfSpan = BRIDGE_COLUMN_RATIO * width
  const bridgeColumn = verticalExtentOf(positions, band, 0, bridgeHalfSpan)
  const bridgeRearZ = bridgeDepthOf(positions, band, bridgeHalfSpan)
  const detectedBridge = bridgeColumn
    ? {
        x: 0,
        y: bridgeColumn.midpoint,
        z: bridgeRearZ ?? prior.bridge.z,
      }
    : null

  // Hinges: at the rear edge of the front band, inset from the band's outer
  // edge. Depth comes from the density cliff; X from the fitted ratio.
  const hingeX = band.halfWidth * HINGE_X_RATIO
  const hingeHalfSpan = HINGE_COLUMN_RATIO * width
  const rightColumn = verticalExtentOf(positions, band, hingeX, hingeHalfSpan)
  const leftColumn = verticalExtentOf(positions, band, -hingeX, hingeHalfSpan)
  const detectedRight = rightColumn
    ? { x: hingeX, y: rightColumn.midpoint, z: band.frontZMin }
    : null
  const detectedLeft = leftColumn
    ? { x: -hingeX, y: leftColumn.midpoint, z: band.frontZMin }
    : null

  const bridge = applyPrior(detectedBridge, prior.bridge, width)
  const rightHinge = applyPrior(detectedRight, prior.rightHinge, width)
  const leftHinge = applyPrior(detectedLeft, prior.leftHinge, width)

  // scaleSanity: 1 when width is mid-range, decaying outside the human range.
  const [minW, maxW] = spec.frameWidthRangeM
  const mid = (minW + maxW) / 2
  const scaleSanity = clamp01(1 - Math.abs(width - mid) / mid)

  // Eyewear canonical orientation: wider in X than tall in Y, with the widest
  // X-span at the front. A model rotated onto the wrong axis scores low.
  const widerThanTall = bounds.size.x > bounds.size.y ? 0.5 : 0
  const frontIsWidest = width >= bounds.size.x * 0.9 ? 0.5 : 0.2
  const orientationConfidence = clamp01(widerThanTall + frontIsWidest)

  return {
    anchors: {
      bridge: bridge.anchor,
      leftHinge: leftHinge.anchor,
      rightHinge: rightHinge.anchor,
    },
    anchorSources: {
      bridge: bridge.source,
      leftHinge: leftHinge.source,
      rightHinge: rightHinge.source,
    },
    signals: {
      symmetryDeviation,
      templeDetectionCertainty: temples.certainty,
      frameWidthMeters: width,
      orientationConfidence,
      scaleSanity,
      bandSharpness: band.sharpness,
    },
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --root packages/calibration test/geometricEstimator.test.js`
Expected: PASS (5 tests)

- [ ] **Step 5: Fit the constants against the reference models**

```bash
node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

**First, settle the hinge-Y rule — it is the one constant never measured
during design.** The hand values are -9.1 mm (Larsson) and -10.6 mm (GRIPZ),
but the frame's vertical extent *at the hinge column* was never profiled, so
`verticalExtentOf(...).midpoint` is an assumption, not a finding. Measure it
before fitting anything else:

```bash
node -e "
const { NodeIO } = require('@gltf-transform/core');
const { KHRONOS_EXTENSIONS } = require('@gltf-transform/extensions');
const C = require('@artryon/calibration');
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
(async () => {
  for (const f of process.argv.slice(1)) {
    const doc = await io.read(f);
    C.normalizeModel(doc, C.MODELING_SPEC);
    const pos = C.mergedPositions(doc);
    const band = C.segmentFrontFrame(pos);
    const hand = C.readTags(doc, C.MODELING_SPEC).anchors.rightHinge;
    const hx = band.halfWidth * 0.905, span = 0.03 * 0.146;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i+2] >= band.frontZMin && Math.abs(pos[i] - hx) <= span) {
        lo = Math.min(lo, pos[i+1]); hi = Math.max(hi, pos[i+1]);
      }
    }
    console.log(f.split(/[\\\\/]/).pop(),
      'column y:', (hi*1000).toFixed(1), '..', (lo*1000).toFixed(1),
      '| midpoint', ((hi+lo)/2*1000).toFixed(1),
      '| hand', (hand.y*1000).toFixed(1));
  }
})();
" "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

If `midpoint` lands within ~3 mm of `hand` on both, keep it. If the hand
values sit consistently near the **top** of the column instead, change
`verticalExtentOf`'s consumer for hinges to `hi - HINGE_Y_INSET_RATIO * width`
and fit that ratio — hinges attach high on a real frame, so this is the likely
outcome. Update the Task 5 `HINGE_Y_RATIO` comment to match whichever rule wins.

Then read the per-axis deltas and adjust **only** the named ratios in
`anchorPrior.js` (`HINGE_X_RATIO`, `HINGE_Y_RATIO`, `BRIDGE_Y_RATIO`,
`BRIDGE_Z_INSET_RATIO`) and `HINGE_COLUMN_RATIO` / `BRIDGE_COLUMN_RATIO` in the
estimator. Re-run after each change. Rules while fitting:

- Do **not** special-case either model by name, by vertex count, or by any
  property that identifies it. Two samples over-fit easily; a constant that
  cannot be justified as a property of eyewear in general does not belong.
- Both models now follow the bridge-centre rule, so fit the bridge to both.
  Their bridge-bar midpoints sit 1.9 mm and 0.4 mm from the hand anchors, which
  is the irreducible floor for a pure centre rule — do not chase it below that
  with a fudge term.
- If a delta cannot be closed by a ratio, the detector is wrong, not the
  constant. Stop and re-read the geometry rather than adding a fudge term.

Target: worst delta ≤3 mm, script exits 0.

- [ ] **Step 6: Run the whole suite and re-baseline what breaks**

Run: `npx vitest run --root packages/calibration`

`calibrator.test.js` and `pipeline.integration.test.js` assert on anchors from
the six-vertex fixtures and will likely need porting to `buildFrameDoc()`.
Re-baseline them deliberately — confirm each new expected value is *correct*,
not merely *current*.

- [ ] **Step 7: Commit**

```bash
git add packages/calibration/src/geometricEstimator.js packages/calibration/src/anchorPrior.js packages/calibration/test/
git commit -m "feat(calibration): derive anchors from the segmented front band

Bridge at the vertical centre of the bridge-bar column; hinges at the
density cliff, inset from the band's outer edge. Each anchor falls back
to the canonical prior independently when its column is unreadable.

Anchor error against the two hand-tagged reference models drops from
17-32mm to under 3mm."
```

---

### Task 7: Confidence aggregation

**Files:**
- Modify: `packages/calibration/src/confidence.js`
- Modify: `packages/calibration/test/confidence.test.js` (re-baseline — one existing test asserts the behaviour being removed)

**Interfaces:**
- Consumes: `signals.bandSharpness` from Task 6.
- Produces: `scoreConfidence(signals, spec) -> { overall, breakdown }` — `breakdown` gains a `sharpness` key; `overall` becomes `min(weightedMean, orientationScore)`.

- [ ] **Step 1: Write the failing test**

```javascript
// packages/calibration/test/confidence.test.js — replace the file
import { describe, it, expect } from 'vitest'
import { scoreConfidence, isConfident } from '../src/confidence.js'
import { MODELING_SPEC } from '../src/spec.js'

const goodSignals = {
  symmetryDeviation: 0.02,
  templeDetectionCertainty: 0.9,
  frameWidthMeters: 0.145,
  orientationConfidence: 0.95,
  scaleSanity: 0.9,
  bandSharpness: 30,
}

describe('scoreConfidence', () => {
  it('scores a clean model as confident with a full breakdown', () => {
    const { overall, breakdown } = scoreConfidence(goodSignals, MODELING_SPEC)
    expect(breakdown.symmetry).toBeGreaterThan(0.8)
    expect(breakdown.frameWidth).toBeGreaterThan(0.9)
    expect(breakdown.sharpness).toBeGreaterThan(0.8)
    expect(overall).toBeGreaterThan(0.6)
    expect(isConfident(overall)).toBe(true)
  })

  it('does NOT let branding asymmetry alone fail a model', () => {
    // Larsson's decals produced symmetryDeviation 0.155 and, under the old
    // weighted-min, an overall score of exactly 0.000.
    const decals = { ...goodSignals, symmetryDeviation: 0.155 }
    const { overall } = scoreConfidence(decals, MODELING_SPEC)
    expect(overall).toBeGreaterThan(0.6)
    expect(isConfident(overall)).toBe(true)
  })

  it('lets a mis-oriented model veto the score outright', () => {
    const rotated = { ...goodSignals, orientationConfidence: 0.2 }
    const { overall } = scoreConfidence(rotated, MODELING_SPEC)
    expect(overall).toBeLessThanOrEqual(0.2)
    expect(isConfident(overall)).toBe(false)
  })

  it('drags the score down when the front band could not be found', () => {
    const noBand = { ...goodSignals, bandSharpness: 0 }
    const { breakdown, overall } = scoreConfidence(noBand, MODELING_SPEC)
    expect(breakdown.sharpness).toBe(0)
    expect(overall).toBeLessThan(scoreConfidence(goodSignals, MODELING_SPEC).overall)
  })

  it('stays finite for a degenerate frame-width range (minW === maxW)', () => {
    const spec = { frameWidthRangeM: [0.13, 0.13] }
    const { breakdown, overall } = scoreConfidence(
      { ...goodSignals, frameWidthMeters: 0.13 }, spec,
    )
    expect(Number.isFinite(breakdown.frameWidth)).toBe(true)
    expect(Number.isFinite(overall)).toBe(true)
  })

  it('treats a missing bandSharpness signal as unmeasured, not as zero-confidence', () => {
    const { overall } = scoreConfidence({ ...goodSignals, bandSharpness: undefined }, MODELING_SPEC)
    expect(Number.isFinite(overall)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/confidence.test.js`
Expected: FAIL — the decal case returns 0.000 under weighted-min, and `breakdown.sharpness` is `undefined`.

- [ ] **Step 3: Rewrite the aggregation**

Replace `scoreConfidence` and `subScores` in `packages/calibration/src/confidence.js`:

```javascript
export const CONFIDENCE_THRESHOLD = 0.6

export const CONFIDENCE_WEIGHTS = {
  symmetry: 1.0,
  temple: 1.0,
  frameWidth: 1.0,
  orientation: 0.8,
  scale: 0.8,
  sharpness: 1.0,
}

// A band sharper than this is as good as it gets; the reference models sit at
// 15x and 49x, so this saturates for any normally-authored frame.
const SHARPNESS_SATURATION = 12

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// Convert each raw signal into a 0-1 sub-score where 1 = good.
function subScores(signals, spec) {
  const [minW, maxW] = spec.frameWidthRangeM
  const sharpness = Number.isFinite(signals.bandSharpness)
    ? clamp01(signals.bandSharpness / SHARPNESS_SATURATION)
    : 1
  return {
    symmetry: clamp01(1 - signals.symmetryDeviation / 0.15),
    temple: clamp01(signals.templeDetectionCertainty),
    frameWidth: clamp01(1 - Math.max(0, minW - signals.frameWidthMeters, signals.frameWidthMeters - maxW) / ((maxW - minW) || 1)),
    orientation: clamp01(signals.orientationConfidence),
    scale: clamp01(signals.scaleSanity),
    sharpness,
  }
}

export function scoreConfidence(signals, spec) {
  const breakdown = subScores(signals, spec)

  // Weighted MEAN, not weighted min. Under the old min, any single weak signal
  // zeroed the score -- and branding decals reliably produce a weak symmetry
  // signal on perfectly good models, so it fired constantly.
  let weighted = 0
  let totalWeight = 0
  for (const key of Object.keys(breakdown)) {
    const weight = CONFIDENCE_WEIGHTS[key] ?? 1
    weighted += breakdown[key] * weight
    totalWeight += weight
  }
  const mean = totalWeight > 0 ? weighted / totalWeight : 0

  // Orientation keeps veto power: a model rotated onto the wrong axis
  // invalidates every other measurement, so no average should rescue it.
  const overall = Math.min(mean, breakdown.orientation)
  return { overall, breakdown }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/calibration test/confidence.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Verify against the real models**

```bash
node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

Expected: Larsson's confidence is well clear of 0.6 (it was 0.000), GRIPZ's too, and both still pass the 3 mm anchor bar.

- [ ] **Step 6: Commit**

```bash
git add packages/calibration/src/confidence.js packages/calibration/test/confidence.test.js
git commit -m "fix(calibration): weighted-mean confidence with an orientation veto

Weighted-min let one weak signal zero the score. Branding decals reliably
weaken the symmetry signal, so a well-authored reference model scored
0.000 and was badged 'Needs review'. Orientation keeps veto power because
a wrong-axis model invalidates every other measurement."
```

---

### Task 8: Per-anchor provenance and full verification

**Files:**
- Modify: `packages/calibration/src/calibrator.js`
- Modify: `packages/calibration/test/calibrator.test.js`

**Interfaces:**
- Consumes: `anchorSources` from Task 6's `estimateAnchors`.
- Produces: `fitMetadata.provenance` gains `anchorSources` on the geometric path. `provenance.source` and `provenance.confidence` keep their existing meanings and values.

- [ ] **Step 1: Write the failing test**

Add to `packages/calibration/test/calibrator.test.js`:

```javascript
import { buildFrameDoc } from './helpers/buildFrame.js'

describe('calibrate provenance', () => {
  it('records per-anchor sources on the geometric path', () => {
    const result = calibrate(buildFrameDoc(), MODELING_SPEC)
    expect(result.fitMetadata.provenance.source).toBe('geometric')
    expect(result.fitMetadata.provenance.anchorSources.bridge).toBe('detected')
    expect(result.fitMetadata.provenance.anchorSources.leftHinge).toBe('detected')
  })

  it('leaves the tagged path untouched', () => {
    const tagged = buildFrameDoc({}, {
      AR_bridge: { x: 0, y: -0.012, z: -0.004 },
      AR_hinge_L: { x: -0.066, y: -0.010, z: -0.012 },
      AR_hinge_R: { x: 0.066, y: -0.010, z: -0.012 },
    })
    const result = calibrate(tagged, MODELING_SPEC)
    expect(result.source).toBe('tagged')
    expect(result.confidence).toBe(null)
    expect(result.needsManual).toBe(false)
    expect(result.fitMetadata.provenance.anchorSources).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root packages/calibration test/calibrator.test.js`
Expected: FAIL — `provenance.anchorSources` is `undefined` on the geometric path.

- [ ] **Step 3: Thread `anchorSources` through**

In `packages/calibration/src/calibrator.js`, change the geometric branch of
`calibrate` only. The tagged branch above it is not touched.

```javascript
  const { anchors, signals, anchorSources } = estimateAnchors(doc, spec)
  const confidence = scoreConfidence(signals, spec)
  const fitMetadata = buildRecord(doc, anchors, signals.frameWidthMeters, {
    source: 'geometric',
    confidence,
    anchorSources,
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root packages/calibration test/calibrator.test.js`
Expected: PASS

- [ ] **Step 5: Full suite green**

Run: `npx vitest run --root packages/calibration`
Expected: every file passes. Compare the count against the 37-test baseline and
account for the difference — new tests added, none silently deleted.

- [ ] **Step 6: Confirm the app-side pipeline still works end to end**

Run: `npx vitest run --root apps/shopify-app`
Expected: PASS. `calibration.server.test.js`, `finalizeUpload.server.test.js`,
`models.server.test.js`, and `registerModelByUrl.server.test.js` all drive
`calibrateUpload`. If one fails on an anchor value, port its fixture to
`buildFrameDoc` rather than reverting behaviour.

- [ ] **Step 7: Final acceptance run**

```bash
node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb" "D:/Downloads/GRIPZ_Sunglasses_anchored_widened.glb"
```

Expected: exit code **0**, worst delta ≤3 mm, both models confident.

- [ ] **Step 8: Commit**

```bash
git add packages/calibration/src/calibrator.js packages/calibration/test/calibrator.test.js
git commit -m "feat(calibration): record per-anchor provenance

Says which anchors were measured and which fell back to the canonical
prior, so a low-confidence model is diagnosable after upload. The tagged
path is unchanged."
```

---

## Handover for on-face testing

The branch is **not deployed and not pushed**. To evaluate it, re-upload a model
through the admin against a local build and compare on-face against the
currently-mapped copy.

Two things to look for beyond anchor accuracy:

1. **Size.** `frameWidthMeters` for GRIPZ drops ~160.8 mm to ~146 mm, so a
   newly-uploaded model renders roughly **10% larger** than the same file does
   today, before any `gscale` adjustment.
2. **Rotation behaviour.** The bridge anchor is the rotation pivot. The frame
   should stay glued to the nose through pitch and yaw rather than sliding —
   that, more than the head-on view, is what the bridge fix buys.

If the on-face result is worse, drop the branch:

```bash
git worktree remove "D:/AR Sunglasses/wt-auto-anchors"
git branch -D feature/auto-anchor-placement
```

`main` is untouched either way.

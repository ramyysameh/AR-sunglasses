# Temple Fit and Occluder Angles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the temples sit tight against the head and end behind the ear on every frame, make the occluder behave the same on pitch as it does on yaw, and make all of that a property of the engine rather than of the particular model that happens to be loaded.

**Architecture:** Three independent root causes, fixed in dependency order. (1) The head half-width that drives the splay solve is found by taking the widest shell *vertex* within an 8 mm slab; the shell is built from a few sparse rings, so that number jumps around by ±5 mm with height and the **same head measures 72.5 / 84.9 / 94.4 mm depending only on which model is loaded** — replaced with a ray cast against the shell's *triangles*, which is continuous in height. (2) The splay target is multiplicative (`headHalf × 1.16`), which both amplifies that error and makes the skin gap scale with head size — replaced with an absolute clearance, corrected for the shell's own lateral inflation. (3) On pitch the shell removes 20–24 mm from Larsson's rear temple while removing nothing at any yaw; that one gets diagnosed before it gets fixed.

**Tech Stack:** Three.js r160+, MediaPipe FaceLandmarker, Vite, Vitest. No new dependencies.

## Global Constraints

- **Do not modify the merchant's temple geometry.** Articulation — splay, curl, the two-piece cut — is allowed. Per-vertex deformation of supplied meshes is not.
- World units are **≈ 1.16 × metres** in this engine. Every constant in world units; convert for human-readable reporting only (`mm = world * 1000 / 1.16`).
- Test runner is Vitest: `npm test`. All 156 existing tests must still pass at every commit.
- Harness: `npm run harness` serves http://localhost:5175. Probe URL shape:
  `http://localhost:5175/?probe=1&mock=turn&mockframes=25&shop=dev.myshopify.com&model=/models/_m-gripz.glb`
  The `shop` parameter is **required** — without it `buildRegisterModelUrl` throws and the engine silently falls back to the default model.
- The three fixtures are `public/models/_m-gripz.glb`, `_m-larsson.glb`, `_m-willow.glb`. They are untracked scratch copies: **never commit them.**
- **Discard the first probe sweep after every page load.** The fit keeps converging for several seconds after the scan locks; the first pass reads worse than steady state.
- `earGapRatio` drifts by up to **0.06 between sweeps** at the same pose. Any comparison finer than that must use a paired A/B/A at a single pinned frame, not two sweeps. `occluderAteWorld` and `hiddenPct` are far steadier and are the preferred signals.
- `_openTemples` only runs while `|yaw| ≤ 12°` (`SPLAY_MEASURE_YAW_DEG`). A page loaded with `&mockframe=` pinned to a turned frame may never solve splay at all — every measurement of splay must be taken from an unpinned load, then pinned with `window.__mock.pin(n)`.

---

## Measured Baseline

Recorded 2026-09-13 at build `1e870fa`, one mock head, from an unpinned load after the scan settled. Every later task is judged against these.

| Frame | head half-width measured | armLateral | jointDepth | splay solved | occluder `ate` on yaw | occluder `ate` on pitch |
|---|---|---|---|---|---|---|
| Gripz | 72.5 mm | 66.5 mm | 107.0 mm | 9.0° | 7–17 mm | 9–20 mm |
| Larsson | 84.9 mm | 68.9 mm | 105.6 mm | 16.6° | 0 mm at every turned pose | **20–24 mm** |
| Willow | 94.4 mm | 64.9 mm | 115.4 mm | 22.6–24.8° | 0 mm at every turned pose | 0 mm |

The head is the same in all three rows. The shell's half-width sampled every 9 mm of height reads
`80.2, 75.0, 80.3, 73.8, 80.6, 70.9, 81.1, 81.1, 79.5, 76.4, 68.7, 57.6` — the alternation is ring
quantisation, not anatomy.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/occlusion/headWidth.js` *(new)* | Ray-cast the shell's half-width at a given height. Pure arrays, no Three.js, headlessly testable. |
| `test/tryon/headWidth.test.js` *(new)* | Continuity and correctness of the above. |
| `src/models/templeHinge.js` *(modify)* | `solveSplay` takes an absolute clearance instead of a ratio. |
| `test/tryon/templeHinge.test.js` *(modify)* | Splay solve against the new contract. |
| `src/core/RenderLoop.js` *(modify)* | `_openTemples` uses the ray cast and passes the shell's inflation to `solveSplay`. |
| `docs/occluder-model-acceptance.md` *(new)* | The check a newly uploaded merchant model has to pass, and how to run it. |

---

### Task 1: Ray-cast head half-width

The vertex-slab measurement is the root cause of the 22 mm spread in the baseline table. A ray hits
the interpolated triangle surface, so its answer is continuous in height and independent of where the
shell happens to have put a vertex ring.

**Files:**
- Create: `src/occlusion/headWidth.js`
- Test: `test/tryon/headWidth.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `toWorldPositions(positions: ArrayLike<number>, matrix: ArrayLike<number>, out?: Float64Array) => Float64Array`
  - `castDistance(world: Float64Array, indices: ArrayLike<number>, origin: number[], direction: number[]) => number` — distance to the nearest triangle along `+direction`, or `Infinity`.
  - `halfWidthAt(world: Float64Array, indices: ArrayLike<number>, origin: number[], lateral: number[], up: number[], height: number) => number | null` — mean of the two sideways casts from `origin + up * height`; `null` if either misses.

- [ ] **Step 1: Write the failing test**

Create `test/tryon/headWidth.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { castDistance, halfWidthAt, toWorldPositions } from '../../src/occlusion/headWidth.js'

/**
 * A truncated pyramid standing on its base: half-width 0.060 at the bottom,
 * 0.090 at the top, 0.100 tall, centred on the origin, extruded 0.2 in z.
 *
 * Deliberately a SLOPE, so "half-width at a height" has a right answer that a
 * vertex-based measurement cannot give between the two rings.
 */
function frustum() {
  const bottom = 0.060, top = 0.090, y0 = -0.05, y1 = 0.05, z0 = -0.1, z1 = 0.1
  const v = [
    [-bottom, y0, z0], [bottom, y0, z0], [-top, y1, z0], [top, y1, z0],
    [-bottom, y0, z1], [bottom, y0, z1], [-top, y1, z1], [top, y1, z1],
  ]
  const positions = new Float64Array(v.flat())
  const indices = [
    0, 2, 4, 4, 2, 6,   // left wall
    1, 5, 3, 5, 7, 3,   // right wall
    0, 4, 1, 1, 4, 5,   // bottom
    2, 3, 6, 6, 3, 7,   // top
    0, 1, 2, 1, 3, 2,   // front cap
    4, 6, 5, 5, 6, 7,   // back cap
  ]
  return { positions, indices }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const X = [1, 0, 0]
const Y = [0, 1, 0]

describe('castDistance', () => {
  it('returns the distance to the nearest face along the ray', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(castDistance(world, indices, [0, 0, 0], X)).toBeCloseTo(0.075, 4)
  })

  it('returns Infinity when the ray leaves without hitting anything', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(castDistance(world, indices, [0, 0.5, 0], X)).toBe(Infinity)
  })
})

describe('halfWidthAt', () => {
  it('reads the true half-width at a height, not the nearest vertex ring', () => {
    // THE regression test. At mid-height the frustum is 0.075 wide; the nearest
    // vertices are 0.060 and 0.090, so a vertex-based measure cannot land here.
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(halfWidthAt(world, indices, [0, 0, 0], X, Y, 0)).toBeCloseTo(0.075, 4)
  })

  it('is continuous in height, with no step at a vertex ring', () => {
    // The bug this replaces: sampling the shell every 9 mm returned
    // 80.2, 75.0, 80.3, 73.8, 80.6, 70.9 mm on a head that does not change
    // shape that way -- the slab was catching a ring or falling between two.
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    let previous = null
    let biggestStep = 0
    for (let h = -0.045; h <= 0.045; h += 0.005) {
      const w = halfWidthAt(world, indices, [0, 0, 0], X, Y, h)
      if (previous != null) biggestStep = Math.max(biggestStep, Math.abs(w - previous))
      previous = w
    }
    // A 0.005 rise on a slope of 0.3 moves the wall 0.0015. Anything much
    // larger means the measurement is quantised again.
    expect(biggestStep).toBeLessThan(0.002)
  })

  it('averages both sides, so an off-centre origin does not bias it', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    const centred = halfWidthAt(world, indices, [0, 0, 0], X, Y, 0)
    const offset = halfWidthAt(world, indices, [0.01, 0, 0], X, Y, 0)
    expect(offset).toBeCloseTo(centred, 6)
  })

  it('returns null when a side misses, rather than a half-measurement', () => {
    const { positions, indices } = frustum()
    const world = toWorldPositions(positions, IDENTITY)
    expect(halfWidthAt(world, indices, [0, 0, 0], X, Y, 0.2)).toBeNull()
  })

  it('works on an axis that is not world-aligned', () => {
    // The head is never square to the world, and a measurement along world X
    // would silently read a diagonal section as the head turns.
    const { positions, indices } = frustum()
    const angle = 0.4
    const matrix = [
      Math.cos(angle), 0, -Math.sin(angle), 0,
      0, 1, 0, 0,
      Math.sin(angle), 0, Math.cos(angle), 0,
      0, 0, 0, 1,
    ]
    const world = toWorldPositions(positions, matrix)
    const lateral = [Math.cos(angle), 0, Math.sin(angle)]
    expect(halfWidthAt(world, indices, [0, 0, 0], lateral, Y, 0)).toBeCloseTo(0.075, 4)
  })
})

describe('toWorldPositions', () => {
  it('reuses the caller\'s buffer, so a per-frame call does not allocate', () => {
    const { positions } = frustum()
    const buffer = new Float64Array(positions.length)
    expect(toWorldPositions(positions, IDENTITY, buffer)).toBe(buffer)
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

```bash
npx vitest run test/tryon/headWidth.test.js
```

Expected: the whole file fails to collect — `Failed to resolve import "../../src/occlusion/headWidth.js"`.
If it fails any other way, stop and read the error before writing code.

- [ ] **Step 3: Write the implementation**

Create `src/occlusion/headWidth.js`:

```js
/**
 * The head's half-width at a height, by ray cast against the shell's triangles.
 *
 * The splay solve needs to know how wide the head is where the temple runs. The
 * measurement it used before took the widest shell VERTEX inside an 8 mm slab,
 * and the shell is built from a few sparse rings, so the answer jumped with
 * height in a way a head does not: sampled every 9 mm it read
 *
 *   80.2  75.0  80.3  73.8  80.6  70.9  81.1  81.1  79.5  76.4  68.7  57.6 mm
 *
 * -- alternating by five millimetres depending on whether the slab happened to
 * catch a ring or fall between two. Downstream that put the SAME head at 72.5,
 * 84.9 and 94.4 mm depending only on how high the loaded frame's temple rides,
 * and the splay solve opened Willow's arms 25 mm wider than Gripz's on one face.
 *
 * A ray hits the interpolated surface, so its answer is continuous in height and
 * says nothing about where the vertices happen to be.
 *
 * Pure arithmetic on arrays, no Three.js, so it can be tested headlessly.
 */

/**
 * Transforms a flat xyz position array by a column-major 4x4.
 *
 * @param {ArrayLike<number>} positions flat xyz, length divisible by 3
 * @param {ArrayLike<number>} matrix column-major 16
 * @param {Float64Array} [out] reusable buffer of the same length
 * @returns {Float64Array}
 */
export function toWorldPositions(positions, matrix, out) {
  const target = out && out.length === positions.length ? out : new Float64Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    target[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    target[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    target[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  }
  return target
}

/**
 * Distance from `origin` to the nearest triangle along `+direction`.
 *
 * Moller-Trumbore, two-sided: the shell is drawn DoubleSide and the origin sits
 * inside it, so a one-sided test would miss every wall it is meant to find.
 *
 * @returns {number} distance in the positions' own units, or Infinity
 */
export function castDistance(world, indices, origin, direction) {
  let nearest = Infinity
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3

    const e1x = world[b] - world[a], e1y = world[b + 1] - world[a + 1], e1z = world[b + 2] - world[a + 2]
    const e2x = world[c] - world[a], e2y = world[c + 1] - world[a + 1], e2z = world[c + 2] - world[a + 2]

    const hx = direction[1] * e2z - direction[2] * e2y
    const hy = direction[2] * e2x - direction[0] * e2z
    const hz = direction[0] * e2y - direction[1] * e2x

    const det = e1x * hx + e1y * hy + e1z * hz
    if (det > -1e-12 && det < 1e-12) continue
    const inv = 1 / det

    const sx = origin[0] - world[a], sy = origin[1] - world[a + 1], sz = origin[2] - world[a + 2]
    const u = (sx * hx + sy * hy + sz * hz) * inv
    if (u < 0 || u > 1) continue

    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inv
    if (v < 0 || u + v > 1) continue

    const distance = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (distance > 1e-9 && distance < nearest) nearest = distance
  }
  return nearest
}

/**
 * Half-width of the shell at `height` above `origin`, along `lateral`.
 *
 * Both sides are cast and averaged: the ear midpoint is not exactly on the
 * mid-sagittal plane, and averaging cancels that offset to first order where
 * taking one side would carry it straight into the splay angle.
 *
 * @param {Float64Array} world positions already in the same space as origin
 * @param {ArrayLike<number>} indices triangle indices
 * @param {number[]} origin a point near the mid-sagittal plane
 * @param {number[]} lateral unit, side to side
 * @param {number[]} up unit, perpendicular to lateral
 * @param {number} height how far above origin to measure
 * @returns {number | null} null if either cast misses -- a half-measurement is
 *   worse than none, because the solve cannot tell the two apart
 */
export function halfWidthAt(world, indices, origin, lateral, up, height) {
  const from = [
    origin[0] + up[0] * height,
    origin[1] + up[1] * height,
    origin[2] + up[2] * height,
  ]
  const right = castDistance(world, indices, from, lateral)
  const left = castDistance(world, indices, from, [-lateral[0], -lateral[1], -lateral[2]])
  if (!Number.isFinite(right) || !Number.isFinite(left)) return null
  return (right + left) / 2
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run test/tryon/headWidth.test.js
```

Expected: 8 passed.

- [ ] **Step 5: Run the whole suite**

```bash
npm test
```

Expected: 164 passed (156 existing + 8 new).

- [ ] **Step 6: Commit**

```bash
git add src/occlusion/headWidth.js test/tryon/headWidth.test.js
git commit -m "feat(occlusion): measure head width by ray cast, not by nearest vertex"
```

---

### Task 2: Feed the ray cast into the splay solve

Swapping the measurement without touching the solve isolates the change: the splay angles should move
*because the width numbers agree now*, not because the target changed too. Task 3 changes the target.

**Files:**
- Modify: `src/core/RenderLoop.js` — the head-width block inside `_openTemples`, currently lines 903–921

**Interfaces:**
- Consumes: `halfWidthAt`, `toWorldPositions` from Task 1.
- Produces: `this._headWidthMean` now holds a ray-cast half-width in world units; nothing else changes shape.

- [ ] **Step 1: Add the import**

At the top of `src/core/RenderLoop.js`, beside the other `../occlusion/` imports:

```js
import { halfWidthAt, toWorldPositions } from '../occlusion/headWidth.js'
```

- [ ] **Step 2: Replace the vertex-slab loop**

In `_openTemples`, delete this block:

```js
    let headHalfWidth = 0
    for (let i = 0; i < position.count; i += 1) {
      const dx = position.getX(i) - mid.x
      const dy = position.getY(i) - mid.y
      const dz = position.getZ(i) - mid.z
      if (Math.abs(dx * axY.x + dy * axY.y + dz * axY.z - armHeight) > HEAD_SLAB_HALF_M) continue
      const d = Math.abs(dx * axX.x + dy * axX.y + dz * axX.z)
      if (d > headHalfWidth) headHalfWidth = d
    }
```

and put this in its place:

```js
    // Cast, do not scan vertices. The shell is a few sparse rings, so the widest
    // vertex within a slab steps by ~5 mm as the slab catches a ring or falls
    // between two -- which put this same head at 72.5, 84.9 and 94.4 mm on three
    // different frames, purely because their temples ride at different heights.
    const mesh = this.faceOccluder.occluderMesh
    const world = toWorldPositions(
      position.array,
      mesh.matrixWorld.elements,
      (this._shellWorld ??= new Float64Array(position.array.length)),
    )
    const headHalfWidth = halfWidthAt(
      world,
      mesh.geometry.index.array,
      [mid.x, mid.y, mid.z],
      [axX.x, axX.y, axX.z],
      [axY.x, axY.y, axY.z],
      armHeight,
    )
    if (headHalfWidth == null) {
      return
    }
```

- [ ] **Step 3: Delete the now-unused constant**

Remove `const HEAD_SLAB_HALF_M = 0.008` and its comment from the top of the file. Confirm it is gone:

```bash
grep -rn "HEAD_SLAB_HALF_M" src/ test/
```

Expected: no output.

- [ ] **Step 4: Run the suite**

```bash
npm test
```

Expected: 164 passed. If `RenderLoop` has no direct tests, that is expected — this step is a
regression check, not a proof.

- [ ] **Step 5: Measure the three frames in the harness**

Start the harness (`npm run harness`). For each of `_m-gripz`, `_m-larsson`, `_m-willow`, load
**unpinned** and let the scan settle for ~15 seconds:

```
http://localhost:5175/?probe=1&mock=turn&mockframes=25&shop=dev.myshopify.com&model=/models/_m-gripz.glb
```

Then in the console:

```js
const L = window.__probeRefs.loop
JSON.stringify({
  headHalfMm: +(L._headWidthMean * 1000 / 1.16).toFixed(1),
  splayDeg: +(L._splayAngle * 180 / Math.PI).toFixed(1),
})
```

**Acceptance:** the three `headHalfMm` readings must agree within **4 mm** of each other. Baseline was
72.5 / 84.9 / 94.4 — a 22 mm spread. Record the three new numbers in the commit message. If they still
disagree by more than 4 mm, the remaining spread is `armHeight`, not ring quantisation: report the
three `armHeight` values (`L._hinges[0].curl.getWorldPosition(v)` minus the ear midpoint, along `axY`)
and stop — do not proceed to Task 3 on an unstable measurement.

- [ ] **Step 6: Commit**

```bash
git add src/core/RenderLoop.js
git commit -m "fix(fit): drive the splay solve from a ray-cast head width"
```

---

### Task 3: An absolute skin clearance, not a percentage

`solveSplay` aims the arm at `headHalf × 1.16`. Two things are wrong with that. A percentage of a big
number is a big gap — 15.1 mm on Willow's reading against 11.6 mm on Gripz's — so it amplifies exactly
the error Task 1 removed. And `headHalf` is measured against the **shell**, which stands
`shellLateralRatio × span` ≈ 7.5 mm proud of the skin, so a 16 % margin on top of an already-inflated
number puts the arm ~22 mm off the head.

**Files:**
- Modify: `src/models/templeHinge.js` — `TEMPLE_GRAZE_HEAD_RATIO` (line 102) and `solveSplay` (line 475)
- Modify: `test/tryon/templeHinge.test.js` — the `solveSplay` describe block
- Modify: `src/core/RenderLoop.js` — the `solveSplay` call inside `_openTemples`

**Interfaces:**
- Consumes: `this._headWidthMean` from Task 2.
- Produces: `solveSplay(headHalf, armLateral, jointDepth, shellInflation) => number` (radians), and
  `TEMPLE_SKIN_CLEARANCE` (world units). `TEMPLE_GRAZE_HEAD_RATIO` is removed.

- [ ] **Step 1: Write the failing test**

Replace the `describe('solveSplay', ...)` block in `test/tryon/templeHinge.test.js` with:

```js
describe('solveSplay', () => {
  const deg = (rad) => (rad * 180) / Math.PI
  // The engine's own measurements on the mock head, in world units.
  const HEAD = 0.0841      // ray-cast half-width of the shell
  const ARM = 0.0772       // where the arm sits at the joint
  const JOINT = 0.1241     // how far back the joint is
  const INFLATION = 0.0087 // shell lateral ratio 0.05 x span 0.174

  it('aims the arm at the SKIN, not at the shell that stands proud of it', () => {
    // The shell is fatter than the head by design. Aiming at its wall put the
    // arm ~9 mm off the face before the clearance was even added.
    const withInflation = solveSplay(HEAD, ARM, JOINT, INFLATION)
    const withoutInflation = solveSplay(HEAD, ARM, JOINT, 0)
    expect(withInflation).toBeLessThan(withoutInflation)
  })

  it('leaves a few millimetres of skin gap, not a percentage of the head', () => {
    // A ratio makes the gap scale with head size: 16% was 11.6 mm on one
    // reading and 15.1 mm on another, and the temples visibly splayed wider on
    // the frame whose arms happened to ride where the shell measured widest.
    const target = HEAD - INFLATION + TEMPLE_SKIN_CLEARANCE
    const expected = Math.asin((target - ARM) / JOINT)
    expect(solveSplay(HEAD, ARM, JOINT, INFLATION)).toBeCloseTo(expected, 9)
  })

  it('gives two frames on the same head nearly the same opening', () => {
    // The whole point. Two frames differing only in where their arms sit
    // should differ in splay by a few degrees, not by fifteen.
    const gripz = deg(solveSplay(HEAD, 0.0772, 0.1241, INFLATION))
    const willow = deg(solveSplay(HEAD, 0.0753, 0.1339, INFLATION))
    expect(Math.abs(gripz - willow)).toBeLessThan(6)
  })

  it('never opens past the ceiling, however bad the measurement', () => {
    expect(solveSplay(0.13, 0.02, 0.05, 0)).toBeLessThanOrEqual(MAX_SPLAY_RAD)
  })

  it('stays shut on a measurement it cannot use', () => {
    expect(solveSplay(HEAD, ARM, 0, INFLATION)).toBe(0)
    expect(solveSplay(0, ARM, JOINT, INFLATION)).toBe(0)
  })

  it('never folds the arm inward when the frame is already wider than the head', () => {
    // A frame wider than the face asks for a NEGATIVE reach. Bending the arm in
    // to meet the skin would clamp it through the cheek.
    expect(solveSplay(0.06, 0.09, JOINT, INFLATION)).toBe(0)
  })
})
```

Update the import at the top of the file: remove `TEMPLE_GRAZE_HEAD_RATIO`, add `TEMPLE_SKIN_CLEARANCE`.

- [ ] **Step 2: Run the test and confirm it fails**

```bash
npx vitest run test/tryon/templeHinge.test.js
```

Expected: fails to collect — `TEMPLE_SKIN_CLEARANCE` is not exported.

- [ ] **Step 3: Replace the constant**

In `src/models/templeHinge.js`, delete `TEMPLE_GRAZE_HEAD_RATIO` and its doc comment, and put this in
its place:

```js
/**
 * How far outside the head's SKIN the arm is placed, in world units (~3 mm).
 *
 * Absolute, not a fraction of the head. A ratio makes the skin gap scale with
 * head size, which is wrong on its face -- a temple grazes a large head by the
 * same few millimetres as a small one -- and it amplifies any error in the
 * width measurement. At 16% the same face got an 11.6 mm gap under one frame
 * and 15.1 mm under another, and the wider one visibly splayed.
 *
 * The caller passes the shell's own lateral inflation separately, because the
 * width this is added to is measured against the SHELL, which is built proud of
 * the skin on purpose.
 */
export const TEMPLE_SKIN_CLEARANCE = 0.0035
```

- [ ] **Step 4: Rewrite `solveSplay`**

Replace the body, keeping the existing doc comment above it and appending the note:

```js
export function solveSplay(headHalf, armLateral, jointDepth, shellInflation = 0) {
  if (!(jointDepth > 0) || !(headHalf > 0)) return 0
  const skin = headHalf - shellInflation
  const reach = skin + TEMPLE_SKIN_CLEARANCE - armLateral
  // Clamped at zero, not allowed to go negative: a frame already wider than the
  // face asks for a negative reach, and honouring it would rotate the arm
  // inward until it clamped through the cheek.
  const sine = Math.min(Math.max(reach / jointDepth, 0), 1)
  return Math.min(Math.asin(sine), MAX_SPLAY_RAD)
}
```

- [ ] **Step 5: Pass the shell's inflation from the render loop**

In `_openTemples`, replace:

```js
      const solved = solveSplay(this._headWidthMean, hinge.armLateral * scale, hinge.jointDepth * scale)
```

with:

```js
      // The width above was measured against the SHELL, which is built
      // shellLateralRatio x span proud of the skin so it can cover the ear.
      // Subtracting it here is what makes the clearance a skin gap.
      const span = this._clipA && this._clipB ? this._clipA.distanceTo(this._clipB) : ear.distanceTo(mid) * 2
      const inflation = span * (this.faceOccluder.shellLateralRatio ?? 0)
      const solved = solveSplay(
        this._headWidthMean,
        hinge.armLateral * scale,
        hinge.jointDepth * scale,
        inflation,
      )
```

- [ ] **Step 6: Run the suite**

```bash
npm test
```

Expected: 164 passed.

- [ ] **Step 7: Check it on the three frames**

For each frame, unpinned load, settle, then read `splayDeg` as in Task 2 Step 5, and look at the
front view: `window.__mock.pin(12)` then screenshot.

**Acceptance:** all three splay angles within **6°** of each other (baseline spread was 9.0–24.8°, i.e.
16°), and Willow's temples visibly no wider relative to the head than Gripz's from the front. If Willow
is now *narrower* than the head — arms visibly clipping into the skull at the cheek — raise
`TEMPLE_SKIN_CLEARANCE` in 1 mm steps and re-check; do not touch the ratio, it is gone.

- [ ] **Step 8: Commit**

```bash
git add src/models/templeHinge.js test/tryon/templeHinge.test.js src/core/RenderLoop.js
git commit -m "fix(fit): give the temple an absolute skin gap instead of 16% of the head"
```

---

### Task 4: Confirm the ends now tuck behind the ear

The behind-ear stretch is already drawn at `renderOrder 0` for the shell to hide (`applyNearArmClip`).
It was not being hidden because the arm was splayed out past the shell wall — Willow's rear temple
measured a median **+40.6 mm proud of the wall**, and nothing can hide what is outside it. Tasks 2–3
should bring it inside. This task proves it, and only adjusts geometry if it does not.

**Files:**
- Modify (only if the acceptance check fails): `src/models/templeHinge.js` — `TEMPLE_CURL_RAD` (line ~521) or `TEMPLE_CUT_BEHIND_EAR_M`

**Interfaces:**
- Consumes: the splay from Task 3.
- Produces: no new API.

- [ ] **Step 1: Measure the rear standoff on all three frames**

Unpinned load, settle, then `window.__mock.pin(20)` (yaw ≈ −39°) and settle ~20 ticks. Paste the
`__standoff` helper — it casts from each temple vertex along the head's lateral axis to the shell wall
and reports the signed clearance, negative meaning inboard of the wall:

```js
window.__standoff = (stride = 11) => {
  const R = window.__probeRefs, occ = R.faceOccluder.occluderMesh
  R.glassesRoot.updateWorldMatrix(true, true); occ.updateWorldMatrix(true, true)
  const xf = (m, x, y, z) => { const e = m.elements; return [
    e[0]*x + e[4]*y + e[8]*z + e[12], e[1]*x + e[5]*y + e[9]*z + e[13], e[2]*x + e[6]*y + e[10]*z + e[14]] }
  const P = occ.geometry.attributes.position, TRI = occ.geometry.index.array, nT = TRI.length / 3
  const V = new Float64Array(P.count * 3)
  for (let i = 0; i < P.count; i++) { const p = xf(occ.matrixWorld, P.getX(i), P.getY(i), P.getZ(i))
    V[i*3] = p[0]; V[i*3+1] = p[1]; V[i*3+2] = p[2] }
  const V3 = (i) => [V[i*3], V[i*3+1], V[i*3+2]]
  const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]], dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]
  const norm = (a) => { const n = Math.hypot(...a); return [a[0]/n, a[1]/n, a[2]/n] }
  const cast = (o, d) => { let best = Infinity
    for (let t = 0; t < nT; t++) { const a = V3(TRI[t*3]), b = V3(TRI[t*3+1]), c = V3(TRI[t*3+2])
      const e1 = sub(b,a), e2 = sub(c,a), h = cross(d,e2), det = dot(e1,h)
      if (Math.abs(det) < 1e-12) continue
      const inv = 1/det, s = sub(o,a), u = dot(s,h)*inv; if (u < 0 || u > 1) continue
      const q = cross(s,e1), v = dot(d,q)*inv; if (v < 0 || u+v > 1) continue
      const tt = dot(e2,q)*inv; if (tt > 1e-9 && tt < best) best = tt }
    return best }
  const at = (i) => xf(occ.matrixWorld, P.getX(i), P.getY(i), P.getZ(i))
  const earA = at(234), earB = at(454), eyeB = at(263)
  const lat = norm(sub(earB, earA))
  const mid = [(earA[0]+earB[0])/2, (earA[1]+earB[1])/2, (earA[2]+earB[2])/2]
  let fwd = sub(eyeB, earB)
  fwd = norm(sub(fwd, [lat[0]*dot(fwd,lat), lat[1]*dot(fwd,lat), lat[2]*dot(fwd,lat)]))
  const span = Math.hypot(...sub(earB, earA)), mm = (v) => +(v * 1000 / 1.16).toFixed(1)
  const rear = []
  R.glassesRoot.traverse((m) => {
    if (!m.isMesh || !/Temple/i.test(m.name) || /__behind$/.test(m.name)) return
    const pos = m.geometry.attributes.position
    for (let i = 0; i < pos.count; i += stride) {
      const p = xf(m.matrixWorld, pos.getX(i), pos.getY(i), pos.getZ(i))
      const d = sub(p, mid), side = Math.sign(dot(d, lat)) || 1
      const out = [lat[0]*side, lat[1]*side, lat[2]*side]
      if (dot(d, fwd) / span > 0.10) continue          // rear of the arm only
      const hit = cast(p, out)
      const clear = Number.isFinite(hit) ? -hit : cast(p, [-out[0], -out[1], -out[2]])
      if (Number.isFinite(clear)) rear.push(clear)
    }
  })
  rear.sort((a, b) => a - b)
  return { n: rear.length, med: mm(rear[rear.length >> 1]), p90: mm(rear[Math.floor(rear.length * 0.9)]) }
}
window.__standoff()
```

**Acceptance:** rear `p90` **≤ 0 mm** on all three frames — the whole rear of the arm inboard of the
shell wall, which is what lets the shell hide it. Baseline for Willow was median **+40.6**, p90 **+63.3**.

- [ ] **Step 2: Confirm visually that the tip disappears**

At `pin(20)` and `pin(4)`, screenshot each frame. The temple must run to the ear and **stop at the ear's
front edge with no tip visible over or past the pinna**. Compare against the same pose with
`R.faceOccluder.hide(); R.faceOccluder.show = () => {}` — the hidden stretch is what the shell removed.

- [ ] **Step 3: If and only if Step 1 or 2 fails, tighten the curl**

The rear segment's inward rotation is `TEMPLE_CURL_RAD = 0.384` (22°). Raise it in 4° steps to a
maximum of `MAX_CURL_RAD` (0.7 rad), re-running Steps 1–2 at each value, and stop at the first value
that passes both. Record the value tried and its rear `p90` in the commit message. Do **not** change
`TEMPLE_CUT_RATIO` — moving the cut changes which vertices are in the rear piece and invalidates the
splay measurements from Task 3.

- [ ] **Step 4: Run the suite**

```bash
npm test
```

Expected: 164 passed. If you changed `TEMPLE_CURL_RAD`, the curl tests in
`test/tryon/templeHinge.test.js` that assert the constant's range may need their bounds widened — widen
the bound, never delete the test.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "fix(fit): tuck the temple tip inside the shell so the ear hides it"
```

---

### Task 5: Diagnose the pitch-axis loss before fixing it

Larsson loses **20–24 mm** off the rear of its near temple at nose-down — visibly, the frame's ear hook
— while losing **nothing** at any yaw. Three plausible causes, and this session has already refuted
three confident guesses about this occluder, so the task is to *identify* the surface first. Each branch
below names the fix for what it finds.

**Files:**
- Modify: whichever the diagnosis names — `src/occlusion/headShell.js`, `src/models/templeHinge.js`, or `src/core/RenderLoop.js`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing until the branch is chosen.

- [ ] **Step 1: Reproduce the loss and confirm the size**

```
http://localhost:5175/?probe=1&mock=pitchyaw&mockframes=14&mockhold=13&shop=dev.myshopify.com&model=/models/_m-larsson.glb
```

`&mockhold=13` is not optional — this sweep has no frontal frame in its series, and without an anchor
to hold, the scan never locks and every row reads "glasses hidden".

```js
await window.__probe.sweep({ step: 2 })            // discard
const { rows } = await window.__probe.sweep({ step: 2 })
JSON.stringify(rows.filter(r => r.frame < 13)
  .map(r => ({ f: r.frame, gap: r.earGapRatio, ate: r.occluderAteWorld })))
```

Expected, matching the audit: `ate` of 0.025 / 0.028 / 0.026 at frames 0 / 2 / 4 (pitch −25° / −17° / −8°).
If it does not reproduce, stop and report — Tasks 2–4 may already have moved it.

- [ ] **Step 2: Pin the worst pose and establish the number to beat**

```js
const settle = async (n) => { for (let i = 0; i < n; i++) { window.__probe.tick(1); await new Promise(r => setTimeout(r, 16)) } }
window.__mock.pin(2); await settle(20)
const base = window.__probe.measure()
JSON.stringify({ ate: base.occluderAteWorld, on: base.templePixelsOn, off: base.templePixelsOff })
```

- [ ] **Step 3: Ask which surface removes the pixels**

Run each probe below at the same pinned pose, recording `templePixelsOn` after `await settle(6)`.
Whichever restores the pixels names the culprit.

```js
// A. The rear extrusion: collapse the shell's depth so only the face mask remains.
window.__probeRefs.faceOccluder.shellDepthRatio = 0.05
await settle(8); const a = window.__probe.measure().templePixelsOn

// B. The lateral bulge: flatten the shell onto the face oval.
window.__probeRefs.faceOccluder.shellDepthRatio = 0.8
window.__probeRefs.faceOccluder.shellLateralRatio = 0
await settle(8); const b = window.__probe.measure().templePixelsOn

// C. The ear-plane cut: stop lifting and clipping the near arm entirely.
window.__probeRefs.faceOccluder.shellLateralRatio = 0.05
window.__probeRefs.loop._clipNearArm = () => {}
await settle(8); const c = window.__probe.measure().templePixelsOn

JSON.stringify({ base: base.templePixelsOn, noDepth: a, noBulge: b, noClip: c })
```

Note the shell only rebuilds when landmarks update, so `settle(8)` is the minimum — if a number does not
move at all, settle longer before concluding it had no effect.

- [ ] **Step 4: Take the branch the numbers name**

| Which restored the pixels | What it means | The fix |
|---|---|---|
| **A, `noDepth`** | The extruded tube swings up behind the head as the chin drops and swallows the arm. | In `src/occlusion/headShell.js`, the extrusion runs along the head's own −Z. Make the *ear ring* extrude along the ear-to-ear lateral axis crossed with the shell's vertical instead, so the tube stays square to the temple under pitch. Add a unit test in `test/tryon/headShell.test.js` asserting the extrusion direction is unchanged by a pure pitch rotation of the input landmarks. |
| **B, `noBulge`** | The ear bulge is a ring in the head's horizontal plane; pitch rotates the temple out of that plane and into the bulge. | Same file: scale the bulge by `cos(angle between the temple's run and the ring's plane)` so it stops growing into the arm off-plane. Test: bulge applied to a pitched head is no larger at the temple's height than on an unpitched one. |
| **C, `noClip`** | The ear-plane cut, not the shell. `headFrame`'s forward axis is built from ear→eye and tilts with pitch, so the cut plane rotates and takes the hook with it. | In `src/occlusion/headFrame.js`, the axis already has the lateral component projected out; project out the *vertical* component too, so forward stays in the ear-to-ear horizontal. Test: `headFrame` returns the same forward vector for landmarks rotated in pitch about the ear axis. |
| **None moved** | The loss is the model's own geometry leaving the frame, not occlusion. | Re-run Step 1 with `reachRatio` alongside `earGapRatio`. If `reachRatio` moves with pitch too, there is nothing to fix here — record that and close the task. |

- [ ] **Step 5: Implement the single branch, with its test, then re-measure**

Write the branch's test first, watch it fail, implement, watch it pass. Then re-run Steps 1–2.

**Acceptance:** Larsson's `ate` at frames 0/2/4 **below 0.015** world units (≈13 mm, matching what the
yaw axis already achieves), with Gripz's and Willow's yaw-axis `ate` unchanged within ±0.003. Re-run the
yaw sweep on all three to confirm no regression — this is a shared surface and the pitch fix can move
yaw.

- [ ] **Step 6: Run the suite and commit**

```bash
npm test
git add -u
git commit -m "fix(occlusion): stop the shell eating the temple hook when the head nods"
```

---

### Task 6: An acceptance gate for newly uploaded models

The question behind all of this is whether a model nobody has seen will look like these three. Tasks 1–3
remove the biggest source of per-model variation, but nothing today *checks* a new upload. There is no
Playwright in this repo, so the gate is a unit test on the part that generalises plus a written harness
check for the part that cannot be unit-tested.

**Files:**
- Create: `docs/occluder-model-acceptance.md`
- Modify: `test/tryon/templeHinge.test.js` — add the envelope test

**Interfaces:**
- Consumes: `solveSplay`, `TEMPLE_SKIN_CLEARANCE`, `MAX_SPLAY_RAD` from Task 3.
- Produces: no runtime API.

- [ ] **Step 1: Write the envelope test**

Append to `test/tryon/templeHinge.test.js`:

```js
describe('solveSplay across the plausible range of merchant frames', () => {
  const deg = (rad) => (rad * 180) / Math.PI
  const HEAD = 0.0841
  const INFLATION = 0.0087

  /**
   * The three known-good frames, plus the extremes a merchant could upload:
   * every model is normalised to a 0.145 m frame width, so armLateral cannot
   * stray far, but jointDepth follows the temple's own length.
   */
  const FRAMES = [
    { name: 'gripz', armLateral: 0.0772, jointDepth: 0.1241 },
    { name: 'larsson', armLateral: 0.0810, jointDepth: 0.1240 },
    { name: 'willow', armLateral: 0.0753, jointDepth: 0.1339 },
    { name: 'stub temple', armLateral: 0.0772, jointDepth: 0.0700 },
    { name: 'long temple', armLateral: 0.0772, jointDepth: 0.1700 },
    { name: 'narrow arms', armLateral: 0.0650, jointDepth: 0.1241 },
    { name: 'wide arms', armLateral: 0.0900, jointDepth: 0.1241 },
  ]

  it('keeps every plausible frame inside a usable opening', () => {
    // An upload that lands outside this band renders visibly wrong, and until
    // now nothing would have caught it before a merchant saw it on a customer.
    for (const frame of FRAMES) {
      const angle = deg(solveSplay(HEAD, frame.armLateral, frame.jointDepth, INFLATION))
      expect(angle, frame.name).toBeGreaterThanOrEqual(0)
      expect(angle, frame.name).toBeLessThan(deg(MAX_SPLAY_RAD))
    }
  })

  it('lands the three known-good frames within a few degrees of each other', () => {
    const solved = FRAMES.slice(0, 3)
      .map((f) => deg(solveSplay(HEAD, f.armLateral, f.jointDepth, INFLATION)))
    expect(Math.max(...solved) - Math.min(...solved)).toBeLessThan(6)
  })

  it('opens a stubby temple more than a long one, never the reverse', () => {
    // A short temple reaches the head at a steeper angle. If this inverts, the
    // solve is keying on the wrong side of the triangle.
    const stub = solveSplay(HEAD, 0.0772, 0.0700, INFLATION)
    const long = solveSplay(HEAD, 0.0772, 0.1700, INFLATION)
    expect(stub).toBeGreaterThan(long)
  })

  it('asks for nothing when the arms already sit wider than the skin', () => {
    expect(solveSplay(HEAD, 0.0950, 0.1241, INFLATION)).toBe(0)
  })
})
```

- [ ] **Step 2: Run it**

```bash
npx vitest run test/tryon/templeHinge.test.js
```

Expected: pass. If `'stub temple'` saturates at `MAX_SPLAY_RAD`, that is a real finding — report the
angle rather than widening the bound, because a saturated solve means the arm cannot reach the head at
all and the frame will float.

- [ ] **Step 3: Write the acceptance doc**

Create `docs/occluder-model-acceptance.md`:

```markdown
# Checking a newly uploaded frame

What generalises, what does not, and the five minutes of harness work that tells
you which one you are looking at.

## What the engine already normalises

Every uploaded GLB is scaled to a 0.145 m frame width and auto-anchored, so
placement on the face does not depend on how the merchant modelled it. The splay
solve reads the frame's own `armLateral` and `jointDepth` and a head width
measured by ray cast, which is a property of the face rather than of the frame.
`test/tryon/templeHinge.test.js` covers the envelope of frames this can produce.

## What does not generalise, and has to be looked at

- **Where the temple's rear sits relative to the shell.** Frames whose arms run
  high or flare late can leave the shell's reach, and the shell cannot hide what
  is outside it. The rear standoff check below is the one that catches this.
- **Material response.** A flat facet can catch the studio key head-on; Larsson
  shows this on its right hinge and nothing in the fit pipeline knows about it.
- **Ear hooks.** A pronounced hook is the part most likely to be eaten, and it is
  the part a customer notices.

## The check

1. `npm run harness`
2. Load unpinned and let the scan settle ~15 s:
   `http://localhost:5175/?probe=1&mock=turn&mockframes=25&shop=dev.myshopify.com&model=<url>`
   The `shop` parameter is required; without it the engine silently loads the
   default model and you will audit the wrong frame.
3. Discard the first sweep, then take a real one:
   ```js
   await window.__probe.sweep({ step: 2 })
   const { rows } = await window.__probe.sweep({ step: 2 })
   ```
4. Repeat with `&mock=pitchyaw&mockframes=14&mockhold=13` for the pitch axis.

## Pass marks

| Measure | Pass | Why |
|---|---|---|
| `armHolePx` | 0 at every pose | The arm coming apart mid-cheek is the worst-looking failure. |
| `occluderAteWorld` | < 0.015 at every judged pose | More than that and the shell is removing arm the customer should see. |
| `earGapRatio` | between −0.25 and +0.05 | Positive stops short of the ear, negative hooks past it. |
| splay solved | within 6° of the three reference frames | Outside that, the temples read as too wide or clipped into the head. |
| rear standoff p90 | ≤ 0 mm | The rear of the arm must be inboard of the shell wall or the ear cannot hide it. |

## Reading the numbers honestly

- `earGapRatio` drifts up to 0.06 between sweeps. Anything finer needs a paired
  A/B/A at one pinned frame. `occluderAteWorld` and `hiddenPct` are steadier.
- Poses inside |yaw| < 25° are not judged: head-on the arm is foreshortened and
  its rear extent is set by the hinge rather than the tip.
- Near and far arm are decided by the sign of the yaw, so at yaw ≈ 0 the far-arm
  figures are a coin flip. Ignore them.
- All of this runs against one synthetic head. It catches frames that are wrong
  everywhere; it does not tell you how the frame sits on a narrow face.
```

- [ ] **Step 4: Run the suite**

```bash
npm test
```

Expected: 168 passed.

- [ ] **Step 5: Commit**

```bash
git add test/tryon/templeHinge.test.js docs/occluder-model-acceptance.md
git commit -m "test(fit): gate the splay solve across the range of frames a merchant can upload"
```

---

## Self-Review

**Spec coverage**

| Request | Task |
|---|---|
| 1. New uploads look like these three | Tasks 1–3 remove the per-model variance; Task 6 gates and documents what is left |
| 2. Willow temples too wide | Tasks 1–3 (ray-cast width, absolute clearance) |
| 3. Temple ends disappear behind the ears | Task 4 |
| 4. Occluder correct at all angles | Task 5 (pitch; yaw is already clean per the audit) |
| 5. Use the audit, plan the fix | This document |

**Known gaps, stated rather than hidden**

- Task 5's fix is not pre-written. Three confident hypotheses about this occluder have already been
  refuted this session, so the task specifies a complete diagnostic and a branch per outcome instead of
  guessing a fourth. That is deliberate.
- Task 4 may turn out to be a no-op once Tasks 2–3 land, which is the good outcome. Its Step 3 exists
  for the case where it is not.
- Everything is measured on one synthetic head. A real-camera pass on a narrow and a wide face is the
  obvious follow-up and is not in this plan.
- `TEMPLE_SKIN_CLEARANCE = 0.0035` is a starting value, not a measured one. Task 3 Step 7 names how to
  move it and in which direction.

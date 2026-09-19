# Occlusion Lifecycle and Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the lifecycle bugs that survive a frame swap or a face change, and give the layer where every one of them lives — `RenderLoop` state management — the test coverage it currently has almost none of.

**Architecture:** The geometry of this subsystem is in good shape; the *lifecycle* is not. A mutation audit scored the pure-geometry modules 9/9 and every survivor was `RenderLoop` state. Both Criticals below are the same shape as the frame-swap bug fixed on 2026-09-13: a field cached across a lifecycle boundary that the setter for that boundary does not clear. Tasks 1–3 fix the verified correctness bugs, Task 4 fixes the instrument that measures them, Tasks 5–7 make each fixed bug un-revertable, Task 8 addresses the one fit case still outside the gate.

**Tech Stack:** Three.js, MediaPipe FaceLandmarker, Vite, Vitest. No new dependencies.

## Global Constraints

- World units are ≈ 1.16 × metres. Convert nothing in code.
- `npm test` is at **174** passing. Report the exact count after each task; never leave it red.
- Do not change tuned constants (`TEMPLE_SHELL_CLEARANCE`, `TEMPLE_FLOOR_DEPTH`, `TEMPLE_CURL_RAD`, `HEAD_WIDTH_MIN_SAMPLES`, `MAX_SPLAY_RAD`) unless a task says so explicitly.
- Do not modify merchant temple geometry. Articulation is allowed; per-vertex deformation of supplied meshes is not.
- Do not commit `public/models/*.glb`; `gripzpelmo-web.glb` is untracked and stays that way.
- Harness: `npm run harness` → http://localhost:5175. The `shop` parameter is **required** or the engine silently loads the default model:
  `?probe=1&mock=turn&mockframes=25&shop=dev.myshopify.com&model=/models/_m-gripz.glb`
- Discard the first probe sweep after a page load. `earGapRatio` **and** `armHolePx` both drift between sweeps — a sweep once reported a 13 px hole that did not reproduce at any pose. Confirm anything marginal with a paired A/B at a pinned pose.
- Unit-testing a `RenderLoop` method: use `Object.create(RenderLoop.prototype)` with a stub occluder. `test/tryon/openTemples.test.js` is the working pattern; copy it rather than inventing another.

---

## Audit Evidence

Everything below is measured at `b340fd0`, not inferred.

### Mutation audit — 9 of 12 caught, 3 survived

Twelve plausible regressions injected one at a time, full suite run each time. A survivor is a change that lands with the suite green.

```
caught     clearance drifts 0.0148 -> 0.0100      caught     occluder order -1 -> -3
caught     splay zero-clamp removed                caught     head width one-sided
caught     curl flips outward                      caught     temple floor pushes TOWARD camera
caught     lift order -2 -> 0 (lift disabled)      caught     head width ignores temple height
caught     BOTH arms lifted
SURVIVED   temple cut ratio 0.66 -> 0.40
SURVIVED   frame-swap latch clear reverted          <- the Critical fixed on 2026-09-13
SURVIVED   splay never re-solves (latch always set) <- the regression fixed the same day
```

Both of the most serious bugs found in the previous effort are in the survivor set. They were fixed and nothing stops either returning.

### Harness matrix — the narrow head is the systematic weak case

Judged poses only (|yaw| ≥ 25). Gate: `earGapRatio` in [−0.25, +0.05], `armHolePx` ≤ 8.

| head | gripz | larsson | willow |
|---|---|---|---|
| narrow (0.88) | **+0.050** | **+0.059** ✗ | −0.067 |
| standard | −0.012 | −0.019 | −0.066 |
| wide (1.12) | −0.005 | −0.072 | −0.071 |

Larsson on the narrow head is out of gate. Gripz sits exactly on the threshold, stable across repeated reads (0.050, 0.051). Direction is consistent: a narrower head makes the arm end short of the ear.

---

## File Structure

| File | Change |
|---|---|
| `src/core/RenderLoop.js` | latch key, optional chaining, probe rebuild, reset scope, scratch-vector guard, freeze-frame counter |
| `src/occlusion/FaceOccluder.js` | snap the shell shape on a face change; stand down instead of showing a stale mask |
| `src/models/templeHinge.js` | provenance for `TEMPLE_CUT_RATIO` |
| `test/tryon/setGlassesRoot.test.js` *(new)* | frame-swap lifecycle contract |
| `test/tryon/openTemples.test.js` | the latch's two halves, including the C1 regression |
| `test/tryon/clipNearArm.test.js` *(new)* | near-side convention, floor arming, degenerate landmarks |
| `test/tryon/templeFloor.test.js` | three-way render-order contract |
| `test/tryon/templeHinge.test.js` | pin `TEMPLE_CUT_RATIO` |

---

### Task 1: Put glasses scale in the latch key

**Verified in source.** `_openTemples` solves with `solveSplay(this._headWidthMean, hinge.armLateral * scale, hinge.jointDepth * scale)` where `scale = this.glassesRoot?.scale?.x`, but the re-solve gate compares **only** `_headWidthMean` against `_splayForWidth`. Scale can move arbitrarily far after the latch closes and the angle never re-solves.

That is harmless in steady state and harmful on a frame swap, because the two mechanisms collide. `setGlassesRoot` sets `filtersNeedReset`; the next step's `_resetTrackingState` clears `smoothedScale`, `_frontalScaleMean` and `_frontalScaleCount` — so the size estimate restarts from a single sample and converges over `FRONTAL_SCALE_SAMPLES = 120`. Meanwhile `setGlassesRoot` clears `_splayForWidth`, so splay re-solves immediately and latches after `HEAD_WIDTH_MIN_SAMPLES = 10` frames. The splay is frozen at frame 10 against a scale the code itself considers unconverged for another 110 frames. On the shipped constants a 2% scale error is about 1° of permanently latched splay.

**Files:**
- Modify: `src/core/RenderLoop.js` — the resolve gate and the latch write in `_openTemples`

- [ ] **Step 1: Widen the latch key**

Replace the gate:

```js
    if (this._splayForWidth != null && Math.abs(this._headWidthMean - this._splayForWidth) < HEAD_WIDTH_RESOLVE_M) {
      return
    }

    const scale = this.glassesRoot?.scale?.x || 1
```

with:

```js
    const scale = this.glassesRoot?.scale?.x || 1
    // The latch key is the PAIR. The solve consumes head width and glasses
    // scale, so keying it on width alone freezes the angle against whatever
    // scale happened to be current when it closed. That is not academic: a
    // frame swap resets the scale estimate to a single sample and it converges
    // over FRONTAL_SCALE_SAMPLES (120) frames, while splay re-latches after
    // HEAD_WIDTH_MIN_SAMPLES (10) -- so the angle locks against a scale the
    // code itself still calls unconverged, and 2% of scale error is about a
    // degree of splay that never recovers.
    if (
      this._splayForWidth != null &&
      Math.abs(this._headWidthMean - this._splayForWidth) < HEAD_WIDTH_RESOLVE_M &&
      Math.abs(scale - (this._splayForScale ?? 0)) < SPLAY_SCALE_RESOLVE
    ) {
      return
    }
```

- [ ] **Step 2: Add the tolerance constant**

Beside `HEAD_WIDTH_RESOLVE_M` at the top of the file:

```js
/**
 * How far the glasses scale may drift before the splay is solved again.
 *
 * 1% of scale is roughly half a degree of splay on the shipped frames, which is
 * under the resolve threshold for width; anything looser and the frame-swap
 * convergence transient latches in.
 */
const SPLAY_SCALE_RESOLVE = 0.01
```

- [ ] **Step 3: Record the scale with the width**

Where the latch closes:

```js
    if (this._headWidthCount >= HEAD_WIDTH_MIN_SAMPLES) {
      this._splayForWidth = this._headWidthMean
      this._splayForScale = scale
    }
```

- [ ] **Step 4: Clear it on a frame swap**

In `setGlassesRoot`, beside the existing `this._splayForWidth = null`:

```js
    this._splayForScale = null
```

- [ ] **Step 5: Run the suite**

```bash
npm test
```

Expected: 174 passing. Task 6 adds the regression test.

- [ ] **Step 6: Commit**

```bash
git add src/core/RenderLoop.js
git commit -m "fix(fit): re-solve splay when the glasses scale moves, not only the head width"
```

---

### Task 2: Optional-chain the four `aimTempleFloor` calls

**Verified in source.** `_clipNearArm` calls `this.faceOccluder.aimTempleFloor(...)` bare at four sites, while every other `faceOccluder` call in the file is guarded (`?.hide?.()`, `?.updateFromFaceMesh?.()`). The guard above them only proves `occluderMesh` exists, not that the object implements the method.

The failure shape is the reason this is Critical rather than Minor. The throw lands inside `_applyTransform`, which runs *before* `renderer.render(...)`, and the surrounding `try/catch` swallows it into `console.error`. Every frame throws, nothing renders, and there is no crash to point at — a frozen picture and a console flood. It also blocks Task 7: a `_clipNearArm` test built on the existing stub throws before it can assert anything.

**Files:**
- Modify: `src/core/RenderLoop.js` — four call sites in `_clipNearArm`

- [ ] **Step 1: Guard all four**

Change every `this.faceOccluder.aimTempleFloor(` in `_clipNearArm` to `this.faceOccluder.aimTempleFloor?.(`. There are four: three `(null)` bail-outs and the live one that passes the camera direction. Verify:

```bash
grep -n "aimTempleFloor" src/core/RenderLoop.js
```

Expected: four lines, all `aimTempleFloor?.(`.

- [ ] **Step 2: Run the suite and commit**

```bash
npm test
git add src/core/RenderLoop.js
git commit -m "fix(occlusion): guard aimTempleFloor like every other occluder call"
```

---

### Task 3: Stop the floor staying armed when the model has no hinges

**Files:**
- Modify: `src/core/RenderLoop.js` — the first guard in `_clipNearArm`

The `!this._hinges?.length` early return is the only exit from `_clipNearArm` that does not call `aimTempleFloor(null)`. `FaceOccluder.hide()` deliberately preserves `_floorAimed` so `show()` can re-arm, so a swap to a model whose arms were not detected (`buildHinges` returns `[]`) leaves the floor drawing at renderOrder −3 for a model that lifts nothing, for the rest of the session.

- [ ] **Step 1: Disarm before the guard**

```js
  _clipNearArm(transform) {
    // Before the guard, not after: this is the one exit that used to leave the
    // floor armed, and FaceOccluder.hide() preserves _floorAimed on purpose so
    // that show() can re-arm it. A model whose arms were never detected would
    // keep an inner shell drawing for a frame that lifts nothing.
    if (!this._hinges?.length) {
      this.faceOccluder?.aimTempleFloor?.(null)
      return
    }
    if (!this.faceOccluder?.occluderMesh) {
      return
    }
```

- [ ] **Step 2: Run the suite and commit**

```bash
npm test
git add src/core/RenderLoop.js
git commit -m "fix(occlusion): disarm the temple floor when a model has no hinges"
```

---

### Task 4: Rebuild the probe on a frame swap

**Verified in source.** `_installProbe` early-returns on `|| this._probe`, and `OcclusionProbe` captures `glassesRoot` by reference in its constructor. `setGlassesRoot` removes the old root from the scene and calls `_installProbe()`, which does nothing.

After one `loadSku`, the probe measures a model that is not in the scene. It still finds temple meshes by name and still passes its `glassesRoot.visible` guard, so it renders a scene the model is absent from and reports near-zero temple pixels — which reads as **perfect occlusion**. This is the instrument every tuned constant in this subsystem was measured with.

**Files:**
- Modify: `src/core/RenderLoop.js` — `_installProbe`

- [ ] **Step 1: Make the guard a staleness check**

```js
  _installProbe() {
    if (!this.probeEnabled || !this.glassesRoot || !this.faceOccluder) {
      return
    }
    // Rebuild when the root changes, do not skip. The probe captures
    // glassesRoot by reference, so after a frame swap it measures a model that
    // is no longer in the scene -- it still finds temples by name, still passes
    // its own visible guard, and reports almost no temple pixels. That reads as
    // flawless occlusion, from the instrument this subsystem is tuned with.
    if (this._probe && this._probe.glassesRoot === this.glassesRoot) {
      return
    }
    this._probe?.target?.dispose?.()
```

Leave the rest of the method as it is — it already reassigns `this._probe`, `window.__probeRefs` and `window.__probe`.

- [ ] **Step 2: Verify in the harness**

Load `?probe=1&mock=turn&mockframes=25&shop=dev.myshopify.com&model=/models/_m-gripz.glb`, settle, then in the console:

```js
const R = window.__probeRefs
R.loop.setGlassesRoot(R.loop.glassesRoot)
JSON.stringify({ rebuilt: window.__probeRefs.glassesRoot === R.loop.glassesRoot })
```

Expected: `rebuilt: true`.

- [ ] **Step 3: Run the suite and commit**

```bash
npm test
git add src/core/RenderLoop.js
git commit -m "fix(probe): rebuild the occlusion probe when the frame changes"
```

---

### Task 5: Reset head width and snap the shell when the face changes

**Files:**
- Modify: `src/core/RenderLoop.js` — `_resetTrackingState`
- Modify: `src/occlusion/FaceOccluder.js` — the >5 cm snap branch in `updateFromFaceMesh`

`_resetTrackingState` clears `_frontalScaleMean` and `_frontalScaleCount` but not `_headWidthMean` and `_headWidthCount`, which are structurally identical capped running means. Neither choice is documented as deliberate. Separately, `_smoothedPts` snaps on a jump over 5 cm but `_ringLocal` and `_shellSpan` do not — they ease at `SHELL_SHAPE_ALPHA = 0.08`, so for roughly 30 frames the shell is a blend of two heads' shapes.

Together those give a concrete misbehaviour on re-acquire with a *different* face: `_openTemples` measures head width off a half-and-half shell, the 0.05–0.13 m plausibility gate is far too wide to reject a blend of two human heads, and the contaminated samples land in a mean that was never reset and whose count is already pinned at 90.

- [ ] **Step 1: Reset the head-width mean with the other running means**

In `_resetTrackingState`, beside `this._frontalScaleCount = 0`:

```js
    // Head width is a running mean over the FACE, so it belongs with the scale
    // means here, not with the model state that survives a frame swap. Left in
    // place it takes ~90 frames to shed samples measured off the previous face.
    this._headWidthMean = null
    this._headWidthCount = 0
```

- [ ] **Step 2: Snap the shell's shape with its points**

In `FaceOccluder.updateFromFaceMesh`, inside the branch that snaps `_smoothedPts` on a jump greater than 5 cm, also clear the eased shape state:

```js
      // The shape eases at SHELL_SHAPE_ALPHA and the points snap. Leaving the
      // shape behind makes the shell a blend of the old head and the new one
      // for ~30 frames, and the head-width measurement reads that blend.
      this._ringLocal = null
      this._shellSpan = null
```

- [ ] **Step 3: Confirm the snap branch is the one you edited**

```bash
grep -n "_ringLocal = null\|_shellSpan = null\|_smoothedPts" src/occlusion/FaceOccluder.js
```

The new lines must sit inside the same conditional as the `_smoothedPts` snap, not at the top of the method.

- [ ] **Step 4: Run the suite and commit**

```bash
npm test
git add src/core/RenderLoop.js src/occlusion/FaceOccluder.js
git commit -m "fix(occlusion): forget the previous face's width and shell shape on re-acquire"
```

---

### Task 6: Test the frame-swap contract and the latch — mutation survivors 2 and 3

**Files:**
- Create: `test/tryon/setGlassesRoot.test.js`
- Modify: `test/tryon/openTemples.test.js`

These are the two survivors, stated directly. Both are pure state assertions; neither needs WebGL.

- [ ] **Step 1: Write the frame-swap test**

`test/tryon/setGlassesRoot.test.js`, using the `Object.create(RenderLoop.prototype)` pattern from `openTemples.test.js`:

```js
  it('clears the splay latch so a new frame re-solves', () => {
    // Survivor #2 of the mutation audit, and a Critical when it regressed: the
    // resolve latch used to release only because the old head measurement swung
    // 22 mm between models and always blew past HEAD_WIDTH_RESOLVE_M. At 0.8 mm
    // of spread it never does, and the new frame kept its authored, unopened,
    // uncurled arms for the whole session.
    const loop = stubLoop()
    loop._splayForWidth = 0.0919
    loop._splayForScale = 1.2
    loop.setGlassesRoot(newRoot())
    expect(loop._splayForWidth).toBeNull()
    expect(loop._splayForScale).toBeNull()
  })

  it('keeps the head measurement, which is a property of the head not the frame', () => {
    const loop = stubLoop()
    loop._headWidthMean = 0.0919
    loop._headWidthCount = 42
    loop.setGlassesRoot(newRoot())
    expect(loop._headWidthMean).toBeCloseTo(0.0919, 6)
    expect(loop._headWidthCount).toBe(42)
  })
```

- [ ] **Step 2: Write the latch tests**

Append to `test/tryon/openTemples.test.js`, driving the same stub loop repeatedly:

```js
  it('splays from the first frame but does not latch until the mean has settled', () => {
    // Survivor #3. Gating the SOLVE on the sample count meant a head that was
    // near-frontal for only five frames never got splay or curl at all --
    // measured on WILLOW: 44% of the temple hidden, earGapRatio +0.145.
    const loop = stubLoop({ armHeight: 0.02 })
    for (let i = 0; i < 9; i += 1) loop._openTemples(TRANSFORM)
    expect(loop._splayForWidth).toBeNull()
    expect(loop._hinges[0].group.rotation.y).not.toBe(0)

    loop._openTemples(TRANSFORM)
    expect(loop._splayForWidth).not.toBeNull()
  })

  it('re-solves when the glasses scale moves, not only when the head width does', () => {
    // Task 1's regression. The solve consumes both; keying the latch on width
    // alone froze the angle against a scale that is still converging for
    // another hundred frames after a frame swap.
    const loop = stubLoop({ armHeight: 0.02 })
    for (let i = 0; i < 12; i += 1) loop._openTemples(TRANSFORM)
    const latched = loop._splayAngle

    loop.glassesRoot.scale.setScalar(loop.glassesRoot.scale.x * 1.05)
    loop._openTemples(TRANSFORM)
    expect(loop._splayAngle).not.toBeCloseTo(latched, 6)
  })
```

You will need `stubLoop` to expose `glassesRoot` with a real `THREE.Vector3` scale and hinges whose `group.rotation` is readable — extend the existing helper rather than writing a second one.

- [ ] **Step 3: Prove both tests have teeth by mutation**

This step is not optional. The previous round shipped a regression test that could not detect the bug it was written for, and that was only discovered by mutating.

For each mutation: apply, run **only** the two test files, confirm the expected test fails, then `git checkout --` the source file.

| Mutation | File | Expected to fail |
|---|---|---|
| comment out `this._splayForWidth = null` in `setGlassesRoot` | `src/core/RenderLoop.js` | the frame-swap latch test |
| change the latch gate to `if (true) {` | `src/core/RenderLoop.js` | the 9-call latch test |
| drop the `SPLAY_SCALE_RESOLVE` clause from the gate | `src/core/RenderLoop.js` | the scale re-solve test |

If any mutation leaves the suite green, the test is toothless — fix the test, do not proceed.

- [ ] **Step 4: Run the suite and commit**

```bash
npm test
git add test/tryon/setGlassesRoot.test.js test/tryon/openTemples.test.js
git commit -m "test(fit): lock the frame-swap contract and both halves of the splay latch"
```

---

### Task 7: Cover `_clipNearArm` and the render-order contract

**Files:**
- Create: `test/tryon/clipNearArm.test.js`
- Modify: `test/tryon/templeFloor.test.js`

`_clipNearArm` has no direct coverage at all. Separately, `INNER_OCCLUDER_RENDER_ORDER = -3` appears only in `FaceOccluder.js` and no test imports it — change it to `-1.5` and the floor silently stops bounding the lifted arm with every test green. `templeHinge.test.js` already asserts `TEMPLE_ON_TOP_ORDER < OCCLUDER_RENDER_ORDER`; this extends that to the full ordering.

Task 2 must land first — the stub occluder has no `aimTempleFloor`, so these tests throw against unguarded calls.

- [ ] **Step 1: The three-way ordering test**

Append to `test/tryon/templeFloor.test.js`:

```js
  it('draws floor, then lifted temple, then shell, then everything else', () => {
    // The floor's whole purpose is to draw BEFORE the lifted temple, and its
    // order lives in a different module from the temple's. Nothing tied the
    // two together: -3 to -1.5 disables the bound with the suite still green.
    expect(INNER_OCCLUDER_RENDER_ORDER).toBeLessThan(TEMPLE_ON_TOP_ORDER)
    expect(TEMPLE_ON_TOP_ORDER).toBeLessThan(OCCLUDER_RENDER_ORDER)
    expect(OCCLUDER_RENDER_ORDER).toBeLessThan(0)
  })
```

- [ ] **Step 2: The `_clipNearArm` tests**

`test/tryon/clipNearArm.test.js`, same stub pattern, with `faceOccluder.aimTempleFloor` as a `vi.fn()`:

```js
  it('lifts nothing and disarms the floor when the head is square on', () => {
    const loop = stubLoop({ headYaw: 0 })
    loop._clipNearArm(TRANSFORM)
    expect(loop.faceOccluder.aimTempleFloor).toHaveBeenCalledWith(null)
    for (const mesh of loop._hinges.flatMap((h) => h.meshes)) {
      expect(mesh.renderOrder).toBe(0)
      expect(mesh.material.clippingPlanes).toBeNull()
    }
  })

  it('lifts the arm on the side the head is turned towards', () => {
    // This sign convention is duplicated in occlusionProbe's own near-arm
    // filter, so the two can drift apart and the probe would then score the
    // arm the renderer did not lift.
    for (const [yawDeg, expected] of [[20, -1], [-20, 1]]) {
      const loop = stubLoop({ headYaw: (yawDeg * Math.PI) / 180 })
      loop._clipNearArm(TRANSFORM)
      const lifted = loop._hinges.filter((h) => h.meshes.some((m) => m.renderOrder === TEMPLE_ON_TOP_ORDER))
      expect(lifted).toHaveLength(1)
      expect(lifted[0].side).toBe(expected)
    }
  })

  it('disarms the floor when the occluder is hidden', () => {
    const loop = stubLoop({ headYaw: 0.5 })
    loop.faceOccluder.occluderMesh.visible = false
    loop._clipNearArm(TRANSFORM)
    expect(loop.faceOccluder.aimTempleFloor).toHaveBeenCalledWith(null)
  })

  it('disarms the floor and does not throw when the head frame is degenerate', () => {
    // Both tragion landmarks at the same point: headFrame returns null. The
    // fallback has to be the safe state, not the last good one.
    const loop = stubLoop({ headYaw: 0.5, coincidentEars: true })
    expect(() => loop._clipNearArm(TRANSFORM)).not.toThrow()
    expect(loop.faceOccluder.aimTempleFloor).toHaveBeenCalledWith(null)
  })

  it('disarms the floor when the model has no hinges', () => {
    // Task 3's regression: this exit used to leave the floor armed for the rest
    // of the session, drawing for a frame that lifts nothing.
    const loop = stubLoop({ headYaw: 0.5 })
    loop._hinges = []
    loop._clipNearArm(TRANSFORM)
    expect(loop.faceOccluder.aimTempleFloor).toHaveBeenCalledWith(null)
  })
```

- [ ] **Step 3: Run the suite and commit**

```bash
npm test
git add test/tryon/clipNearArm.test.js test/tryon/templeFloor.test.js
git commit -m "test(occlusion): cover the near-arm clip and the four-way render order"
```

---

### Task 8: Pin `TEMPLE_CUT_RATIO` and record where it came from — mutation survivor 1

**Files:**
- Modify: `src/models/templeHinge.js`
- Modify: `test/tryon/templeHinge.test.js`

`TEMPLE_CUT_RATIO = 0.66` decides where each arm splits into two rigid pieces. In a file where every other tuned constant carries ten to thirty lines of measured justification, this one is a bare `export const` — and that absence is exactly why the mutation to 0.40 survived. `templeHinge.test.js` already imports the constant and never uses it.

- [ ] **Step 1: Pin the value and assert the cut lands where it should**

Use the already-unused import:

```js
  it('pins the cut ratio, which nothing else would catch', () => {
    // Mutating this to 0.40 left the whole suite green. It moves which vertices
    // belong to the rear piece, so it changes both the curl's leverage and where
    // the ear-plane clip falls -- with no unit-level consequence to assert
    // except the cut's own position.
    expect(TEMPLE_CUT_RATIO).toBe(0.66)
  })
```

Then extend the existing `buildHinges` test ("cuts each arm in two and hangs the rear piece on its own pivot") to assert `hinge.cutZ` lands at `hingeZ - (hingeZ - zBack) * TEMPLE_CUT_RATIO` for its fixture geometry. Read the fixture's actual `hingeZ` and `zBack` from the test rather than assuming them.

- [ ] **Step 2: Write the provenance comment**

Replace the bare declaration in `src/models/templeHinge.js` with a doc comment recording what the ratio is, what moving it does (it changes which vertices are in the rear piece, so it changes the curl's leverage and where the ear-plane clip falls), and the honest state of its evidence: the 0.35–0.74 range was swept during the 2026-09-13 fit work and 0.66 was the value in place when the current gates were met. Do **not** invent a measurement table for it.

- [ ] **Step 3: Verify the pin has teeth**

```bash
python -c "
import io; p='src/models/templeHinge.js'; s=io.open(p,encoding='utf-8').read()
io.open(p,'w',encoding='utf-8',newline='').write(s.replace('TEMPLE_CUT_RATIO = 0.66','TEMPLE_CUT_RATIO = 0.40',1))"
npx vitest run test/tryon/templeHinge.test.js
git checkout -- src/models/templeHinge.js
```

Expected: fails. Then confirm it passes again after the checkout.

- [ ] **Step 4: Run the suite and commit**

```bash
npm test
git add src/models/templeHinge.js test/tryon/templeHinge.test.js
git commit -m "test(fit): pin the temple cut ratio and record its provenance"
```

---

### Task 9: Larsson on a narrow head ends short of the ear

**Files:**
- Investigate first; modify only what the measurement names.

The one fit case still outside the gate. Larsson at yaw −43 on the narrow head reads `earGapRatio` +0.059 against a +0.05 threshold; Gripz reads +0.050 exactly on it. Both are stable across repeated reads. Every wide-head and standard-head case passes comfortably, so the direction is consistent: a narrower head makes the arm end short.

Resist the urge to move `TEMPLE_SHELL_CLEARANCE`. The previous round's over-fitting came from tuning a constant against one head, and a narrow head is where the monocular pipeline is least trustworthy — head width and camera distance are close to degenerate, so a "narrow head" is partly "a head further away".

- [ ] **Step 1: Establish whether the occluder or the model's reach is responsible**

Pin the failing pose and read both numbers:

```js
const settle = async (n) => { for (let i = 0; i < n; i++) { window.__probe.tick(1); await new Promise(r => setTimeout(r, 16)) } }
window.__mock.pin(2); await settle(30)
const m = window.__probe.measure()
JSON.stringify({ gap: m.earGapRatio, reach: m.reachRatio, ate: m.occluderAteWorld })
```

`reachRatio` is where the arm ends with the occluder off — a property of the model on this head that no occluder change can move.

- [ ] **Step 2: Take the branch the numbers name**

| Reading | Meaning | Action |
|---|---|---|
| `reach` ≥ +0.05 | the arm genuinely does not reach the ear on this head; the occluder is not eating it | Nothing to fix in the occluder. Record it in `docs/occluder-model-acceptance.md` as a known limit of this frame on a narrow face and close the task. |
| `reach` < 0 but `gap` > +0.05, with `ate` ≥ 0.015 | the occluder is removing the last stretch | Re-run the Task 5 diagnostic from the 2026-09-13 plan (suppress rear extrusion, then bulge, then clip) at this pose and fix whichever surface the numbers name. |
| `reach` ≈ `gap` and `ate` ≈ 0 | neither: the arm's end is where the model puts it | Same as the first row. |

- [ ] **Step 3: Whatever the branch, record the outcome**

Add the measured `reach` alongside the existing gap figures in the narrow-head table in `docs/occluder-model-acceptance.md`, so the next reader can tell a frame limit from an occluder bug without re-deriving it.

- [ ] **Step 4: Commit**

```bash
git add -u
git commit -m "fix(fit): resolve the narrow-head shortfall on Larsson"
```

---

### Task 10: Remove the rot the audit found

Low risk, no behaviour change except the first item. Fold into one commit.

**Files:**
- Modify: `src/core/RenderLoop.js`, `src/occlusion/FaceOccluder.js`, `src/occlusion/headShell.js`, `src/models/templeHinge.js`

- [ ] **Step 1: The freeze-frame counter is double-incremented**

`lowQualityFrames` is bumped once for the frame and again inside the freeze branch, so `LOW_QUALITY_FREEZE_FRAMES = 3` yields exactly one freeze frame. Delete the second increment. If the double bump was deliberate — to make the freeze non-reentrant — keep it, say so in a comment, and rename the constant, because right now it misdescribes the code.

- [ ] **Step 2: The freeze path drops `occluderCorrection`**

`lastGoodTransform` is built without `occluderCorrection`, which the live transform carries, so `updateFromFaceMesh` falls back to a zero correction on freeze frames. That correction is what locks the mask to the frame by construction; dropping it steps the whole mask and back again, precisely on the frames where tracking is already poor. Add the field to the `lastGoodTransform` literal.

- [ ] **Step 3: `updateFromAnchors` cannot place a single vertex**

`OCCLUDER_POINTS` is built with `key: null` for all 468 entries, so the body of its loop returns early for every vertex, always. The method then collapses the shell and calls `show()` — leaving the previous frame's mask standing as a depth writer at the previous head's position. It is currently unreachable, but it is written as a safety net and is the opposite of one. Make it `hide()` and return, then delete the dead `key` field and the two dead ternaries so nobody reads this as a working path.

- [ ] **Step 4: Invalidate `_shellWorld` when the occluder changes**

`(this._shellWorld ??= …)` is sized from the first occluder ever seen and `setFaceOccluder` clears nothing. All instances currently share a vertex count so it is harmless — and it is the exact shape of the bug this plan opens with. Add `this._shellWorld = null` to `setFaceOccluder`.

- [ ] **Step 5: Guard the arm-height accumulator**

`_openTemples` accumulates through a persistent scratch vector that `.sub(mid)` mutates in place, behind `hinge.curl?.getWorldPosition(armTmp)`. A hinge without a `curl` silently re-reads the previous iteration's residual. `applyCurl` guards `if (!hinge.curl) continue`; this does not — two modules disagree on whether `curl` is optional. Either skip hinges without one and divide by the count actually used, or drop the `?.` here and the guard in `applyCurl` so the contract is stated once.

- [ ] **Step 6: Stale comments and dead exports**

- `shellTriangles`' JSDoc documents four parameters it does not have and describes the superseded single-ring shell.
- `EXTRUDED_START`'s comment claims it is "kept for the tests"; it is module-local and not exported.
- `FaceOccluder.update(matrix)` and the `else if` that calls it are unreachable — nothing sets `transform.occluderMatrix`.
- `applyOffset` is called from one site with a hardcoded `0`. Either delete it or note that the zero call is a deliberate reset and say what it resets.
- `_splayAngle` is written and never read in `src/`. Expose it on `window.__probeRefs`, where it would be genuinely useful, or delete it and the assertion that keeps it alive.
- Stray double blank lines in `templeHinge.js` where constants were removed.

- [ ] **Step 7: Run the suite and commit**

```bash
npm test
git add -u
git commit -m "chore(occlusion): remove the dead paths and stale comments the audit found"
```

---

## Self-Review

**Coverage of the audit**

| Finding | Task |
|---|---|
| C1 latch keys on width, not scale | 1, regression test in 6 |
| C2 unguarded `aimTempleFloor` | 2 |
| I1 probe pinned to the first frame | 4 |
| I2 freeze path drops `occluderCorrection` | 10 |
| I3 freeze counter double-incremented | 10 |
| I4 floor armed with no hinges | 3, regression test in 7 |
| I5 arm-height scratch residual | 10 |
| I6 `updateFromAnchors` places no vertex | 10 |
| I7 `_shellWorld` not invalidated | 10 |
| Lifecycle: head width and shell shape on face change | 5 |
| Mutation survivor 1 (`TEMPLE_CUT_RATIO`) | 8 |
| Mutation survivors 2 and 3 (latch) | 6 |
| Untested render order | 7 |
| Untested `_clipNearArm` | 7 |
| Larsson narrow head out of gate | 9 |
| Minor rot (M2–M7) | 10 |

**Ordering constraints.** Task 2 before Task 7 — the stub has no `aimTempleFloor` and the tests throw against unguarded calls. Task 1 before Task 6's scale test. Task 3 before Task 7's no-hinges test. Everything else is independent.

**Deliberately not in this plan**

- A test for `_resetTrackingState`'s exact field list. It would have caught the Task 5 asymmetry and it is cheap, but it is a change-detector: it fails on every legitimate addition. Worth discussing, not worth adding unasked.
- GPU resource disposal on frame swap (M7). Each swap leaks an articulated frame's worth of GL objects. Real, but it needs a considered `dispose` walk rather than a step in a bugfix plan.
- Anything about real cameras. Every number here is one synthetic head at three widths, and the narrow/wide sweep showed a mock cannot cleanly separate head width from camera distance. That gap does not close from this repo.

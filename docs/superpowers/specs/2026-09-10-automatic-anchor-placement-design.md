# Automatic Eyewear Anchor Placement

**Date:** 2026-09-10
**Status:** Approved design (pre-implementation)
**Component:** `packages/calibration` — geometric anchor estimation

## Problem

Getting exact fit anchors out of a model today requires hand-authoring three
empties (`AR_bridge`, `AR_hinge_L`, `AR_hinge_R`) in Blender for every frame.
When those tags are absent, `calibrate()` falls back to `estimateAnchors()`, and
that estimate is not close enough to be a substitute for the hand work.

Measured against two hand-tagged reference models, in normalized space:

| Model | Anchor | Hand-placed | Estimated | Error |
|---|---|---|---|---|
| Larsson | bridge | y=-9.6, z=-3.6 | y=0.0, z=0.0 | **10.2 mm** |
| Larsson | hinge L/R | x=±66.7, z=-9.9 | x=±73.2, z=-37.9 | **29.1 mm** |
| GRIPZ | bridge | y=-11.4, z=-3.7 | y=0.0, z=0.0 | **11.9 mm** |
| GRIPZ | hinge L/R | x=±65.6, z=-10.6 | x=±80.4, z=-38.5 | **31.9 mm** |

A 3 cm hinge error and a 1.5 cm bridge error are plainly visible on a face.
`bridgeAnchor` is the frame's rotation pivot in `FaceFitSolver`, so bridge error
shows up as the frame sliding around the nose as the head pitches and turns.

### Root cause

`measureFrontWidth` and `detectTemples` both define "the front slab" as **the
front 25% of the model's Z range**. Temples make that Z range ~155 mm, so the
"front slab" is ~39 mm deep and swallows the temple flare. Every downstream
measurement inherits the error:

- Hinges land at the widest point *of that oversized slab* — 28 mm too far back
  on both reference models.
- `measureFrontWidth` returns 160.8 mm for a GRIPZ frame that is really ~146 mm,
  which trips a spurious `WIDTH_OUT_OF_RANGE` warning **and** feeds
  `frameWidthMeters`, the denominator of the runtime fit scale.

### Two related defects surfaced by the same measurements

1. **The confidence score misfires on legitimate models.** Larsson scores
   `overall = 0.000` — not because it is a bad model, but because
   `measureSymmetryDeviation` returns 0.155, tripped by asymmetric branding
   (`10_Larsson_UKCA_UV400_CE_Inner_Print`, `08_BELVOIR_AND_CO_Gold_Lettering`,
   `09_White_Illustrated_Lens_Emblem`). Symmetry carries weight 1.0 in a
   weighted-**min**, so that one signal zeroes the total and a well-authored
   frame is badged "Needs review". Nearly every real merchant GLB carries
   branding, so this would fire constantly.

2. **`needs_manual` promises a step that does not exist.** There is no manual
   anchor UI anywhere in the app. A flagged asset still maps and still renders.

## Goal

Derive all three anchors from mesh geometry accurately enough that hand-tagging
is no longer necessary: **within 3 mm of hand placement on every anchor of both
reference models**, for arbitrary merchant GLBs, degrading to a safe canonical
placement rather than a wild one when the geometry is unreadable.

## Decisions taken during design

- **Fully automatic.** No anchor editor, no human in the loop. (An in-admin
  editor was considered and rejected.)
- **Any merchant GLB**, not just the Gripz catalogue — so heuristics must degrade
  safely and keep reporting a confidence signal.
- **Low confidence snaps to canonical proportions** rather than trusting a bad
  measurement, applied **per anchor** rather than all-or-nothing.
- **New uploads only.** No backfill; `fitMetadata` on existing `ModelAsset` rows
  is left frozen, so live storefronts are unaffected.
- **Bridge anchor targets the vertical centre of the bridge bar.** At design
  time only GRIPZ followed this rule and Larsson's anchor sat 5 mm lower, on the
  bridge underside. Larsson was re-exported on 2026-09-10 at 03:27 with its
  `AR_bridge` raised 6.85 mm (raw y 32.0 → 39.05; hinges untouched), so **both
  reference models now follow the centre rule** — within 1.9 mm and 0.4 mm of
  their respective bridge-bar midpoints. There is no longer an outlier to
  exempt.
- **`AR_*` tags keep absolute precedence.** A merchant who can author tags still
  beats any estimate, and models already tagged in production are unaffected.

## Non-goals / out of scope

- Any admin UI, including an anchor editor.
- Backfilling or recalibrating existing `ModelAsset` rows.
- Writing `AR_*` tag nodes into stored GLBs.
- Any change to the tagged path in `calibrate()`.
- Any Prisma schema change.
- Any change in `apps/shopify-app` beyond consuming better `fitMetadata`.

## Ground truth

Two hand-tagged reference models (not committed — 3.5 MB and 6.7 MB):

- `D:\Downloads\Larsson_Sunglasses_AR.glb` — validation `pass`, real-metre scale,
  normalize applies `recenter` only.
- `D:\Downloads\GRIPZ_Sunglasses_anchored_widened.glb` — validation `warn` (over
  150k triangles), normalize applies `flatten, recenter`.

Both author the frame front at z≈0 with temples trailing to -z, so normalization
leaves Z untouched (the normalizer deliberately sets `dz = 0`).

### The front frame ends in a density cliff

Vertex counts in 2 mm Z bins, measured after normalization:

| Z band | Larsson | GRIPZ |
|---|---|---|
| -8 … -10 mm | 8295 | 18928 |
| -10 … -12 mm | 2644 | 5897 |
| -12 … -14 mm | **54** | **397** |

A 49x collapse on Larsson, 15x on GRIPZ, both at -12 mm — and both hand-placed
hinges sit just in front of it (-9.9 mm and -10.6 mm). The front frame is not a
fixed fraction of anything; it is a dense band with a sharp rear edge.

### Anchor proportions measured within that band

| Quantity | Larsson | GRIPZ |
|---|---|---|
| band half-width (max abs x) | 73.1 mm | 73.1 mm |
| hand hinge x ÷ half-width | 0.912 | 0.897 |
| bridge bar y-extent at abs x < 3 mm | -7.0 … -15.9 | -6.9 … -16.7 |
| bridge bar midpoint | -11.5 mm | -11.8 mm |
| hand bridge y | **-9.6** | **-11.4** |
| bridge-centre rule error | 1.9 mm | 0.4 mm |
| hand bridge z behind front face | 3.6 mm | 3.7 mm |
| hand hinge y | -9.1 mm | -10.6 mm |

The bridge-centre rule predicts both hand anchors inside the 3 mm bar.

## Design

### Normalized-space contract

`calibrate()` runs after `normalizeModel()`, so the estimator always sees:
metres, front slab centred on x=0, top of the front at y=0, front plane at +Z.
Proportions expressed in this space transfer between models. This is existing
behaviour and is relied upon, not changed.

### `frontFrame.js` (new) — `segmentFrontFrame(positions)`

Bins vertices by Z from `bounds.max.z` backward and finds the first bin whose
count collapses relative to the running median of the band so far.

Returns `{ frontZMin, frontZMax, halfWidth, sharpness }`, where `sharpness` is
the density ratio across the cliff — a direct measure of how confidently the
front frame was located, and therefore of how far the derived anchors can be
trusted.

When no cliff is found (rimless or wraparound frames, where the temple blends
continuously into the front) it returns a proportional depth clamped to a
plausible millimetre range, with `sharpness` near zero to force the prior
downstream.

### `geometricEstimator.js` (rewritten)

**Hinges.** `z = frontZMin` (within 1–2 mm of hand placement on both models).
`x = ±HINGE_X_RATIO × halfWidth`, `HINGE_X_RATIO ≈ 0.905`, measured within the
band. `y` from the band's vertical extent in the hinge column.

**Bridge.** Take the column at `abs(x) < BRIDGE_COLUMN_RATIO × frameWidth`
(≈2%, i.e. ~3 mm on a 146 mm frame). `y` = midpoint of that column's vertical
extent. `z = frontZMax - BRIDGE_Z_INSET_RATIO × frameWidth`, where the ratio is
≈0.025 (3.6 mm and 3.7 mm on a ~146 mm frame — the two hand placements agree to
0.1 mm here). `x = 0` by construction.

All named constants are fitted against the reference set during implementation
and asserted by the tolerance test below — the exact values are an
implementation detail, the fitting procedure is not.

### `anchorPrior.js` (new) — canonical fallback

Expresses all three anchors as ratios of frame width alone, so a model whose
geometry cannot be read still gets an anatomically plausible placement rather
than a wild one.

Applied **per anchor**: each detected anchor is accepted only if it falls inside
a sanity window around the prior; otherwise the prior value is substituted. A
frame with a readable bridge but a mushy hinge region keeps the good bridge and
gets a safe hinge.

### Confidence rework

- Measure symmetry on the **front band only**, so temple asymmetry and rear
  branding stop dominating.
- Replace the weighted-**min** aggregation, where any one signal can zero the
  total, with a weighted **mean**, floored by orientation alone:
  `overall = min(weightedMean(subScores), orientationScore)`. Orientation keeps
  veto power because a model rotated onto the wrong axis invalidates every other
  measurement; no other single signal should be able to.
- Add `sharpness` as a signal, since it is now what actually predicts anchor
  quality.
- Record per-anchor provenance (`detected` vs `prior`) in
  `fitMetadata.provenance` so a low-confidence model is diagnosable after the
  fact. `provenance.source` keeps its current meaning and values
  (`tagged` / `geometric`) — `saveCalibratedModel` and the admin's `sourceLabel`
  both read it, so new keys are added alongside, never replacing it.
- `CONFIDENCE_THRESHOLD` stays at 0.6, and both reference models must clear it
  comfortably under the new aggregation (Larsson scores 0.000 today).

`needsManual` keeps its name and its DB status values (`ready` / `needs_manual`)
to avoid a migration, but its meaning becomes "spot-check this one" rather than
"a human must fix this" — which is already how the admin behaves.

### `measureFrontWidth` correction and its side effect

`measureFrontWidth` switches to the segmented band. This is correct, and it also
changes behaviour on-face: GRIPZ measures 160.8 mm today and ~146 mm after, and
`frameWidthMeters` is the denominator in

```
scale = clamp(templeSpan / frameWidthMeters, scaleLimits.min, scaleLimits.max)
```

so **a newly uploaded model renders roughly 10% larger than the same file would
today**. That is the right direction given the standing "glasses render too
small" issue, but it is a real change and it interacts with the `gscale` block
slider. Existing assets are unaffected because there is no backfill.

## Testing

**The existing fixtures are too sparse for this work and must be extended.**
`test/helpers/buildDoc.js` builds an in-memory `Document` from a flat position
array, and `build-fixtures.mjs` currently feeds it **six vertices** per model.
A density-cliff detector cannot be exercised on six vertices — there is no
density to profile.

So the helpers gain a procedural generator, `buildFrame({ frameWidth, frontDepth,
bridgeBarHeight, templeLength, density })`, emitting a plausible vertex
distribution: a dense front band, a bridge arch at x≈0, and two sparse temples
trailing to -z. Anchor ground truth is known by construction, so tolerance
assertions are exact.

The existing six-vertex fixtures stay for the tests that legitimately use them
(tag reading, validation, normalizer transforms), but **every existing test that
exercises `detectTemples`, `measureFrontWidth`, or `estimateAnchors` will need
updating**, because those functions change behaviour on sparse input. Expect
`geometricEstimator.test.js`, `geometry.temples.test.js`, `validator.test.js`,
`calibrator.test.js`, and `pipeline.integration.test.js` to require revision —
treat a failure there as expected churn to be re-baselined deliberately, not as
a regression to paper over.

New unit tests cover: cliff detection, the no-cliff fallback, per-anchor prior
substitution, symmetry measured on the band only, the new confidence
aggregation, and `measureFrontWidth` ignoring temple flare.

**Reference regression** (`scripts/anchor-audit.mjs`, new): points at any real
GLB, runs validate → normalize → estimate, and prints per-anchor Δ against that
file's own `AR_*` tags. Not in CI (the models are too large to commit); it is the
tool used to fit the constants and to verify the tolerance.

**Acceptance bar:** every anchor within **3 mm** of hand placement on both
reference models. No exemptions — since Larsson's 2026-09-10 re-export, both
models follow the bridge-centre rule.

## Risks

- **Constants fitted to two models.** Both are conventional full-rim frames from
  the same authoring pipeline. Rimless, wraparound, and thick-acetate frames are
  unrepresented; the prior and the per-anchor sanity gate exist to bound the
  damage, but the first genuinely odd merchant model is where this gets tested.
- **The size change is user-visible.** Anyone re-uploading an existing model will
  see it render larger than the copy already mapped.
- **Cliff detection assumes temples are sparser than the front.** A model with a
  very heavily tessellated temple could blunt the cliff; `sharpness` is designed
  to notice and fall back rather than to guess.

## Rollout

Implemented on `feature/auto-anchor-placement` in an isolated worktree.
**Nothing is deployed.** The change is validated locally against the reference
models and on-face by the user before any decision to ship; if the on-face result
is worse, the branch is dropped without touching `main`.

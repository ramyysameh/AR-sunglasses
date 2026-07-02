# Sub-project A — AR Fit & Model-Calibration Core

- **Date:** 2026-07-03
- **Status:** Approved (design). Next: implementation plan (writing-plans).
- **Parent:** [Shopify App Roadmap](2026-07-02-shopify-ar-tryon-roadmap-design.md) — Sub-project A, built first to de-risk the self-serve model.

## Goal

Prove that a merchant-supplied GLB can become a correctly-fitting, stable AR try-on
with little or no manual work. This is the make-or-break sub-project: if acceptable fit
requires heavy per-model manual tuning, the self-serve tier is not viable.

**Headless.** No Shopify integration and no merchant-facing UI (both are Sub-project B).

- **Input:** a GLB (optionally tagged) + the published modeling spec.
- **Output:** a validated + normalized model, a **fit-metadata record** (the contract
  Sub-project B stores per product), and a **confidence report**.

## Confirmed decisions

- **GLB input contract: hybrid** — publish a modeling spec, auto-calibrate, fall back to
  a manual anchor/scale step only when confidence is low.
- **Scope: headless core + dev harness.** The interactive calibration *logic* and a local
  harness live in A; the merchant-facing Polaris UI that wraps them is B.
- **Calibration strategy: tags-first (#2) + geometric fallback (#1).** Read embedded anchor
  tags if present (exact); otherwise derive anchors from geometry with a confidence score;
  low confidence → manual fallback. Rationale: keeps self-serve genuinely self-serve (most
  merchants won't tag) while giving the done-for-you tier a guaranteed-clean tagged path.
- **Reference-image alignment (#3) is cut from A** — an accuracy improvement, not needed to
  prove the pipeline. Deferred to a later revision, gated on kill-criterion data.
- **Confidence is a composite of named sub-signals, not an opaque scalar** — so the
  low-confidence threshold is tunable and debuggable.

## Fit-metadata schema (`eyewear-v1`)

Formalizes what the engine needs (today hand-authored in `src/config/tryOnConfig.js` and
`src/config/arConfig.js`). A versioned record:

- `frameWidthMeters` — real-world front width.
- `bridgeAnchor` / `bridgePivot` — resting contact + rotation pivot on the nose bridge.
- `leftHinge`, `rightHinge` — temple hinge points.
- `frontFramePlane` / `depthPivot` — front-of-frame reference for depth placement.
- `lensCenterOffset` — lens center relative to origin.
- `scaleLimits`, `templeFade`, `materialProfile` — existing render/fit tunables.
- `orientation` — canonical axes (see Modeling Spec).
- **Provenance:** `source` (`tagged` | `geometric`), the full `confidenceReport`,
  `fitProfileVersion`.

## Modeling spec (published conventions)

Single source of truth for both the Validator and the Calibrator:

- Units: **meters** (1 unit = 1 m).
- Orientation: **+Y up**, canonical front/temple axis (exact convention fixed in the plan).
- Origin: at the **bridge** contact point.
- Optional **anchor tags**: named glTF nodes / `extras` for `bridge`, `leftHinge`,
  `rightHinge` (exact names fixed in the plan).
- Poly budget + texture guidance for real-time mobile rendering.

## Module breakdown (single-responsibility units)

- **Modeling Spec** — the conventions above, as shared constants + docs.
- **Validator** — checks a GLB against the spec (expected meshes, poly budget, UVs/materials,
  plausible units, tag presence) → `pass | warn | fail` **with reasons**. Pure, no side effects.
- **Normalizer** — deterministically conforms what is safe to auto-correct: axis/orientation,
  unit scale, recenter origin to bridge, Draco compression, texture color space. Partly exists
  in `scripts/`.
- **Calibrator** — produces the fit-metadata:
  - *TagReader* — reads anchor tags → exact anchors (`source: tagged`).
  - *GeometricEstimator* — derives anchors from geometry when tags absent (`source: geometric`).
  - *ConfidenceScorer* — see below.
- **Fit Engine** (existing, hardened) — the MediaPipe + Three.js pipeline; consumes
  fit-metadata; A finishes the open tracking bugs to the acceptance bar.
- **Dev Harness** — standalone local page: load GLB → validate → normalize → calibrate →
  preview (mock face + webcam) → **show the confidence breakdown** → manually adjust anchors →
  export fit-metadata. Serves as the done-for-you tagging/QA tool and the automated-test rig.

## ConfidenceScorer

Composite; each sub-signal is normalized 0–1 and **independently inspectable**:

- `symmetryDeviation` — deviation of the mesh from bilateral symmetry about the X=0 plane.
- `templeDetectionCertainty` — clarity of the two temple-arm protrusions / hinge picks.
- `frameWidthOutlier` — measured front width vs. the human range (~120–150 mm).
- `orientationConfidence` — agreement of detected front/up axes with the spec.
- `scaleSanity` — bounding-box dimensions vs. plausible eyewear dimensions.

**Aggregation (proposed):** weighted-min, so any single bad signal drags the overall score
down (fail-safe). Overall score **plus the full per-signal breakdown** are emitted in the
report. Thresholds and weights are configurable. Below threshold → flagged for manual
adjustment (never silently shipped). Exact weights/thresholds are an open item, tuned against
the golden fixtures.

## Data flow

```
GLB → Validator (gate) → Normalizer → Calibrator
        (TagReader ∥ GeometricEstimator → ConfidenceScorer)
     → fit-metadata record → Fit Engine (render)
low confidence → manual adjust in harness → export fit-metadata
```

The **fit-metadata record is the contract handed to Sub-project B** (stored per product).

## Tracking fixes + acceptance bar

Fold the open tracking work into A:

- **Open:** 45°+ yaw scale-down / move-forward (needs `?fitdbg` real-device data to root-cause).
- **Mostly fixed:** residual tilt shake (via `motionLevel` smoothing) — confirm on device.
- **Coverage:** across face shapes, lighting, and mid-tier mobile.

**Proposed acceptance bar** (numbers finalized with real-device capture via the `?fitdbg`
overlay + a small metrics harness):

- Across **yaw ±45°, pitch ±25°, roll ±20°**: frame stays bridge-anchored within a set mm
  tolerance; apparent-scale drift under a set %; no visible static-at-angle shake
  (applied-rotation frame-to-frame jitter below a threshold).
- Sustained **≥ 30 fps** on iPhone-12 / Pixel-6-class devices in iOS Safari + Android Chrome.

## Error handling

- Validator fail → reject with actionable reasons (no silent bad fit).
- Calibrator low confidence → always flag for manual; never silently ship.
- Normalizer cannot conform → fail with reason.
- Fit Engine → keeps its existing low-tracking-quality freeze/degradation.

## Testing

- **Unit** per module, with **golden GLB fixtures** (well-formed / tagged / asymmetric /
  mis-scaled / bad) asserting exact anchors and each confidence sub-signal value.
- **Integration** — the full validate → normalize → calibrate pipeline on fixtures.
- **Engine regression** — the existing mock-turn harness + captured metrics guarding the
  acceptance bar; add a mock-tilt fixture if feasible.
- The dev harness doubles as manual QA.
- (Repo currently has only `validate-*.mjs` math/config validators — this establishes the
  first real test suite.)

## Scope boundaries — deferred

- Merchant Polaris UI, upload storage/CDN, product↔model DB, auth → **Sub-project B**.
- Reference-image alignment (#3) → later revision, gated on kill-criterion data.

## Open questions (resolve during planning/implementation)

- Exact canonical orientation axes and anchor-tag node names.
- ConfidenceScorer weights + the low-confidence threshold (tune against golden fixtures).
- Final acceptance-bar numbers (mm tolerance, %, jitter threshold) from real-device capture.

## Exit criteria

A tagged-or-spec-compliant GLB can be validated, normalized, auto-calibrated with a
transparent confidence breakdown, manually adjusted when needed via the harness, and rendered
as a correct, stable try-on on desktop and mid-tier mobile — with **no per-model source-code
changes** and the tracking acceptance bar met.

## Next step

Invoke the writing-plans skill to produce the implementation plan for this spec.

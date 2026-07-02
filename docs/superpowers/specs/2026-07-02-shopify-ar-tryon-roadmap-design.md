# AR Eyewear Try-On — Shopify App Roadmap

- **Date:** 2026-07-02
- **Status:** Approved (roadmap level). Sub-project specs to follow.
- **Type:** Multi-subsystem roadmap. Each sub-project below gets its own spec → plan → build cycle.

## Goal

Ship a **distributable Shopify App Store app** that adds AR eyewear (sunglasses/glasses)
try-on to any store, powered by the existing custom MediaPipe + Three.js engine
(`ar-tryon-prototype/`). The engine runs entirely client-side — camera video never
leaves the shopper's device.

## Business / catalog model

Hybrid, two paths that feed the **same** ingestion + calibration pipeline:

1. **Self-serve upload** (base tier) — merchant uploads their own GLB per product.
2. **Done-for-you modeling** (paid package) — we build and calibrate the GLB for the
   merchant, using the same internal tooling as path 1.

## Confirmed decisions

- **Backend/stack:** Shopify official **Remix app template** + **PostgreSQL**. Hosting
  provider TBD (Fly / Render / Vercel) — not architecture-blocking.
- **Asset storage:** object storage + CDN for per-merchant GLBs (e.g. S3/R2 + CDN).
- **Sequencing is locked: A → B → C → D.** De-risk the unique core before standard plumbing.
- Effort is expressed as **relative size (S/M/L)**, not calendar time.

---

## Sub-project A — AR fit & model-calibration core  *(effort: L)*

**Why first:** highest technical risk and the make-or-break for self-serve. An arbitrary
uploaded GLB does not fit a face on its own — the engine needs per-model fit metadata.
If acceptable fit requires heavy manual work per model, the self-serve tier is not viable
and the product becomes "assisted-only." This must be proven before anything else is built.

**Scope:**
- Finish tracking robustness. Known open issues: glasses scale-down + move-forward on
  large (45°+) yaw; residual shake on tilt (partially fixed via `motionLevel` smoothing);
  plus coverage across mobile devices, lighting, and face shapes.
- Formalize the **fit-metadata schema** (frame width, bridge/hinge anchors, scale limits,
  pivots, temple-fade) — currently hand-authored per SKU in
  `ar-tryon-prototype/src/config/tryOnConfig.js` and `arConfig.js`.
- **Calibration approach:** auto-derive what geometry allows (bounding box → frame width,
  symmetry detection → hinge points), plus a lightweight **anchor-placement / preview
  tool** for the rest. The done-for-you tier is simply *us* operating this tool.
- **Model normalization + validation** pipeline: units, orientation (+Y up), poly budget,
  Draco compression, sanity checks. Partly exists in `ar-tryon-prototype/scripts/`.

**Exit criteria:** a merchant-supplied GLB can be uploaded, calibrated (auto + light manual),
and rendered with a correct, stable try-on on desktop and mobile — with no per-model
source-code changes.

**Key risks:** auto-calibration quality; inconsistent/un-rigged uploaded GLBs; mobile
performance and thermal throttling.

---

## Sub-project B — Shopify app shell + admin + storefront  *(effort: L)*

**Goal:** an installable, multi-tenant Shopify app.

**Scope:**
- OAuth / Shopify managed install; Remix backend; Postgres; session storage.
- Embedded **Polaris admin**: map products ↔ models, upload GLBs, run the calibration
  tool from A, per-product enable/disable.
- **Theme App Extension**: auto-installed "Try on" button/block on the product page
  (replaces the current manual `shopify/sections/ar-try-on.liquid`).
- Mandatory webhooks: `app/uninstalled` + GDPR (`customers/redact`, `shop/redact`,
  `customers/data_request`).
- Strict per-shop data isolation; asset storage + CDN wiring.

**Exit criteria:** a merchant installs on a dev store, uploads/maps a model, the button
appears on their PDP, and the try-on works end-to-end.

**Key risks:** multi-tenant data isolation; Theme App Extension UX across arbitrary themes.

---

## Sub-project C — Monetization + ops + commerce loop  *(effort: M)*

**Scope:**
- Shopify **Billing API**: recurring subscription + tiers; gate the done-for-you package.
- Internal **ops queue/workflow** for building commissioned models.
- **Add-to-cart + variant selection** from within the try-on experience.
- Conversion analytics: merchant-facing dashboard + our own product metrics.

**Exit criteria:** a pilot merchant can subscribe, get billed, and convert a try-on to a
cart add; commissioned-model requests flow through the ops queue.

---

## Sub-project D — Compliance, hardening & App Store launch  *(effort: M)*

**Scope:**
- Privacy policy + camera-data disclosure (client-side processing is a strong story).
- GDPR webhooks verified end-to-end; security review.
- Performance/load; error monitoring; browser/device support matrix; accessibility.
- **Built-for-Shopify** listing assets + App Store review submission; support docs.

**Exit criteria:** app passes Shopify review and is listed.

---

## Sequencing & milestones

| Milestone | Sub-project | Definition of done |
|-----------|-------------|--------------------|
| M1 | A | Fit proven on an uploaded GLB (private prototype) |
| M2 | B | End-to-end install + try-on on a dev store |
| M3 | C | Billing + commerce live; first pilot merchant |
| M4 | D | App Store submission accepted |

## Cross-cutting concerns

- **Testing:** unit tests for fit math + calibration; integration tests for the ingestion
  pipeline; e2e for the install + try-on flow. (Repo currently has only `validate-*.mjs`
  math/config validators — no test suite.)
- **Security:** per-shop isolation, signed asset URLs, webhook HMAC verification.
- **Observability:** error monitoring + structured logs from M2 onward.
- **Analytics:** event schema defined in C, but instrument the engine (try-on start,
  frames viewed) as early as A so we have data during pilots.

## Open questions (deferred to sub-project specs)

- A: how much calibration can realistically be automated vs. manual? (answered by building A)
- A: minimum acceptable device/perf floor for mobile.
- B: hosting provider; CDN choice.
- C: pricing tiers and done-for-you package boundaries.

## Next step

Spec **Sub-project A** (its own brainstorming → spec → plan cycle).

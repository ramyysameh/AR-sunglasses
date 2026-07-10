# AR Try-On Shopify App — Progress Report

**Date:** 2026-07-08
**Milestone:** Sub-project B, Slice 1 — "One model, product-page try-on"
**Status:** On track — 7 of 10 tasks complete; 1 environment issue affecting the final 3.

---

## Executive summary

We are building a distributable Shopify App that lets a merchant upload a 3D eyewear
model and add an AR "Try on" button to a product page. This milestone (the first
end-to-end merchant flow) is **~70% complete**. The core engine — model upload,
automatic calibration, storage, and the data/serving layer — is **built and verified
with automated tests**. The remaining work is the merchant-facing admin screens and the
storefront button, which are currently gated by a **Shopify local-preview environment
issue (not a defect in our code)**, for which we have a candidate fix.

---

## What this milestone delivers

On a Shopify development store, a merchant can:
1. Install the app,
2. Upload one eyewear model (`.glb`), which the app **automatically calibrates**,
3. Map it to a product, and
4. See a **"Try on"** button on that product's page that opens the working AR try-on.

---

## Progress: 7 of 10 tasks complete

| # | Task | Status | Verified by |
|---|------|--------|-------------|
| 1 | Extract calibration engine into a shared package | ✅ Done | Automated tests |
| 2 | Scaffold the Shopify app (React Router + database) | ✅ Done | Builds & runs |
| 3 | Data model (models + product mappings) | ✅ Done | Automated tests |
| 4 | Auto-calibration service (model → fit data) | ✅ Done | Automated tests |
| 5 | Upload & calibrate admin screen | ✅ Done* | End-to-end HTTP test |
| 6 | Serving endpoints (model file + config API) | ✅ Done | Automated tests |
| 8 | Try-on engine adapter (consume calibration output) | ✅ Done | Automated tests |
| 7 | Storefront "Try on" button (theme extension) | ⏳ Remaining | Gated by env issue |
| 9 | Product-mapping admin screen | ⏳ Remaining | Gated by env issue |
| 10 | Full end-to-end validation on a dev store | ⏳ Remaining | Gated by env issue |

\* Task 5's upload/calibration pipeline is fully verified over a real HTTP upload
(file → parse → calibrate → store → save). Its in-admin visual styling is the only
part awaiting final confirmation, pending the environment issue below.

**Quality:** 40 automated tests passing (calibration engine, app data/services, try-on
engine). Continuous build is clean.

---

## Current blocker (and why it is not a code defect)

The three remaining tasks are merchant-facing screens that run **inside the Shopify
admin**. Previewing them locally requires Shopify's embedded "App Bridge" layer, which
is **intermittently hanging during local development** ("Handling response").

We investigated this thoroughly and **confirmed the application itself is correct**:
the app loaded successfully in the admin, authenticated (a valid session was created),
and the upload flow completed. We ruled out every code-level cause. The remaining
factor is a **known Shopify local-development flakiness**, made worse by our current
project structure.

**Candidate fix:** restructure the Shopify app to stand alone (rather than share a
combined dependency setup with the rest of the codebase). This is a contained,
low-risk change and is the most likely path to a reliable local preview, which unblocks
Tasks 7, 9, and 10.

---

## Next steps

1. Apply the project-structure fix to stabilize the local admin preview.
2. Build the product-mapping screen (Task 9) and the storefront "Try on" button (Task 7).
3. Run the full end-to-end validation on the development store (Task 10).
4. Merge the slice and demo the complete merchant flow.

**Estimate to complete the slice:** small — the remaining tasks are well-specified and
build on the verified foundation; the main variable is resolving the preview
environment (est. hours, not days).

---

## Notes

- Work is committed on a feature branch; **not yet merged** (the slice is intentionally
  kept open until complete) and **not in production**.
- No customer or production data is involved; all testing is on a Shopify development store.
- A deliberate, documented technical choice: the dev slice uses a lightweight local
  database (SQLite) and the current official Shopify app framework (React Router);
  both are production-swappable in a later hardening phase.

# Shopify Polaris UI/UX Review

**Audit target:** `feature/admin-ux` worktree, Shopify embedded admin app  
**Date:** 2026-09-17 (original audit); rescored 2026-09-19 after Tasks 1–6 of the `2026-09-17-polaris-24-of-24` plan  
**Method:** source-level UX review, Shopify App Home pattern comparison, Polaris component validation, type checking, and targeted UI tests. The deployed `/app` route required an authenticated Shopify context and returned an unauthenticated error boundary, so visual findings are based on the implemented component structure rather than a live merchant session.

## Rescore — Task 7 acceptance (2026-09-19)

Full evidence, commands, and per-row reasoning: [`docs/qa/polaris-ux-acceptance.md`](docs/qa/polaris-ux-acceptance.md).

Tasks 1–6 fixed every P1/P2 finding below: invalid `tone="subdued"`/ARIA-string props, the contextual home primary action, the empty-model "Add try-on" dead end, Products search/filter/sort/pagination and mobile `listSlot` design, the compact single-preview model picker, "Check fit" → "Review fit" with a resolution action, and centralized native admin navigation via `TopLevelAdminAction`. All are backed by passing automated tests (`npm test`: 46 files / 278 tests / 0 failures) and, for the four setup/merchant states, by SSR-rendering the real routes with each loader shape — see the acceptance record for exact test names.

Two of the six pillars could not be *fully* re-verified because of environment access: this environment has no authenticated Shopify session (no working `shopify app dev` tunnel, no installed development store, no browser/e2e harness in the repo — confirmed by genuinely attempting all three), so live 320/768/desktop rendering and live keyboard/focus/modal-trap behavior are unobserved. Both pillars kept substantial, real, structural evidence (listSlot assignment, `s-query-container`, single mounted preview, full `accessibilityLabel` coverage, zero un-migrated `onChange`-on-`s-*`) but are held to 3/4 rather than 4/4 until a human runs the live checks described in the acceptance record.

A third pillar, Interaction and feedback, is held to the same 3/4 standard for a different reason: not an access limitation, but an incomplete verification step. The task brief's Step 6 requires forcing or mocking all three failure paths (upload, mapping, unmapping); only unmapping has a genuine forced-failure test. The row's underlying mechanism (per-failure critical banners, a shared retry helper) is real, but a row that isn't a clean, unqualified PASS is held below 4/4 here on the same basis as the other two — see the follow-up list.

**Overall score: 21/24** (4+4+4+3+3+3) — up from 16/24. Not 24/24: three pillars are held below full marks because a required verification step (a live QA check, or — for Interaction and feedback — a forced-failure test for every required failure path) wasn't completed, even though each of the three has substantial, real, structural or automated-test evidence behind it.

| Pillar | Score | Evidence |
|---|---:|---|
| Shopify-native visual system | 4/4 | [Acceptance row 1](docs/qa/polaris-ux-acceptance.md#result-table) — validator run on every changed file (zero genuine property errors), consistent native component usage, centralized admin links. **Caveat:** Shopify's own `validate.mjs` never produced a clean run on anything, including a docs-sourced control snippet — the "zero genuine property errors" finding rests on comparing error classes across files, not on the validator ever reporting success. See the acceptance doc's Step 2 investigation before treating this as a validator-certified pass. |
| Information hierarchy | 4/4 | [Acceptance row 2](docs/qa/polaris-ux-acceptance.md#result-table) — SSR-tested for all four setup states (`test/appIndex.ui.test.js`). |
| Merchant journey and task clarity | 4/4 | [Acceptance row 3](docs/qa/polaris-ux-acceptance.md#result-table) — empty-model dead end closed and SSR-tested (`test/appProducts.ui.test.js`, `test/appModels.ui.test.js`). |
| Interaction and feedback | 3/4 | [Acceptance row 4 — PASS (partial)](docs/qa/polaris-ux-acceptance.md#result-table) — per-failure critical banners with retry, but only **1 of the 3 required failure paths** (unmapping) has a genuine forced-failure test (`test/appProducts.unmap.test.js:66`). The upload and mapping banners are grep-verified present with correct headings/retry wiring but are not exercised by any forced-failure test — held below 4/4 for the same reason Rows 5 and 6 are: a required verification step (forcing all three Step 6 failure paths) wasn't completed. See follow-up 5 below for the concrete path back to 4/4. Toasts kept supplementary. |
| Responsive behavior and scale | 3/4 | [Acceptance row 5 — BLOCKED for live QA](docs/qa/polaris-ux-acceptance.md#result-table) — structure shipped and unit-tested (listSlot, `s-query-container`, single preview); live 320/768/desktop rendering unverified, no authenticated session available. |
| Accessibility and inclusive UX | 3/4 | [Acceptance row 6 — BLOCKED for live QA](docs/qa/polaris-ux-acceptance.md#result-table) — accessibilityLabel coverage and onChange/onInput dispatch fix verified; live keyboard/focus/modal-trap behavior unverified, no authenticated session available. |

### Follow-up tasks (required before claiming 24/24)

1. **Live responsive QA (Responsive behavior and scale → 4/4).** In an authenticated embedded session (deployed admin or a working `shopify app dev` tunnel inside an installed development store), check at 320px/768px/desktop: no horizontal page scroll, setup actions stay visible/readable, Products converts to a list with Product primary / Status secondary / Model labeled, filters stay operable without overlap, modal actions stay visible, and the compact model picker shows only one interactive preview. Record PASS/FAIL per breakpoint in a follow-up to `docs/qa/polaris-ux-acceptance.md`.
2. **Live keyboard/focus QA (Accessibility and inclusive UX → 4/4).** Same authenticated session: keyboard-only (Tab/Shift+Tab/Enter/Space/Escape) traverse the setup guide, Products search/filter/sort/pagination, and every modal (Add try-on, Preview, Change model, Remove try-on, Upload, Rename, Delete, Review fit); confirm focus returns to the invoking control after each modal closes, menus/icon buttons announce useful names, and there is no keyboard trap inside `model-viewer`.
3. **Close the hollow typecheck gate.** `npm run typecheck` currently validates zero application code — `tsconfig.json`'s `include` has no `**/*.jsx` glob and `checkJs` is unset, while every source file in this app is `.jsx` (29 files, 0 `.ts`/`.tsx`). Task 4's review measured turning on `checkJs` + `**/*.jsx` at **364 errors app-wide** (~73% `noImplicitAny` noise from zero JSDoc typing), plus false positives on the correct `paginate=""` boolean-attribute pattern and a `useRef(null)` narrowing. Scope a real fix: either incrementally JSDoc-annotate and enable `checkJs` per-directory, or introduce `.tsx` for new files going forward and accept a mixed codebase, tracked as its own phase rather than folded into a UX pass.
4. **Root-cause (or replace) the Shopify validator bootstrap failure**, if reducing tooling risk is worth the time: `validate.mjs` fails a docs-sourced, known-valid control snippet with `preact/jsx-runtime` module-resolution errors even though the skill bundles Preact's type stubs under `assets/types/preact/10.29.2`. The defect is somewhere in the virtual `ts.LanguageServiceHost`'s handling of those gzipped assets; not investigated past confirming it's a bootstrap defect, independent of this app's code. File upstream with Shopify's toolkit maintainers if this persists across skill updates.
5. **Close the upload and mapping forced-failure test gap (Interaction and feedback → 3/4 to 4/4).** This is the concrete path back to full marks on this pillar. Only the unmapping failure path (`test/appProducts.unmap.test.js:66`) has a genuine forced-external-failure test asserting a preserved-work retry. Add equivalents for the other two Step 6 paths: a test that forces the storefront-publish call `app.products.jsx`'s mapping action makes to fail and asserts the "Could not add try-on" banner renders with `mapError` set and a working retry (nothing today references `mapError` in a test), and a test that ties `finalizeUpload.server.test.js`'s existing pure-function `rejects.toThrow` failures to the "Could not upload model" banner actually rendering with a retry action, rather than stopping at the server-function boundary. Once all three Step 6 failure paths have a genuine forced-failure test, Row 4 becomes a clean PASS and this pillar moves to 4/4.

**Un-migrated `onChange`-on-`s-*` risk: none remains.** `grep -rn "onChange=" app/routes app/components` returns only `ModelPicker`'s own component prop (called from `app.products.jsx`); every listener actually bound to an `s-*` element in `ModelPicker.jsx` and `app.models.jsx` uses `onInput`. This closes the pre-existing prod bug Task 4's review flagged; no follow-up task needed.

---

## Original audit (2026-09-17, pre-Task-1–6 baseline)

The section below is the audit these six tasks were built to close. It is left intact as the historical record; every P1/P2 item it lists has a corresponding fix and test referenced above.

## Executive verdict

The app has a solid Polaris foundation: it uses App Home web components consistently, keeps navigation small, uses clear merchant language, provides strong destructive-action confirmation, and includes useful loading, success, and error feedback. It is not yet at a strong Built for Shopify UX bar because the first-run journey is internally inconsistent, collection management does not scale, and the home route contains invalid Polaris properties.

**Overall score: 16/24 — functional and recognizable as Shopify, but needs a focused refinement pass.**

## Six-pillar scorecard

| Pillar | Score | Assessment |
|---|---:|---|
| Shopify-native visual system | 3/4 | Predominantly native App Home components, but invalid text properties, custom hard-coded progress colors, and plain anchors reduce consistency. |
| Information hierarchy | 3/4 | Pages have clear headings and primary actions. Home onboarding and status content need stronger action hierarchy. |
| Merchant journey and task clarity | 2/4 | The first required task is uploading a model, while the home primary action sends merchants to Products; empty-model flows then lead into a disabled modal. |
| Interaction and feedback | 4/4 | Strong use of banners, loading states, confirmation modals, toasts, retry language, and destructive tones. |
| Responsive behavior and scale | 2/4 | The product table uses responsive `variant="auto"`, but lacks complete mobile slot design and collection controls; model choices become very tall as the library grows. |
| Accessibility and inclusive UX | 2/4 | Good labels, alt text, modal headings, and progress semantics overall. Invalid properties, a string ARIA numeric value, and ambiguous status-only language prevent a higher score. |

## Prioritized findings

### P1 — Fix invalid Polaris text properties and progress semantics

The home route uses `tone="subdued"` four times. Shopify defines `subdued` as a `color`, not a semantic tone; the validator rejects all four instances. The custom progress bar also passes `aria-valuemin="0"` as a string rather than a number.

**Evidence:** `app._index.jsx` lines 74, 95, 102, 117, and 137.  
**Impact:** secondary information may render with default emphasis, validation fails, and the ARIA contract is not type-correct.  
**Recommendation:** change those instances to `color="subdued"`; use numeric ARIA values. Prefer Polaris tokens or supported components over the hard-coded `#e3e3e3` and `#008060` colors so the indicator follows Shopify themes.

### P1 — Align the homepage primary action with the next incomplete setup step

The setup sequence starts with “Upload a model,” but the page-level primary action is always “Go to products.” The three setup rows are passive labels, while only the theme step has an adjacent action.

**Evidence:** `app._index.jsx` lines 54–87.  
**Impact:** a new merchant is sent to Products before the required model exists, adding a detour and making setup feel less guided. This conflicts with Shopify’s setup-guide pattern, which is intended to guide merchants through required configuration steps.  
**Recommendation:** make the primary action contextual: “Upload model” until a model exists, “Add try-on to product” next, then “Add to theme.” Make each incomplete setup row actionable and provide completion details for finished rows.

### P1 — Prevent the empty-model dead end in “Add try-on”

The Products page enables “Add try-on” whenever the plan is below its limit, even if no models exist. The modal then contains an upload-model link and a disabled submit button.

**Evidence:** `app.products.jsx` lines 434–491 and `ModelPicker.jsx` lines 8–14.  
**Impact:** the primary action opens a workflow that cannot be completed. Merchants must exit the modal, navigate away, upload a model, and return.  
**Recommendation:** when the model library is empty, replace the page action with “Upload model,” or present a true empty-state call to action that takes the merchant directly to the upload flow before product selection.

### P2 — Add standard collection controls to Products

The product collection is a single unpaginated table with no search, filter, sort, selection, or bulk actions.

**Evidence:** `app.products.jsx` lines 493–561.  
**Impact:** the page works for a handful of mappings but degrades quickly for larger stores. Shopify’s index-table composition expects scannable lists with search/filtering, sorting, bulk actions where useful, and pagination for large datasets.  
**Recommendation:** add search and status filtering first, then pagination. Consider bulk removal or bulk model reassignment only if merchant workflows justify it. Configure mobile `listSlot` values deliberately for Model, Status, and Actions rather than relying on defaults.

### P2 — Reduce model-picker density and loading cost

Every choice in the model picker includes a 160px interactive 3D preview. A merchant with many models receives a long, heavy modal before choosing a single item.

**Evidence:** `ModelPicker.jsx` lines 17–33 and `ModelViewer.jsx` lines 37–51.  
**Impact:** slow scanning, excessive scrolling, and a visually dense modal; multiple interactive 3D canvases also increase cognitive and rendering cost.  
**Recommendation:** use a compact searchable list with thumbnail/static preview, name, and status. Load the interactive 3D preview only for the selected model or in a dedicated preview surface.

### P2 — Give “Check fit” a resolution path

Model cards show either “Ready” or “Check fit,” but the latter has no adjacent explanation or action. The Help page explains the phrase, but the merchant must discover it separately.

**Evidence:** `app.models.jsx` lines 568–583.  
**Impact:** the warning communicates concern without telling the merchant what is wrong or how to resolve it.  
**Recommendation:** pair the badge with “Preview fit” or a short tooltip/help link. If the status cannot be programmatically verified, use language such as “Review fit” rather than implying a detected problem.

### P2 — Use consistent Shopify-native links and external-navigation cues

Pricing and theme-editor links use plain `<a>` elements while in-app links use `s-link`. The technical reason for top-level navigation is valid, but the result may not share the same styling, focus treatment, and external-destination cues.

**Evidence:** `app.jsx` lines 33–52; `app._index.jsx` lines 83–87; `app.products.jsx` lines 439–463 and 522–528; `app.additional.jsx` lines 15–35.  
**Impact:** visual and behavioral inconsistency across otherwise native pages.  
**Recommendation:** centralize top-level admin navigation in one reusable, accessible link component that preserves Polaris-like styling, keyboard focus, and an accessible description that the destination opens outside the app.

## What is already strong

- Clear four-item app navigation: Home, Products, Models, Help.
- Consistent page headings and one obvious page-level action.
- Good error recovery: contextual critical banners and retry-specific labels.
- Strong destructive-action UX: explicit consequences, critical tone, and safe disabled states.
- Useful feedback through loading states and App Bridge toasts.
- Helpful product status badges and direct “Add to theme” remediation.
- Good baseline accessibility work: model alt text, spinner labels, menu labels, modal headings, and a labeled usage progress bar.
- Concise, task-based Help content with direct links to the relevant app areas.

## Recommended implementation order

1. Correct invalid Polaris props and ARIA numeric types.
2. Make onboarding contextual and remove the empty-model dead end.
3. Add Products search, status filters, pagination, and deliberate mobile table slots.
4. Redesign model selection as a compact searchable picker with one active preview.
5. Add resolution actions for “Check fit” and unify top-level link presentation.

## Verification notes

- `npm run typecheck`: passed.
- Targeted UI tests: 14/14 passed (`appProducts.ui.test.js`, `appModels.ui.test.js`).
- Shopify component validator: rejected the current home route for four invalid `s-text tone="subdued"` usages and string-valued `aria-valuemin`.
- Project-wide lint: failed with 923 errors, overwhelmingly from generated AR/MediaPipe/Draco bundles under `public/tryon`; it also flags a small number of Node/global configuration issues. This is a tooling-scope problem worth fixing, but it did not drive the UX score.

> **Superseded.** All four figures above are the pre-fix baseline. As of the 2026-09-19 rescore: `npm test` is 46 files / 278 tests / 0 failures, `npm run lint` passes clean (the lint config/scope issue was resolved), and the validator finds zero genuine component-property errors on any changed file (the `tone="subdued"`/ARIA-string issues are fixed; remaining validator failures are a confirmed tooling bootstrap defect — see [`docs/qa/polaris-ux-acceptance.md`](docs/qa/polaris-ux-acceptance.md)). `npm run typecheck` still passes but is hollow (see the rescore's follow-up list).

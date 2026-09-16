# Task 5 Report: Upload-First Add Try-On Flow

## Status

Implemented the reducer-driven `AddTryOnFlow` and minimally connected it to the workspace index route.

The flow enforces model -> product -> review, supports ready-library selection and embedded upload auto-advance, preserves selections through picker cancellation and publish retry, and resets only on explicit close or successful publish. A valid `initialModelId` starts at product selection; stale or non-ready ids start at model selection.

## Files

- Created `apps/shopify-app/app/components/AddTryOnFlow.jsx`
- Created `apps/shopify-app/test/addTryOnFlow.ui.test.js`
- Modified `apps/shopify-app/app/routes/app._index.jsx`

## Verification

- `npm test -- addTryOnFlow.ui.test.js modelUploadFlow.ui.test.js appProducts.ui.test.js appIndex.loader.test.js`: 25 passed
- `npx eslint app/components/AddTryOnFlow.jsx app/routes/app._index.jsx test/addTryOnFlow.ui.test.js`: passed
- `npm run typecheck`: passed
- `git diff --check`: passed

## Concerns

- Repository-wide `npm run lint` remains blocked by 929 pre-existing errors outside Task 5, primarily generated files under `public/tryon`, plus unrelated server/config files.
- `npm run build` remains blocked by the existing `app.products.jsx` client import of `workspace.server`; the failure does not originate in the Task 5 files.

## Fix Round 1

Status: addressed all round 1 findings.

Changes:

- Normalized the real finalize descriptor `{ assetId, status, source, confidence, needsManual }` in `ModelUploadFlow`, producing one canonical asset object with `id: uploaded.id ?? uploaded.assetId` while retaining all original fields.
- Updated the upload callback integration test to use the real finalize response shape and assert the callback receives `id`.
- Added AddTryOnFlow integration coverage proving an uploaded descriptor reaches review with a defined `modelAssetId`.
- Made `modelName` safe for malformed descriptors without an `id`.
- Consolidated `onClose` ownership in a per-session guarded `afterhide` path, so explicit close and publish success notify exactly once.
- Scoped publish responses to a submission started in the current open session and consumed each response once. New sessions ignore retained success and error data from prior sessions.
- Added an effect-capable hook test harness covering explicit close, successful publish, stale success on reopen, and stale error on reopen.

Results:

- RED: real finalize descriptor callback test failed because `id` was absent.
- RED: all four lifecycle effect tests failed before the lifecycle fix (duplicate close, duplicate success close, stale success, stale error).
- `npm test -- modelUploadFlow.ui.test.js addTryOnFlow.ui.test.js addTryOnFlow.effects.test.js apiModelUpload.route.test.js appProducts.ui.test.js appIndex.loader.test.js`: 35 passed.
- `npx eslint app/components/ModelUploadFlow.jsx app/components/AddTryOnFlow.jsx test/modelUploadFlow.ui.test.js test/addTryOnFlow.ui.test.js test/addTryOnFlow.effects.test.js`: passed with zero warnings.
- `npm run typecheck`: passed.
- `git diff --check`: passed.

SHA: this report is part of the atomic fix commit; its exact SHA is returned in the completion response because a commit cannot contain its own final hash.

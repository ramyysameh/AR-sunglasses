# Presigned Direct-to-Storage Model Upload

**Date:** 2026-09-04
**Status:** Approved design (pre-implementation)
**Component:** `apps/shopify-app` — admin model upload

## Problem

Uploading a model GLB through the admin **Models** page fails with **HTTP 413
(Payload Too Large)** for files bigger than ~4.5 MB. The upload action buffers
the entire file through the serverless function request body
(`app.models.jsx`: `request.formData()` → `file.arrayBuffer()`), and Vercel
caps a serverless function's request body at ~4.5 MB. That cap is a platform
limit — it cannot be raised in application code.

Real models exceed this: an un-optimized export is ~8.8 MB. Merchants (and we)
need to upload larger files.

## Goal

Accept model uploads up to **25 MB** by sending the file **from the browser
directly to object storage** via a presigned `PUT` URL, bypassing the
serverless request-body cap entirely. The server then calibrates the model by
reading it from storage. Show a determinate **upload progress bar** during the
direct upload.

25 MB matches the existing register-by-URL cap (`remoteGlb.server.js`
`MAX_GLB_BYTES`), whose reasoning applies here too: `calibrateUpload` parses and
re-exports the GLB in memory (gltf-transform), so peak memory is a multiple of
the file size, and 25 MB stays clear of Vercel's 1 GB function limit.

## Non-goals / out of scope

- Resumable or multipart uploads (unnecessary at a 25 MB ceiling).
- Any change to the register-by-URL path (`registerModelByUrl`).
- Raising the ceiling above 25 MB (would risk OOM during calibration).

## Existing infrastructure this reuses

- **`storage.server.js`** — S3 / S3-compatible object storage
  (`@aws-sdk/client-s3`); `saveModelGlb`, `readModelGlb`, `deleteModelGlb`.
  Works with AWS S3 or Cloudflare R2 (selected by the `S3_ENDPOINT` env var).
- **`models.server.js` `saveCalibratedModel(prisma, shop, glbBytes, filename)`**
  — calibrates, validates, stores the normalized GLB under a fresh key, and
  creates the `ModelAsset` row. Reused **unchanged**.
- **`calibration.server.js` `calibrateUpload`** — normalize + validate.
- **`remoteGlb.server.js` `MAX_GLB_BYTES`** — the 25 MB constant, reused.
- Billing gate: `getActivePlanName(admin, session.shop)` (already used by the
  current upload action).

## Design

### Flow (replaces the single buffered POST)

1. **Presign** — client POSTs `intent=upload-presign` (tiny JSON) to the
   `app.models.jsx` action. Server:
   - `authenticate.admin(request)`, then `getActivePlanName`; no active plan →
     `{ error: 'No active subscription…' }` (same message as today).
   - Mints a temp key `uploads/<uuid>.glb`.
   - Returns `{ uploadUrl, storageRef }` where `uploadUrl` is a presigned `PUT`
     URL with a 5-minute expiry.
2. **Direct PUT** — client uploads the file bytes straight to `uploadUrl`.
   - Uses **`XMLHttpRequest`** (not `fetch`) so `xhr.upload.onprogress`
     drives the progress bar.
   - `Content-Type: model/gltf-binary` (must match the presigned command's
     ContentType).
   - Client pre-checks the file is a `.glb` and ≤ 25 MB before requesting the
     presign — instant feedback, avoids a wasted round trip. This is UX only;
     the server enforces the real limit.
3. **Finalize** — client POSTs `intent=upload-finalize` with
   `{ storageRef, filename }`. Server:
   - `authenticate.admin` + `getActivePlanName` again (re-gate).
   - Validates `storageRef` matches `^uploads/[0-9a-f-]+\.glb$` (never trust a
     client-supplied key; reject anything outside the temp prefix).
   - `readModelGlb(storageRef)` → raw bytes. `null` (missing/expired) →
     `{ error: 'Upload expired, please try again.' }`.
   - Enforce `bytes.length <= MAX_GLB_BYTES`; over → delete temp key + error.
   - `deleteModelGlb(storageRef)` (temp key is now consumed).
   - `saveCalibratedModel(prisma, shop, bytes, filename)` → calibrates, stores
     the **permanent normalized** GLB under its own fresh key, creates the row.
   - Return the existing `uploaded` summary shape the UI already consumes.
   - On **any** finalize failure (oversize, calibration validation throw,
     storage error), the temp key is deleted so nothing orphans.

The `uploads/<uuid>.glb` key is a transport buffer only. Because the serving
route (`models.$assetId[.]glb.jsx`) requires a `ModelAsset` row, and the row is
created only inside `saveCalibratedModel` (with a different permanent key), the
raw uploaded bytes are never publicly served.

### New / changed code

- **`storage.server.js`**: add
  `presignModelUpload(storageRef, { expiresIn = 300 } = {})` using
  `@aws-sdk/s3-request-presigner` `getSignedUrl` + `PutObjectCommand`
  (`ContentType: 'model/gltf-binary'`). Built from the same lazy `getClient()`.
- **`app.models.jsx` action**: add `upload-presign` and `upload-finalize`
  intents (both billing-gated). **Remove** the `form.get('model')` /
  `file.arrayBuffer()` branch.
- **`app.models.jsx` client (`upload()` + component)**:
  presign → XHR PUT (progress) → finalize. Add the ≤ 25 MB / `.glb` client
  check. Keep existing toast + fetcher result handling.
- **New dependency**: `@aws-sdk/s3-request-presigner`, pinned to the same
  version as the installed `@aws-sdk/client-s3`.

### Upload progress bar (UX)

- Component state: `idle → uploading(percent) → calibrating → done | error`.
- During the direct PUT, `xhr.upload.onprogress` sets
  `percent = Math.round(loaded / total * 100)`; render a **determinate**
  progress bar (Polaris `s-progress-bar` / `ProgressBar` if available in this
  app-home component set, otherwise a labeled `N%` text + a simple bar).
- When the PUT completes and finalize begins, switch the label to
  **"Calibrating…"** with an indeterminate/spinner state — calibration runs
  server-side and takes a few seconds; the percentage no longer applies.
- On error at any step, clear the bar and show the existing error toast.

### Size & safety

- Authoritative size enforcement is **server-side on finalize** (byte length
  vs `MAX_GLB_BYTES`); the client check is UX only.
- Billing gate on **both** presign and finalize.
- Temp key restricted to the `uploads/` prefix and validated server-side on
  finalize.

### Infra (one-time, not code)

- **CORS** on the bucket must allow `PUT` and `OPTIONS` (preflight) from the
  app's origin (the Vercel domain that serves the embedded admin), with
  allowed header `content-type`. The spec ships ready-to-paste CORS JSON for
  **AWS S3** and **Cloudflare R2**; confirm which by checking whether
  `S3_ENDPOINT` is set in the Vercel env (set → R2/compatible, unset → AWS S3).
- **Lifecycle rule**: expire objects under the `uploads/` prefix after 1 day,
  to reap uploads abandoned before finalize (browser closed mid-flow).

Example CORS (adapt origin):

```json
[
  {
    "AllowedOrigins": ["https://<app-domain>"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3000
  }
]
```

### Error handling summary

| Step | Failure | Result |
|------|---------|--------|
| Presign | no active plan | error toast, no URL issued |
| PUT | network / CORS / expiry | error toast, nothing persisted (no row) |
| Finalize | temp object missing/expired | "Upload expired, please try again." |
| Finalize | bytes > 25 MB | delete temp key, error toast |
| Finalize | calibration validation throws | delete temp key, existing error surface |

## Testing

- **Unit — `presignModelUpload`**: returns a URL string for a given key
  (mock `getSignedUrl`); passes the expected Bucket/Key/ContentType.
- **Unit — finalize handler**: happy path reads temp bytes → deletes temp key →
  calls `saveCalibratedModel` with the bytes + filename → returns summary.
  Rejection paths: oversize (deletes temp, errors), missing object (errors),
  no active plan (errors), bad `storageRef` prefix (errors).
- **Unit — presign handler**: no active plan → error, no key minted.
- **Regression**: existing `saveCalibratedModel` / calibration / `remoteGlb`
  tests stay green (those modules are unchanged).
- **Manual E2E**: upload the 8.8 MB full-res `gripz_G_yellow.glb` through the
  admin Models page and confirm it calibrates and appears in the list — the
  exact file/size that produced the original 413.

## Rollout notes

- Requires the bucket CORS rule to be live **before** the client PUT will
  succeed; deploy the CORS config first (or alongside).
- The old buffered path is removed, so no dual-path period — the CORS rule is a
  hard prerequisite for any upload after deploy.

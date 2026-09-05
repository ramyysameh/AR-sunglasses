# Presigned Direct-to-Storage Model Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the admin upload model GLBs up to 25 MB by sending the file from the browser directly to object storage via a presigned PUT URL (bypassing Vercel's ~4.5 MB serverless body cap), then calibrating server-side from storage, with an upload progress bar.

**Architecture:** Add two small, HTTP-free server functions — `presignModelUpload` (storage) and `finalizeUpload` (models) — and make the `app.models.jsx` route action a thin dispatcher for two new intents (`upload-presign`, `upload-finalize`). The client runs presign → XHR PUT (with progress) → finalize. The temp `uploads/<uuid>.glb` object is a transport buffer that finalize reads, deletes, and hands to the existing unchanged `saveCalibratedModel` pipeline.

**Tech Stack:** Remix (react-router) + Shopify App Bridge v4, Vitest, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, S3/S3-compatible (R2) object storage, Prisma.

## Global Constraints

- New dependency `@aws-sdk/s3-request-presigner` pinned to `^3.1090.0` (exact match of the installed `@aws-sdk/client-s3`).
- Max upload size is `MAX_GLB_BYTES` = `25 * 1024 * 1024`, enforced authoritatively server-side in `finalizeUpload`.
- Temp upload key format is exactly `uploads/<uuid>.glb`; the server validates this prefix/shape and rejects anything else.
- Upload PUT Content-Type is `model/gltf-binary` (must match on presign and on the client PUT).
- Billing gate (`getActivePlanName`) already runs at the top of the `app.models.jsx` action for every intent — do not remove it; both new intents inherit it.
- Do NOT modify `registerModelByUrl` or the register-by-URL route.
- Tests run with `npm test` (`vitest run`) from `apps/shopify-app`.

---

### Task 1: `presignModelUpload` in storage layer

**Files:**
- Modify: `apps/shopify-app/package.json` (add dependency)
- Modify: `apps/shopify-app/app/storage.server.js`
- Test: `apps/shopify-app/test/presignUpload.server.test.js`

**Interfaces:**
- Produces: `presignModelUpload({ expiresIn?: number } = {}) : Promise<{ uploadUrl: string, storageRef: string }>` — `storageRef` matches `uploads/<uuid>.glb`; `uploadUrl` is a presigned S3 PUT URL.

- [ ] **Step 1: Add the dependency**

Edit `apps/shopify-app/package.json` — add to `dependencies`, keeping alphabetical order near the other `@aws-sdk` entry:

```json
"@aws-sdk/s3-request-presigner": "^3.1090.0",
```

Then install:

```bash
cd apps/shopify-app && npm install
```

- [ ] **Step 2: Write the failing test**

Create `apps/shopify-app/test/presignUpload.server.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'

// Mock the presigner so no signing/network happens; assert we hand it the right command.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://bucket.example/signed-put'),
}))

process.env.S3_BUCKET = 'test-bucket'

const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
const { presignModelUpload } = await import('../app/storage.server.js')

describe('presignModelUpload', () => {
  it('returns a presigned PUT url and an uploads/-prefixed .glb key', async () => {
    const { uploadUrl, storageRef } = await presignModelUpload()
    expect(uploadUrl).toBe('https://bucket.example/signed-put')
    expect(storageRef).toMatch(/^uploads\/[0-9a-f-]+\.glb$/)

    const cmd = getSignedUrl.mock.calls[0][1]
    expect(cmd.input.Bucket).toBe('test-bucket')
    expect(cmd.input.Key).toBe(storageRef)
    expect(cmd.input.ContentType).toBe('model/gltf-binary')
  })

  it('passes the requested expiry through', async () => {
    await presignModelUpload({ expiresIn: 120 })
    const opts = getSignedUrl.mock.calls.at(-1)[2]
    expect(opts.expiresIn).toBe(120)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/shopify-app && npx vitest run test/presignUpload.server.test.js`
Expected: FAIL — `presignModelUpload` is not exported.

- [ ] **Step 4: Implement `presignModelUpload`**

In `apps/shopify-app/app/storage.server.js`, add to the top imports (a separate line after the existing `@aws-sdk/client-s3` import):

```js
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
```

Add this exported function (after `getClient`, before `saveModelGlb`). `PutObjectCommand` is already imported in this file:

```js
/**
 * Presigned PUT URL for a direct browser->storage model upload, bypassing the
 * serverless request-body size cap. The returned key lives under `uploads/` — a
 * transport buffer that `finalizeUpload` consumes (reads + deletes) after the
 * client PUT. Default 5-minute expiry: long enough for a 25 MB upload on a slow
 * connection, short enough that a leaked URL is not a lasting capability.
 */
export async function presignModelUpload({ expiresIn = 300 } = {}) {
  const storageRef = `uploads/${globalThis.crypto.randomUUID()}.glb`
  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageRef,
      ContentType: 'model/gltf-binary',
    }),
    { expiresIn },
  )
  return { uploadUrl, storageRef }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/shopify-app && npx vitest run test/presignUpload.server.test.js`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add apps/shopify-app/package.json apps/shopify-app/package-lock.json apps/shopify-app/app/storage.server.js apps/shopify-app/test/presignUpload.server.test.js
git commit -m "feat: presigned PUT url for direct model upload

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `finalizeUpload` in models layer

**Files:**
- Modify: `apps/shopify-app/app/remoteGlb.server.js` (export the size constant)
- Modify: `apps/shopify-app/app/models.server.js`
- Test: `apps/shopify-app/test/finalizeUpload.server.test.js`

**Interfaces:**
- Consumes: `readModelGlb(ref)`, `deleteModelGlb(ref)`, `saveModelGlb(ref, bytes)` (storage); `saveCalibratedModel(prisma, shop, bytes, filename)` (models); `MAX_GLB_BYTES` (remoteGlb); `tagged(code, msg)` (errors).
- Produces: `finalizeUpload(prisma, shop, storageRef, filename = null) : Promise<{ assetId, status, source, confidence, needsManual }>` — same summary shape as `saveCalibratedModel`. Throws `tagged`-coded errors: `BAD_UPLOAD_KEY`, `UPLOAD_MISSING`, `TOO_LARGE`.

- [ ] **Step 1: Export the size constant**

In `apps/shopify-app/app/remoteGlb.server.js`, change the declaration (currently `const MAX_GLB_BYTES = 25 * 1024 * 1024`) to export it:

```js
export const MAX_GLB_BYTES = 25 * 1024 * 1024
```

- [ ] **Step 2: Write the failing test**

Create `apps/shopify-app/test/finalizeUpload.server.test.js`:

```js
import { describe, it, expect, afterAll, vi } from 'vitest'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { buildDoc } from '@artryon/calibration/test/helpers/buildDoc.js'
import prisma from '../app/db.server.js'

const storage = vi.hoisted(() => ({ objects: new Map(), deleted: [] }))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (ref, bytes) => { storage.objects.set(ref, Buffer.from(bytes)) },
  readModelGlb: async (ref) => storage.objects.get(ref) ?? null,
  deleteModelGlb: async (ref) => { storage.deleted.push(ref); storage.objects.delete(ref) },
}))

const { finalizeUpload } = await import('../app/models.server.js')
const { MAX_GLB_BYTES } = await import('../app/remoteGlb.server.js')

const shop = 'finalize-test.myshopify.com'
const GOOD = [
  -0.069, 0, 0.02, 0.069, 0, 0.02, 0, 0.024, 0.02,
  -0.069, 0, -0.13, 0.069, 0, -0.13, 0, -0.02, 0.02,
]
async function taggedGlbBytes() {
  const doc = buildDoc(GOOD, {
    AR_bridge: { x: 0, y: 0.024, z: 0.02 },
    AR_hinge_L: { x: -0.069, y: 0, z: -0.01 },
    AR_hinge_R: { x: 0.069, y: 0, z: -0.01 },
  })
  return new NodeIO().registerExtensions(KHRONOS_EXTENSIONS).writeBinary(doc)
}

afterAll(async () => {
  storage.objects.clear(); storage.deleted.length = 0
  await prisma.modelAsset.deleteMany({ where: { shop } })
})

describe('finalizeUpload', () => {
  it('reads the temp object, deletes it, calibrates, and persists a ready asset', async () => {
    const ref = 'uploads/11111111-1111-4111-8111-111111111111.glb'
    storage.objects.set(ref, Buffer.from(await taggedGlbBytes()))

    const res = await finalizeUpload(prisma, shop, ref, 'hat.glb')
    expect(res.status).toBe('pass')
    expect(storage.deleted).toContain(ref)          // temp buffer removed
    expect(storage.objects.has(ref)).toBe(false)

    const asset = await prisma.modelAsset.findUnique({ where: { id: res.assetId } })
    expect(asset.shop).toBe(shop)
    expect(asset.filename).toBe('hat.glb')
    expect(asset.storageRef).not.toBe(ref)          // permanent model has its own key
  })

  it('rejects a key outside the uploads/ prefix', async () => {
    await expect(finalizeUpload(prisma, shop, 'models/evil.glb', null))
      .rejects.toThrow(/invalid upload key/i)
  })

  it('errors when the temp object is missing/expired', async () => {
    await expect(finalizeUpload(prisma, shop, 'uploads/22222222-2222-4222-8222-222222222222.glb', null))
      .rejects.toThrow(/expired/i)
  })

  it('rejects and cleans up an oversize upload', async () => {
    const ref = 'uploads/33333333-3333-4333-8333-333333333333.glb'
    storage.objects.set(ref, Buffer.alloc(MAX_GLB_BYTES + 1))
    await expect(finalizeUpload(prisma, shop, ref, null)).rejects.toThrow(/exceeds/i)
    expect(storage.deleted).toContain(ref)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/shopify-app && npx vitest run test/finalizeUpload.server.test.js`
Expected: FAIL — `finalizeUpload` is not exported.

- [ ] **Step 4: Implement `finalizeUpload`**

In `apps/shopify-app/app/models.server.js`, extend the storage import and add the `MAX_GLB_BYTES` import. Current line 2 imports only `saveModelGlb`; change it and add line 3's sibling:

```js
import { saveModelGlb, readModelGlb, deleteModelGlb } from './storage.server.js'
import { fetchRemoteGlb, assertAllowedGlbUrl, MAX_GLB_BYTES } from './remoteGlb.server.js'
```

Add this exported function (after `saveCalibratedModel`):

```js
const TEMP_UPLOAD_KEY = /^uploads\/[0-9a-f-]+\.glb$/

/**
 * Finalize a direct (presigned) upload: the client has already PUT the raw GLB to
 * the temp `uploads/<uuid>.glb` key. Read it, size-check it, delete the temp
 * buffer, and run the same calibrate->store->persist pipeline as a normal upload.
 *
 * The temp key is client-supplied, so its shape is validated (never trust a raw
 * key — an attacker could otherwise point us at any object). Size is enforced
 * here authoritatively; the browser check is only UX.
 */
export async function finalizeUpload(prisma, shop, storageRef, filename = null) {
  if (typeof storageRef !== 'string' || !TEMP_UPLOAD_KEY.test(storageRef)) {
    throw tagged('BAD_UPLOAD_KEY', `invalid upload key: ${String(storageRef)}`)
  }
  const bytes = await readModelGlb(storageRef)
  if (!bytes) {
    throw tagged('UPLOAD_MISSING', 'upload expired, please try again')
  }
  if (bytes.length > MAX_GLB_BYTES) {
    await deleteModelGlb(storageRef)
    throw tagged('TOO_LARGE', `upload ${bytes.length} exceeds ${MAX_GLB_BYTES}`)
  }
  // Bytes are in memory now; the temp buffer is no longer needed. Deleting before
  // calibration means a calibration failure leaves no orphan behind either.
  await deleteModelGlb(storageRef)
  return saveCalibratedModel(prisma, shop, bytes, filename)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd apps/shopify-app && npx vitest run test/finalizeUpload.server.test.js`
Expected: PASS (all four).

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `cd apps/shopify-app && npm test`
Expected: PASS — existing `models.server.test.js`, `calibration.server.test.js`, `remoteGlb.server.test.js` still green.

- [ ] **Step 7: Commit**

```bash
git add apps/shopify-app/app/remoteGlb.server.js apps/shopify-app/app/models.server.js apps/shopify-app/test/finalizeUpload.server.test.js
git commit -m "feat: finalizeUpload calibrates a presigned upload from storage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire the route action (presign + finalize intents)

**Files:**
- Modify: `apps/shopify-app/app/routes/app.models.jsx` (action, lines 38–96)

**Interfaces:**
- Consumes: `presignModelUpload` (storage), `finalizeUpload` (models).
- Produces (HTTP): `intent=upload-presign` → JSON `{ uploadUrl, storageRef }` or `{ error }`; `intent=upload-finalize` (`storageRef`, `filename`) → JSON `{ uploaded }` or `{ error }`.

- [ ] **Step 1: Extend imports**

At the top of `app.models.jsx`, wherever `saveCalibratedModel`/`mapProductToModel` are imported from `../models.server.js`, add `finalizeUpload` and drop `saveCalibratedModel` if it is no longer referenced elsewhere in the file. Add a `presignModelUpload` import from `../storage.server.js`. Example:

```js
import { finalizeUpload, mapProductToModel, listMappings } from '../models.server.js'
import { presignModelUpload } from '../storage.server.js'
```

(Keep whatever other names the existing import already pulls in; only swap `saveCalibratedModel` → `finalizeUpload` and add the storage import.)

- [ ] **Step 2: Add the two intents; remove the buffered branch**

In the `action`, after the `unmap` branch and BEFORE the old `const file = form.get('model')` block, add:

```js
  if (intent === 'upload-presign') {
    return await presignModelUpload()
  }

  if (intent === 'upload-finalize') {
    const storageRef = form.get('storageRef')?.toString()
    const filename = form.get('filename')?.toString() || null
    try {
      const uploaded = await finalizeUpload(prisma, session.shop, storageRef, filename)
      return { uploaded }
    } catch (e) {
      return { error: e.message }
    }
  }
```

Then DELETE the old buffered upload block entirely (the current lines 84–95):

```js
  const file = form.get('model')
  if (!file || typeof file === 'string') {
    return { error: 'Choose a .glb file to upload.' }
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  const filename = typeof file.name === 'string' ? file.name : null
  try {
    const uploaded = await saveCalibratedModel(prisma, session.shop, bytes, filename)
    return { uploaded }
  } catch (e) {
    return { error: e.message }
  }
```

Replace it with a fallthrough for unknown intents:

```js
  return { error: 'Unknown action.' }
```

The billing gate at the top of the action (the `getActivePlanName` / `if (!activePlan)` block) is unchanged and still guards every intent, including both new ones.

- [ ] **Step 3: Lint + typecheck**

Run: `cd apps/shopify-app && npm run lint && npm run typecheck`
Expected: PASS, no unused-import warnings for `saveCalibratedModel`.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify-app/app/routes/app.models.jsx
git commit -m "feat: models action serves upload-presign and upload-finalize intents

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client — presign → PUT (progress) → finalize

**Files:**
- Modify: `apps/shopify-app/app/routes/app.models.jsx` (`Models` component)

**Interfaces:**
- Consumes (HTTP): the two intents from Task 3. Relative POSTs to `/app/models` are auto-authenticated by App Bridge v4 (it injects the session token on same-origin fetches).

- [ ] **Step 1: Add react-router revalidator import**

At the top of `app.models.jsx`, add `useRevalidator` to the existing `react-router` (or `@remix-run/react`) import — match whichever module `useLoaderData`/`useFetcher` already come from:

```js
import { useLoaderData, useFetcher, useRevalidator } from 'react-router'
```

- [ ] **Step 2: Replace upload state + `upload()` in the `Models` component**

Remove the `uploadFetcher` declaration and its `useEffect` (the one showing the "Model calibrated" / `uploadError` toasts). Replace with local state and a sequential flow. Add near the other `useState` hooks:

```js
  const revalidator = useRevalidator()
  const [progress, setProgress] = useState(null)       // null | 0..100 | 'calibrating'
  const [uploadResult, setUploadResult] = useState(null)
  const [uploadErr, setUploadErr] = useState(null)
  const uploading = progress !== null
  const MAX_UPLOAD_BYTES = 25 * 1048576
```

Replace the existing `upload` function with:

```js
  const upload = async () => {
    if (!pendingFile) {
      shopify.toast.show('Choose a .glb file first', { isError: true }); return
    }
    if (!pendingFile.name.toLowerCase().endsWith('.glb')) {
      shopify.toast.show('Choose a .glb file', { isError: true }); return
    }
    if (pendingFile.size > MAX_UPLOAD_BYTES) {
      shopify.toast.show('Model exceeds the 25 MB limit', { isError: true }); return
    }
    setUploadErr(null); setUploadResult(null); setProgress(0)
    try {
      // 1) presign
      const pf = new FormData(); pf.append('intent', 'upload-presign')
      const presign = await fetch('/app/models', { method: 'POST', body: pf }).then((r) => r.json())
      if (presign.error) throw new Error(presign.error)
      const { uploadUrl, storageRef } = presign

      // 2) direct PUT with progress (XHR — fetch can't report upload progress)
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('PUT', uploadUrl)
        xhr.setRequestHeader('Content-Type', 'model/gltf-binary')
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Upload failed (${xhr.status})`))
        xhr.onerror = () => reject(new Error('Upload failed (network/CORS)'))
        xhr.send(pendingFile)
      })

      // 3) finalize (calibrate server-side)
      setProgress('calibrating')
      const ff = new FormData()
      ff.append('intent', 'upload-finalize')
      ff.append('storageRef', storageRef)
      ff.append('filename', pendingFile.name)
      const fin = await fetch('/app/models', { method: 'POST', body: ff }).then((r) => r.json())
      if (fin.error) throw new Error(fin.error)

      setUploadResult(fin.uploaded)
      shopify.toast.show('Model calibrated')
      revalidator.revalidate() // refresh the model list (no fetcher to auto-revalidate now)
    } catch (e) {
      setUploadErr(e.message)
      shopify.toast.show(e.message, { isError: true })
    } finally {
      setProgress(null)
    }
  }
```

- [ ] **Step 3: Update the JSX — progress bar + result/error banners**

In the "Upload a model (GLB)" section, after the upload `s-button` stack, add the progress UI (uses the native `<progress>` element so it needs no Polaris component that may not exist in this set):

```jsx
        {progress !== null && (
          <s-stack direction="block" gap="small-500">
            {typeof progress === 'number' ? (
              <>
                <progress value={progress} max="100" style={{ width: '100%' }} />
                <s-text>Uploading… {progress}%</s-text>
              </>
            ) : (
              <s-text>Calibrating…</s-text>
            )}
          </s-stack>
        )}
```

Replace the old fetcher-driven banners. Change `{up && (` to `{uploadResult && (` and inside it use `uploadResult` in place of `up` (i.e. `uploadResult.status`, `sourceLabel(uploadResult)`, `uploadResult.needsManual`). Change the error banner from `{uploadError && (` to `{uploadErr && (` rendering `{uploadErr}`.

The upload button already reads `uploading` for its loading state — no change needed there since `uploading` is now derived from `progress`.

- [ ] **Step 4: Remove now-dead references**

Delete the old `const up = uploadFetcher.data?.uploaded` and `const uploadError = uploadFetcher.data?.error` lines, and the `useEffect` that depended on `[up, uploadError, shopify]`.

- [ ] **Step 5: Lint + typecheck + build**

Run: `cd apps/shopify-app && npm run lint && npm run typecheck && npm run build`
Expected: PASS, no references to `uploadFetcher`, `up`, or `uploadError` remaining.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify-app/app/routes/app.models.jsx
git commit -m "feat: client presigned upload flow with progress bar

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Bucket CORS + lifecycle (infra) and end-to-end verification

**Files:**
- Create: `apps/shopify-app/docs/storage-cors.md` (runbook so the config is reproducible)

This task is configuration + manual verification, not code. It is a hard prerequisite: after Task 3 removes the buffered path, uploads only work once CORS is live.

- [ ] **Step 1: Determine the provider**

Check the Vercel env for the app: if `S3_ENDPOINT` is set → Cloudflare R2 (or other S3-compatible); if unset → AWS S3. Note the app's public origin (the domain serving the embedded admin iframe, e.g. `https://<app>.vercel.app`).

- [ ] **Step 2: Apply the CORS rule**

Write `apps/shopify-app/docs/storage-cors.md` documenting the exact config, then apply it.

CORS JSON (replace `<app-origin>` with the app's real origin):

```json
[
  {
    "AllowedOrigins": ["<app-origin>"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "MaxAgeSeconds": 3000
  }
]
```

- **AWS S3:** `aws s3api put-bucket-cors --bucket <S3_BUCKET> --cors-configuration file://cors.json` (S3 uses `CORSRules` wrapping; convert with `{ "CORSRules": [ ... ] }`).
- **Cloudflare R2:** R2 dashboard → bucket → Settings → CORS policy → paste the array above; or `wrangler r2 bucket cors put <bucket> --file cors.json`.

- [ ] **Step 3: Add the lifecycle rule (orphan cleanup)**

Expire objects under the `uploads/` prefix after 1 day (reaps uploads abandoned before finalize).

- **AWS S3:** `aws s3api put-bucket-lifecycle-configuration` with a rule: `Filter.Prefix = "uploads/"`, `Expiration.Days = 1`.
- **Cloudflare R2:** dashboard → bucket → Settings → Object lifecycle rules → prefix `uploads/`, expire after 1 day.

Record both commands/screens in `storage-cors.md`.

- [ ] **Step 4: End-to-end verification (the original repro)**

Deploy (or run against the configured bucket). In the admin **Models** page, upload the full-res `gripz_G_yellow.glb` (~8.8 MB — the file that previously returned 413).
Expected: progress bar advances 0→100%, switches to "Calibrating…", then the "Model calibrated" banner appears and the model shows in the list. Confirm in storage that no object remains under `uploads/` for that upload (finalize deleted it) and one permanent `<uuid>.glb` exists.

- [ ] **Step 5: Commit the runbook**

```bash
git add apps/shopify-app/docs/storage-cors.md
git commit -m "docs: storage CORS + lifecycle runbook for presigned uploads

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **App Bridge auth:** the client POSTs to the relative path `/app/models`; App Bridge v4 patches `fetch` to attach the session token on same-origin requests, so the Remix `authenticate.admin` in the action succeeds. Do not build an absolute URL and do not add auth headers manually.
- **Why delete the temp object before calibrating:** the bytes are already in memory, so a calibration failure needs no cleanup — nothing is left under `uploads/`. The lifecycle rule only exists for the case where the browser never calls finalize at all.
- **Serving is unaffected:** `models.$assetId[.]glb.jsx` serves by `ModelAsset` row, and rows are only created by `saveCalibratedModel` with a fresh permanent key, so raw uploaded bytes are never publicly served.

# Create 3D models with AI

**Date:** 2026-09-30
**Status:** Approved design, not yet implemented

## Problem

A merchant needs a GLB of every frame before it can have try-on. Most merchants
don't have one and can't make one: today that means Blender, a 3D artist, or a
generator they have to learn. That's the biggest drop-off between installing the
app and a live try-on button.

## Feature

On the admin **Models** page, a merchant can **Create with AI**: upload 3–4
photos of a frame (front, left side, right side, back), and the app produces a
calibrated 3D model from them, using OpenAI's **GPT-6.1 Sol**. A saved generated
model is an ordinary `ModelAsset`; it's mapped to products exactly like an
uploaded one.

Pricing: each plan includes a **lifetime** allowance of free generated models.
Past it, each saved model costs **$5**, billed on the merchant's Shopify invoice.

## Merchant flow

1. **Create with AI** sits next to the existing upload on the Models page.
2. The merchant adds 3–4 photos: front, left side, right side, back (back is
   optional). JPG, PNG or WebP, up to 10 MB each. A short photo guide sits
   beside the drop zone: plain background, frame only (not worn), good light,
   whole frame in shot.
3. The balance is always visible before they start:
   - within allowance: *"7 of 10 free AI models left"*
   - past it: *"Next model: $5, added to your Shopify bill"*
   - Pro / comped: *"Unlimited AI models on your plan"*
4. **Generate** starts a job. Generation takes minutes; the page shows
   *Generating…* and the merchant can leave and come back. In-progress and ready
   generations are listed on the Models page.
5. When ready: an interactive 3D preview (the existing `ModelViewer`) plus the
   calibration result.
6. The merchant chooses:
   - **Save model** → becomes a `ModelAsset`. This is the only step that uses
     the allowance or charges. Past the allowance, a confirm dialog comes first:
     *"This model costs $5. It will be added to your next Shopify bill."*
   - **Try again** → a new generation from the same photos. Free, up to
     **3 retries per photo set**. After that the merchant has to upload a new
     photo set.
   - **Discard** → free.
7. A **failed** generation (see Error handling) is never counted or charged. It
   shows why, plus a photo tip.

## Allowance and charging rules

| Plan | Free AI models (lifetime) |
|---|---|
| Starter | 10 |
| Growth | 40 |
| Pro | unlimited |
| Comped shops (`hasFreeAccess`) | unlimited (read as Pro, as today) |
| No active plan | none; feature blocked like other admin actions |

- **Free remaining** = `allowance(currentPlan) − count(saved AI models, ever)`,
  floored at 0. It counts all saved AI models, including ones later deleted, so
  delete-and-regenerate can't reset it.
- **Upgrade tops up:** a Starter shop with 10 saved that upgrades to Growth has
  40 − 10 = 30 free left. This falls out of the formula; no migration needed.
- **Downgrade** never removes or charges for already-saved models. It only
  changes what the *next* save costs.
- A save is **paid** when free remaining = 0 at the moment of saving. The
  paid/free decision is stored on the generation row, so it's made once.
- **Unchanged:** the existing product-mapping cap (`PLAN_LIMITS`, counts
  products with try-on) is a separate limit. Generating models doesn't raise it.

### Cost guard

Protects the OpenAI bill, mainly from unlimited (Pro/comped) shops:

- at most **2** generations running at once per shop
- at most **20** generations started per shop per rolling 24 h (retries and the
  automatic retry below count toward the 20)

Both return a clear message, not a silent failure.

## Architecture

```
Models page ──► api.generation-photos  (presign S3 PUTs for the photos)
            ──► api.generations        (POST: create job; GET: list/poll)
                     │
                     ▼
            generations.server.js      (job state machine, allowance, guard)
                     │                              │
                     ▼                              ▼
            modelGenerator.server.js       usageBilling.server.js
            (OpenAI GPT-6.1 Sol, the       (App Events API: report one
             only provider-specific file)   $5 event on a paid save)
                     │
                     ▼
            calibration.server.js  +  models.server.js   (existing)
            (validate → normalize → calibrate, then store as ModelAsset)
```

### Units

**`modelGenerator.server.js`**: the only file that knows about OpenAI.
- `startGeneration({ photoUrls, feedback? }) → { providerJobId }`: creates a
  Responses API request, `model: "gpt-6.1-sol"`, `background: true`,
  `tools: [{ type: "code_interpreter", container: { type: "auto" } }]`, the 4
  photos as `input_image` parts (short-lived presigned S3 GET URLs), and the
  modelling instructions below. `feedback` carries validation errors for the
  automatic retry.
- `checkGeneration(providerJobId) → { state: running|done|failed, glbBytes?, error? }`:
  retrieves the response. When it's complete, finds the `.glb` container file
  citation in the output and downloads it through the container files API.
  Rejects anything over `MAX_GLB_BYTES` (25 MB, existing constant).
- Swapping providers later (Meshy, Tripo, …) means replacing this file only.

**Modelling instructions** (a prompt constant in the same file, versioned). The
model is told to write and run Python (trimesh / pygltflib or equivalent) that
produces a single binary glTF meeting the existing try-on spec:
- metres, Y-up, frame front facing **+Z**, symmetric about **X = 0**
- front width ≈ **0.145 m** (the pipeline normalizes anyway; this keeps
  proportions sane)
- ≤ **150k triangles**
- separate meshes/materials for frame, lenses, temples; PBR materials matching
  the photos' colour and finish; lenses transparent/tinted (alpha blend)
- empties named exactly **`AR_bridge`**, **`AR_hinge_L`**, **`AR_hinge_R`** at
  the bridge centre and the two hinge points (tags take precedence in
  calibration; auto-anchors are the fallback)
- temples open at ~90°, the natural worn pose
- no logos, text, background, or person
- save as `/mnt/data/model.glb` and cite the file in the final answer

**`generations.server.js`**: the job state machine plus business rules.
- `createGeneration(prisma, shop, photoRefs, { retryOf? })`: enforces the cost
  guard, the 3-retry limit and plan-required; creates the row; calls
  `startGeneration`.
- `advanceGeneration(prisma, generation)`: called when a merchant polls a
  `running` job. Calls `checkGeneration`. On done: runs `calibrateUpload`; on
  pass → `ready` (GLB stored to S3 under a pending key, calibration result saved
  on the row); on validation or confidence failure and `autoRetried = false` →
  starts **one** automatic retry with the errors as `feedback` (free, not one of
  the merchant's 3); otherwise → `failed`.
- `getAllowance(prisma, shop, planName)` → `{ allowance, used, freeRemaining }`.
- `saveGeneration(prisma, shop, generationId)`: claims the save and decides
  paid/free under a per-shop lock, creates the `ModelAsset` (`readModelGlb` +
  the existing `saveCalibratedModel`), marks the row `saved`, then, if
  paid, calls `reportModelCharge`. See Save/charge ordering below.
- `discardGeneration(...)`.

**`usageBilling.server.js`**
- `reportModelCharge({ shopGid, generationId, timestamp })`: POST to the App
  Events API with `event_handle: "ai_model_generated"`, `attributes.value: 1`,
  `idempotency_key: "aimodel_<generationId>"`. Shopify enforces idempotency
  permanently, so retries and double-clicks can't double-charge. No merchant PII
  in the payload.

**Routes**
- `api.generation-photos.jsx`: presigned S3 PUTs for up to 4 photos (same
  pattern as `presignModelUpload`), image content types only, 10 MB limit.
- `api.generations.jsx`: `POST` create / retry / save / discard (intent field);
  `GET` list the shop's generations and advance any `running` ones (polling).
  Admin-authenticated; `requireActivePlanForAction` on every mutating intent.

**UI**
- `components/AiModelFlow.jsx`: photo slots, balance line, generate, progress,
  preview (reuses `ModelViewer`), save/try again/discard, $5 confirm dialog.
  The page polls `GET api.generations` every ~5 s while any job is running.
- `PlanUsage.jsx` gains an "AI models: x of y free used" line.
- React 18 + Polaris web components: bind events through refs /
  `addEventListener`, not `onChange` props on `s-*` elements (known trap).

## Data model

New Prisma model (migration runs on deploy via `prisma migrate deploy`):

```prisma
model ModelGeneration {
  id             String    @id @default(uuid())
  shop           String
  photoRefs      Json      // S3 keys of the 3–4 photos
  photoSetId     String    // groups a set and its retries
  retryIndex     Int       @default(0)   // 0 = original, 1..3 = merchant retries
  autoRetried    Boolean   @default(false)
  providerJobId  String?
  status         String    // queued|running|ready|saving|saved|discarded|failed
  error          String?
  glbRef         String?   // S3 key of the generated GLB (pending until saved)
  calibration    Json?
  paid           Boolean?  // decided once, at save
  chargeReported Boolean   @default(false)
  modelAssetId   String?   @unique
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([shop, status])
  @@index([shop, createdAt])
}
```

`used` for the allowance = `count(ModelGeneration where shop and status in (saving, saved))`.
A saved row is never deleted when its `ModelAsset` is deleted (the link is just
nulled), which is what keeps the allowance lifetime.

## Billing setup (Partner Dashboard, done by the owner)

1. In Shopify App Pricing, add a usage meter to **Starter** and **Growth**:
   name *AI 3D models*, handle **`ai_model_generated`**, **fixed** pricing,
   **$5.00** per unit, **0 included units** (the app tracks the free allowance).
   Pro doesn't need the meter: it never sends events.
2. Create a Partner API key with the **`write_global_api_app_events`** scope and
   store it as an env var in Vercel (all three environments).
3. Update the App Store listing pricing text to disclose the AI feature and the
   $5 per model beyond the plan allowance.

Shopify App Pricing constraints that apply: usage is billed **monthly** (a
yearly-only plan can't carry the meter); **no usage caps** exist, so the
confirm dialog and cost guard are our only brakes.

### Save/charge ordering

1. **Claim (short transaction):** take `pg_advisory_xact_lock` on a hash of the
   shop (works under PgBouncer transaction mode because it's transaction
   scoped), re-count `used` (statuses `saving` + `saved`), set `paid`, and move
   the row `ready → saving` with a conditional update. The lock means two
   simultaneous saves can't both take the last free slot; the conditional
   update means a double-click can't claim twice.
2. **Create the asset (outside the transaction):** `readModelGlb(glbRef)` →
   `saveCalibratedModel` → `ModelAsset`; then `saving → saved` with
   `modelAssetId`; only then delete the pending GLB. (Not `finalizeUpload`: it
   only accepts temp-upload keys and deletes the file before saving, which
   would make a failed save unrecoverable.) If this step fails, the row goes
   back to `ready` with `paid = null`. Nothing was charged, and the merchant can
   retry the save.
3. **Charge:** once `saved`, if `paid`: `reportModelCharge`. On success, set
   `chargeReported = true`.
4. If reporting fails, the model stays saved (the merchant already confirmed),
   and `chargeReported` stays false. Any later `GET api.generations` for that
   shop re-sends unreported charges. Idempotency keys make re-sending safe.
   Failures are logged with the generation id.

## Error handling

| Situation | Result | Counted/charged? |
|---|---|---|
| OpenAI error / timeout (> 15 min running) | `failed`, "Couldn't generate, try again" | No |
| No GLB file in output | auto-retry once, then `failed` | No |
| GLB fails validate/normalize | auto-retry once with errors, then `failed` | No |
| Calibration confidence too low | auto-retry once, then `failed` + photo tip | No |
| Merchant rejects result | discard / try again (≤ 3) | No |
| Cost guard hit | request refused with a message | No |
| Charge report fails | model saved, report re-sent on next poll | Once, eventually |

## Privacy and data retention

- Photos go to OpenAI. Update the app's privacy page (`routes/privacy.jsx`) to
  name OpenAI as a subprocessor for this feature, and add it to the listing's
  data-use disclosure.
- Photos and unsaved GLBs are deleted from S3 **30 days** after creation
  (swept whenever a shop's generations are listed; no cron needed for v1).
  Rows for saved generations are kept for billing history.
- `purgeShopData` (the `shop/redact` path) also deletes the shop's
  `ModelGeneration` rows and their S3 objects.

## Risks, checked first during implementation

1. **Output quality (gate for everything else).** First task: a standalone
   script sends 4 real photos of a Gripz frame through `modelGenerator` and
   writes the GLB to `public/calibrated/`. The owner checks it on-face with
   `?fit=` (`scripts/calibrate-local.mjs`). If quality is unacceptable, stop and
   revisit the approach before building routes, billing or UI.
2. **Existing subscribers and new meters.** Confirm in Shopify's docs whether
   adding a usage meter to a live plan needs existing subscribers to re-approve,
   before the owner edits the dashboard. If it does, the flow must send those
   merchants to re-approve before their first paid save.
3. **App Store review.** The listing must disclose the AI feature, the $5
   charge, and OpenAI data sharing, or review will flag it.

## Testing

- **Unit (DB-free, fakes for OpenAI and Shopify):** allowance maths including
  upgrade top-up, downgrade and deleted models; paid/free decided once;
  idempotent charge key; unreported-charge re-send; state machine transitions
  including the single auto-retry; retry limit; cost guard; the 15-minute
  timeout.
- **Generator:** `checkGeneration` parses a recorded Responses API fixture and
  finds and downloads the cited GLB; rejects oversize and missing files.
- **Never run tests against the production DB** (dev and prod share Neon).
- **End to end:** on the dev store, with a test charge: generate → save within
  allowance → exhaust allowance → paid save → the event shows in the Dev
  Dashboard as billable.

## Out of scope (v1)

- Editing a generated model (colour tweaks, re-texturing) in the app.
- Logos/branding on generated frames.
- Bulk generation for many products at once.
- A monthly-resetting allowance or usage caps.

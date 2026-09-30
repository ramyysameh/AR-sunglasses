# Create 3D Models with AI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merchants upload 3–4 photos of a frame, GPT-6.1 Sol writes and runs modelling code that produces a GLB, the app calibrates it, and the merchant saves it as an ordinary model — free up to a lifetime per-plan allowance, $5 per saved model after that via a Shopify App Pricing usage meter.

**Architecture:** One provider-specific module (`modelGenerator.server.js`) wraps the OpenAI Responses API in background mode with the code-interpreter tool. A job state machine (`generations.server.js`, new `ModelGeneration` table) owns allowance, cost guards, retries and the save/charge sequence; it is advanced by an OpenAI webhook and, as a fallback, by the admin page polling. Charges go to Shopify through the App Events API (`usageBilling.server.js`). The UI is a "Create with AI" section on the existing Models page, gated per shop by `AI_GENERATION_SHOPS`.

**Tech Stack:** React Router 7 (Shopify app template), Prisma 6 on Neon Postgres, AWS S3 (`@aws-sdk/client-s3`), `openai` Node SDK v7, Shopify App Events API `2026-10`, Polaris web components (`s-*`), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-ai-model-generation-design.md` (read its "Amendments found while planning" section — this plan implements the amended design).

## Global Constraints

- Worktree: `D:\AR Sunglasses\wt-ai-model-gen`, branch `feature/ai-model-generation`. Other Claude sessions share `D:\AR Sunglasses\ar-tryon-prototype`; never work or commit there. Before every commit run `git branch --show-current` and STOP if it isn't `feature/ai-model-generation`.
- App code lives in `apps/shopify-app/`. All `npx vitest` commands below run from `apps/shopify-app/`.
- **Never run the full suite (`npm test`) or any DB-backed test file.** Dev and production share one Neon database. Every test this plan adds is DB-free (fake Prisma, mocked modules); run only the files named in each step.
- **Never run `prisma migrate dev` / `migrate deploy` / `db push`.** The migration is hand-written (Task 4) and applied by the Vercel build on deploy.
- Model id: `gpt-6.1-sol`. Tool: `code_interpreter` with `container: { type: 'auto' }`. Requests use `background: true`.
- Allowance (lifetime, free saved AI models): `Starter: 10`, `Growth: 40`, `Pro: Infinity`; unknown/missing plan → `0`. Comped shops already resolve to `'Pro'` via `getActivePlanName`.
- Charge: $5 per paid save. App Events meter handle `ai_model_generated`; idempotency key `aimodel_<generationId>`; endpoint `https://api.shopify.com/app/2026-10/events`; token from `https://api.shopify.com/auth/access_token` (client credentials).
- Limits: 2 generations running at once per shop; 20 started per rolling 24 h (automatic retries count); 3 merchant retries per photo set; 15-minute timeout per attempt; one free automatic retry per generation; photos + unsaved GLBs deleted after 30 days.
- Photos: 3 or 4 (front, left side, right side, optional back); `image/jpeg`, `image/png`, `image/webp`; ≤ 10 MB each. S3 keys: photos `generation-photos/<uuid>.<ext>`, pending GLBs `generations/<generationId>.glb`.
- Statuses: `queued | running | collecting | ready | saving | saved | discarded | failed`. Allowance `used` counts `saving` + `saved`.
- Env vars: `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `SHOPIFY_APP_EVENTS_CLIENT_ID`, `SHOPIFY_APP_EVENTS_CLIENT_SECRET`, `AI_GENERATION_SHOPS` (comma-separated myshopify domains or `*`; unset = feature off).
- Merchant copy: say what happened and what to do; never forward internal error text. Failures always say "You weren't charged."
- React 18 + Polaris web components: `s-drop-zone` uses `onInput` (not `onChange`); `droprejected` is attached with `addEventListener` via a ref. `onClick` on `s-button` is fine.
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## File Structure

| File | Responsibility |
|---|---|
| `apps/shopify-app/app/modelGenerator.server.js` (new) | Everything OpenAI: request shape, modelling instructions, polling a job, finding + downloading the GLB, cancel, webhook verification |
| `apps/shopify-app/scripts/ai-generate-spike.mjs` (new) | Quality gate: local photos → GLB file for an on-face check |
| `apps/shopify-app/app/usageBilling.server.js` (new) | App Events API: access token cache + one `$5` charge event |
| `apps/shopify-app/app/storage.server.js` (modify) | + `presignPhotoUpload`, `presignObjectRead` |
| `apps/shopify-app/prisma/schema.prisma` + new migration (modify/new) | `ModelGeneration` table |
| `apps/shopify-app/app/billing.server.js` (modify) | + `AI_MODEL_ALLOWANCE`, `aiModelAllowance` |
| `apps/shopify-app/app/generations.server.js` (new) | Feature flag, allowance, create/advance/save/discard/list, sweep, client shape |
| `apps/shopify-app/app/routes/api.generations.jsx` (new) | Admin JSON API (GET list/poll, POST presign/create/retry/save/discard) |
| `apps/shopify-app/app/routes/generations.$generationId[.]glb.jsx` (new) | Serves a pending GLB for the preview |
| `apps/shopify-app/app/routes/webhooks.openai.jsx` (new) | OpenAI job-finished webhook |
| `apps/shopify-app/app/webhooks.server.js` (modify) | Purge also erases generations |
| `apps/shopify-app/app/routes/privacy.jsx` (modify) | Name OpenAI as a provider |
| `apps/shopify-app/app/components/AiModelFlow.jsx` (new) | Create-with-AI UI |
| `apps/shopify-app/app/routes/app.models.jsx` (modify) | Render `AiModelFlow` when enabled |
| `apps/shopify-app/app/components/PlanUsage.jsx` + `app/routes/app._index.jsx` (modify) | "AI models used" line on Home |
| `apps/shopify-app/test/helpers/fakePrisma.js` (new) | In-memory `modelGeneration` delegate for DB-free tests |
| `apps/shopify-app/test/*.test.js` (new) | One test file per unit, listed in each task |

---

### Task 1: OpenAI generator module + quality spike (GATE)

This task ends with a manual on-face check by the owner. **Do not start Task 2 until the owner approves the result.** If the model is not good enough, stop and report back — the approach gets revisited before anything else is built.

**Files:**
- Create: `apps/shopify-app/app/modelGenerator.server.js`
- Create: `apps/shopify-app/scripts/ai-generate-spike.mjs`
- Modify: `apps/shopify-app/package.json` (dependency `openai`)
- Modify: `apps/shopify-app/.env.example`
- Test: `apps/shopify-app/test/modelGenerator.server.test.js`

**Interfaces:**
- Consumes: `MAX_GLB_BYTES` from `app/remoteGlb.server.js` (25 MB).
- Produces:
  - `GENERATION_MODEL = 'gpt-6.1-sol'`
  - `buildGenerationRequest({ images: string[], feedback?: string|null }) → object` (Responses API create body)
  - `startGeneration({ images, feedback? }) → Promise<{ providerJobId: string }>`
  - `checkGeneration(providerJobId) → Promise<{ state: 'running' } | { state: 'failed', error: string } | { state: 'done', glbBytes: Buffer, usage: object|null }>` — error codes: `openai_<status>`, `no_glb_output`, `glb_too_large`
  - `cancelGeneration(providerJobId) → Promise<void>` (never throws)
  - `unwrapWebhook(body: string, headers: Record<string,string>) → Promise<{ type: string, data: { id: string } }>` (throws on a bad signature)
  - `setGeneratorClient(client|null)` — test seam

- [ ] **Step 1: Set up the worktree**

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen"
git branch --show-current   # must print feature/ai-model-generation
npm install
npm install openai@^7 --workspace apps/shopify-app
cd apps/shopify-app && npx prisma generate
```

Expected: installs succeed; `apps/shopify-app/package.json` now lists `"openai": "^7.x"`.

- [ ] **Step 2: Confirm the SDK method shapes this plan relies on**

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen"
grep -rn "retrieve(\|cancel(" node_modules/openai/resources/responses/responses.d.ts | head -5
grep -rn "retrieve(" node_modules/openai/resources/containers/files/content.d.ts
grep -rn "list(" node_modules/openai/resources/containers/files/files.d.ts
grep -rn "unwrap(" node_modules/openai/resources/webhooks*.d.ts node_modules/openai/resources/webhooks/*.d.ts 2>/dev/null
```

Expected: `responses.retrieve(responseID, ...)`, `responses.cancel(responseID, ...)`, `containers.files.content.retrieve(fileID, { container_id })` returning a `Response`, `containers.files.list(containerID, ...)` (async-iterable page), `webhooks.unwrap(payload, headers, secret?)`. If any signature differs, adapt the calls in Step 5 to match and note it in the commit message.

- [ ] **Step 3: Write the failing tests**

Create `apps/shopify-app/test/modelGenerator.server.test.js`:

```js
import { describe, it, expect, afterEach } from 'vitest'
import {
  GENERATION_MODEL,
  buildGenerationRequest,
  startGeneration,
  checkGeneration,
  cancelGeneration,
  setGeneratorClient,
} from '../app/modelGenerator.server.js'
import { MAX_GLB_BYTES } from '../app/remoteGlb.server.js'

function fakeClient({ response = null, containerFiles = [], fileBytes = Buffer.from('glTF-bytes') } = {}) {
  const calls = { created: [], downloaded: [], listed: [], cancelled: [] }
  return {
    calls,
    responses: {
      create: async (body) => {
        calls.created.push(body)
        return { id: 'resp_1', status: 'queued' }
      },
      retrieve: async () => response,
      cancel: async (id) => {
        calls.cancelled.push(id)
        throw new Error('already finished')
      },
    },
    containers: {
      files: {
        list: (containerId) => {
          calls.listed.push(containerId)
          return (async function* () {
            yield* containerFiles
          })()
        },
        content: {
          retrieve: async (fileId, { container_id }) => {
            calls.downloaded.push({ fileId, containerId: container_id })
            return new Response(fileBytes)
          },
        },
      },
    },
  }
}

const citedMessage = {
  type: 'message',
  content: [{
    type: 'output_text',
    text: 'Saved the model.',
    annotations: [
      { type: 'container_file_citation', container_id: 'cntr_1', file_id: 'cfile_png', filename: 'preview.png' },
      { type: 'container_file_citation', container_id: 'cntr_1', file_id: 'cfile_glb', filename: 'model.glb' },
    ],
  }],
}

afterEach(() => setGeneratorClient(null))

describe('buildGenerationRequest', () => {
  it('asks gpt-6.1-sol, in the background, with the code interpreter and every photo in order', () => {
    const body = buildGenerationRequest({ images: ['u1', 'u2', 'u3', 'u4'] })
    expect(body.model).toBe(GENERATION_MODEL)
    expect(GENERATION_MODEL).toBe('gpt-6.1-sol')
    expect(body.background).toBe(true)
    expect(body.tools).toEqual([{ type: 'code_interpreter', container: { type: 'auto' } }])
    expect(body.instructions).toMatch(/AR_bridge/)
    expect(body.instructions).toMatch(/\/mnt\/data\/model\.glb/)
    const parts = body.input[0].content
    expect(parts.filter((p) => p.type === 'input_image').map((p) => p.image_url)).toEqual(['u1', 'u2', 'u3', 'u4'])
  })

  it('appends retry feedback as a final text part', () => {
    const body = buildGenerationRequest({ images: ['a', 'b', 'c'], feedback: 'Fix the hinges.' })
    const last = body.input[0].content.at(-1)
    expect(last).toEqual({ type: 'input_text', text: 'A previous attempt was rejected. Fix this: Fix the hinges.' })
  })
})

describe('startGeneration', () => {
  it('returns the response id as the provider job id', async () => {
    const client = fakeClient()
    setGeneratorClient(client)
    await expect(startGeneration({ images: ['a', 'b', 'c'] })).resolves.toEqual({ providerJobId: 'resp_1' })
    expect(client.calls.created).toHaveLength(1)
  })
})

describe('checkGeneration', () => {
  it('reports queued and in-progress jobs as running', async () => {
    for (const status of ['queued', 'in_progress']) {
      setGeneratorClient(fakeClient({ response: { id: 'resp_1', status } }))
      await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'running' })
    }
  })

  it('downloads the cited .glb from its container', async () => {
    const client = fakeClient({
      response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 10 }, output: [citedMessage] },
    })
    setGeneratorClient(client)
    const result = await checkGeneration('resp_1')
    expect(result.state).toBe('done')
    expect(result.glbBytes.toString()).toBe('glTF-bytes')
    expect(result.usage).toEqual({ input_tokens: 10 })
    expect(client.calls.downloaded).toEqual([{ fileId: 'cfile_glb', containerId: 'cntr_1' }])
  })

  it('falls back to listing the container when the model forgot to cite the file', async () => {
    const client = fakeClient({
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [{ type: 'code_interpreter_call', container_id: 'cntr_2' }, { type: 'message', content: [] }],
      },
      containerFiles: [{ id: 'cfile_a', path: '/mnt/data/notes.txt' }, { id: 'cfile_b', path: '/mnt/data/model.glb' }],
    })
    setGeneratorClient(client)
    const result = await checkGeneration('resp_1')
    expect(result.state).toBe('done')
    expect(client.calls.listed).toEqual(['cntr_2'])
    expect(client.calls.downloaded).toEqual([{ fileId: 'cfile_b', containerId: 'cntr_2' }])
  })

  it('fails with no_glb_output when there is no GLB anywhere', async () => {
    setGeneratorClient(fakeClient({ response: { id: 'resp_1', status: 'completed', output: [] } }))
    await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: 'no_glb_output' })
  })

  it('fails with openai_<status> for failed, incomplete and cancelled jobs', async () => {
    for (const status of ['failed', 'incomplete', 'cancelled']) {
      setGeneratorClient(fakeClient({ response: { id: 'resp_1', status } }))
      await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: `openai_${status}` })
    }
  })

  it('rejects a GLB over the upload size limit', async () => {
    setGeneratorClient(fakeClient({
      response: { id: 'resp_1', status: 'completed', output: [citedMessage] },
      fileBytes: Buffer.alloc(MAX_GLB_BYTES + 1),
    }))
    await expect(checkGeneration('resp_1')).resolves.toEqual({ state: 'failed', error: 'glb_too_large' })
  })
})

describe('cancelGeneration', () => {
  it('swallows errors (a job that already finished cannot be cancelled)', async () => {
    const client = fakeClient()
    setGeneratorClient(client)
    await expect(cancelGeneration('resp_1')).resolves.toBeUndefined()
    expect(client.calls.cancelled).toEqual(['resp_1'])
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/modelGenerator.server.test.js`
Expected: FAIL — `Failed to load url ../app/modelGenerator.server.js`.

- [ ] **Step 5: Write the module**

Create `apps/shopify-app/app/modelGenerator.server.js`:

```js
import OpenAI from 'openai'
import { MAX_GLB_BYTES } from './remoteGlb.server.js'

/**
 * The only file that knows which AI builds the models. Everything else talks
 * to startGeneration / checkGeneration / cancelGeneration / unwrapWebhook, so
 * swapping providers later means replacing this file, not the job logic.
 *
 * GPT-6.1 Sol outputs text only, so it builds the model by writing and running
 * Python in the code interpreter; the GLB lands in the job's container and is
 * downloaded from there. Containers expire 20 minutes after their last
 * activity, which is why a finished job is collected by webhook
 * (routes/webhooks.openai.jsx) rather than only when a merchant next polls.
 */

export const GENERATION_MODEL = 'gpt-6.1-sol'

// Bump when the instructions change, so a quality regression can be traced to
// the prompt version that produced a model (sent as response metadata).
export const MODELING_PROMPT_VERSION = 1

export const MODELING_INSTRUCTIONS = `You are a 3D modeller building eyewear for a web AR try-on. You receive 3 or 4 photos of ONE pair of glasses: front, left side, right side, and optionally back. Build that exact frame as a 3D model by writing and running Python in the code interpreter.

Hard requirements. The file is rejected automatically if any one is missed:
1. Save exactly one binary glTF file at /mnt/data/model.glb and cite it in your final message.
2. Units are metres. Y is up. The front of the frame faces +Z. The frame is centred on, and mirror-symmetric about, X = 0.
3. The frame front is about 0.145 m wide, hinge to hinge. Keep the photos' proportions for everything else.
4. At most 150,000 triangles in total.
5. Separate meshes named Frame, Lens_L, Lens_R, Temple_L, Temple_R (plus Nosepad_L and Nosepad_R if the photos show nose pads).
6. Three empty nodes (no mesh) named exactly AR_bridge, AR_hinge_L and AR_hinge_R. AR_bridge sits at the centre of the bridge on the back surface of the frame, where it rests on the nose. AR_hinge_L sits at the hinge at negative X, AR_hinge_R at the hinge at positive X.
7. Temples are open at about 90 degrees to the front and run towards -Z, as when worn.
8. PBR metallic-roughness materials matching the photos: frame colour and finish (matte, glossy, metal; tortoiseshell as a texture), lens tint. Lenses use alphaMode BLEND with an alpha between 0.35 and 0.85 that matches how dark they look.
9. No logos, text, background, ground plane, stand, case or person.

Method: trace each lens outline from the front photo as a closed 2D curve, build the rim around it, mirror it for the other side, build the bridge, then build the temples from the side photos. Use trimesh and numpy if they are available. If your library drops empty nodes on export, add the AR_* nodes with pygltflib afterwards; if neither library is available, write the glTF binary directly with numpy and struct.

Before finishing, verify with code and fix any failure: the triangle count, the front width (about 0.145 m), symmetry about X = 0, the front facing +Z, and that all three AR_* nodes exist in the saved file.`

let client = null

function getClient() {
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      webhookSecret: process.env.OPENAI_WEBHOOK_SECRET,
    })
  }
  return client
}

/** Test seam: inject a fake client (null restores the lazily built real one). */
export function setGeneratorClient(fake) {
  client = fake
}

export function buildGenerationRequest({ images, feedback = null }) {
  const content = [
    {
      type: 'input_text',
      text: `These ${images.length} photos show one pair of glasses: front, left side, right side${images.length > 3 ? ', back' : ''}. Build its 3D model.`,
    },
    ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'high' })),
  ]
  if (feedback) {
    content.push({ type: 'input_text', text: `A previous attempt was rejected. Fix this: ${feedback}` })
  }
  return {
    model: GENERATION_MODEL,
    background: true,
    instructions: MODELING_INSTRUCTIONS,
    tools: [{ type: 'code_interpreter', container: { type: 'auto' } }],
    input: [{ role: 'user', content }],
    metadata: { prompt_version: String(MODELING_PROMPT_VERSION) },
  }
}

export async function startGeneration({ images, feedback = null }) {
  const response = await getClient().responses.create(buildGenerationRequest({ images, feedback }))
  return { providerJobId: response.id }
}

const isGlb = (name) => typeof name === 'string' && name.toLowerCase().endsWith('.glb')

// The last .glb the model cited in its answer.
function citedGlb(response) {
  let found = null
  for (const item of response.output ?? []) {
    if (item.type !== 'message') continue
    for (const part of item.content ?? []) {
      for (const note of part.annotations ?? []) {
        if (note.type === 'container_file_citation' && isGlb(note.filename)) {
          found = { containerId: note.container_id, fileId: note.file_id }
        }
      }
    }
  }
  return found
}

// Fallback: the model saved the file but didn't cite it.
async function listedGlb(response) {
  const call = (response.output ?? []).find((item) => item.type === 'code_interpreter_call' && item.container_id)
  if (!call) return null
  for await (const file of getClient().containers.files.list(call.container_id)) {
    if (isGlb(file.path)) return { containerId: call.container_id, fileId: file.id }
  }
  return null
}

export async function checkGeneration(providerJobId) {
  const response = await getClient().responses.retrieve(providerJobId)
  if (response.status === 'queued' || response.status === 'in_progress') {
    return { state: 'running' }
  }
  if (response.status !== 'completed') {
    return { state: 'failed', error: `openai_${response.status}` }
  }
  const file = citedGlb(response) ?? (await listedGlb(response))
  if (!file) return { state: 'failed', error: 'no_glb_output' }
  const download = await getClient().containers.files.content.retrieve(file.fileId, {
    container_id: file.containerId,
  })
  const glbBytes = Buffer.from(await download.arrayBuffer())
  if (glbBytes.length > MAX_GLB_BYTES) return { state: 'failed', error: 'glb_too_large' }
  return { state: 'done', glbBytes, usage: response.usage ?? null }
}

/** Best effort: a job that already finished can't be cancelled, and that's fine. */
export async function cancelGeneration(providerJobId) {
  try {
    await getClient().responses.cancel(providerJobId)
  } catch (error) {
    console.warn('AI generation cancel failed', providerJobId, error?.message)
  }
}

/** Verifies an OpenAI webhook signature (OPENAI_WEBHOOK_SECRET) and parses it. Throws if invalid. */
export async function unwrapWebhook(body, headers) {
  return getClient().webhooks.unwrap(body, headers)
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/modelGenerator.server.test.js`
Expected: PASS (10 tests).

- [ ] **Step 7: Add the spike script and env documentation**

Create `apps/shopify-app/scripts/ai-generate-spike.mjs`:

```js
// Quality gate for AI model generation (plan Task 1). Sends 3-4 local photos
// through the real modelGenerator and writes the GLB for an on-face check.
//
//   cd apps/shopify-app
//   node --env-file=.env scripts/ai-generate-spike.mjs front.jpg left.jpg right.jpg [back.jpg]
//
// Needs OPENAI_API_KEY in apps/shopify-app/.env. Photos are sent inline as
// data URLs, so no S3 or database is involved.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startGeneration, checkGeneration } from '../app/modelGenerator.server.js'

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

const files = process.argv.slice(2)
if (files.length < 3 || files.length > 4) {
  console.error('usage: node --env-file=.env scripts/ai-generate-spike.mjs front left right [back]')
  process.exit(2)
}

const images = await Promise.all(files.map(async (file) => {
  const mime = MIME[path.extname(file).toLowerCase()]
  if (!mime) throw new Error(`unsupported photo type: ${file}`)
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`
}))

const started = Date.now()
const { providerJobId } = await startGeneration({ images })
console.log(`started ${providerJobId}`)

let result
do {
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  result = await checkGeneration(providerJobId)
  console.log(`${Math.round((Date.now() - started) / 1000)}s: ${result.state}`)
} while (result.state === 'running')

if (result.state === 'failed') {
  console.error(`generation failed: ${result.error}`)
  process.exit(1)
}

// public/calibrated/ at the repo root is gitignored (scripts/calibrate-local.mjs output).
const outDir = path.resolve('../../public/calibrated/raw')
await mkdir(outDir, { recursive: true })
const out = path.join(outDir, `ai-spike-${Date.now()}.glb`)
await writeFile(out, result.glbBytes)
console.log(`wrote ${out} (${result.glbBytes.length} bytes)`)
console.log(`token usage: ${JSON.stringify(result.usage)}`)
console.log('next, from the repo root:')
console.log(`  node scripts/calibrate-local.mjs "${out}"`)
```

Append to `apps/shopify-app/.env.example`:

```
# --- AI model generation (docs/superpowers/specs/2026-09-30-ai-model-generation-design.md) ---
# Feature switch: comma-separated myshopify domains, or * for everyone. Unset = off.
AI_GENERATION_SHOPS=
# OpenAI API key (GPT-6.1 Sol) and the signing secret of the webhook registered
# at <app url>/webhooks/openai for response.completed/failed/incomplete/cancelled.
OPENAI_API_KEY=
OPENAI_WEBHOOK_SECRET=
# Dev Dashboard API key used to report $5 usage events to Shopify App Pricing.
SHOPIFY_APP_EVENTS_CLIENT_ID=
SHOPIFY_APP_EVENTS_CLIENT_SECRET=
```

- [ ] **Step 8: Commit**

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen"
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/modelGenerator.server.js apps/shopify-app/test/modelGenerator.server.test.js apps/shopify-app/scripts/ai-generate-spike.mjs apps/shopify-app/.env.example apps/shopify-app/package.json package-lock.json
git commit -m "feat(ai-models): add the GPT-6.1 Sol generator and a quality spike script

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: GATE — owner runs the spike and checks the model on-face**

Hand this to the owner (needs their `OPENAI_API_KEY` in `apps/shopify-app/.env`, and 3–4 photos of a real Gripz frame on a plain background):

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen/apps/shopify-app"
node --env-file=.env scripts/ai-generate-spike.mjs front.jpg left.jpg right.jpg back.jpg
cd ../.. && node scripts/calibrate-local.mjs "public/calibrated/raw/ai-spike-<timestamp>.glb"
npm run dev
```

Run `npm run dev` from the worktree root, not from the shared checkout, because the shared checkout serves its own `public/`. If another session holds port 5173, Vite picks the next free port: use the URL it prints. Open `https://localhost:5173/?fit=/calibrated/ai-spike-<timestamp>-hand.json` (the model carries `AR_*` tags; use `-auto.json` if calibrate-local reports no tags). Record: pass/fail of calibration, confidence, token usage, wall-clock time, and the owner's verdict on shape, size and materials.

**STOP here.** Continue to Task 2 only when the owner says the quality is acceptable. If it isn't, report the numbers and the verdict; the approach is revisited before any more is built.

---

### Task 2: App Events usage billing

**Files:**
- Create: `apps/shopify-app/app/usageBilling.server.js`
- Test: `apps/shopify-app/test/usageBilling.server.test.js`

**Interfaces:**
- Consumes: `tagged(code, message)` from `app/errors.server.js`.
- Produces:
  - `AI_MODEL_METER = 'ai_model_generated'`, `APP_EVENTS_VERSION = '2026-10'`
  - `reportModelCharge({ shopGid: string, idempotencyKey: string, timestamp: Date|string }, { fetchImpl?, now? }) → Promise<void>` — throws `tagged('APP_EVENTS_AUTH' | 'APP_EVENTS_REJECTED')` on failure
  - `resetAppEventsToken()` — test seam

- [ ] **Step 1: Write the failing tests**

Create `apps/shopify-app/test/usageBilling.server.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { reportModelCharge, resetAppEventsToken, AI_MODEL_METER } from '../app/usageBilling.server.js'

function fakeFetch({ tokenStatus = 200, eventStatus = 202, eventBody = { success: true } } = {}) {
  return vi.fn(async (url, init) => {
    if (url === 'https://api.shopify.com/auth/access_token') {
      return new Response(JSON.stringify({ access_token: 'tok_1', expires_in: 3599 }), { status: tokenStatus })
    }
    return new Response(JSON.stringify(eventBody), { status: eventStatus })
  })
}

const charge = { shopGid: 'gid://shopify/Shop/42', idempotencyKey: 'aimodel_abc', timestamp: new Date('2026-10-01T10:00:00Z') }

beforeEach(() => {
  resetAppEventsToken()
  vi.stubEnv('SHOPIFY_APP_EVENTS_CLIENT_ID', 'cid')
  vi.stubEnv('SHOPIFY_APP_EVENTS_CLIENT_SECRET', 'csecret')
})

describe('reportModelCharge', () => {
  it('gets a client-credentials token, then posts one $5 meter event', async () => {
    const fetchImpl = fakeFetch()
    await reportModelCharge(charge, { fetchImpl, now: 0 })

    const [authUrl, authInit] = fetchImpl.mock.calls[0]
    expect(authUrl).toBe('https://api.shopify.com/auth/access_token')
    expect(JSON.parse(authInit.body)).toEqual({ client_id: 'cid', client_secret: 'csecret', grant_type: 'client_credentials' })

    const [eventUrl, eventInit] = fetchImpl.mock.calls[1]
    expect(eventUrl).toBe('https://api.shopify.com/app/2026-10/events')
    expect(eventInit.headers.Authorization).toBe('Bearer tok_1')
    expect(JSON.parse(eventInit.body)).toEqual({
      shop_id: 'gid://shopify/Shop/42',
      event_handle: AI_MODEL_METER,
      timestamp: '2026-10-01T10:00:00.000Z',
      idempotency_key: 'aimodel_abc',
      attributes: { value: 1 },
    })
    expect(AI_MODEL_METER).toBe('ai_model_generated')
  })

  it('reuses the token until a minute before it expires', async () => {
    const fetchImpl = fakeFetch()
    await reportModelCharge(charge, { fetchImpl, now: 0 })
    await reportModelCharge(charge, { fetchImpl, now: 3_000_000 })
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/access_token'))).toHaveLength(1)
    await reportModelCharge(charge, { fetchImpl, now: 3_560_000 })
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/access_token'))).toHaveLength(2)
  })

  it('throws APP_EVENTS_AUTH when the token request fails', async () => {
    await expect(reportModelCharge(charge, { fetchImpl: fakeFetch({ tokenStatus: 401 }), now: 0 }))
      .rejects.toMatchObject({ code: 'APP_EVENTS_AUTH' })
  })

  it('throws APP_EVENTS_REJECTED on a non-2xx event response or success:false', async () => {
    await expect(reportModelCharge(charge, { fetchImpl: fakeFetch({ eventStatus: 409 }), now: 0 }))
      .rejects.toMatchObject({ code: 'APP_EVENTS_REJECTED' })
    resetAppEventsToken()
    await expect(reportModelCharge(charge, { fetchImpl: fakeFetch({ eventBody: { success: false, error: 'bad' } }), now: 0 }))
      .rejects.toMatchObject({ code: 'APP_EVENTS_REJECTED' })
  })

  it('drops a cached token that the events API rejects as unauthorized', async () => {
    const fetchImpl = fakeFetch({ eventStatus: 401 })
    await expect(reportModelCharge(charge, { fetchImpl, now: 0 })).rejects.toBeTruthy()
    await expect(reportModelCharge(charge, { fetchImpl, now: 1 })).rejects.toBeTruthy()
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/access_token'))).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/usageBilling.server.test.js`
Expected: FAIL — cannot load `../app/usageBilling.server.js`.

- [ ] **Step 3: Write the module**

Create `apps/shopify-app/app/usageBilling.server.js`:

```js
import { tagged } from './errors.server.js'

/**
 * Reports paid AI-model saves to Shopify App Pricing through the App Events
 * API. The Partner Dashboard meter `ai_model_generated` is fixed $5 with 0
 * included units: the free lifetime allowance is enforced by
 * generations.server.js, so only paid saves are ever sent here.
 *
 * Billing idempotency is permanent on Shopify's side, so re-sending the same
 * key after a failure can never charge twice.
 */

export const APP_EVENTS_VERSION = '2026-10'
export const AI_MODEL_METER = 'ai_model_generated'

const TOKEN_URL = 'https://api.shopify.com/auth/access_token'
const EVENTS_URL = `https://api.shopify.com/app/${APP_EVENTS_VERSION}/events`

let cachedToken = null // { token, expiresAt } -- tokens last 60 minutes

/** Test seam. */
export function resetAppEventsToken() {
  cachedToken = null
}

async function accessToken(fetchImpl, now) {
  if (cachedToken && cachedToken.expiresAt > now + 60_000) return cachedToken.token
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_APP_EVENTS_CLIENT_ID,
      client_secret: process.env.SHOPIFY_APP_EVENTS_CLIENT_SECRET,
      grant_type: 'client_credentials',
    }),
  })
  if (!res.ok) throw tagged('APP_EVENTS_AUTH', `app events token request failed: ${res.status}`)
  const body = await res.json()
  cachedToken = { token: body.access_token, expiresAt: now + body.expires_in * 1000 }
  return cachedToken.token
}

/**
 * One $5 charge for one saved AI model.
 * @param {{ shopGid: string, idempotencyKey: string, timestamp: Date|string }} charge
 */
export async function reportModelCharge(
  { shopGid, idempotencyKey, timestamp },
  { fetchImpl = fetch, now = Date.now() } = {},
) {
  const token = await accessToken(fetchImpl, now)
  const res = await fetchImpl(EVENTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      shop_id: shopGid,
      event_handle: AI_MODEL_METER,
      timestamp: new Date(timestamp).toISOString(),
      idempotency_key: idempotencyKey,
      attributes: { value: 1 },
    }),
  })
  if (res.status === 401) cachedToken = null
  if (!res.ok) throw tagged('APP_EVENTS_REJECTED', `app event rejected: ${res.status}`)
  const body = await res.json().catch(() => ({}))
  if (body.success === false) throw tagged('APP_EVENTS_REJECTED', `app event rejected: ${body.error}`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/usageBilling.server.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/usageBilling.server.js apps/shopify-app/test/usageBilling.server.test.js
git commit -m "feat(ai-models): report paid AI model saves to Shopify App Pricing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Photo upload and read URLs in storage

**Files:**
- Modify: `apps/shopify-app/app/storage.server.js`
- Test: `apps/shopify-app/test/storagePhotos.server.test.js`

**Interfaces:**
- Consumes: `tagged` from `app/errors.server.js`.
- Produces:
  - `MAX_PHOTO_BYTES = 10 * 1024 * 1024`
  - `presignPhotoUpload({ contentType: string, size: number, expiresIn?: number }) → Promise<{ uploadUrl: string, storageRef: string }>` — key `generation-photos/<uuid>.<jpg|png|webp>`; throws `tagged('BAD_PHOTO')`
  - `presignObjectRead(storageRef: string, { expiresIn? = 3600 }) → Promise<string>`
  - Existing `deleteModelGlb(key)` is reused to delete photos and pending GLBs (it deletes any key).

- [ ] **Step 1: Write the failing tests**

Create `apps/shopify-app/test/storagePhotos.server.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'

const signed = vi.hoisted(() => [])
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client, command, options) => {
    signed.push({ name: command.constructor.name, input: command.input, options })
    return `https://s3.example/${command.input.Key}`
  },
}))

const { presignPhotoUpload, presignObjectRead, MAX_PHOTO_BYTES } = await import('../app/storage.server.js')

describe('presignPhotoUpload', () => {
  it('signs a PUT for an image under generation-photos/ with its exact type and length', async () => {
    const { uploadUrl, storageRef } = await presignPhotoUpload({ contentType: 'image/webp', size: 1234 })
    expect(storageRef).toMatch(/^generation-photos\/[0-9a-f-]+\.webp$/)
    expect(uploadUrl).toBe(`https://s3.example/${storageRef}`)
    const last = signed.at(-1)
    expect(last.name).toBe('PutObjectCommand')
    expect(last.input).toMatchObject({ Key: storageRef, ContentType: 'image/webp', ContentLength: 1234 })
    expect(last.options).toEqual({ expiresIn: 300 })
  })

  it('maps jpeg and png to their extensions', async () => {
    expect((await presignPhotoUpload({ contentType: 'image/jpeg', size: 1 })).storageRef).toMatch(/\.jpg$/)
    expect((await presignPhotoUpload({ contentType: 'image/png', size: 1 })).storageRef).toMatch(/\.png$/)
  })

  it('rejects other types and out-of-range sizes', async () => {
    await expect(presignPhotoUpload({ contentType: 'image/gif', size: 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    await expect(presignPhotoUpload({ contentType: 'image/png', size: 0 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    await expect(presignPhotoUpload({ contentType: 'image/png', size: MAX_PHOTO_BYTES + 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    expect(MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024)
  })
})

describe('presignObjectRead', () => {
  it('signs a one-hour GET for the key', async () => {
    const url = await presignObjectRead('generation-photos/abc.jpg')
    expect(url).toBe('https://s3.example/generation-photos/abc.jpg')
    const last = signed.at(-1)
    expect(last.name).toBe('GetObjectCommand')
    expect(last.options).toEqual({ expiresIn: 3600 })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/storagePhotos.server.test.js`
Expected: FAIL — `presignPhotoUpload is not a function`.

- [ ] **Step 3: Implement**

In `apps/shopify-app/app/storage.server.js`, add below the existing imports:

```js
import { tagged } from './errors.server.js'
```

Add after `presignModelUpload`:

```js
// AI model generation photos (spec 2026-09-30). The browser PUTs each photo
// straight to storage; the signed ContentLength makes S3 refuse a body of any
// other size, so the 10 MB cap holds even though the check runs server-side
// before the upload happens.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const PHOTO_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export async function presignPhotoUpload({ contentType, size, expiresIn = 300 }) {
  const extension = PHOTO_EXTENSIONS[contentType]
  if (!extension) throw tagged('BAD_PHOTO', `unsupported photo type: ${contentType}`)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PHOTO_BYTES) {
    throw tagged('BAD_PHOTO', `photo size out of range: ${size}`)
  }
  const storageRef = `generation-photos/${globalThis.crypto.randomUUID()}.${extension}`
  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageRef,
      ContentType: contentType,
      ContentLength: size,
    }),
    { expiresIn },
  )
  return { uploadUrl, storageRef }
}

/**
 * Short-lived GET URL, handed to OpenAI so it can fetch the photos itself.
 * Server-to-server, so bucket CORS doesn't apply.
 */
export async function presignObjectRead(storageRef, { expiresIn = 3600 } = {}) {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageRef }),
    { expiresIn },
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/storagePhotos.server.test.js test/presignUpload.server.test.js`
Expected: PASS (both files; the second is the existing DB-free presign test and must stay green).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/storage.server.js apps/shopify-app/test/storagePhotos.server.test.js
git commit -m "feat(ai-models): presign photo uploads and short-lived reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: ModelGeneration table, allowance and feature switch

**Files:**
- Modify: `apps/shopify-app/prisma/schema.prisma`
- Create: `apps/shopify-app/prisma/migrations/20260930000000_model_generation/migration.sql`
- Modify: `apps/shopify-app/app/billing.server.js`
- Create: `apps/shopify-app/app/generations.server.js`
- Create: `apps/shopify-app/test/helpers/fakePrisma.js`
- Test: `apps/shopify-app/test/generations.server.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `billing.server.js`: `AI_MODEL_ALLOWANCE = { Starter: 10, Growth: 40, Pro: Infinity }`, `aiModelAllowance(planName) → number`
  - `generations.server.js`:
    - `LIMITS = { running: 2, perDay: 20, retries: 3, timeoutMs: 900000, retentionDays: 30, stuckMs: 300000 }`
    - `PHOTO_REF = /^generation-photos\/[0-9a-f-]+\.(jpg|png|webp)$/`
    - `aiGenerationEnabled(shop, setting = process.env.AI_GENERATION_SHOPS) → boolean`
    - `getAllowance(prisma, shop, planName) → Promise<{ allowance: number|null, used: number, unlimited: boolean, freeRemaining: number|null }>` (JSON-safe: `null` means unlimited)
    - `toClientGeneration(row) → { id, status, error, retriesLeft, previewUrl, confidence, paid, modelAssetId, createdAt }` where `status` folds `queued`/`collecting` into `running`
  - `test/helpers/fakePrisma.js`: `createFakePrisma() → { modelGeneration, $transaction(fn), $executeRaw(strings, ...values), locks: any[][] }`

- [ ] **Step 1: Add the Prisma model**

Append to `apps/shopify-app/prisma/schema.prisma`:

```prisma
// One AI "Create with AI" job (spec 2026-09-30). Saved rows are kept forever:
// the lifetime free allowance counts them, so deleting the resulting
// ModelAsset must not lower the count. modelAssetId is therefore a plain
// string, not a relation.
model ModelGeneration {
  id             String    @id @default(uuid())
  shop           String
  shopGid        String
  photoRefs      Json
  photoSetId     String
  retryIndex     Int       @default(0)
  autoRetried    Boolean   @default(false)
  providerJobId  String?
  // queued|running|collecting|ready|saving|saved|discarded|failed
  status         String
  error          String?
  glbRef         String?
  calibration    Json?
  paid           Boolean?
  chargeReported Boolean   @default(false)
  modelAssetId   String?   @unique
  startedAt      DateTime?
  savedAt        DateTime?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@index([shop, status])
  @@index([shop, createdAt])
  @@index([providerJobId])
}
```

- [ ] **Step 2: Generate the migration SQL without touching any database**

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen/apps/shopify-app"
git show HEAD:apps/shopify-app/prisma/schema.prisma > /tmp/schema.before.prisma
mkdir -p prisma/migrations/20260930000000_model_generation
npx prisma migrate diff --from-schema-datamodel /tmp/schema.before.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20260930000000_model_generation/migration.sql
cat prisma/migrations/20260930000000_model_generation/migration.sql
```

Expected: the file contains only `CREATE TABLE "ModelGeneration"` (with `"photoRefs" JSONB NOT NULL`, `"calibration" JSONB`, `TIMESTAMP(3)` columns), `CREATE UNIQUE INDEX "ModelGeneration_modelAssetId_key"`, and three `CREATE INDEX` statements. If it contains anything that alters or drops an existing table, STOP — the base schema has drifted; report it instead of committing.

Then: `npx prisma validate && npx prisma generate` → both succeed.

- [ ] **Step 3: Write the fake Prisma helper**

Create `apps/shopify-app/test/helpers/fakePrisma.js`:

```js
import { randomUUID } from 'node:crypto'

// In-memory stand-in for the parts of Prisma that generations.server.js uses,
// so its tests never touch the shared Neon database. Supports equality,
// { in }, { not }, { gte } and { lt } filters -- nothing more.
function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key]
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('in' in cond && !cond.in.includes(value)) return false
      if ('not' in cond && value === cond.not) return false
      if ('gte' in cond && !(value >= cond.gte)) return false
      if ('lt' in cond && !(value < cond.lt)) return false
      return true
    }
    if (value instanceof Date && cond instanceof Date) return value.getTime() === cond.getTime()
    return value === cond
  })
}

const DEFAULTS = {
  retryIndex: 0,
  autoRetried: false,
  providerJobId: null,
  error: null,
  glbRef: null,
  calibration: null,
  paid: null,
  chargeReported: false,
  modelAssetId: null,
  startedAt: null,
  savedAt: null,
}

export function createFakePrisma() {
  const rows = []
  const copy = (row) => (row ? { ...row } : null)
  const modelGeneration = {
    rows,
    async create({ data }) {
      const now = new Date()
      const row = { id: randomUUID(), ...DEFAULTS, createdAt: now, ...data, updatedAt: data.updatedAt ?? now }
      rows.push(row)
      return copy(row)
    },
    async findUnique({ where }) {
      return copy(rows.find((row) => row.id === where.id))
    },
    async findFirst({ where }) {
      return copy(rows.find((row) => matches(row, where)))
    },
    async findMany({ where, orderBy, take } = {}) {
      let out = rows.filter((row) => matches(row, where))
      if (orderBy?.createdAt === 'desc') out = [...out].sort((a, b) => b.createdAt - a.createdAt)
      if (take) out = out.slice(0, take)
      return out.map(copy)
    },
    async count({ where } = {}) {
      return rows.filter((row) => matches(row, where)).length
    },
    async update({ where, data }) {
      const row = rows.find((r) => r.id === where.id)
      if (!row) throw new Error(`fakePrisma: no row ${where.id}`)
      Object.assign(row, data, { updatedAt: new Date() })
      return copy(row)
    },
    async updateMany({ where, data }) {
      const hit = rows.filter((row) => matches(row, where))
      for (const row of hit) Object.assign(row, data, { updatedAt: new Date() })
      return { count: hit.length }
    },
    async delete({ where }) {
      const index = rows.findIndex((row) => row.id === where.id)
      if (index < 0) throw new Error(`fakePrisma: no row ${where.id}`)
      return copy(rows.splice(index, 1)[0])
    },
    async deleteMany({ where }) {
      const keep = rows.filter((row) => !matches(row, where))
      const count = rows.length - keep.length
      rows.splice(0, rows.length, ...keep)
      return { count }
    },
  }
  const prisma = {
    modelGeneration,
    locks: [],
    async $executeRaw(_strings, ...values) {
      prisma.locks.push(values)
      return 1
    },
    async $transaction(fn) {
      return fn(prisma)
    },
  }
  return prisma
}
```

- [ ] **Step 4: Write the failing tests**

Create `apps/shopify-app/test/generations.server.test.js`. This file grows in Tasks 5–7; the mock block at the top already covers every module those tasks use.

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createFakePrisma } from './helpers/fakePrisma.js'

const deps = vi.hoisted(() => ({
  start: vi.fn(),
  check: vi.fn(),
  cancel: vi.fn(),
  calibrate: vi.fn(),
  saveCalibratedModel: vi.fn(),
  report: vi.fn(),
  objects: new Map(),
}))

vi.mock('../app/modelGenerator.server.js', () => ({
  startGeneration: (...args) => deps.start(...args),
  checkGeneration: (...args) => deps.check(...args),
  cancelGeneration: (...args) => deps.cancel(...args),
}))
vi.mock('../app/calibration.server.js', () => ({
  calibrateUpload: (...args) => deps.calibrate(...args),
}))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async (key, bytes) => {
    deps.objects.set(key, Buffer.from(bytes))
  },
  readModelGlb: async (key) => deps.objects.get(key) ?? null,
  deleteModelGlb: async (key) => {
    deps.objects.delete(key)
  },
  presignObjectRead: async (key) => `https://signed.example/${key}`,
}))
vi.mock('../app/models.server.js', () => ({
  saveCalibratedModel: (...args) => deps.saveCalibratedModel(...args),
}))
vi.mock('../app/usageBilling.server.js', () => ({
  reportModelCharge: (...args) => deps.report(...args),
}))

const generations = await import('../app/generations.server.js')
const { aiModelAllowance } = await import('../app/billing.server.js')

const SHOP = 'gen-test.myshopify.com'
const SHOP_GID = 'gid://shopify/Shop/1'
const PHOTOS = ['generation-photos/0a1b.jpg', 'generation-photos/2c3d.png', 'generation-photos/4e5f.webp']
const NOW = new Date('2026-10-01T12:00:00Z')

function row(overrides = {}) {
  return { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, photoSetId: 'set-1', status: 'ready', ...overrides }
}

async function seed(prisma, statuses, overrides = {}) {
  for (const status of statuses) await prisma.modelGeneration.create({ data: row({ status, ...overrides }) })
}

beforeEach(() => {
  vi.resetAllMocks()
  deps.objects.clear()
})

describe('aiModelAllowance', () => {
  it('gives Starter 10, Growth 40, Pro unlimited, and anything else nothing', () => {
    expect(aiModelAllowance('Starter')).toBe(10)
    expect(aiModelAllowance('Growth')).toBe(40)
    expect(aiModelAllowance('Pro')).toBe(Infinity)
    expect(aiModelAllowance('Enterprise')).toBe(0)
    expect(aiModelAllowance(null)).toBe(0)
  })
})

describe('getAllowance', () => {
  it('counts saving and saved rows for this shop only, over the shop lifetime', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, ['saved', 'saved', 'saving', 'ready', 'failed', 'discarded', 'running'])
    await seed(prisma, ['saved'], { shop: 'other.myshopify.com' })
    await expect(generations.getAllowance(prisma, SHOP, 'Starter'))
      .resolves.toEqual({ allowance: 10, used: 3, unlimited: false, freeRemaining: 7 })
  })

  it('tops up on upgrade: 10 used leaves 30 on Growth', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(10).fill('saved'))
    await expect(generations.getAllowance(prisma, SHOP, 'Growth'))
      .resolves.toEqual({ allowance: 40, used: 10, unlimited: false, freeRemaining: 30 })
  })

  it('floors at zero after a downgrade', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(12).fill('saved'))
    expect((await generations.getAllowance(prisma, SHOP, 'Starter')).freeRemaining).toBe(0)
  })

  it('reports Pro as unlimited with JSON-safe nulls', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, ['saved'])
    await expect(generations.getAllowance(prisma, SHOP, 'Pro'))
      .resolves.toEqual({ allowance: null, used: 1, unlimited: true, freeRemaining: null })
  })
})

describe('aiGenerationEnabled', () => {
  it('is off when unset, on for listed shops (case-insensitive), and on for everyone with *', () => {
    expect(generations.aiGenerationEnabled(SHOP, undefined)).toBe(false)
    expect(generations.aiGenerationEnabled(SHOP, '')).toBe(false)
    expect(generations.aiGenerationEnabled(SHOP, 'a.myshopify.com, GEN-TEST.myshopify.com')).toBe(true)
    expect(generations.aiGenerationEnabled(SHOP, 'a.myshopify.com')).toBe(false)
    expect(generations.aiGenerationEnabled(SHOP, '*')).toBe(true)
    expect(generations.aiGenerationEnabled(null, '*')).toBe(false)
  })
})

describe('toClientGeneration', () => {
  it('folds queued and collecting into running and only exposes a preview when ready', () => {
    const base = { id: 'g1', error: null, retryIndex: 1, calibration: { confidence: 0.9 }, paid: null, modelAssetId: null, createdAt: NOW }
    expect(generations.toClientGeneration({ ...base, status: 'queued' }).status).toBe('running')
    expect(generations.toClientGeneration({ ...base, status: 'collecting' }).status).toBe('running')
    expect(generations.toClientGeneration({ ...base, status: 'ready' })).toEqual({
      id: 'g1', status: 'ready', error: null, retriesLeft: 2, previewUrl: '/generations/g1.glb',
      confidence: 0.9, paid: null, modelAssetId: null, createdAt: NOW,
    })
    expect(generations.toClientGeneration({ ...base, status: 'failed' }).previewUrl).toBeNull()
  })
})
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npx vitest run test/generations.server.test.js`
Expected: FAIL — cannot load `../app/generations.server.js`.

- [ ] **Step 6: Implement**

In `apps/shopify-app/app/billing.server.js`, directly below `PLAN_LIMITS`:

```js
// Lifetime free AI-generated models per plan (spec 2026-09-30). Separate from
// PLAN_LIMITS, which caps products with try-on. Past it, each saved model is a
// $5 usage charge. Same fail-closed rule as planLimit: unknown name -> 0.
export const AI_MODEL_ALLOWANCE = { Starter: 10, Growth: 40, Pro: Infinity }

export function aiModelAllowance(name) {
  return Object.prototype.hasOwnProperty.call(AI_MODEL_ALLOWANCE, name)
    ? AI_MODEL_ALLOWANCE[name]
    : 0
}
```

Create `apps/shopify-app/app/generations.server.js`:

```js
import { aiModelAllowance } from './billing.server.js'

/**
 * "Create with AI": turns merchant photos into a saved ModelAsset
 * (spec docs/superpowers/specs/2026-09-30-ai-model-generation-design.md).
 *
 * Lifecycle of a ModelGeneration row:
 *   queued -> running -> collecting -> ready -> saving -> saved
 *                  \-> (one free automatic retry) -> running
 *                  \-> failed           ready -> discarded
 */

export const LIMITS = {
  running: 2,
  perDay: 20,
  retries: 3,
  timeoutMs: 15 * 60 * 1000,
  retentionDays: 30,
  stuckMs: 5 * 60 * 1000,
}

export const PHOTO_REF = /^generation-photos\/[0-9a-f-]+\.(jpg|png|webp)$/

const USED_STATUSES = ['saving', 'saved']

/**
 * Per-shop switch while the feature rolls out. Admin changes are only visible
 * after a production deploy, so it ships dark and is enabled shop by shop.
 * @param {string|null|undefined} shop myshopify domain
 * @param {string|undefined} setting comma-separated domains, or '*'
 */
// eslint-disable-next-line no-undef
export function aiGenerationEnabled(shop, setting = process.env.AI_GENERATION_SHOPS) {
  if (!shop || !setting) return false
  const list = setting.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return list.includes('*') || list.includes(shop.toLowerCase())
}

/**
 * Free AI models left for a shop. `used` is lifetime: every row that reached
 * saving/saved, whatever the plan was then, so an upgrade tops up
 * (allowance - used) and a downgrade never takes anything back.
 * Unlimited plans come back as nulls so the value survives JSON.
 */
export async function getAllowance(prisma, shop, planName) {
  const allowance = aiModelAllowance(planName)
  const used = await prisma.modelGeneration.count({ where: { shop, status: { in: USED_STATUSES } } })
  if (!Number.isFinite(allowance)) {
    return { allowance: null, used, unlimited: true, freeRemaining: null }
  }
  return { allowance, used, unlimited: false, freeRemaining: Math.max(0, allowance - used) }
}

/** The shape the admin UI sees. Internal states collapse to what a merchant can act on. */
export function toClientGeneration(generation) {
  const status = ['queued', 'collecting'].includes(generation.status) ? 'running' : generation.status
  return {
    id: generation.id,
    status,
    error: generation.error,
    retriesLeft: Math.max(0, LIMITS.retries - generation.retryIndex),
    previewUrl: status === 'ready' ? `/generations/${generation.id}.glb` : null,
    confidence: generation.calibration?.confidence ?? null,
    paid: generation.paid,
    modelAssetId: generation.modelAssetId,
    createdAt: generation.createdAt,
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run test/generations.server.test.js test/billing.server.test.js`
Expected: PASS. (`billing.server.test.js` is existing and DB-free; it must stay green. If it turns out to import `db.server`, drop it from the command and run only the new file.)

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/prisma apps/shopify-app/app/billing.server.js apps/shopify-app/app/generations.server.js apps/shopify-app/test/helpers/fakePrisma.js apps/shopify-app/test/generations.server.test.js
git commit -m "feat(ai-models): add the ModelGeneration table, lifetime allowance and rollout switch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Start a generation (cost guard, retries)

**Files:**
- Modify: `apps/shopify-app/app/generations.server.js`
- Test: `apps/shopify-app/test/generations.server.test.js` (append)

**Interfaces:**
- Consumes: `startGeneration` (Task 1), `presignObjectRead`, `deleteModelGlb` (Task 3/existing), `tagged`.
- Produces:
  - `createGeneration(prisma, { shop, shopGid, photoRefs?, retryOf?, now? }) → Promise<row>` — row is `running` on success or `failed` with `error: 'start_failed'`; throws `tagged` codes `BAD_PHOTOS`, `NOT_FOUND`, `NOT_RETRYABLE`, `RETRY_LIMIT`, `TOO_MANY_RUNNING`, `DAILY_LIMIT`
  - `discardGeneration(prisma, shop, generationId) → Promise<row>` — throws `NOT_FOUND`, `NOT_READY`
  - internal `photoUrls(photoRefs) → Promise<string[]>` (reused by Task 6)

- [ ] **Step 1: Append the failing tests**

Append to `apps/shopify-app/test/generations.server.test.js`:

```js
describe('createGeneration', () => {
  beforeEach(() => {
    let n = 0
    deps.start.mockImplementation(async () => ({ providerJobId: `resp_${++n}` }))
  })

  it('starts a job with signed photo URLs and marks it running', async () => {
    const prisma = createFakePrisma()
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(deps.start).toHaveBeenCalledWith({ images: PHOTOS.map((k) => `https://signed.example/${k}`) })
    expect(g).toMatchObject({ status: 'running', providerJobId: 'resp_1', shopGid: SHOP_GID, retryIndex: 0, startedAt: NOW })
    expect(g.photoSetId).toEqual(expect.any(String))
  })

  it('accepts 3 or 4 photo keys and nothing else', async () => {
    const prisma = createFakePrisma()
    const bad = [
      PHOTOS.slice(0, 2),
      [...PHOTOS, 'generation-photos/aa.jpg', 'generation-photos/bb.jpg'],
      [...PHOTOS.slice(0, 2), 'uploads/0a1b.glb'],
      'generation-photos/0a1b.jpg',
    ]
    for (const photoRefs of bad) {
      await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs, now: NOW }))
        .rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    }
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: [...PHOTOS, 'generation-photos/9f.jpg'], now: NOW }))
      .resolves.toMatchObject({ status: 'running' })
  })

  it('refuses a third concurrent generation', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, ['running', 'collecting'])
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }))
      .rejects.toMatchObject({ code: 'TOO_MANY_RUNNING' })
  })

  it('refuses the 21st start in 24 hours, counting automatic retries, ignoring older rows', async () => {
    const prisma = createFakePrisma()
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000)
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000)
    await seed(prisma, Array(15).fill('failed'), { createdAt: recent })
    await seed(prisma, Array(4).fill('failed'), { createdAt: recent, autoRetried: true })
    await seed(prisma, Array(10).fill('failed'), { createdAt: old, autoRetried: true })
    // 15 + 4 rows + 4 automatic retries = 23 >= 20
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }))
      .rejects.toMatchObject({ code: 'DAILY_LIMIT' })
  })

  it('retries reuse the photo set, discard a ready parent, and stop after 3', async () => {
    const prisma = createFakePrisma()
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/p.glb' }) })
    deps.objects.set('generations/p.glb', Buffer.from('p'))

    const first = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW })
    expect(first).toMatchObject({ photoSetId: 'set-1', retryIndex: 1, photoRefs: PHOTOS, status: 'running' })
    expect((await prisma.modelGeneration.findUnique({ where: { id: parent.id } })).status).toBe('discarded')
    expect(deps.objects.has('generations/p.glb')).toBe(false)

    await prisma.modelGeneration.update({ where: { id: first.id }, data: { status: 'failed' } })
    const second = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: first.id, now: NOW })
    await prisma.modelGeneration.update({ where: { id: second.id }, data: { status: 'failed' } })
    const third = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: second.id, now: NOW })
    expect(third.retryIndex).toBe(3)
    await prisma.modelGeneration.update({ where: { id: third.id }, data: { status: 'failed' } })

    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: third.id, now: NOW }))
      .rejects.toMatchObject({ code: 'RETRY_LIMIT' })
  })

  it('will not retry a running or saved generation, or another shop\'s', async () => {
    const prisma = createFakePrisma()
    const running = await prisma.modelGeneration.create({ data: row({ status: 'running' }) })
    const saved = await prisma.modelGeneration.create({ data: row({ status: 'saved' }) })
    const foreign = await prisma.modelGeneration.create({ data: row({ status: 'failed', shop: 'other.myshopify.com' }) })
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: running.id, now: NOW })).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: saved.id, now: NOW })).rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: foreign.id, now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('marks the row failed (start_failed) when OpenAI refuses the job, without throwing', async () => {
    const prisma = createFakePrisma()
    deps.start.mockRejectedValue(new Error('429'))
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g).toMatchObject({ status: 'failed', error: 'start_failed' })
  })
})

describe('discardGeneration', () => {
  it('discards a ready or failed generation and deletes its pending GLB', async () => {
    const prisma = createFakePrisma()
    const ready = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/r.glb' }) })
    deps.objects.set('generations/r.glb', Buffer.from('r'))
    const failed = await prisma.modelGeneration.create({ data: row({ status: 'failed' }) })
    await expect(generations.discardGeneration(prisma, SHOP, ready.id)).resolves.toMatchObject({ status: 'discarded', glbRef: null })
    expect(deps.objects.has('generations/r.glb')).toBe(false)
    await expect(generations.discardGeneration(prisma, SHOP, failed.id)).resolves.toMatchObject({ status: 'discarded' })
  })

  it('refuses other states and other shops', async () => {
    const prisma = createFakePrisma()
    const running = await prisma.modelGeneration.create({ data: row({ status: 'running' }) })
    const foreign = await prisma.modelGeneration.create({ data: row({ status: 'ready', shop: 'other.myshopify.com' }) })
    await expect(generations.discardGeneration(prisma, SHOP, running.id)).rejects.toMatchObject({ code: 'NOT_READY' })
    await expect(generations.discardGeneration(prisma, SHOP, foreign.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/generations.server.test.js`
Expected: FAIL — `generations.createGeneration is not a function` (Task 4 tests still pass).

- [ ] **Step 3: Implement**

In `apps/shopify-app/app/generations.server.js`, replace the import line with:

```js
import { aiModelAllowance } from './billing.server.js'
import { startGeneration } from './modelGenerator.server.js'
import { deleteModelGlb, presignObjectRead } from './storage.server.js'
import { tagged } from './errors.server.js'
```

Add below `LIMITS`/`PHOTO_REF`/`USED_STATUSES`:

```js
const ACTIVE_STATUSES = ['queued', 'running', 'collecting']
const RETRYABLE_STATUSES = ['ready', 'failed', 'discarded']
const DAY_MS = 24 * 60 * 60 * 1000

// OpenAI fetches the photos itself, so it gets short-lived signed URLs.
async function photoUrls(photoRefs) {
  return Promise.all(photoRefs.map((ref) => presignObjectRead(ref)))
}

function validPhotoRefs(photoRefs) {
  return Array.isArray(photoRefs)
    && photoRefs.length >= 3
    && photoRefs.length <= 4
    && photoRefs.every((ref) => typeof ref === 'string' && PHOTO_REF.test(ref))
}

async function assertWithinCostGuard(prisma, shop, now) {
  const running = await prisma.modelGeneration.count({ where: { shop, status: { in: ACTIVE_STATUSES } } })
  if (running >= LIMITS.running) {
    throw tagged('TOO_MANY_RUNNING', `shop already has ${running} generations running`)
  }
  const since = new Date(now.getTime() - DAY_MS)
  const [started, autoRetries] = await Promise.all([
    prisma.modelGeneration.count({ where: { shop, createdAt: { gte: since } } }),
    prisma.modelGeneration.count({ where: { shop, createdAt: { gte: since }, autoRetried: true } }),
  ])
  if (started + autoRetries >= LIMITS.perDay) {
    throw tagged('DAILY_LIMIT', `shop started ${started + autoRetries} generations in 24h`)
  }
}

/**
 * Start a generation from fresh photos, or a merchant retry (`retryOf`) that
 * reuses a previous attempt's photos. A retry of a result the merchant hasn't
 * saved discards that result. Failing to reach OpenAI is not an exception: the
 * row comes back `failed`, which is free and shows the merchant a message.
 */
export async function createGeneration(prisma, { shop, shopGid, photoRefs = null, retryOf = null, now = new Date() }) {
  let photoSetId = globalThis.crypto.randomUUID()
  let retryIndex = 0
  let parent = null

  if (retryOf) {
    parent = await prisma.modelGeneration.findFirst({ where: { id: retryOf, shop } })
    if (!parent) throw tagged('NOT_FOUND', `generation ${retryOf} not found`)
    if (!RETRYABLE_STATUSES.includes(parent.status)) {
      throw tagged('NOT_RETRYABLE', `cannot retry a ${parent.status} generation`)
    }
    // Counting the set, not reading parent.retryIndex, so retrying an older
    // attempt can't restart the count.
    const setSize = await prisma.modelGeneration.count({ where: { shop, photoSetId: parent.photoSetId } })
    if (setSize > LIMITS.retries) throw tagged('RETRY_LIMIT', 'no retries left for this photo set')
    photoRefs = parent.photoRefs
    photoSetId = parent.photoSetId
    retryIndex = setSize
  } else if (!validPhotoRefs(photoRefs)) {
    throw tagged('BAD_PHOTOS', 'expected 3 or 4 uploaded photos')
  }

  await assertWithinCostGuard(prisma, shop, now)
  if (parent?.status === 'ready') await discardGeneration(prisma, shop, parent.id)

  const generation = await prisma.modelGeneration.create({
    data: { shop, shopGid, photoRefs, photoSetId, retryIndex, status: 'queued', createdAt: now },
  })
  try {
    const { providerJobId } = await startGeneration({ images: await photoUrls(photoRefs) })
    return prisma.modelGeneration.update({
      where: { id: generation.id },
      data: { status: 'running', providerJobId, startedAt: now },
    })
  } catch (error) {
    console.error('AI generation start failed', generation.id, error)
    return prisma.modelGeneration.update({
      where: { id: generation.id },
      data: { status: 'failed', error: 'start_failed' },
    })
  }
}

/** Throw away an unsaved result (free). Photos stay: a later retry reuses them. */
export async function discardGeneration(prisma, shop, generationId) {
  const generation = await prisma.modelGeneration.findFirst({ where: { id: generationId, shop } })
  if (!generation) throw tagged('NOT_FOUND', `generation ${generationId} not found`)
  if (!['ready', 'failed'].includes(generation.status)) {
    throw tagged('NOT_READY', `cannot discard a ${generation.status} generation`)
  }
  if (generation.glbRef) await deleteModelGlb(generation.glbRef)
  return prisma.modelGeneration.update({
    where: { id: generation.id },
    data: { status: 'discarded', glbRef: null },
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/generations.server.test.js`
Expected: PASS (all describes so far).

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/generations.server.js apps/shopify-app/test/generations.server.test.js
git commit -m "feat(ai-models): start generations behind a cost guard and a 3-retry limit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Advance a running generation (collect, check, auto-retry, timeout)

**Files:**
- Modify: `apps/shopify-app/app/generations.server.js`
- Test: `apps/shopify-app/test/generations.server.test.js` (append)

**Interfaces:**
- Consumes: `checkGeneration`, `cancelGeneration`, `startGeneration` (Task 1); `calibrateUpload(glbBuffer) → { needsManual, confidence: { overall }|null, fitMetadata: { provenance: { source } } }` (existing, throws on invalid); `saveModelGlb` (existing).
- Produces:
  - `advanceGeneration(prisma, generation, now?) → Promise<row>` — no-op unless `status === 'running'`; never runs twice for one finished job (claims `running → collecting`)
  - `advanceByProviderJob(prisma, providerJobId, now?) → Promise<row|null>` (for the webhook)
  - `FEEDBACK` map and error codes stored on rows: `timeout`, `low_confidence`, `invalid_model: <msg>`, `no_glb_output`, `glb_too_large`, `openai_<status>`

- [ ] **Step 1: Append the failing tests**

Append to `apps/shopify-app/test/generations.server.test.js`:

```js
describe('advanceGeneration', () => {
  const GOOD_CALIBRATION = { needsManual: false, confidence: { overall: 0.93 }, fitMetadata: { provenance: { source: 'tagged' } } }

  async function running(prisma, overrides = {}) {
    return prisma.modelGeneration.create({
      data: row({ status: 'running', providerJobId: 'resp_1', startedAt: new Date(NOW.getTime() - 60_000), ...overrides }),
    })
  }

  beforeEach(() => {
    deps.start.mockResolvedValue({ providerJobId: 'resp_retry' })
  })

  it('leaves a job that is still working alone', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'running' })
    await expect(generations.advanceGeneration(prisma, g, NOW)).resolves.toMatchObject({ status: 'running' })
    expect(deps.cancel).not.toHaveBeenCalled()
  })

  it('stores a good model and marks it ready', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
    deps.calibrate.mockResolvedValue(GOOD_CALIBRATION)
    const next = await generations.advanceGeneration(prisma, g, NOW)
    expect(next).toMatchObject({
      status: 'ready',
      glbRef: `generations/${g.id}.glb`,
      error: null,
      calibration: { confidence: 0.93, source: 'tagged' },
    })
    expect(deps.objects.get(`generations/${g.id}.glb`).toString()).toBe('glb')
  })

  it('auto-retries an invalid model once, for free, with the reason as feedback', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('bad') })
    deps.calibrate.mockRejectedValue(new Error('model rejected: no mesh'))
    const next = await generations.advanceGeneration(prisma, g, NOW)
    expect(next).toMatchObject({ status: 'running', autoRetried: true, providerJobId: 'resp_retry', startedAt: NOW })
    expect(next.error).toMatch(/^invalid_model: model rejected: no mesh/)
    const [{ images, feedback }] = deps.start.mock.calls[0]
    expect(images).toEqual(PHOTOS.map((k) => `https://signed.example/${k}`))
    expect(feedback).toMatch(/model rejected: no mesh/)
  })

  it('fails for good after the automatic retry also fails', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma, { autoRetried: true })
    deps.check.mockResolvedValue({ state: 'failed', error: 'no_glb_output' })
    await expect(generations.advanceGeneration(prisma, g, NOW)).resolves.toMatchObject({ status: 'failed', error: 'no_glb_output' })
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('treats a low-confidence fit as a failure and says how to fix it', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('meh') })
    deps.calibrate.mockResolvedValue({ ...GOOD_CALIBRATION, needsManual: true })
    const next = await generations.advanceGeneration(prisma, g, NOW)
    expect(next).toMatchObject({ status: 'running', autoRetried: true, error: 'low_confidence' })
    expect(deps.start.mock.calls[0][0].feedback).toMatch(/AR_bridge/)
  })

  it('cancels a job that runs past 15 minutes, then retries or fails it', async () => {
    const prisma = createFakePrisma()
    const late = new Date(NOW.getTime() - 16 * 60_000)
    const first = await running(prisma, { startedAt: late })
    deps.check.mockResolvedValue({ state: 'running' })
    await expect(generations.advanceGeneration(prisma, first, NOW)).resolves.toMatchObject({ status: 'running', autoRetried: true, error: 'timeout' })
    expect(deps.cancel).toHaveBeenCalledWith('resp_1')

    const second = await running(prisma, { startedAt: late, autoRetried: true, providerJobId: 'resp_2' })
    await expect(generations.advanceGeneration(prisma, second, NOW)).resolves.toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('does nothing when someone else already collected the job', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    await prisma.modelGeneration.update({ where: { id: g.id }, data: { status: 'ready' } })
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
    await expect(generations.advanceGeneration(prisma, g, NOW)).resolves.toMatchObject({ status: 'ready' })
    expect(deps.calibrate).not.toHaveBeenCalled()
  })

  it('ignores rows that are not running', async () => {
    const prisma = createFakePrisma()
    const g = await prisma.modelGeneration.create({ data: row({ status: 'ready' }) })
    await expect(generations.advanceGeneration(prisma, g, NOW)).resolves.toMatchObject({ status: 'ready' })
    expect(deps.check).not.toHaveBeenCalled()
  })
})

describe('advanceByProviderJob', () => {
  it('advances the running row that owns the OpenAI job, and ignores unknown or stale ids', async () => {
    const prisma = createFakePrisma()
    await prisma.modelGeneration.create({ data: row({ status: 'running', providerJobId: 'resp_live', startedAt: NOW }) })
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
    deps.calibrate.mockResolvedValue({ needsManual: false, confidence: null, fitMetadata: { provenance: { source: 'tagged' } } })
    await expect(generations.advanceByProviderJob(prisma, 'resp_live', NOW)).resolves.toMatchObject({ status: 'ready' })
    await expect(generations.advanceByProviderJob(prisma, 'resp_unknown', NOW)).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/generations.server.test.js`
Expected: FAIL — `generations.advanceGeneration is not a function`.

- [ ] **Step 3: Implement**

In `apps/shopify-app/app/generations.server.js`, change the imports to:

```js
import { aiModelAllowance } from './billing.server.js'
import { startGeneration, checkGeneration, cancelGeneration } from './modelGenerator.server.js'
import { calibrateUpload } from './calibration.server.js'
import { saveModelGlb, deleteModelGlb, presignObjectRead } from './storage.server.js'
import { tagged } from './errors.server.js'
```

Add at the end of the file:

```js
// What the automatic retry tells the model about the previous attempt.
const FEEDBACK = {
  timeout: 'The previous attempt took too long. Use simpler geometry (fewer segments) and finish within a few minutes.',
  no_glb_output: 'The previous attempt did not save and cite /mnt/data/model.glb. You must save the GLB there and cite it.',
  glb_too_large: 'The previous GLB was over 25 MB. Reduce the triangle count and texture sizes.',
  low_confidence: 'The previous model could not be fitted to a face reliably. Make sure the front faces +Z, the frame is symmetric about X = 0, and AR_bridge, AR_hinge_L and AR_hinge_R sit exactly at the bridge and the two hinges.',
}

function feedbackFor(reason) {
  if (FEEDBACK[reason]) return FEEDBACK[reason]
  if (reason.startsWith('invalid_model')) return `The previous GLB failed validation (${reason.slice('invalid_model: '.length)}). Fix it.`
  return `The previous attempt failed (${reason}). Try again, following every requirement.`
}

// One free automatic retry per generation, then a merchant-visible failure.
async function retryOrFail(prisma, generation, reason, now) {
  if (!generation.autoRetried) {
    try {
      const { providerJobId } = await startGeneration({
        images: await photoUrls(generation.photoRefs),
        feedback: feedbackFor(reason),
      })
      return prisma.modelGeneration.update({
        where: { id: generation.id },
        data: { status: 'running', autoRetried: true, providerJobId, startedAt: now, error: reason },
      })
    } catch (error) {
      console.error('AI generation automatic retry failed to start', generation.id, error)
    }
  }
  return prisma.modelGeneration.update({
    where: { id: generation.id },
    data: { status: 'failed', error: reason },
  })
}

/**
 * Move a running generation forward. Called by the OpenAI webhook and by the
 * admin page's polling, possibly at the same moment -- so a finished job is
 * claimed (running -> collecting, conditional on the same providerJobId)
 * before anything is downloaded, and only the claimer proceeds.
 */
export async function advanceGeneration(prisma, generation, now = new Date()) {
  if (generation.status !== 'running') return generation

  const result = await checkGeneration(generation.providerJobId)
  const timedOut = result.state === 'running'
    && now.getTime() - new Date(generation.startedAt).getTime() > LIMITS.timeoutMs
  if (result.state === 'running' && !timedOut) return generation
  if (timedOut) await cancelGeneration(generation.providerJobId)

  const claim = await prisma.modelGeneration.updateMany({
    where: { id: generation.id, status: 'running', providerJobId: generation.providerJobId },
    data: { status: 'collecting' },
  })
  if (claim.count === 0) return prisma.modelGeneration.findUnique({ where: { id: generation.id } })

  if (timedOut) return retryOrFail(prisma, generation, 'timeout', now)
  if (result.state === 'failed') return retryOrFail(prisma, generation, result.error, now)

  let calibration
  try {
    calibration = await calibrateUpload(result.glbBytes)
  } catch (error) {
    return retryOrFail(prisma, generation, `invalid_model: ${error.message}`, now)
  }
  if (calibration.needsManual) return retryOrFail(prisma, generation, 'low_confidence', now)

  const glbRef = `generations/${generation.id}.glb`
  await saveModelGlb(glbRef, result.glbBytes)
  return prisma.modelGeneration.update({
    where: { id: generation.id },
    data: {
      status: 'ready',
      glbRef,
      error: null,
      calibration: {
        confidence: calibration.confidence?.overall ?? null,
        source: calibration.fitMetadata.provenance.source,
      },
    },
  })
}

/** Webhook entry point. A stale id (replaced by an automatic retry) matches nothing. */
export async function advanceByProviderJob(prisma, providerJobId, now = new Date()) {
  const generation = await prisma.modelGeneration.findFirst({ where: { providerJobId, status: 'running' } })
  if (!generation) return null
  return advanceGeneration(prisma, generation, now)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/generations.server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/generations.server.js apps/shopify-app/test/generations.server.test.js
git commit -m "feat(ai-models): collect finished jobs, check them, and auto-retry once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Save and charge, list, sweep

**Files:**
- Modify: `apps/shopify-app/app/generations.server.js`
- Test: `apps/shopify-app/test/generations.server.test.js` (append)

**Interfaces:**
- Consumes: `saveCalibratedModel(prisma, shop, glbBytes, filename) → { assetId, ... }` (existing `models.server.js`); `readModelGlb` (existing); `reportModelCharge` (Task 2); `getAllowance` (Task 4).
- Produces:
  - `saveGeneration(prisma, { shop, generationId, planName, acceptCharge = false, now? }) → Promise<{ assetId: string, paid: boolean }>` — throws `NOT_FOUND`, `NOT_READY`, `CHARGE_NOT_CONFIRMED`, `GLB_MISSING`, or the asset-creation error
  - `listGenerations(prisma, shop, now?) → Promise<row[]>` — sweeps, unsticks, advances, re-sends unreported charges, then returns up to 20 rows in `queued|running|collecting|ready|saving|failed`, newest first
  - Saved model filename: `'AI model'`

- [ ] **Step 1: Append the failing tests**

Append to `apps/shopify-app/test/generations.server.test.js`:

```js
describe('saveGeneration', () => {
  async function readyRow(prisma, overrides = {}) {
    const g = await prisma.modelGeneration.create({ data: row({ status: 'ready', ...overrides }) })
    const glbRef = `generations/${g.id}.glb`
    deps.objects.set(glbRef, Buffer.from('glb'))
    return prisma.modelGeneration.update({ where: { id: g.id }, data: { glbRef } })
  }

  beforeEach(() => {
    deps.saveCalibratedModel.mockResolvedValue({ assetId: 'asset-1' })
    deps.report.mockResolvedValue(undefined)
  })

  it('saves within the allowance for free', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .resolves.toEqual({ assetId: 'asset-1', paid: false })
    const [, shopArg, bytes, filename] = deps.saveCalibratedModel.mock.calls[0]
    expect([shopArg, bytes.toString(), filename]).toEqual([SHOP, 'glb', 'AI model'])
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({
      status: 'saved', paid: false, modelAssetId: 'asset-1', savedAt: NOW, glbRef: null,
    })
    expect(deps.objects.has(`generations/${g.id}.glb`)).toBe(false)
    expect(deps.report).not.toHaveBeenCalled()
    expect(prisma.locks).toEqual([[SHOP]])
  })

  it('charges $5 once the allowance is used up, when the merchant accepted', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(10).fill('saved'))
    const g = await readyRow(prisma)
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', acceptCharge: true, now: NOW }))
      .resolves.toEqual({ assetId: 'asset-1', paid: true })
    expect(deps.report).toHaveBeenCalledWith({ shopGid: SHOP_GID, idempotencyKey: `aimodel_${g.id}`, timestamp: NOW })
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ paid: true, chargeReported: true })
  })

  it('refuses a paid save the merchant did not accept, and leaves it ready', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(10).fill('saved'))
    const g = await readyRow(prisma)
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .rejects.toMatchObject({ code: 'CHARGE_NOT_CONFIRMED' })
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'ready', paid: null })
    expect(deps.saveCalibratedModel).not.toHaveBeenCalled()
  })

  it('never charges on Pro', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(100).fill('saved'))
    const g = await readyRow(prisma)
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Pro', now: NOW }))
      .resolves.toEqual({ assetId: 'asset-1', paid: false })
    expect(deps.report).not.toHaveBeenCalled()
  })

  it('puts the row back to ready, uncharged, when creating the asset fails', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    deps.saveCalibratedModel.mockRejectedValue(new Error('S3 down'))
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .rejects.toThrow('S3 down')
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'ready', paid: null })
    expect(deps.objects.has(`generations/${g.id}.glb`)).toBe(true)
  })

  it('keeps the model saved when reporting the charge fails', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(10).fill('saved'))
    const g = await readyRow(prisma)
    deps.report.mockRejectedValue(Object.assign(new Error('503'), { code: 'APP_EVENTS_REJECTED' }))
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', acceptCharge: true, now: NOW }))
      .resolves.toEqual({ assetId: 'asset-1', paid: true })
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'saved', chargeReported: false })
  })

  it('only saves ready rows of this shop', async () => {
    const prisma = createFakePrisma()
    const running = await prisma.modelGeneration.create({ data: row({ status: 'running' }) })
    const foreign = await readyRow(prisma, { shop: 'other.myshopify.com' })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: running.id, planName: 'Pro', now: NOW })).rejects.toMatchObject({ code: 'NOT_READY' })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: foreign.id, planName: 'Pro', now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('listGenerations', () => {
  it('re-sends unreported charges', async () => {
    const prisma = createFakePrisma()
    const g = await prisma.modelGeneration.create({ data: row({ status: 'saved', paid: true, chargeReported: false, savedAt: NOW }) })
    deps.report.mockResolvedValue(undefined)
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(deps.report).toHaveBeenCalledWith({ shopGid: SHOP_GID, idempotencyKey: `aimodel_${g.id}`, timestamp: NOW })
    expect((await prisma.modelGeneration.findUnique({ where: { id: g.id } })).chargeReported).toBe(true)
  })

  it('advances running rows and unsticks rows left collecting for over 5 minutes', async () => {
    const prisma = createFakePrisma()
    await prisma.modelGeneration.create({ data: row({ status: 'running', providerJobId: 'resp_a', startedAt: NOW }) })
    await prisma.modelGeneration.create({ data: row({ status: 'collecting', providerJobId: 'resp_b', startedAt: NOW, updatedAt: new Date(NOW.getTime() - 6 * 60_000) }) })
    deps.check.mockResolvedValue({ state: 'running' })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(deps.check.mock.calls.map(([id]) => id).sort()).toEqual(['resp_a', 'resp_b'])
  })

  it('deletes 30-day-old photos and pending models; keeps saved rows for the allowance', async () => {
    const prisma = createFakePrisma()
    const old = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000)
    for (const key of PHOTOS) deps.objects.set(key, Buffer.from('p'))
    deps.objects.set('generations/old.glb', Buffer.from('g'))
    const saved = await prisma.modelGeneration.create({ data: row({ status: 'saved', createdAt: old }) })
    const readyOld = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/old.glb', createdAt: old }) })

    await generations.listGenerations(prisma, SHOP, NOW)

    for (const key of PHOTOS) expect(deps.objects.has(key)).toBe(false)
    expect(deps.objects.has('generations/old.glb')).toBe(false)
    expect(await prisma.modelGeneration.findUnique({ where: { id: saved.id } })).toMatchObject({ status: 'saved', photoRefs: [] })
    expect(await prisma.modelGeneration.findUnique({ where: { id: readyOld.id } })).toBeNull()
    expect((await generations.getAllowance(prisma, SHOP, 'Starter')).used).toBe(1)
  })

  it('returns active rows newest first, without saved or discarded ones', async () => {
    const prisma = createFakePrisma()
    const t = (min) => new Date(NOW.getTime() - min * 60_000)
    await prisma.modelGeneration.create({ data: row({ status: 'failed', createdAt: t(3) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'ready', createdAt: t(1) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'saved', createdAt: t(2) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'discarded', createdAt: t(0) }) })
    const rows = await generations.listGenerations(prisma, SHOP, NOW)
    expect(rows.map((r) => r.status)).toEqual(['ready', 'failed'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/generations.server.test.js`
Expected: FAIL — `generations.saveGeneration is not a function`.

- [ ] **Step 3: Implement**

In `apps/shopify-app/app/generations.server.js`, change the imports to:

```js
import { aiModelAllowance } from './billing.server.js'
import { startGeneration, checkGeneration, cancelGeneration } from './modelGenerator.server.js'
import { calibrateUpload } from './calibration.server.js'
import { saveModelGlb, readModelGlb, deleteModelGlb, presignObjectRead } from './storage.server.js'
import { saveCalibratedModel } from './models.server.js'
import { reportModelCharge } from './usageBilling.server.js'
import { tagged } from './errors.server.js'
```

Add at the end of the file:

```js
async function reportChargeFor(prisma, generation) {
  await reportModelCharge({
    shopGid: generation.shopGid,
    idempotencyKey: `aimodel_${generation.id}`,
    timestamp: generation.savedAt,
  })
  await prisma.modelGeneration.update({ where: { id: generation.id }, data: { chargeReported: true } })
}

/**
 * Keep a result: it becomes an ordinary ModelAsset. This is the only step that
 * uses the allowance or costs $5.
 *
 * 1. Claim, under a per-shop advisory lock, so two simultaneous saves can't
 *    both take the last free slot; paid/free is decided here, once.
 * 2. Create the asset outside the transaction (S3 read + calibration are too
 *    slow to hold a pooled connection). If that fails, nothing was charged
 *    and the row goes back to ready.
 * 3. Charge. A failed report leaves the model saved; listGenerations re-sends
 *    it, and Shopify's permanent idempotency makes that safe.
 */
export async function saveGeneration(prisma, { shop, generationId, planName, acceptCharge = false, now = new Date() }) {
  const { generation, paid } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`
    const found = await tx.modelGeneration.findFirst({ where: { id: generationId, shop } })
    if (!found) throw tagged('NOT_FOUND', `generation ${generationId} not found`)
    if (found.status !== 'ready') throw tagged('NOT_READY', `cannot save a ${found.status} generation`)
    const { unlimited, freeRemaining } = await getAllowance(tx, shop, planName)
    const isPaid = !unlimited && freeRemaining <= 0
    if (isPaid && !acceptCharge) {
      throw tagged('CHARGE_NOT_CONFIRMED', 'this save costs $5 and was not confirmed')
    }
    const claim = await tx.modelGeneration.updateMany({
      where: { id: found.id, status: 'ready' },
      data: { status: 'saving', paid: isPaid },
    })
    if (claim.count === 0) throw tagged('NOT_READY', 'generation is already being saved')
    return { generation: found, paid: isPaid }
  })

  let asset
  try {
    const bytes = await readModelGlb(generation.glbRef)
    if (!bytes) throw tagged('GLB_MISSING', `pending model ${generation.glbRef} is gone`)
    asset = await saveCalibratedModel(prisma, shop, bytes, 'AI model')
  } catch (error) {
    await prisma.modelGeneration.update({ where: { id: generation.id }, data: { status: 'ready', paid: null } })
    throw error
  }

  const saved = await prisma.modelGeneration.update({
    where: { id: generation.id },
    data: { status: 'saved', modelAssetId: asset.assetId, savedAt: now, glbRef: null },
  })
  await deleteModelGlb(generation.glbRef)

  if (paid) {
    try {
      await reportChargeFor(prisma, saved)
    } catch (error) {
      console.error('AI model charge report failed; will re-send', generation.id, error)
    }
  }
  return { assetId: asset.assetId, paid }
}

// Photos and unsaved models are kept 30 days. Saved rows stay (the lifetime
// allowance counts them) but lose their photos.
async function sweepExpired(prisma, shop, now) {
  const cutoff = new Date(now.getTime() - LIMITS.retentionDays * DAY_MS)
  const expired = await prisma.modelGeneration.findMany({
    where: { shop, createdAt: { lt: cutoff }, status: { in: ['ready', 'saved', 'discarded', 'failed'] } },
  })
  for (const generation of expired) {
    const photos = Array.isArray(generation.photoRefs) ? generation.photoRefs : []
    if (generation.status === 'saved' && photos.length === 0 && !generation.glbRef) continue
    for (const key of photos) await deleteModelGlb(key)
    if (generation.glbRef) await deleteModelGlb(generation.glbRef)
    if (generation.status === 'saved') {
      await prisma.modelGeneration.update({ where: { id: generation.id }, data: { photoRefs: [], glbRef: null } })
    } else {
      await prisma.modelGeneration.delete({ where: { id: generation.id } })
    }
  }
}

/**
 * What the admin page shows, brought up to date first. Also the fallback that
 * collects finished jobs when a webhook was missed, and retries charge reports.
 */
export async function listGenerations(prisma, shop, now = new Date()) {
  await sweepExpired(prisma, shop, now)

  // A crash between claim and ready leaves a row "collecting"; hand it back.
  await prisma.modelGeneration.updateMany({
    where: { shop, status: 'collecting', updatedAt: { lt: new Date(now.getTime() - LIMITS.stuckMs) } },
    data: { status: 'running' },
  })

  const running = await prisma.modelGeneration.findMany({ where: { shop, status: 'running' } })
  for (const generation of running) {
    try {
      await advanceGeneration(prisma, generation, now)
    } catch (error) {
      console.error('AI generation advance failed', generation.id, error)
    }
  }

  const unreported = await prisma.modelGeneration.findMany({
    where: { shop, status: 'saved', paid: true, chargeReported: false },
  })
  for (const generation of unreported) {
    try {
      await reportChargeFor(prisma, generation)
    } catch (error) {
      console.error('AI model charge re-send failed', generation.id, error)
    }
  }

  return prisma.modelGeneration.findMany({
    where: { shop, status: { in: ['queued', 'running', 'collecting', 'ready', 'saving', 'failed'] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/generations.server.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/generations.server.js apps/shopify-app/test/generations.server.test.js
git commit -m "feat(ai-models): save once, charge once, and keep the list up to date

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Routes — admin API, preview GLB, OpenAI webhook

**Files:**
- Create: `apps/shopify-app/app/routes/api.generations.jsx`
- Create: `apps/shopify-app/app/routes/generations.$generationId[.]glb.jsx`
- Create: `apps/shopify-app/app/routes/webhooks.openai.jsx`
- Test: `apps/shopify-app/test/apiGenerations.route.test.js`

**Interfaces:**
- Consumes: from `generations.server.js`: `aiGenerationEnabled`, `getAllowance`, `listGenerations`, `createGeneration`, `saveGeneration`, `discardGeneration`, `advanceByProviderJob`, `toClientGeneration`; `presignPhotoUpload`, `readModelGlb`; `getActivePlanName(admin, shop)`; `unwrapWebhook`.
- Produces (HTTP, relative to the app origin):
  - `GET /api/generations` → `200 { generations: ClientGeneration[], allowance }` | `404` (not enabled) | `402` (no plan)
  - `POST /api/generations` form fields:
    - `intent=presign-photos`, `files=<JSON [{type,size}]>` → `{ uploads: [{ uploadUrl, storageRef }] }`
    - `intent=create`, `photoRefs=<JSON string[]>` → `{ generation }`
    - `intent=retry`, `generationId` → `{ generation }`
    - `intent=save`, `generationId`, `acceptCharge=true|false` → `{ assetId, paid }`
    - `intent=discard`, `generationId` → `{ discarded: true }`
    - errors → `{ error: <merchant copy>, code }` with status from `STATUS_BY_CODE`; unknown → `500 { error: 'Something went wrong. Try again.' }`
  - `GET /generations/:generationId.glb` → GLB bytes (`Cache-Control: private, no-store`) when the row is `ready`/`saving`, else `404`
  - `POST /webhooks/openai` → `200` handled/ignored, `400` bad signature, `500` advance failed (OpenAI retries)

- [ ] **Step 1: Write the failing tests**

Create `apps/shopify-app/test/apiGenerations.route.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  shop: 'route-test.myshopify.com',
  plan: 'Starter',
  enabled: true,
  gen: {},
  presign: vi.fn(),
  unwrap: vi.fn(),
  glb: new Map(),
  rows: new Map(),
}))

vi.mock('../app/shopify.server.js', () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: h.shop },
      admin: {
        graphql: async (query) => {
          if (query.includes('currentAppInstallation')) {
            return new Response(JSON.stringify({
              data: { currentAppInstallation: { activeSubscriptions: h.plan ? [{ name: h.plan, status: 'ACTIVE' }] : [] } },
            }))
          }
          return new Response(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/7' } } }))
        },
      },
    }),
  },
}))
vi.mock('../app/db.server.js', () => ({
  default: { modelGeneration: { findUnique: async ({ where }) => h.rows.get(where.id) ?? null } },
}))
vi.mock('../app/storage.server.js', () => ({
  presignPhotoUpload: (...args) => h.presign(...args),
  readModelGlb: async (key) => h.glb.get(key) ?? null,
}))
vi.mock('../app/modelGenerator.server.js', () => ({
  unwrapWebhook: (...args) => h.unwrap(...args),
}))
vi.mock('../app/generations.server.js', () => ({
  aiGenerationEnabled: () => h.enabled,
  getAllowance: async () => ({ allowance: 10, used: 1, unlimited: false, freeRemaining: 9 }),
  listGenerations: (...args) => h.gen.list(...args),
  createGeneration: (...args) => h.gen.create(...args),
  saveGeneration: (...args) => h.gen.save(...args),
  discardGeneration: (...args) => h.gen.discard(...args),
  advanceByProviderJob: (...args) => h.gen.advance(...args),
  toClientGeneration: (g) => ({ id: g.id, status: g.status }),
}))

const api = await import('../app/routes/api.generations.jsx')
const glbRoute = await import('../app/routes/generations.$generationId[.]glb.jsx')
const webhook = await import('../app/routes/webhooks.openai.jsx')

function post(fields) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return { request: new Request('https://x/api/generations', { method: 'POST', body: fd }) }
}
const get = () => ({ request: new Request('https://x/api/generations') })
const tagged = (code) => Object.assign(new Error(code), { code })

beforeEach(() => {
  h.plan = 'Starter'
  h.enabled = true
  h.gen = { list: vi.fn(), create: vi.fn(), save: vi.fn(), discard: vi.fn(), advance: vi.fn() }
  h.presign.mockReset()
  h.unwrap.mockReset()
  h.glb.clear()
  h.rows.clear()
})

describe('api.generations', () => {
  it('404s for shops the feature is not enabled for', async () => {
    h.enabled = false
    expect((await api.loader(get())).status).toBe(404)
    expect((await api.action(post({ intent: 'create' }))).status).toBe(404)
  })

  it('402s without an active plan', async () => {
    h.plan = null
    const res = await api.loader(get())
    expect(res.status).toBe(402)
    expect((await res.json()).error).toMatch(/no active subscription/i)
  })

  it('lists generations with the allowance', async () => {
    h.gen.list.mockResolvedValue([{ id: 'g1', status: 'ready' }])
    const body = await (await api.loader(get())).json()
    expect(body).toEqual({
      generations: [{ id: 'g1', status: 'ready' }],
      allowance: { allowance: 10, used: 1, unlimited: false, freeRemaining: 9 },
    })
    expect(h.gen.list.mock.calls[0][1]).toBe(h.shop)
  })

  it('presigns one upload per photo', async () => {
    h.presign.mockImplementation(async ({ contentType }) => ({ uploadUrl: `u-${contentType}`, storageRef: `generation-photos/x.${contentType.split('/')[1]}` }))
    const files = [{ type: 'image/jpeg', size: 1 }, { type: 'image/png', size: 2 }, { type: 'image/webp', size: 3 }]
    const body = await (await api.action(post({ intent: 'presign-photos', files: JSON.stringify(files) }))).json()
    expect(body.uploads.map((u) => u.uploadUrl)).toEqual(['u-image/jpeg', 'u-image/png', 'u-image/webp'])
    expect(h.presign).toHaveBeenCalledWith({ contentType: 'image/png', size: 2 })
  })

  it('rejects the wrong number of photos, or malformed JSON, with a 400', async () => {
    for (const files of [JSON.stringify([{ type: 'image/png', size: 1 }]), 'not json']) {
      const res = await api.action(post({ intent: 'presign-photos', files }))
      expect(res.status).toBe(400)
      expect((await res.json()).code).toBe('BAD_PHOTOS')
    }
  })

  it('creates with the shop GID and parsed photo refs', async () => {
    h.gen.create.mockResolvedValue({ id: 'g2', status: 'running' })
    const refs = ['generation-photos/a.jpg', 'generation-photos/b.jpg', 'generation-photos/c.jpg']
    const body = await (await api.action(post({ intent: 'create', photoRefs: JSON.stringify(refs) }))).json()
    expect(body).toEqual({ generation: { id: 'g2', status: 'running' } })
    expect(h.gen.create.mock.calls[0][1]).toEqual({ shop: h.shop, shopGid: 'gid://shopify/Shop/7', photoRefs: refs, retryOf: null })
  })

  it('retries by generation id', async () => {
    h.gen.create.mockResolvedValue({ id: 'g3', status: 'running' })
    await api.action(post({ intent: 'retry', generationId: 'g1' }))
    expect(h.gen.create.mock.calls[0][1]).toMatchObject({ photoRefs: null, retryOf: 'g1' })
  })

  it('saves, passing the plan and whether the charge was accepted', async () => {
    h.gen.save.mockResolvedValue({ assetId: 'a1', paid: true })
    const body = await (await api.action(post({ intent: 'save', generationId: 'g1', acceptCharge: 'true' }))).json()
    expect(body).toEqual({ assetId: 'a1', paid: true })
    expect(h.gen.save.mock.calls[0][1]).toEqual({ shop: h.shop, generationId: 'g1', planName: 'Starter', acceptCharge: true })
  })

  it('maps known error codes to statuses and merchant copy', async () => {
    const cases = [
      ['CHARGE_NOT_CONFIRMED', 402], ['TOO_MANY_RUNNING', 429], ['DAILY_LIMIT', 429],
      ['RETRY_LIMIT', 409], ['NOT_READY', 409], ['NOT_FOUND', 404],
    ]
    for (const [code, status] of cases) {
      h.gen.save.mockRejectedValue(tagged(code))
      const res = await api.action(post({ intent: 'save', generationId: 'g1' }))
      expect(res.status).toBe(status)
      const body = await res.json()
      expect(body.code).toBe(code)
      expect(body.error).not.toBe(code)
    }
  })

  it('hides unexpected errors behind a generic 500', async () => {
    h.gen.discard.mockRejectedValue(new Error('prisma exploded at 0x1f'))
    const res = await api.action(post({ intent: 'discard', generationId: 'g1' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Something went wrong. Try again.' })
  })

  it('400s an unknown intent', async () => {
    expect((await api.action(post({ intent: 'bogus' }))).status).toBe(400)
  })
})

describe('generations/:id.glb', () => {
  it('serves a ready model without caching, and 404s anything else', async () => {
    h.rows.set('g1', { id: 'g1', status: 'ready', glbRef: 'generations/g1.glb' })
    h.rows.set('g2', { id: 'g2', status: 'saved', glbRef: null })
    h.glb.set('generations/g1.glb', Buffer.from('glb'))
    const ok = await glbRoute.loader({ params: { generationId: 'g1' } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('model/gltf-binary')
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
    expect((await glbRoute.loader({ params: { generationId: 'g2' } })).status).toBe(404)
    expect((await glbRoute.loader({ params: { generationId: 'nope' } })).status).toBe(404)
  })
})

describe('webhooks/openai', () => {
  const hook = (body = '{}') => ({ request: new Request('https://x/webhooks/openai', { method: 'POST', body, headers: { 'webhook-id': 'w1' } }) })

  it('400s a bad signature', async () => {
    h.unwrap.mockRejectedValue(new Error('invalid'))
    expect((await webhook.action(hook())).status).toBe(400)
  })

  it('advances the generation for a finished job, passing the raw body and headers', async () => {
    h.unwrap.mockResolvedValue({ type: 'response.completed', data: { id: 'resp_9' } })
    h.gen.advance.mockResolvedValue({ id: 'g1' })
    const res = await webhook.action(hook('{"raw":true}'))
    expect(res.status).toBe(200)
    expect(h.unwrap).toHaveBeenCalledWith('{"raw":true}', expect.objectContaining({ 'webhook-id': 'w1' }))
    expect(h.gen.advance.mock.calls[0][1]).toBe('resp_9')
  })

  it('500s when advancing fails so OpenAI retries, and ignores other event types', async () => {
    h.unwrap.mockResolvedValue({ type: 'response.failed', data: { id: 'resp_9' } })
    h.gen.advance.mockRejectedValue(new Error('db down'))
    expect((await webhook.action(hook())).status).toBe(500)

    h.unwrap.mockResolvedValue({ type: 'batch.completed', data: { id: 'b1' } })
    h.gen.advance.mockReset()
    expect((await webhook.action(hook())).status).toBe(200)
    expect(h.gen.advance).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/apiGenerations.route.test.js`
Expected: FAIL — cannot load the route modules.

- [ ] **Step 3: Write the admin API route**

Create `apps/shopify-app/app/routes/api.generations.jsx`:

```jsx
import { authenticate } from '../shopify.server'
import prisma from '../db.server'
import { getActivePlanName } from '../billing.server'
import { presignPhotoUpload } from '../storage.server'
import {
  aiGenerationEnabled,
  getAllowance,
  listGenerations,
  createGeneration,
  saveGeneration,
  discardGeneration,
  toClientGeneration,
} from '../generations.server'

// Resource route (no default export), for the same reason as api.model-upload:
// fetch() + json() needs a real JSON Response, not the rendered document.
// App Bridge attaches the session token to same-origin relative fetches.

const STATUS_BY_CODE = {
  BAD_PHOTOS: 400,
  BAD_PHOTO: 400,
  NOT_FOUND: 404,
  NOT_RETRYABLE: 409,
  NOT_READY: 409,
  RETRY_LIMIT: 409,
  CHARGE_NOT_CONFIRMED: 402,
  TOO_MANY_RUNNING: 429,
  DAILY_LIMIT: 429,
}

const MESSAGES = {
  BAD_PHOTOS: 'Add 3 or 4 photos: front, left side, right side, and optionally back.',
  BAD_PHOTO: 'Use JPG, PNG or WebP photos of 10 MB or less.',
  NOT_FOUND: 'That model is no longer available. Refresh the page.',
  NOT_RETRYABLE: "This model can't be regenerated right now.",
  NOT_READY: 'This model is still being worked on. Refresh the page.',
  RETRY_LIMIT: "You've used all 3 retries for these photos. Upload a new set to try again.",
  CHARGE_NOT_CONFIRMED: 'This model costs $5. Confirm to save it.',
  TOO_MANY_RUNNING: 'Two models are already being generated. Wait for one to finish.',
  DAILY_LIMIT: "You've reached today's limit of 20 AI generations. Try again tomorrow.",
}

const SHOP_ID_QUERY = `#graphql
  query ShopId {
    shop { id }
  }`

function errorResponse(error) {
  const status = STATUS_BY_CODE[error?.code]
  if (!status) {
    console.error('AI generation request failed', error)
    return Response.json({ error: 'Something went wrong. Try again.' }, { status: 500 })
  }
  return Response.json({ error: MESSAGES[error.code], code: error.code }, { status })
}

function parseJson(value) {
  try {
    return JSON.parse(value ?? '')
  } catch {
    throw Object.assign(new Error('malformed JSON field'), { code: 'BAD_PHOTOS' })
  }
}

async function requestContext(request) {
  const { session, admin } = await authenticate.admin(request)
  if (!aiGenerationEnabled(session.shop)) {
    return { response: Response.json({ error: 'Not found.' }, { status: 404 }) }
  }
  const planName = await getActivePlanName(admin, session.shop)
  if (!planName) {
    return { response: Response.json({ error: 'No active subscription. Choose a plan to continue.' }, { status: 402 }) }
  }
  return { shop: session.shop, admin, planName }
}

export const loader = async ({ request }) => {
  const context = await requestContext(request)
  if (context.response) return context.response
  const rows = await listGenerations(prisma, context.shop)
  return Response.json({
    generations: rows.map(toClientGeneration),
    allowance: await getAllowance(prisma, context.shop, context.planName),
  })
}

export const action = async ({ request }) => {
  const context = await requestContext(request)
  if (context.response) return context.response
  const { shop, admin, planName } = context
  const form = await request.formData()
  const intent = form.get('intent')
  const generationId = form.get('generationId')?.toString() ?? null

  try {
    if (intent === 'presign-photos') {
      const files = parseJson(form.get('files'))
      if (!Array.isArray(files) || files.length < 3 || files.length > 4) {
        throw Object.assign(new Error('wrong photo count'), { code: 'BAD_PHOTOS' })
      }
      const uploads = await Promise.all(
        files.map((file) => presignPhotoUpload({ contentType: file?.type, size: file?.size })),
      )
      return Response.json({ uploads })
    }

    if (intent === 'create' || intent === 'retry') {
      const res = await admin.graphql(SHOP_ID_QUERY)
      const shopGid = (await res.json())?.data?.shop?.id
      if (!shopGid) throw new Error('shop id lookup failed')
      const generation = await createGeneration(prisma, {
        shop,
        shopGid,
        photoRefs: intent === 'create' ? parseJson(form.get('photoRefs')) : null,
        retryOf: intent === 'retry' ? generationId : null,
      })
      return Response.json({ generation: toClientGeneration(generation) })
    }

    if (intent === 'save') {
      return Response.json(await saveGeneration(prisma, {
        shop,
        generationId,
        planName,
        acceptCharge: form.get('acceptCharge') === 'true',
      }))
    }

    if (intent === 'discard') {
      await discardGeneration(prisma, shop, generationId)
      return Response.json({ discarded: true })
    }

    return Response.json({ error: 'Unknown action.' }, { status: 400 })
  } catch (error) {
    return errorResponse(error)
  }
}
```

- [ ] **Step 4: Write the preview GLB route**

Create `apps/shopify-app/app/routes/generations.$generationId[.]glb.jsx`:

```jsx
import db from '../db.server'
import { readModelGlb } from '../storage.server'

// Public, like models/:assetId.glb: model-viewer's fetch carries no App Bridge
// token, and the id is an unguessable UUID. Unlike saved models, a pending
// result can be discarded or replaced, so it is never cached.
export const loader = async ({ params }) => {
  const generation = await db.modelGeneration.findUnique({ where: { id: params.generationId } })
  if (!generation || !generation.glbRef || !['ready', 'saving'].includes(generation.status)) {
    return new Response('not found', { status: 404 })
  }
  const bytes = await readModelGlb(generation.glbRef)
  if (!bytes) return new Response('not found', { status: 404 })
  return new Response(bytes, {
    headers: { 'Content-Type': 'model/gltf-binary', 'Cache-Control': 'private, no-store' },
  })
}
```

- [ ] **Step 5: Write the webhook route**

Create `apps/shopify-app/app/routes/webhooks.openai.jsx`:

```jsx
import prisma from '../db.server'
import { unwrapWebhook } from '../modelGenerator.server'
import { advanceByProviderJob } from '../generations.server'

// OpenAI calls this when a background job ends. Code-interpreter containers
// expire 20 minutes after their last activity, so the GLB has to be collected
// now, not whenever the merchant next opens the Models page.
const FINISHED = new Set(['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'])

export const action = async ({ request }) => {
  // The signature covers the raw body; read it as text before anything parses it.
  const body = await request.text()
  let event
  try {
    event = await unwrapWebhook(body, Object.fromEntries(request.headers))
  } catch {
    return new Response('invalid signature', { status: 400 })
  }
  if (!FINISHED.has(event.type)) return new Response('ignored')
  try {
    await advanceByProviderJob(prisma, event.data.id)
  } catch (error) {
    // Non-2xx makes OpenAI retry the delivery.
    console.error('OpenAI webhook: advancing generation failed', event.data.id, error)
    return new Response('retry', { status: 500 })
  }
  return new Response('ok')
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/apiGenerations.route.test.js`
Expected: PASS.

- [ ] **Step 7: Check the routes build**

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen/apps/shopify-app" && npx react-router build
```

Expected: build succeeds. (It also proves `openai` and the new `.server` modules stay out of the client bundle: a leak fails the build with a server-only module error.)

- [ ] **Step 8: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/routes/api.generations.jsx "apps/shopify-app/app/routes/generations.\$generationId[.]glb.jsx" apps/shopify-app/app/routes/webhooks.openai.jsx apps/shopify-app/test/apiGenerations.route.test.js
git commit -m "feat(ai-models): add the generations API, preview route and OpenAI webhook

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Data erasure and privacy page

**Files:**
- Modify: `apps/shopify-app/app/webhooks.server.js`
- Modify: `apps/shopify-app/app/routes/privacy.jsx:54-60`
- Test: `apps/shopify-app/test/purgeShopData.generations.test.js`

**Interfaces:**
- Consumes: `deleteModelGlb` (existing).
- Produces: `purgeShopData(prisma, shop)` also deletes every `ModelGeneration` photo and pending GLB (before any row), then its rows; the result gains `generations: <count>`.

- [ ] **Step 1: Write the failing test**

Create `apps/shopify-app/test/purgeShopData.generations.test.js`:

```js
import { describe, it, expect, vi } from 'vitest'

const deleted = vi.hoisted(() => [])
vi.mock('../app/storage.server.js', () => ({
  deleteModelGlb: async (key) => {
    deleted.push(key)
  },
}))

const { purgeShopData } = await import('../app/webhooks.server.js')

const SHOP = 'purge-ai.myshopify.com'

// DB-free stand-in: just enough of each delegate for purgeShopData.
function table(rows) {
  return {
    findMany: async ({ where }) => rows.filter((r) => r.shop === where.shop),
    deleteMany: async ({ where }) => {
      const before = rows.length
      rows.splice(0, rows.length, ...rows.filter((r) => r.shop !== where.shop))
      return { count: before - rows.length }
    },
  }
}

describe('purgeShopData and AI generations', () => {
  it('deletes generation photos and pending GLBs before any rows, then the rows', async () => {
    const generationRows = [
      { shop: SHOP, photoRefs: ['generation-photos/1.jpg', 'generation-photos/2.jpg'], glbRef: 'generations/g.glb' },
      { shop: SHOP, photoRefs: [], glbRef: null },
      { shop: 'other.myshopify.com', photoRefs: ['generation-photos/x.jpg'], glbRef: null },
    ]
    const prisma = {
      modelAsset: table([{ shop: SHOP, storageRef: 'a.glb' }]),
      productMapping: table([]),
      session: table([]),
      shopSubscription: table([]),
      modelGeneration: table(generationRows),
    }

    const result = await purgeShopData(prisma, SHOP)

    expect(deleted).toEqual(['a.glb', 'generation-photos/1.jpg', 'generation-photos/2.jpg', 'generations/g.glb'])
    expect(result.generations).toBe(2)
    expect(generationRows).toHaveLength(1)
    expect(generationRows[0].shop).toBe('other.myshopify.com')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/purgeShopData.generations.test.js`
Expected: FAIL — deleted keys contain only `a.glb`, and `result.generations` is undefined.

- [ ] **Step 3: Implement**

In `apps/shopify-app/app/webhooks.server.js`, directly after the existing loop that deletes each asset's `storageRef`, add:

```js
  // AI generations (spec 2026-09-30): photos and unsaved models are S3 objects
  // indexed only by these rows, so they go before the rows, same as assets.
  const generations = await prisma.modelGeneration.findMany({
    where: { shop },
    select: { photoRefs: true, glbRef: true },
  })
  for (const { photoRefs, glbRef } of generations) {
    for (const key of Array.isArray(photoRefs) ? photoRefs : []) await deleteModelGlb(key)
    if (glbRef) await deleteModelGlb(glbRef)
  }
```

After the `shopSubscription.deleteMany` line, add:

```js
  // No foreign keys; deleted last so a failure above leaves the index intact.
  const generationRows = await prisma.modelGeneration.deleteMany({ where: { shop } })
```

Add `generations: generationRows.count,` to the returned object.

- [ ] **Step 4: Update the privacy page**

In `apps/shopify-app/app/routes/privacy.jsx`, replace the "Service providers" paragraph with:

```jsx
      <p>
        We use Vercel (application hosting), Neon (database), and Amazon Web
        Services S3 (storage of merchant-uploaded models and photos). Merchant
        data as described above is processed by these providers on our behalf.
        If a merchant uses &ldquo;Create with AI&rdquo;, the frame photos they
        upload are sent to OpenAI, which builds the 3D model; those photos are
        deleted from our storage after 30 days. No shopper or camera data is
        sent to any of these providers, because none is ever collected.
      </p>
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/purgeShopData.generations.test.js test/webhooks.routes.test.js`
Expected: PASS. (`webhooks.routes.test.js` mocks `purgeShopData` and is DB-free. Do NOT run `webhooks.server.test.js` — it is DB-backed; it also needs the new table, which only exists after deploy.)

- [ ] **Step 6: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/webhooks.server.js apps/shopify-app/app/routes/privacy.jsx apps/shopify-app/test/purgeShopData.generations.test.js
git commit -m "feat(ai-models): erase generations on shop redact and disclose OpenAI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Admin UI — Create with AI

**Files:**
- Create: `apps/shopify-app/app/components/AiModelFlow.jsx`
- Modify: `apps/shopify-app/app/routes/app.models.jsx` (loader + render)
- Modify: `apps/shopify-app/app/components/PlanUsage.jsx`
- Modify: `apps/shopify-app/app/routes/app._index.jsx:66-69` (loader) and `:340` (render)
- Test: `apps/shopify-app/test/aiModelFlow.ui.test.js`, `apps/shopify-app/test/planUsage.ui.test.js` (append)

**Interfaces:**
- Consumes: `GET/POST /api/generations` (Task 8); `ModelViewer({ src, alt })` (existing); `aiGenerationEnabled`, `getAllowance` (Task 4).
- Produces (exported pure helpers, unit-tested):
  - `PHOTO_SLOTS: { key, label, required }[]`
  - `photoError(file) → string|null`
  - `canGenerate(photos: Record<string, File|undefined>) → boolean`
  - `balanceMessage(allowance) → string`
  - `saveNeedsCharge(allowance) → boolean`
  - `failureMessage(errorCode) → string`
  - `generationView(generation) → { label, tone, actions: ('save'|'retry'|'discard')[] }`
  - `aiModelsLine(aiModels) → string` (in `PlanUsage.jsx`)
  - default export `AiModelFlow({ initialAllowance })`

- [ ] **Step 1: Write the failing tests**

Create `apps/shopify-app/test/aiModelFlow.ui.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  PHOTO_SLOTS,
  photoError,
  canGenerate,
  balanceMessage,
  saveNeedsCharge,
  failureMessage,
  generationView,
} from '../app/components/AiModelFlow.jsx'

const file = (type = 'image/jpeg', size = 1000) => ({ type, size, name: 'x' })

describe('photos', () => {
  it('has front, left and right required and back optional', () => {
    expect(PHOTO_SLOTS.map((s) => [s.key, s.required])).toEqual([
      ['front', true], ['left', true], ['right', true], ['back', false],
    ])
  })

  it('accepts JPG, PNG and WebP up to 10 MB', () => {
    expect(photoError(file('image/png'))).toBeNull()
    expect(photoError(file('image/gif'))).toMatch(/JPG, PNG or WebP/)
    expect(photoError(file('image/jpeg', 10 * 1048576 + 1))).toMatch(/10 MB/)
  })

  it('needs the three required photos, all valid', () => {
    expect(canGenerate({ front: file(), left: file() })).toBe(false)
    expect(canGenerate({ front: file(), left: file(), right: file() })).toBe(true)
    expect(canGenerate({ front: file(), left: file(), right: file(), back: file('image/gif') })).toBe(false)
  })
})

describe('balance', () => {
  it('shows free models left, the $5 price, or unlimited', () => {
    expect(balanceMessage({ allowance: 10, used: 3, unlimited: false, freeRemaining: 7 })).toBe('7 of 10 free AI models left')
    expect(balanceMessage({ allowance: 10, used: 10, unlimited: false, freeRemaining: 0 })).toBe('Next model: $5, added to your Shopify bill')
    expect(balanceMessage({ allowance: null, used: 4, unlimited: true, freeRemaining: null })).toBe('Unlimited AI models on your plan')
    expect(balanceMessage(null)).toBe('')
  })

  it('asks for the $5 confirmation only when nothing free is left', () => {
    expect(saveNeedsCharge({ unlimited: false, freeRemaining: 0 })).toBe(true)
    expect(saveNeedsCharge({ unlimited: false, freeRemaining: 1 })).toBe(false)
    expect(saveNeedsCharge({ unlimited: true, freeRemaining: null })).toBe(false)
    expect(saveNeedsCharge(null)).toBe(false)
  })
})

describe('generationView', () => {
  it('offers save, retry and discard on a ready result while retries remain', () => {
    expect(generationView({ status: 'ready', retriesLeft: 2 }).actions).toEqual(['save', 'retry', 'discard'])
    expect(generationView({ status: 'ready', retriesLeft: 0 }).actions).toEqual(['save', 'discard'])
  })

  it('shows progress with no actions while running or saving', () => {
    expect(generationView({ status: 'running', retriesLeft: 3 })).toMatchObject({ actions: [] })
    expect(generationView({ status: 'saving', retriesLeft: 3 })).toMatchObject({ actions: [] })
  })

  it('explains a failure, says nothing was charged, and offers retry and dismiss', () => {
    const view = generationView({ status: 'failed', error: 'low_confidence', retriesLeft: 1 })
    expect(view.tone).toBe('critical')
    expect(view.label).toMatch(/plain background/)
    expect(view.actions).toEqual(['retry', 'discard'])
  })

  it('always tells the merchant a failure was free', () => {
    for (const code of ['low_confidence', 'invalid_model: x', 'timeout', 'start_failed', 'openai_failed', null]) {
      expect(failureMessage(code)).toMatch(/You weren't charged\./)
    }
  })
})
```

Append to `apps/shopify-app/test/planUsage.ui.test.js` (add `aiModelsLine` to its existing import from `../app/components/PlanUsage.jsx`):

```js
describe('aiModelsLine', () => {
  it('shows free AI models used, or a plain count on unlimited plans', () => {
    expect(aiModelsLine({ allowance: 10, used: 3, unlimited: false, freeRemaining: 7 })).toBe('3 / 10 free AI models used')
    expect(aiModelsLine({ allowance: 10, used: 12, unlimited: false, freeRemaining: 0 })).toBe('12 AI models created (10 free, then $5 each)')
    expect(aiModelsLine({ allowance: null, used: 1, unlimited: true, freeRemaining: null })).toBe('1 AI model created')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/aiModelFlow.ui.test.js test/planUsage.ui.test.js`
Expected: FAIL — `AiModelFlow.jsx` doesn't exist; `aiModelsLine` is not exported.

- [ ] **Step 3: Write the component**

Create `apps/shopify-app/app/components/AiModelFlow.jsx`:

```jsx
/* eslint-disable react/prop-types -- lightweight props, same as the other flows */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRevalidator } from 'react-router'
import { useAppBridge } from '@shopify/app-bridge-react'
import ModelViewer from './ModelViewer'

// Keep in step with the server: storage.server.js MAX_PHOTO_BYTES and the
// $5 App Pricing meter. (A client component can't import .server modules.)
const MAX_PHOTO_BYTES = 10 * 1048576
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const PRICE = '$5'
const POLL_MS = 5000
const CONFIRM_MODAL_ID = 'ai-charge-confirm'
const GENERIC_ERROR = 'Something went wrong. Try again.'
const UPLOAD_FAILED = "The photos didn't upload. Check your connection and try again."

export const PHOTO_SLOTS = [
  { key: 'front', label: 'Front', required: true },
  { key: 'left', label: 'Left side', required: true },
  { key: 'right', label: 'Right side', required: true },
  { key: 'back', label: 'Back (optional)', required: false },
]

export function photoError(file) {
  if (!file) return null
  if (!PHOTO_TYPES.includes(file.type)) return 'Use a JPG, PNG or WebP photo.'
  if (file.size > MAX_PHOTO_BYTES) return 'Photos must be 10 MB or smaller.'
  return null
}

export function canGenerate(photos) {
  return PHOTO_SLOTS.every((slot) => !slot.required || photos[slot.key])
    && PHOTO_SLOTS.every((slot) => !photoError(photos[slot.key]))
}

export function balanceMessage(allowance) {
  if (!allowance) return ''
  if (allowance.unlimited) return 'Unlimited AI models on your plan'
  if (allowance.freeRemaining > 0) return `${allowance.freeRemaining} of ${allowance.allowance} free AI models left`
  return `Next model: ${PRICE}, added to your Shopify bill`
}

export function saveNeedsCharge(allowance) {
  return Boolean(allowance) && !allowance.unlimited && allowance.freeRemaining <= 0
}

export function failureMessage(error) {
  if (error === 'low_confidence' || error?.startsWith('invalid_model')) {
    return "We couldn't build a model that fits from these photos. Try clearer photos: plain background, frame only (not worn), good light, whole frame in shot. You weren't charged."
  }
  if (error === 'timeout') return "Generating took too long. Try again. You weren't charged."
  return "Generating failed. Try again. You weren't charged."
}

export function generationView(generation) {
  const retry = generation.retriesLeft > 0 ? ['retry'] : []
  switch (generation.status) {
    case 'running':
      return { label: 'Generating… this takes a few minutes. You can leave this page.', tone: 'info', actions: [] }
    case 'ready':
      return { label: 'Ready to review', tone: 'success', actions: ['save', ...retry, 'discard'] }
    case 'saving':
      return { label: 'Saving…', tone: 'info', actions: [] }
    case 'failed':
      return { label: failureMessage(generation.error), tone: 'critical', actions: [...retry, 'discard'] }
    default:
      return { label: generation.status, tone: 'neutral', actions: [] }
  }
}

const ACTION_LABELS = { save: 'Save model', retry: 'Try again', discard: 'Discard' }

function PhotoSlot({ slot, file, disabled, onFile, onRejected }) {
  const ref = useRef(null)
  // React 18 strips onDropRejected from custom elements; attach it directly.
  useEffect(() => {
    const zone = ref.current
    if (!zone) return undefined
    zone.addEventListener('droprejected', onRejected)
    return () => zone.removeEventListener('droprejected', onRejected)
  }, [onRejected])
  const error = photoError(file)
  return (
    <s-stack direction="block" gap="small-200">
      <s-drop-zone
        ref={ref}
        label={slot.label}
        accept={PHOTO_TYPES.join(',')}
        accessibilityLabel={`Choose the ${slot.label.toLowerCase()} photo`}
        disabled={disabled}
        error={error ?? undefined}
        // onInput, not onChange: React 18 never dispatches change for s-drop-zone.
        onInput={(event) => onFile(event.currentTarget.files?.[0] ?? null)}
      ></s-drop-zone>
      {file && !error && <s-text color="subdued">{file.name}</s-text>}
    </s-stack>
  )
}

function GenerationRow({ generation, disabled, onAction }) {
  const view = generationView(generation)
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="base">
        <s-badge tone={view.tone}>{view.label}</s-badge>
        {generation.previewUrl && <ModelViewer src={generation.previewUrl} alt="AI-generated model preview" />}
        {view.actions.length > 0 && (
          <s-stack direction="inline" gap="small-200">
            {view.actions.map((action) => (
              <s-button
                key={action}
                variant={action === 'save' ? 'primary' : 'secondary'}
                disabled={disabled}
                onClick={() => onAction(action)}
              >
                {ACTION_LABELS[action]}
              </s-button>
            ))}
          </s-stack>
        )}
      </s-stack>
    </s-box>
  )
}

async function postForm(fields) {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  const res = await fetch('/api/generations', { method: 'POST', body: form })
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

export default function AiModelFlow({ initialAllowance }) {
  const shopify = useAppBridge()
  const revalidator = useRevalidator()
  const [photos, setPhotos] = useState({})
  const [generations, setGenerations] = useState([])
  const [allowance, setAllowance] = useState(initialAllowance ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [chargeFor, setChargeFor] = useState(null)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/generations')
    if (!res.ok) return
    const body = await res.json()
    setGenerations(body.generations)
    setAllowance(body.allowance)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const anyRunning = generations.some((g) => g.status === 'running' || g.status === 'saving')
  useEffect(() => {
    if (!anyRunning) return undefined
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [anyRunning, refresh])

  const onRejected = useCallback(() => setError('Use a JPG, PNG or WebP photo of 10 MB or less.'), [])

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      const chosen = PHOTO_SLOTS.map((slot) => photos[slot.key]).filter(Boolean)
      const presign = await postForm({
        intent: 'presign-photos',
        files: JSON.stringify(chosen.map((f) => ({ type: f.type, size: f.size }))),
      })
      if (!presign.ok) throw new Error(presign.body.error ?? GENERIC_ERROR)
      await Promise.all(presign.body.uploads.map(async ({ uploadUrl }, i) => {
        const res = await fetch(uploadUrl, { method: 'PUT', body: chosen[i], headers: { 'Content-Type': chosen[i].type } })
        if (!res.ok) {
          console.error('AI photo upload failed', res.status)
          throw new Error(UPLOAD_FAILED)
        }
      }))
      const created = await postForm({
        intent: 'create',
        photoRefs: JSON.stringify(presign.body.uploads.map((u) => u.storageRef)),
      })
      if (!created.ok) throw new Error(created.body.error ?? GENERIC_ERROR)
      setPhotos({})
      await refresh()
    } catch (e) {
      setError(e.message || GENERIC_ERROR)
    } finally {
      setBusy(false)
    }
  }

  function askToConfirmCharge(generationId) {
    setChargeFor(generationId)
    shopify.modal.show(CONFIRM_MODAL_ID)
  }

  async function act(generation, action, { acceptCharge = false } = {}) {
    if (action === 'save' && saveNeedsCharge(allowance) && !acceptCharge) {
      askToConfirmCharge(generation.id)
      return
    }
    setBusy(true)
    setError(null)
    const res = await postForm({
      intent: action,
      generationId: generation.id,
      ...(action === 'save' ? { acceptCharge: String(acceptCharge) } : {}),
    })
    setBusy(false)
    if (res.body.code === 'CHARGE_NOT_CONFIRMED') {
      // Another save took the last free slot since this page loaded.
      askToConfirmCharge(generation.id)
      await refresh()
      return
    }
    if (!res.ok) {
      setError(res.body.error ?? GENERIC_ERROR)
      return
    }
    if (action === 'save') {
      shopify.toast.show(res.body.paid ? `Model saved. ${PRICE} added to your Shopify bill.` : 'Model saved to your library')
      revalidator.revalidate()
    }
    await refresh()
  }

  function confirmCharge() {
    shopify.modal.hide(CONFIRM_MODAL_ID)
    const generation = generations.find((g) => g.id === chargeFor)
    if (generation) act(generation, 'save', { acceptCharge: true })
  }

  return (
    <s-section heading="Create with AI">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          Upload photos of a frame and we&apos;ll build its 3D model. Use a plain
          background, the frame only (not worn), good light, and the whole frame in shot.
        </s-paragraph>
        <s-text type="strong">{balanceMessage(allowance)}</s-text>
        {error && (
          <s-banner tone="critical" heading="Couldn't create the model">
            {error}
          </s-banner>
        )}
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(160px, 1fr))" gap="base">
          {PHOTO_SLOTS.map((slot) => (
            <PhotoSlot
              key={slot.key}
              slot={slot}
              file={photos[slot.key]}
              disabled={busy}
              onRejected={onRejected}
              onFile={(file) => setPhotos((current) => ({ ...current, [slot.key]: file ?? undefined }))}
            />
          ))}
        </s-grid>
        <s-stack direction="inline">
          <s-button variant="primary" disabled={busy || !canGenerate(photos)} loading={busy} onClick={generate}>
            Generate 3D model
          </s-button>
        </s-stack>
        {generations.map((generation) => (
          <GenerationRow
            key={generation.id}
            generation={generation}
            disabled={busy}
            onAction={(action) => act(generation, action)}
          />
        ))}
      </s-stack>
      <s-modal id={CONFIRM_MODAL_ID} heading={`Save this model for ${PRICE}?`}>
        <s-paragraph>
          You&apos;ve used all the free AI models on your plan. This model costs {PRICE}.
          It will be added to your next Shopify bill.
        </s-paragraph>
        <s-button slot="primary-action" variant="primary" onClick={confirmCharge}>
          Save for {PRICE}
        </s-button>
        <s-button slot="secondary-actions" onClick={() => shopify.modal.hide(CONFIRM_MODAL_ID)}>
          Cancel
        </s-button>
      </s-modal>
    </s-section>
  )
}
```

- [ ] **Step 4: Add the Home "AI models" line**

In `apps/shopify-app/app/components/PlanUsage.jsx`, add above the default export:

```jsx
/**
 * One line about AI-generated models, shown when the feature is on for the shop.
 * @param {{allowance: number|null, used: number, unlimited: boolean}} aiModels
 */
export function aiModelsLine({ allowance, used, unlimited }) {
  const models = `${used} AI ${used === 1 ? 'model' : 'models'}`
  if (unlimited) return `${models} created`
  if (used <= allowance) return `${used} / ${allowance} free AI models used`
  return `${models} created (${allowance} free, then $5 each)`
}
```

Change the signature to `export default function PlanUsage({ usage, aiModels = null })`. In the unlimited branch, after the existing products `<s-text>`, add:

```jsx
          {aiModels && <s-text color="subdued">{aiModelsLine(aiModels)}</s-text>}
```

In the limited branch, after the final "remaining" `<s-text>`, add the same line.

In `apps/shopify-app/app/routes/app._index.jsx`, replace the loader:

```jsx
export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request)
  const workspace = await loadWorkspace({ admin, shop: session.shop, engineUrl: resolveEngineUrl(request) })
  const aiModels = aiGenerationEnabled(session.shop) && workspace.usage.planName
    ? await getAllowance(prisma, session.shop, workspace.usage.planName)
    : null
  return { ...workspace, aiModels }
}
```

Add the imports (keep existing ones; add `prisma` only if the file doesn't import it already):

```jsx
import prisma from '../db.server'
import { aiGenerationEnabled, getAllowance } from '../generations.server'
```

Change the render at line ~340 to `<PlanUsage usage={data.usage} aiModels={data.aiModels} />`.

- [ ] **Step 5: Render the flow on the Models page**

In `apps/shopify-app/app/routes/app.models.jsx`:

Add imports:

```jsx
import AiModelFlow from '../components/AiModelFlow'
import { aiGenerationEnabled, getAllowance } from '../generations.server'
```

In the loader, after `const usage = planUsage(...)`, add:

```jsx
  const ai = aiGenerationEnabled(session.shop)
    ? { allowance: await getAllowance(prisma, session.shop, activePlan) }
    : null
```

and add `ai,` to the returned object (the no-plan early return stays as it is — no plan, no AI section).

In `Models()`, change the `useLoaderData` destructure to include `ai = null`, and render the flow directly above `<s-section heading="Model library">`:

```jsx
      {ai && <AiModelFlow initialAllowance={ai.allowance} />}
```

Update the comment above the primary action ("Models are uploaded inside Add try-on (Models is a library, not an upload surface)…") to add: `Create with AI (when enabled for the shop) is the one exception: it produces a model from photos, so it lives with the library.`

- [ ] **Step 6: Run the tests and the build**

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen/apps/shopify-app"
npx vitest run test/aiModelFlow.ui.test.js test/planUsage.ui.test.js test/appModels.ui.test.js test/appIndex.workspace.test.js
npx react-router build
npx eslint app/components/AiModelFlow.jsx app/components/PlanUsage.jsx app/routes/app.models.jsx app/routes/app._index.jsx app/routes/api.generations.jsx app/routes/webhooks.openai.jsx app/generations.server.js app/modelGenerator.server.js app/usageBilling.server.js
```

Expected: tests PASS; build succeeds; eslint reports no errors. (Before running `appModels.ui.test.js` and `appIndex.workspace.test.js`, open each and confirm it doesn't import `db.server` unmocked — if one does, it is DB-backed: skip it.)

- [ ] **Step 7: Commit**

```bash
git branch --show-current   # must print feature/ai-model-generation
git add apps/shopify-app/app/components/AiModelFlow.jsx apps/shopify-app/app/components/PlanUsage.jsx apps/shopify-app/app/routes/app.models.jsx apps/shopify-app/app/routes/app._index.jsx apps/shopify-app/test/aiModelFlow.ui.test.js apps/shopify-app/test/planUsage.ui.test.js
git commit -m "feat(ai-models): add the Create with AI section and the Home usage line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Release on the dev store (owner-assisted)

No new code. Every step marked **(owner)** is done by the owner in a dashboard; the implementer prepares, verifies and reports. **Ask the owner before pushing or merging anything** — merging to `main` deploys to production and runs the migration on the shared database.

- [ ] **Step 1: Answer the open billing question before touching live plans**

Search Shopify's docs (the Shopify docs MCP `search_docs_chunks`, or shopify.dev) for how editing a live Shopify App Pricing plan (adding a usage meter) affects existing subscribers. Report the answer to the owner. If existing subscribers must re-approve, stop and raise it: the plan then needs a re-approval prompt before a paid save, which is new scope.

- [ ] **Step 2: Dashboard setup (owner)**

1. Partner Dashboard → app → Distribution → Manage listing → Pricing content: on **Starter** and **Growth**, add a usage meter — name *AI 3D models*, handle `ai_model_generated`, pricing **Fixed**, unit price **$5.00**, included units **0**.
2. Dev Dashboard → API keys: create a key; note its client ID and secret.
3. OpenAI platform → project → Webhooks: add endpoint `https://ar-sunglasses-tryon.vercel.app/webhooks/openai` for `response.completed`, `response.failed`, `response.incomplete`, `response.cancelled`; note the signing secret.
4. Vercel → project → Environment Variables (Production and Preview): `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `SHOPIFY_APP_EVENTS_CLIENT_ID`, `SHOPIFY_APP_EVENTS_CLIENT_SECRET`, and `AI_GENERATION_SHOPS=ar-tryon-dev-xbqbnjhd.myshopify.com`.

- [ ] **Step 3: Deploy (owner approves)**

Open a PR from `feature/ai-model-generation` to `main`. After the owner approves the merge, the Vercel build runs `prisma migrate deploy` (adds `ModelGeneration`) and deploys. The feature stays invisible to every shop except the dev store.

- [ ] **Step 4: End-to-end on the dev store**

On `ar-tryon-dev-xbqbnjhd.myshopify.com` (test subscription):
1. Models page shows "Create with AI" with the correct balance.
2. Upload 4 photos → Generate → leave the page → come back later: the result is ready (proves the webhook collected it). Preview renders.
3. Try again → a new result; the old one disappears. Discard works.
4. Save within the allowance → model appears in the library, balance drops by one, no event in the Dev Dashboard.
5. Make the dev store's allowance run out (temporarily set its plan to one with a small allowance, or save until 0) → Save shows the $5 dialog → confirm → the Dev Dashboard → Logs → App Event shows `ai_model_generated` as **billable** with key `aimodel_<id>`.
6. Map a saved AI model to a product and open the storefront try-on.
7. Check the Vercel logs for `AI generation` errors, and S3 for `generation-photos/` and `generations/` objects (if S3 returns AccessDenied on these prefixes, the app IAM key needs object permissions for them). If the browser's photo PUT fails with a CORS error, the bucket's CORS rule must allow `PUT` with a `Content-Type` header from the admin origin. Existing GLB uploads already rely on that rule, so check it covers `image/*` requests too.

Record the results for the owner.

- [ ] **Step 5: Before enabling for everyone (owner)**

Update the App Store listing's pricing text and data-use disclosure (the AI feature, $5 per model past the plan's free models, photos sent to OpenAI). Then set `AI_GENERATION_SHOPS=*`.

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

function introText(images, source) {
  if (source === 'product') {
    return `These ${images.length} product photos show one pair of glasses from different angles, in no particular order. Some may show the glasses worn by a person or on a background: model only the glasses. Build its 3D model.`
  }
  return `These ${images.length} photos show one pair of glasses: front, left side, right side${images.length > 3 ? ', back' : ''}. Build its 3D model.`
}

export function buildGenerationRequest({ images, feedback = null, source = 'upload' }) {
  const content = [
    {
      type: 'input_text',
      text: introText(images, source),
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

export async function startGeneration({ images, feedback = null, source = 'upload' }) {
  const response = await getClient().responses.create(buildGenerationRequest({ images, feedback, source }))
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

// The container (or the file in it) no longer exists: it expired 20 minutes
// after its last activity. The OpenAI SDK raises NotFoundError (status 404) for
// this; 410 Gone is treated the same. Anything else (network, 5xx) may pass, so
// it is rethrown for the next webhook or poll to try again.
const isGone = (error) => error?.status === 404 || error?.status === 410

async function downloadGlb(response) {
  const file = citedGlb(response) ?? (await listedGlb(response))
  if (!file) return null
  const download = await getClient().containers.files.content.retrieve(file.fileId, {
    container_id: file.containerId,
  })
  return Buffer.from(await download.arrayBuffer())
}

export async function checkGeneration(providerJobId) {
  const response = await getClient().responses.retrieve(providerJobId)
  if (response.status === 'queued' || response.status === 'in_progress') {
    return { state: 'running' }
  }
  if (response.status !== 'completed') {
    // The row only keeps `openai_<status>`; the detail goes to the logs.
    console.warn(
      'AI generation ended without a model',
      response.id ?? providerJobId,
      response.status,
      response.error ?? null,
      response.incomplete_details ?? null,
    )
    return { state: 'failed', error: `openai_${response.status}` }
  }
  let glbBytes
  try {
    glbBytes = await downloadGlb(response)
  } catch (error) {
    if (isGone(error)) return { state: 'failed', error: 'output_expired' }
    throw error
  }
  if (!glbBytes) return { state: 'failed', error: 'no_glb_output' }
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

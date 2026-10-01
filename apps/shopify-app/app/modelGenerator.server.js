import OpenAI, { toFile } from 'openai'
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
export const MODELING_PROMPT_VERSION = 2

export const MODELING_INSTRUCTIONS = `You are a 3D modeller building eyewear for a web AR try-on. You receive 3 or 4 photos of ONE pair of glasses: front, left side, right side, and optionally back. Build that exact frame as a 3D model by writing and running Python in the code interpreter. Shoppers compare the model with the product photos, so it must look like this product down to its details, not like a generic frame of the same shape.

Hard requirements. The file is rejected automatically if any one is missed:
1. Save exactly one binary glTF file at /mnt/data/model.glb and cite it in your final message.
2. Units are metres. Y is up. The front of the frame faces +Z. The frame's shape is centred on, and mirror-symmetric about, X = 0.
3. The frame front is about 0.145 m wide, hinge to hinge. Keep the photos' proportions for everything else.
4. At most 150,000 triangles in total.
5. Separate meshes named Frame, Lens_L, Lens_R, Temple_L, Temple_R (plus Nosepad_L and Nosepad_R if the photos show nose pads, and Logo_1, Logo_2, ... for logos and text, see below).
6. Three empty nodes (no mesh) named exactly AR_bridge, AR_hinge_L and AR_hinge_R. AR_bridge sits at the centre of the bridge on the back surface of the frame, where it rests on the nose. AR_hinge_L sits at the hinge at negative X, AR_hinge_R at the hinge at positive X.
7. Temples are open at about 90 degrees to the front and run towards -Z, as when worn.
8. PBR metallic-roughness materials matching the photos: frame colour and finish (matte, glossy, metal; tortoiseshell or other patterns as a texture), lens tint. Lenses use alphaMode BLEND with an alpha between 0.35 and 0.85 that matches how dark they look.
9. No background, ground plane, stand, case, packaging or person.

Details. Before modelling anything, study every photo closely and write a numbered inventory of every visible detail: logos, brand marks, text and emblems (which part, which side, where, how big, what colour); rivets, pins and studs; hinge hardware; metal accents and inlays; two-tone, gradient or patterned colours; lens tint, gradient or mirror coating; bridge shape (keyhole, double bridge); nose pads; temple shape and temple tips; rim thickness and edge bevels. Then build every item on the inventory:
- Logos, brand marks and text are part of the product. Never drop, invent or restyle them. Crop each one from the sharpest photo that shows it, make its background transparent, and put it on its own mesh (Logo_1, Logo_2, ...): a thin quad that follows the surface it sits on, 0.0003 m in front of that surface, textured with the crop as a PNG of at most 512 px on its longest side, with alphaMode MASK. Match its position and size on the real frame. If no photo file is available to crop from, draw the mark in Python (PIL) as faithfully as you can.
- The frame's shape is symmetric, its surface details are not. Put each detail only where the photos show it, on the same side: something on the right of the front photo goes at positive X (seen from the front, +X is on the right).
- Measure colours from the photos with code instead of guessing: take the median of a clean patch, avoiding highlights, reflections and shadows. Strongly tinted lenses (amber, green, dark grey) must read as strongly as in the photos, so use the upper end of the alpha range for them.
- Build small hardware (rivets, pins, hinge barrels) as real geometry in a metal material (metallic 1) at the positions you measured.

Method: trace each lens outline from the front photo as a closed 2D curve, build the rim around it, mirror it for the other side, build the bridge, then build the temples from the side photos, then add the details from your inventory. Use trimesh, numpy and PIL if they are available. If your library drops empty nodes on export, add the AR_* nodes with pygltflib afterwards; if neither library is available, write the glTF binary directly with numpy and struct.

Before finishing, verify with code and fix any failure: the triangle count, the front width (about 0.145 m), the shape's symmetry about X = 0, the front facing +Z, that all three AR_* nodes exist in the saved file, and that every Logo_* mesh in it has its texture. Then go back through your inventory and fix anything missing. End your final message with the inventory, marking each item as built or saying why it could not be.`

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

const photoName = (index, url) => {
  const ext = /\.(jpe?g|png|webp)(?:$|\?)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? 'jpg'
  return `photo_${index + 1}.${ext}`
}

export function buildGenerationRequest({ images, feedback = null, source = 'upload', fileIds = [] }) {
  const content = [
    {
      type: 'input_text',
      text: introText(images, source),
    },
    ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'high' })),
  ]
  if (fileIds.length > 0) {
    content.push({
      type: 'input_text',
      text: 'The same photos, in the same order, are files in /mnt/data (photo_1, photo_2, ...), so your code can measure them, sample their colours and crop their logos.',
    })
  }
  if (feedback) {
    content.push({ type: 'input_text', text: `A previous attempt was rejected. Fix this: ${feedback}` })
  }
  const container = fileIds.length > 0 ? { type: 'auto', file_ids: fileIds } : { type: 'auto' }
  return {
    model: GENERATION_MODEL,
    background: true,
    instructions: MODELING_INSTRUCTIONS,
    tools: [{ type: 'code_interpreter', container }],
    input: [{ role: 'user', content }],
    metadata: { prompt_version: String(MODELING_PROMPT_VERSION) },
  }
}

// The model only *sees* input images; its code can't read them. Uploading the
// photos as files puts them in the container, so it can crop logos and sample
// colours from the real pixels. They expire on their own after a day, so
// nothing has to clean them up.
const PHOTO_FILE_TTL_SECONDS = 24 * 60 * 60
const PHOTO_FETCH_TIMEOUT_MS = 15_000

async function uploadPhotos(images) {
  try {
    return await Promise.all(images.map(async (url, index) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(PHOTO_FETCH_TIMEOUT_MS) })
      if (!res.ok) throw new Error(`photo download failed: ${res.status}`)
      const file = await toFile(Buffer.from(await res.arrayBuffer()), photoName(index, url))
      const uploaded = await getClient().files.create({
        file,
        purpose: 'user_data',
        expires_after: { anchor: 'created_at', seconds: PHOTO_FILE_TTL_SECONDS },
      })
      return uploaded.id
    }))
  } catch (error) {
    // Still worth building from the images alone; the model just can't crop logos.
    console.warn('AI generation photo upload failed; continuing without photo files', error?.message)
    return []
  }
}

export async function startGeneration({ images, feedback = null, source = 'upload' }) {
  const fileIds = await uploadPhotos(images)
  const response = await getClient().responses.create(buildGenerationRequest({ images, feedback, source, fileIds }))
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

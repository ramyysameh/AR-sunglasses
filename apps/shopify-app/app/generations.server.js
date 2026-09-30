import { aiModelAllowance } from './billing.server.js'
import { startGeneration } from './modelGenerator.server.js'
import { deleteModelGlb, presignObjectRead } from './storage.server.js'
import { tagged } from './errors.server.js'

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

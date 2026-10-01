import { aiModelAllowance } from './billing.server.js'
import { startGeneration, checkGeneration, cancelGeneration } from './modelGenerator.server.js'
import { calibrateUpload } from './calibration.server.js'
import { saveModelGlb, readModelGlb, deleteModelGlb, presignObjectRead } from './storage.server.js'
import { saveCalibratedModel } from './models.server.js'
import { reportModelCharge } from './usageBilling.server.js'
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

// The part of a photo key after generation-photos/<shop>/ (storage.server.js).
const PHOTO_FILE = /^[0-9a-f-]+\.(jpg|png|webp)$/

/** True when `ref` is a photo key that presignPhotoUpload issued for this shop. */
export function isShopPhotoRef(shop, ref) {
  if (typeof shop !== 'string' || typeof ref !== 'string') return false
  const prefix = `generation-photos/${shop.toLowerCase()}/`
  return ref.startsWith(prefix) && PHOTO_FILE.test(ref.slice(prefix.length))
}

const USED_STATUSES = ['saving', 'saved']
const ACTIVE_STATUSES = ['queued', 'running', 'collecting']
const RETRYABLE_STATUSES = ['ready', 'failed', 'discarded']
const DAY_MS = 24 * 60 * 60 * 1000

// OpenAI fetches the photos itself, so it gets short-lived signed URLs.
async function photoUrls(photoRefs) {
  return Promise.all(photoRefs.map((ref) => presignObjectRead(ref)))
}

const PHOTO_SOURCES = ['upload', 'product']

function validPhotoRefs(shop, photoRefs) {
  return Array.isArray(photoRefs)
    && photoRefs.length >= 3
    && photoRefs.length <= 4
    && photoRefs.every((ref) => isShopPhotoRef(shop, ref))
}

/**
 * The cost guard: at most LIMITS.running generations in flight and
 * LIMITS.perDay starts (plus automatic retries) in 24 hours. createGeneration
 * runs it under the per-shop lock; the photo presign runs it first, unlocked,
 * so a start that would be refused doesn't leave uploaded photos behind.
 */
export async function assertCanStartGeneration(prisma, shop, now = new Date()) {
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
    photoSource: generation.photoSource ?? 'upload',
    productTitle: generation.productTitle ?? null,
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
export async function createGeneration(prisma, {
  shop, shopGid, photoRefs = null, retryOf = null,
  photoSource = 'upload', productId = null, productTitle = null, productHandle = null,
  now = new Date(),
}) {
  // The guard and the row it protects are created under one per-shop lock, so
  // two concurrent starts can't both pass the same count.
  const { generation, parent } = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`

    let photoSetId = globalThis.crypto.randomUUID()
    let retryIndex = 0
    let parentRow = null
    let refs = photoRefs
    let source = { photoSource, productId, productTitle, productHandle }

    if (retryOf) {
      parentRow = await tx.modelGeneration.findFirst({ where: { id: retryOf, shop } })
      if (!parentRow) throw tagged('NOT_FOUND', `generation ${retryOf} not found`)
      if (!RETRYABLE_STATUSES.includes(parentRow.status)) {
        throw tagged('NOT_RETRYABLE', `cannot retry a ${parentRow.status} generation`)
      }
      // Counting the set, not reading parent.retryIndex, so retrying an older
      // attempt can't restart the count.
      const setSize = await tx.modelGeneration.count({ where: { shop, photoSetId: parentRow.photoSetId } })
      if (setSize > LIMITS.retries) throw tagged('RETRY_LIMIT', 'no retries left for this photo set')
      refs = parentRow.photoRefs
      photoSetId = parentRow.photoSetId
      retryIndex = setSize
      source = {
        photoSource: parentRow.photoSource,
        productId: parentRow.productId,
        productTitle: parentRow.productTitle,
        productHandle: parentRow.productHandle,
      }
    } else if (!PHOTO_SOURCES.includes(photoSource)) {
      throw tagged('BAD_PHOTOS', 'unknown photo source')
    } else if (!validPhotoRefs(shop, refs)) {
      throw tagged('BAD_PHOTOS', "expected 3 or 4 of this shop's uploaded photos")
    }

    await assertCanStartGeneration(tx, shop, now)

    const created = await tx.modelGeneration.create({
      data: { shop, shopGid, photoRefs: refs, photoSetId, retryIndex, ...source, status: 'queued', createdAt: now },
    })
    return { generation: created, parent: parentRow }
  })

  // Slow network call: outside the transaction.
  let providerJobId
  try {
    const started = await startGeneration({
      images: await photoUrls(generation.photoRefs),
      source: generation.photoSource,
    })
    providerJobId = started.providerJobId
  } catch (error) {
    console.error('AI generation start failed', generation.id, error)
    return prisma.modelGeneration.update({
      where: { id: generation.id },
      data: { status: 'failed', error: 'start_failed' },
    })
  }

  // A database error here must surface, not mark a live OpenAI job as failed.
  const running = await prisma.modelGeneration.update({
    where: { id: generation.id },
    data: { status: 'running', providerJobId, startedAt: now },
  })
  // The unsaved result is only thrown away once its replacement is running.
  if (parent?.status === 'ready') await discardGeneration(prisma, shop, parent.id)
  return running
}

/** Throw away an unsaved result (free). Photos stay: a later retry reuses them. */
export async function discardGeneration(prisma, shop, generationId) {
  const generation = await prisma.modelGeneration.findFirst({ where: { id: generationId, shop } })
  if (!generation) throw tagged('NOT_FOUND', `generation ${generationId} not found`)
  if (!['ready', 'failed'].includes(generation.status)) {
    throw tagged('NOT_READY', `cannot discard a ${generation.status} generation`)
  }
  // Conditional on the status we read, so a save that started meanwhile wins.
  const { count } = await prisma.modelGeneration.updateMany({
    where: { id: generation.id, status: generation.status },
    data: { status: 'discarded', glbRef: null },
  })
  if (count === 0) throw tagged('NOT_READY', `generation ${generationId} changed state`)
  if (generation.glbRef) await deleteModelGlb(generation.glbRef)
  return prisma.modelGeneration.findUnique({ where: { id: generation.id } })
}

// What the automatic retry tells the model about the previous attempt.
const FEEDBACK = {
  timeout: 'The previous attempt took too long. Use simpler geometry (fewer segments) and finish within a few minutes.',
  no_glb_output: 'The previous attempt did not save and cite /mnt/data/model.glb. You must save the GLB there and cite it.',
  glb_too_large: 'The previous GLB was over 25 MB. Reduce the triangle count and texture sizes.',
  low_confidence: 'The previous model could not be fitted to a face reliably. Make sure the front faces +Z, the frame is symmetric about X = 0, and AR_bridge, AR_hinge_L and AR_hinge_R sit exactly at the bridge and the two hinges.',
}

function feedbackFor(rawReason) {
  const reason = rawReason ?? 'unknown_error'
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
        source: generation.photoSource,
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
 * before calibration and storage, so only the claimer calibrates, stores and
 * moves the row on. A concurrent caller may also have downloaded the file
 * (checkGeneration fetches it before the claim); that is harmless.
 */
export async function advanceGeneration(prisma, generation, now = new Date()) {
  if (generation.status !== 'running') return generation

  const ageMs = now.getTime() - new Date(generation.startedAt).getTime()
  // Past this age a job that still can't be checked or collected is given up
  // on, so it can't hold one of the shop's two running slots forever.
  const abandoned = ageMs > 2 * LIMITS.timeoutMs

  let result
  try {
    result = await checkGeneration(generation.providerJobId)
  } catch (error) {
    if (!abandoned) throw error
    console.warn('AI generation check keeps failing; giving up on the job', generation.id, error?.message)
    // The job may still be running (and billing); stop it before it's replaced.
    await cancelGeneration(generation.providerJobId)
    result = { state: 'failed', error: 'check_failed' }
  }
  const timedOut = result.state === 'running' && ageMs > LIMITS.timeoutMs
  if (result.state === 'running' && !timedOut) return generation
  if (timedOut) await cancelGeneration(generation.providerJobId)

  const claim = await prisma.modelGeneration.updateMany({
    where: { id: generation.id, status: 'running', providerJobId: generation.providerJobId },
    data: { status: 'collecting' },
  })
  if (claim.count === 0) return prisma.modelGeneration.findUnique({ where: { id: generation.id } })

  try {
    if (timedOut) return await retryOrFail(prisma, generation, 'timeout', now)
    if (result.state === 'failed') return await retryOrFail(prisma, generation, result.error ?? 'unknown_error', now)

    let calibration
    try {
      calibration = await calibrateUpload(result.glbBytes)
    } catch (error) {
      return await retryOrFail(prisma, generation, `invalid_model: ${String(error.message).slice(0, 300)}`, now)
    }
    if (calibration.needsManual) return await retryOrFail(prisma, generation, 'low_confidence', now)

    const glbRef = `generations/${generation.id}.glb`
    await saveModelGlb(glbRef, result.glbBytes)
    return await prisma.modelGeneration.update({
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
  } catch (error) {
    // Hand the row back so the next webhook or poll retries promptly, instead
    // of leaving it stuck in `collecting` -- unless it has been failing for too
    // long, in which case it fails (free) rather than looping forever.
    console.error('AI generation collect failed', generation.id, error)
    await prisma.modelGeneration.updateMany({
      where: { id: generation.id, status: 'collecting' },
      data: abandoned ? { status: 'failed', error: 'collect_failed' } : { status: 'running' },
    })
    throw error
  }
}

/** Webhook entry point. A stale id (replaced by an automatic retry) matches nothing. */
export async function advanceByProviderJob(prisma, providerJobId, now = new Date()) {
  const generation = await prisma.modelGeneration.findFirst({ where: { providerJobId, status: 'running' } })
  if (!generation) return null
  return advanceGeneration(prisma, generation, now)
}

// A generation's ModelAsset has the generation's id, so the asset a crashed
// save already created is found instead of made twice.
async function ownAsset(prisma, shop, generationId) {
  const asset = await prisma.modelAsset.findUnique({ where: { id: generationId } })
  return asset?.shop === shop ? asset : null
}

async function assetForGeneration(prisma, shop, generation) {
  const existing = await ownAsset(prisma, shop, generation.id)
  if (existing) return { assetId: existing.id }
  const bytes = await readModelGlb(generation.glbRef)
  if (!bytes) throw tagged('GLB_MISSING', `pending model ${generation.glbRef} is gone`)
  try {
    return await saveCalibratedModel(prisma, shop, bytes, 'AI model', { id: generation.id })
  } catch (error) {
    // P2002: another save created it between our lookup and our create.
    if (error?.code !== 'P2002') throw error
    const raced = await ownAsset(prisma, shop, generation.id)
    if (!raced) throw error
    return { assetId: raced.id }
  }
}

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
 *    slow to hold a pooled connection), with the generation's id, so a save
 *    re-run after a crash reuses it. If that fails, nothing was charged and
 *    the row goes back to ready.
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
    asset = await assetForGeneration(prisma, shop, generation)
  } catch (error) {
    // The create may have committed before the call errored (e.g. a connection
    // reset after commit). Reverting then would leave a live model that is
    // never charged or counted, so check for it first and carry on if it's there.
    let committed = null
    try {
      committed = await ownAsset(prisma, shop, generation.id)
    } catch (lookupError) {
      console.error('AI generation save: asset lookup after failure also failed', generation.id, lookupError)
    }
    if (!committed) {
      await prisma.modelGeneration.update({ where: { id: generation.id }, data: { status: 'ready', paid: null } })
      throw error
    }
    console.warn('AI generation save errored after the asset was created; completing the save', generation.id, error?.message)
    asset = { assetId: committed.id }
  }

  const saved = await prisma.modelGeneration.update({
    where: { id: generation.id },
    data: { status: 'saved', modelAssetId: asset.assetId, savedAt: now, glbRef: null },
  })
  try {
    await deleteModelGlb(generation.glbRef)
  } catch (error) {
    // The save is committed; an orphaned pending GLB must not undo it.
    console.error('AI generation pending GLB delete failed', generation.id, error)
  }

  if (paid) {
    try {
      await reportChargeFor(prisma, saved)
    } catch (error) {
      console.error('AI model charge report failed; will re-send', generation.id, error)
    }
  }
  return {
    assetId: asset.assetId,
    paid,
    productId: generation.productId ?? null,
    productHandle: generation.productHandle ?? null,
  }
}

// Photos and unsaved models are kept 30 days. Saved rows stay (the lifetime
// allowance counts them) but lose their photos. Retries reuse their parent's
// photos, so a photo set is swept only once every row in it is old.
async function deleteObjects(keys) {
  for (const key of keys) {
    try {
      await deleteModelGlb(key)
    } catch (error) {
      console.error('AI generation sweep delete failed', key, error)
    }
  }
}

async function sweepExpired(prisma, shop, now) {
  const cutoff = new Date(now.getTime() - LIMITS.retentionDays * DAY_MS)
  const expired = await prisma.modelGeneration.findMany({
    where: { shop, createdAt: { lt: cutoff }, status: { in: ['ready', 'saved', 'discarded', 'failed'] } },
  })
  for (const generation of expired) {
    const photos = Array.isArray(generation.photoRefs) ? generation.photoRefs : []
    if (generation.status === 'saved' && photos.length === 0 && !generation.glbRef) continue
    const freshInSet = await prisma.modelGeneration.count({
      where: { shop, photoSetId: generation.photoSetId, createdAt: { gte: cutoff } },
    })
    if (freshInSet > 0) continue
    // Change the row first and delete objects only if we won: a save that
    // claimed the row in between must keep its pending model.
    const changed = generation.status === 'saved'
      ? await prisma.modelGeneration.updateMany({
        where: { id: generation.id, status: 'saved' },
        data: { photoRefs: [], glbRef: null },
      })
      : await prisma.modelGeneration.deleteMany({ where: { id: generation.id, status: generation.status } })
    if (changed.count === 0) continue
    await deleteObjects(generation.glbRef ? [...photos, generation.glbRef] : photos)
  }
}

/**
 * A crash or timeout between the save claim and the "saved" update leaves a
 * row "saving" that would burn a free slot forever. After 15 minutes (longer
 * than any function run, so an in-flight save is never touched):
 * - if its asset was created, the save happened: roll it forward to "saved",
 *   so the merchant keeps one model and a paid save is charged (below);
 * - otherwise hand it back to "ready". The pending GLB is only deleted after
 *   "saved", and the charge only happens after "saved", so nothing is lost or
 *   billed.
 */
async function settleStuckSaves(prisma, shop, now) {
  const stuck = await prisma.modelGeneration.findMany({
    where: { shop, status: 'saving', modelAssetId: null, updatedAt: { lt: new Date(now.getTime() - LIMITS.timeoutMs) } },
  })
  for (const generation of stuck) {
    const asset = await ownAsset(prisma, shop, generation.id)
    const where = { id: generation.id, status: 'saving', modelAssetId: null }
    if (!asset) {
      await prisma.modelGeneration.updateMany({ where, data: { status: 'ready', paid: null } })
      continue
    }
    const { count } = await prisma.modelGeneration.updateMany({
      where,
      data: { status: 'saved', modelAssetId: asset.id, savedAt: now, glbRef: null },
    })
    if (count > 0 && generation.glbRef) await deleteObjects([generation.glbRef])
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

  await settleStuckSaves(prisma, shop, now)

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

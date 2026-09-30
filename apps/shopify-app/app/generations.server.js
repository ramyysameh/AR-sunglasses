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

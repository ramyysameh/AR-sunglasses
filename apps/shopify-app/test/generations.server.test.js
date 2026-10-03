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
const PHOTO_DIR = `generation-photos/${SHOP}`
const PHOTOS = [`${PHOTO_DIR}/0a1b.jpg`, `${PHOTO_DIR}/2c3d.png`, `${PHOTO_DIR}/4e5f.webp`]
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
    // undefined triggers the default parameter, which reads the real env: pin it.
    vi.stubEnv('AI_GENERATION_SHOPS', '')
    try {
      expect(generations.aiGenerationEnabled(SHOP, undefined)).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(generations.aiGenerationEnabled(SHOP, '')).toBe(false)
    expect(generations.aiGenerationEnabled(SHOP, 'a.myshopify.com, GEN-TEST.myshopify.com')).toBe(true)
    expect(generations.aiGenerationEnabled(SHOP, 'a.myshopify.com')).toBe(false)
    expect(generations.aiGenerationEnabled(SHOP, '*')).toBe(true)
    expect(generations.aiGenerationEnabled(null, '*')).toBe(false)
  })
})

describe('toClientGeneration', () => {
  it('folds a starting row and collecting into running, keeps a waiting row queued, and only exposes a preview when ready', () => {
    const base = { id: 'g1', error: null, retryIndex: 1, calibration: { confidence: 0.9 }, paid: null, modelAssetId: null, createdAt: NOW }
    expect(generations.toClientGeneration({ ...base, status: 'queued', startedAt: NOW }).status).toBe('running')
    expect(generations.toClientGeneration({ ...base, status: 'queued', startedAt: null }).status).toBe('queued')
    expect(generations.toClientGeneration({ ...base, status: 'collecting' }).status).toBe('running')
    expect(generations.toClientGeneration({ ...base, status: 'ready' })).toEqual({
      id: 'g1', status: 'ready', error: null, retriesLeft: 2, previewUrl: '/generations/g1.glb',
      confidence: 0.9, paid: null, photoSource: 'upload', productTitle: null, modelAssetId: null, createdAt: NOW,
    })
    expect(generations.toClientGeneration({ ...base, status: 'failed' }).previewUrl).toBeNull()
  })
})

describe('createGeneration', () => {
  beforeEach(() => {
    let n = 0
    deps.start.mockImplementation(async () => ({ providerJobId: `resp_${++n}` }))
  })

  it('starts a job with signed photo URLs and marks it running', async () => {
    const prisma = createFakePrisma()
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(deps.start).toHaveBeenCalledWith({ images: PHOTOS.map((k) => `https://signed.example/${k}`), source: 'upload' })
    expect(g).toMatchObject({ status: 'running', providerJobId: 'resp_1', shopGid: SHOP_GID, retryIndex: 0, startedAt: NOW })
    expect(g.photoSetId).toEqual(expect.any(String))
  })

  it('accepts 3 or 4 photo keys and nothing else', async () => {
    const prisma = createFakePrisma()
    const bad = [
      PHOTOS.slice(0, 2),
      [...PHOTOS, `${PHOTO_DIR}/aa.jpg`, `${PHOTO_DIR}/bb.jpg`],
      [...PHOTOS.slice(0, 2), 'uploads/0a1b.glb'],
      [...PHOTOS.slice(0, 2), 'generation-photos/0a1b.jpg'],
      [...PHOTOS.slice(0, 2), `${PHOTO_DIR}/../x.myshopify.com/0a1b.jpg`],
      `${PHOTO_DIR}/0a1b.jpg`,
    ]
    for (const photoRefs of bad) {
      await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs, now: NOW }))
        .rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    }
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: [...PHOTOS, `${PHOTO_DIR}/9f.jpg`], now: NOW }))
      .resolves.toMatchObject({ status: 'running' })
  })

  it('refuses photo keys that belong to another shop', async () => {
    const prisma = createFakePrisma()
    const foreign = [...PHOTOS.slice(0, 2), 'generation-photos/other.myshopify.com/0a1b.jpg']
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: foreign, now: NOW }))
      .rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('queues a sixth concurrent generation instead of refusing it', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, ['running', 'running', 'running', 'running', 'collecting'], { startedAt: NOW })
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g).toMatchObject({ status: 'queued', startedAt: null })
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('counts starts and automatic retries in the last 24 hours, ignoring older rows', async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000)
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000)
    const input = { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }

    const L = generations.LIMITS.perDay
    // (L-5) + 2 rows + 2 automatic retries = L-1 < L; the 10 old rows must not count.
    const under = createFakePrisma()
    await seed(under, Array(L - 5).fill('failed'), { createdAt: recent })
    await seed(under, Array(2).fill('failed'), { createdAt: recent, autoRetried: true })
    await seed(under, Array(10).fill('failed'), { createdAt: old, autoRetried: true })
    await expect(generations.createGeneration(under, input)).resolves.toMatchObject({ status: 'running' })

    // (L-4) + 2 rows + 2 automatic retries = L >= L.
    const over = createFakePrisma()
    await seed(over, Array(L - 4).fill('failed'), { createdAt: recent })
    await seed(over, Array(2).fill('failed'), { createdAt: recent, autoRetried: true })
    await expect(generations.createGeneration(over, input)).rejects.toMatchObject({ code: 'DAILY_LIMIT' })
  })

  it('takes the per-shop lock before counting', async () => {
    const prisma = createFakePrisma()
    await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(prisma.locks).toEqual([[SHOP]])
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

  it('keeps a ready parent (and its GLB) when the guard refuses the retry', async () => {
    const prisma = createFakePrisma()
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/p.glb', createdAt: NOW }) })
    deps.objects.set('generations/p.glb', Buffer.from('p'))
    await seed(prisma, Array(generations.LIMITS.perDay - 1).fill('failed'), { createdAt: NOW, photoSetId: 'other' })
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW }))
      .rejects.toMatchObject({ code: 'DAILY_LIMIT' })
    expect((await prisma.modelGeneration.findUnique({ where: { id: parent.id } })).status).toBe('ready')
    expect(deps.objects.has('generations/p.glb')).toBe(true)
  })

  it('keeps a ready parent while its retry waits for a slot', async () => {
    const prisma = createFakePrisma()
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/p.glb' }) })
    deps.objects.set('generations/p.glb', Buffer.from('p'))
    await seed(prisma, Array(5).fill('running'), { startedAt: NOW, photoSetId: 'busy' })
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW })
    expect(g).toMatchObject({ status: 'queued', startedAt: null })
    expect((await prisma.modelGeneration.findUnique({ where: { id: parent.id } })).status).toBe('ready')
    expect(deps.objects.has('generations/p.glb')).toBe(true)
  })

  it('keeps a ready parent (and its GLB) when the retry fails to start', async () => {
    const prisma = createFakePrisma()
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/p.glb' }) })
    deps.objects.set('generations/p.glb', Buffer.from('p'))
    deps.start.mockRejectedValue(new Error('429'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW })
      expect(g).toMatchObject({ status: 'failed', error: 'start_failed' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
    expect((await prisma.modelGeneration.findUnique({ where: { id: parent.id } })).status).toBe('ready')
    expect(deps.objects.has('generations/p.glb')).toBe(true)
  })

  it('does not mark the row failed when the update after a successful start throws', async () => {
    const prisma = createFakePrisma()
    const update = prisma.modelGeneration.update
    prisma.modelGeneration.update = vi.fn().mockRejectedValue(new Error('db down'))
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }))
      .rejects.toThrow('db down')
    expect(prisma.modelGeneration.update).toHaveBeenCalledTimes(1)
    prisma.modelGeneration.update = update
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
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
      expect(g).toMatchObject({ status: 'failed', error: 'start_failed' })
      expect(logged).toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})

describe('isShopPhotoRef', () => {
  it("accepts only this shop's photo keys", () => {
    for (const ref of PHOTOS) expect(generations.isShopPhotoRef(SHOP, ref)).toBe(true)
    const bad = [
      'generation-photos/other.myshopify.com/0a1b.jpg',
      'generation-photos/0a1b.jpg',
      `${PHOTO_DIR}/0a1b.gif`,
      `${PHOTO_DIR}/sub/0a1b.jpg`,
      `${PHOTO_DIR}/../other.myshopify.com/0a1b.jpg`,
      `generation-photos/${SHOP}x/0a1b.jpg`,
      null,
    ]
    for (const ref of bad) expect(generations.isShopPhotoRef(SHOP, ref)).toBe(false)
  })
})

describe('assertCanStartGeneration', () => {
  it('passes under the daily limit however many are running, and refuses past it', async () => {
    const prisma = createFakePrisma()
    await expect(generations.assertCanStartGeneration(prisma, SHOP, NOW)).resolves.toBeUndefined()
    await seed(prisma, Array(6).fill('running'), { startedAt: NOW })
    await expect(generations.assertCanStartGeneration(prisma, SHOP, NOW)).resolves.toBeUndefined()

    const busy = createFakePrisma()
    await seed(busy, Array(generations.LIMITS.perDay).fill('failed'), { createdAt: new Date(NOW.getTime() - 60_000) })
    await expect(generations.assertCanStartGeneration(busy, SHOP, NOW)).rejects.toMatchObject({ code: 'DAILY_LIMIT' })
  })
})

describe('remainingToday', () => {
  it('is the daily limit minus starts and automatic retries in the last 24h, never negative', async () => {
    const prisma = createFakePrisma()
    const L = generations.LIMITS.perDay
    await expect(generations.remainingToday(prisma, SHOP, NOW)).resolves.toBe(L)
    await seed(prisma, ['failed', 'failed', 'ready'], { createdAt: new Date(NOW.getTime() - 60_000) })
    await seed(prisma, ['ready'], { createdAt: new Date(NOW.getTime() - 60_000), autoRetried: true })
    await seed(prisma, ['ready'], { createdAt: new Date(NOW.getTime() - 25 * 3600_000) })
    await seed(prisma, ['ready'], { createdAt: NOW, shop: 'other.myshopify.com' })
    await expect(generations.remainingToday(prisma, SHOP, NOW)).resolves.toBe(L - 4 - 1)
    await seed(prisma, Array(L + 10).fill('failed'), { createdAt: NOW })
    await expect(generations.remainingToday(prisma, SHOP, NOW)).resolves.toBe(0)
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

  it('loses to a save that starts between the read and the update, and keeps the GLB', async () => {
    const prisma = createFakePrisma()
    const ready = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/r.glb' }) })
    deps.objects.set('generations/r.glb', Buffer.from('r'))
    const findFirst = prisma.modelGeneration.findFirst
    prisma.modelGeneration.findFirst = async (args) => {
      const found = await findFirst(args)
      await prisma.modelGeneration.update({ where: { id: ready.id }, data: { status: 'saving' } })
      return found
    }
    await expect(generations.discardGeneration(prisma, SHOP, ready.id)).rejects.toMatchObject({ code: 'NOT_READY' })
    expect(deps.objects.has('generations/r.glb')).toBe(true)
    expect((await prisma.modelGeneration.findUnique({ where: { id: ready.id } })).status).toBe('saving')
  })
})

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
    expect(deps.start.mock.calls[0][0].feedback).toMatch(/took too long/)

    const second = await running(prisma, { startedAt: late, autoRetried: true, providerJobId: 'resp_2' })
    await expect(generations.advanceGeneration(prisma, second, NOW)).resolves.toMatchObject({ status: 'failed', error: 'timeout' })
  })

  it('fails right away when the automatic retry cannot be started', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'failed', error: 'no_glb_output' })
    deps.start.mockRejectedValue(new Error('openai down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(generations.advanceGeneration(prisma, g, NOW)).resolves.toMatchObject({ status: 'failed', error: 'no_glb_output' })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('hands the row back to running when collecting blows up after the claim', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
    deps.calibrate.mockResolvedValue(GOOD_CALIBRATION)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setSpy = vi.spyOn(deps.objects, 'set').mockImplementation(() => {
      throw new Error('s3 unavailable')
    })
    try {
      await expect(generations.advanceGeneration(prisma, g, NOW)).rejects.toThrow('s3 unavailable')
      expect(errorSpy).toHaveBeenCalled()
      expect((await prisma.modelGeneration.findUnique({ where: { id: g.id } })).status).toBe('running')
    } finally {
      setSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('gives up on a job it has failed to check for over 30 minutes: one free retry, then failed', async () => {
    const prisma = createFakePrisma()
    const old = new Date(NOW.getTime() - 31 * 60_000)
    const first = await running(prisma, { startedAt: old })
    deps.check.mockRejectedValue(new Error('openai 503'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(generations.advanceGeneration(prisma, first, NOW))
        .resolves.toMatchObject({ status: 'running', autoRetried: true, providerJobId: 'resp_retry', error: 'check_failed' })
      const second = await running(prisma, { startedAt: old, autoRetried: true, providerJobId: 'resp_2' })
      await expect(generations.advanceGeneration(prisma, second, NOW))
        .resolves.toMatchObject({ status: 'failed', error: 'check_failed' })
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('cancels the old OpenAI job when it gives up on one it cannot check', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma, { startedAt: new Date(NOW.getTime() - 31 * 60_000) })
    deps.check.mockRejectedValue(new Error('openai 503'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await generations.advanceGeneration(prisma, g, NOW)
    } finally {
      warn.mockRestore()
    }
    expect(deps.cancel).toHaveBeenCalledTimes(1)
    expect(deps.cancel).toHaveBeenCalledWith('resp_1')
  })

  it('rethrows a failed check on a young job and leaves it running', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma, { startedAt: new Date(NOW.getTime() - 5 * 60_000) })
    deps.check.mockRejectedValue(new Error('openai 503'))
    await expect(generations.advanceGeneration(prisma, g, NOW)).rejects.toThrow('openai 503')
    expect((await prisma.modelGeneration.findUnique({ where: { id: g.id } })).status).toBe('running')
    expect(deps.start).not.toHaveBeenCalled()
  })

  it('marks an old job failed (collect_failed) instead of handing it back forever', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma, { startedAt: new Date(NOW.getTime() - 31 * 60_000) })
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
    deps.calibrate.mockResolvedValue(GOOD_CALIBRATION)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const setSpy = vi.spyOn(deps.objects, 'set').mockImplementation(() => {
      throw new Error('s3 unavailable')
    })
    try {
      await expect(generations.advanceGeneration(prisma, g, NOW)).rejects.toThrow('s3 unavailable')
      expect(errorSpy).toHaveBeenCalled()
      expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } }))
        .toMatchObject({ status: 'failed', error: 'collect_failed' })
    } finally {
      setSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('keeps a long calibration message out of the stored error', async () => {
    const prisma = createFakePrisma()
    const g = await running(prisma)
    deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('bad') })
    deps.calibrate.mockRejectedValue(new Error('x'.repeat(1000)))
    const next = await generations.advanceGeneration(prisma, g, NOW)
    expect(next.error).toBe(`invalid_model: ${'x'.repeat(300)}`)
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

  describe('starting waiting rows', () => {
    async function withWaiting(prisma) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', providerJobId: 'resp_live', startedAt: NOW }) })
      const waiting = await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'w' }) })
      deps.start.mockResolvedValue({ providerJobId: 'resp_next' })
      return waiting
    }
    const statusOf = async (prisma, g) => (await prisma.modelGeneration.findUnique({ where: { id: g.id } })).status
    const GOOD = { needsManual: false, confidence: null, fitMetadata: { provenance: { source: 'tagged' } } }

    it('starts a waiting row when the advanced row becomes ready', async () => {
      const prisma = createFakePrisma()
      const waiting = await withWaiting(prisma)
      deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
      deps.calibrate.mockResolvedValue(GOOD)
      await expect(generations.advanceByProviderJob(prisma, 'resp_live', NOW)).resolves.toMatchObject({ status: 'ready' })
      expect(await statusOf(prisma, waiting)).toBe('running')
    })

    it('starts a waiting row when the advanced row fails', async () => {
      const prisma = createFakePrisma()
      const waiting = await withWaiting(prisma)
      deps.check.mockResolvedValue({ state: 'failed', error: 'no_glb_output' })
      // Its automatic retry is already spent, so it fails and frees the slot.
      await prisma.modelGeneration.updateMany({ where: { providerJobId: 'resp_live' }, data: { autoRetried: true } })
      await expect(generations.advanceByProviderJob(prisma, 'resp_live', NOW)).resolves.toMatchObject({ status: 'failed' })
      expect(await statusOf(prisma, waiting)).toBe('running')
    })

    it('does not start waiting rows when the row stays running (automatic retry)', async () => {
      const prisma = createFakePrisma()
      const waiting = await withWaiting(prisma)
      // The other 4 slots are busy, so only a freed slot could let the waiting row in.
      for (let i = 0; i < 4; i += 1) {
        await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `b${i}` }) })
      }
      deps.check.mockResolvedValue({ state: 'failed', error: 'no_glb_output' })
      deps.start.mockResolvedValue({ providerJobId: 'resp_retry' })
      await expect(generations.advanceByProviderJob(prisma, 'resp_live', NOW)).resolves.toMatchObject({ status: 'running', autoRetried: true })
      expect(await statusOf(prisma, waiting)).toBe('queued')
      expect(deps.start).toHaveBeenCalledTimes(1)
    })

    it('logs a startQueued error without rejecting', async () => {
      const prisma = createFakePrisma()
      await withWaiting(prisma)
      deps.check.mockResolvedValue({ state: 'done', glbBytes: Buffer.from('glb') })
      deps.calibrate.mockResolvedValue(GOOD)
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        prisma.$transaction = vi.fn().mockRejectedValue(new Error('db down'))
        await expect(generations.advanceByProviderJob(prisma, 'resp_live', NOW)).resolves.toMatchObject({ status: 'ready' })
        expect(logged).toHaveBeenCalledWith('AI generation queue start failed', SHOP, expect.any(Error))
      } finally {
        logged.mockRestore()
      }
    })
  })
})

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
      .resolves.toEqual({ assetId: 'asset-1', paid: false, productId: null, productHandle: null })
    const [, shopArg, bytes, filename, options] = deps.saveCalibratedModel.mock.calls[0]
    expect([shopArg, bytes.toString(), filename, options]).toEqual([SHOP, 'glb', 'AI model', { id: g.id, label: null }])
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
      .resolves.toEqual({ assetId: 'asset-1', paid: true, productId: null, productHandle: null })
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
      .resolves.toEqual({ assetId: 'asset-1', paid: false, productId: null, productHandle: null })
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
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', acceptCharge: true, now: NOW }))
        .resolves.toEqual({ assetId: 'asset-1', paid: true, productId: null, productHandle: null })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'saved', chargeReported: false })
  })

  it('only saves ready rows of this shop', async () => {
    const prisma = createFakePrisma()
    const running = await prisma.modelGeneration.create({ data: row({ status: 'running' }) })
    const foreign = await readyRow(prisma, { shop: 'other.myshopify.com' })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: running.id, planName: 'Pro', now: NOW })).rejects.toMatchObject({ code: 'NOT_READY' })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: foreign.id, planName: 'Pro', now: NOW })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('reports GLB_MISSING and puts the row back to ready when the pending model is gone', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    deps.objects.delete(`generations/${g.id}.glb`)
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .rejects.toMatchObject({ code: 'GLB_MISSING' })
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'ready', paid: null })
    expect(deps.saveCalibratedModel).not.toHaveBeenCalled()
  })

  it('refuses to save the same row twice', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    await generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_READY' })
    expect(deps.saveCalibratedModel).toHaveBeenCalledTimes(1)

    const claimed = await prisma.modelGeneration.create({ data: row({ status: 'saving' }) })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: claimed.id, planName: 'Starter', now: NOW }))
      .rejects.toMatchObject({ code: 'NOT_READY' })
  })

  it('stays free within the allowance even when the charge was accepted', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', acceptCharge: true, now: NOW }))
      .resolves.toEqual({ assetId: 'asset-1', paid: false, productId: null, productHandle: null })
    expect(deps.report).not.toHaveBeenCalled()
  })

  it('reuses the asset a crashed save already created: no second asset, one charge', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(10).fill('saved'))
    const g = await readyRow(prisma)
    // The asset row commits, then the connection drops before the reply. The
    // lookup that would have spotted it inside the save fails too, so the row
    // is handed back to ready and the retry finds the asset instead.
    deps.saveCalibratedModel.mockImplementationOnce(async (_prisma, shop, _bytes, _name, { id }) => {
      prisma.modelAsset.assets.set(id, { id, shop })
      throw new Error('connection reset')
    })
    const realFind = prisma.modelAsset.findUnique
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const input = { shop: SHOP, generationId: g.id, planName: 'Starter', acceptCharge: true, now: NOW }
    try {
      // 1st lookup (before create) passes through; 2nd (after the failed create) throws.
      let lookups = 0
      prisma.modelAsset.findUnique = async (args) => {
        if (++lookups === 2) throw new Error('db gone')
        return realFind(args)
      }
      await expect(generations.saveGeneration(prisma, input)).rejects.toThrow('connection reset')
      prisma.modelAsset.findUnique = realFind
      expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'ready', paid: null })

      await expect(generations.saveGeneration(prisma, input)).resolves.toEqual({ assetId: g.id, paid: true, productId: null, productHandle: null })
    } finally {
      prisma.modelAsset.findUnique = realFind
      errorSpy.mockRestore()
    }
    expect(deps.saveCalibratedModel).toHaveBeenCalledTimes(1)
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } }))
      .toMatchObject({ status: 'saved', modelAssetId: g.id, chargeReported: true })

    await generations.listGenerations(prisma, SHOP, NOW)
    expect(deps.report).toHaveBeenCalledTimes(1)
    expect(deps.report).toHaveBeenCalledWith({ shopGid: SHOP_GID, idempotencyKey: `aimodel_${g.id}`, timestamp: NOW })
  })

  it('completes the save when the asset create committed but the call errored (paid: charged once)', async () => {
    const prisma = createFakePrisma()
    await seed(prisma, Array(10).fill('saved'))
    const g = await readyRow(prisma)
    deps.saveCalibratedModel.mockImplementationOnce(async (_prisma, shop, _bytes, _name, { id }) => {
      prisma.modelAsset.assets.set(id, { id, shop })
      throw new Error('connection reset')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', acceptCharge: true, now: NOW }))
        .resolves.toEqual({ assetId: g.id, paid: true, productId: null, productHandle: null })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } }))
      .toMatchObject({ status: 'saved', paid: true, modelAssetId: g.id, savedAt: NOW, glbRef: null, chargeReported: true })
    expect(deps.objects.has(`generations/${g.id}.glb`)).toBe(false)
    expect(deps.report).toHaveBeenCalledTimes(1)
    expect(deps.report).toHaveBeenCalledWith({ shopGid: SHOP_GID, idempotencyKey: `aimodel_${g.id}`, timestamp: NOW })
  })

  it('completes a free save too when the asset create committed but the call errored', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    deps.saveCalibratedModel.mockImplementationOnce(async (_prisma, shop, _bytes, _name, { id }) => {
      prisma.modelAsset.assets.set(id, { id, shop })
      throw new Error('connection reset')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
        .resolves.toEqual({ assetId: g.id, paid: false, productId: null, productHandle: null })
    } finally {
      warn.mockRestore()
    }
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } }))
      .toMatchObject({ status: 'saved', paid: false, modelAssetId: g.id })
    expect(deps.report).not.toHaveBeenCalled()
  })

  it('reuses the asset when a concurrent create wins the unique id (P2002)', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    deps.saveCalibratedModel.mockImplementationOnce(async (_prisma, shop, _bytes, _name, { id }) => {
      prisma.modelAsset.assets.set(id, { id, shop })
      throw Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), { code: 'P2002' })
    })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .resolves.toEqual({ assetId: g.id, paid: false, productId: null, productHandle: null })
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'saved', modelAssetId: g.id })
  })

  it('does not reuse an asset with the same id that belongs to another shop', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    prisma.modelAsset.assets.set(g.id, { id: g.id, shop: 'other.myshopify.com' })
    deps.saveCalibratedModel.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .rejects.toMatchObject({ code: 'P2002' })
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'ready', paid: null })
  })

  it('still succeeds when deleting the pending model afterwards fails', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    const glbRef = `generations/${g.id}.glb`
    // deleteModelGlb is the mocked storage function backed by deps.objects.
    const realDelete = deps.objects.delete.bind(deps.objects)
    deps.objects.delete = () => { throw new Error('S3 delete down') }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
        .resolves.toEqual({ assetId: 'asset-1', paid: false, productId: null, productHandle: null })
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      deps.objects.delete = realDelete
    }
    expect(deps.objects.has(glbRef)).toBe(true)
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'saved' })
  })

  it('names a product-sourced model after its product', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma, { photoSource: 'product', productTitle: 'Aviator Gold' })
    await generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW })
    expect(deps.saveCalibratedModel).toHaveBeenCalledWith(prisma, SHOP, expect.anything(), 'AI model', { id: g.id, label: 'Aviator Gold' })
  })

  it('adds (2) when the shop already has a model with that name', async () => {
    const prisma = createFakePrisma()
    prisma.modelAsset.assets.set('a1', { id: 'a1', shop: SHOP, label: 'Aviator Gold' })
    prisma.modelAsset.assets.set('a2', { id: 'a2', shop: 'other.myshopify.com', label: 'Aviator Gold (2)' })
    expect(await generations.uniqueAssetLabel(prisma, SHOP, 'Aviator Gold')).toBe('Aviator Gold (2)')
    prisma.modelAsset.assets.set('a3', { id: 'a3', shop: SHOP, label: 'Aviator Gold (2)' })
    expect(await generations.uniqueAssetLabel(prisma, SHOP, 'Aviator Gold')).toBe('Aviator Gold (3)')
  })

  it('keeps an uploaded-photo model unlabelled', async () => {
    const prisma = createFakePrisma()
    const g = await readyRow(prisma)
    await generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW })
    expect(deps.saveCalibratedModel).toHaveBeenCalledWith(prisma, SHOP, expect.anything(), 'AI model', { id: g.id, label: null })
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
    await prisma.modelGeneration.create({ data: row({ status: 'failed', photoSetId: 'set-2', createdAt: t(3) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'ready', createdAt: t(1) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'saved', createdAt: t(2) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'discarded', createdAt: t(0) }) })
    const rows = await generations.listGenerations(prisma, SHOP, NOW)
    expect(rows.map((r) => r.status)).toEqual(['ready', 'failed'])
  })

  it('hides a failed attempt once a retry of the same photos exists, whatever became of the retry', async () => {
    const t = (min) => new Date(NOW.getTime() - min * 60_000)
    for (const retryStatus of ['running', 'ready', 'saved', 'discarded', 'failed']) {
      const prisma = createFakePrisma()
      const first = await prisma.modelGeneration.create({ data: row({ status: 'failed', createdAt: t(10) }) })
      const retry = await prisma.modelGeneration.create({ data: row({ status: retryStatus, retryIndex: 1, providerJobId: 'resp_r', startedAt: NOW, createdAt: t(5) }) })
      deps.check.mockResolvedValue({ state: 'running' })
      const ids = (await generations.listGenerations(prisma, SHOP, NOW)).map((r) => r.id)
      expect(ids, retryStatus).not.toContain(first.id)
      if (['running', 'failed'].includes(retryStatus)) expect(ids, retryStatus).toContain(retry.id)
    }
  })

  it('keeps showing the latest failed attempt, and failures of other photos', async () => {
    const prisma = createFakePrisma()
    const t = (min) => new Date(NOW.getTime() - min * 60_000)
    const mine = await prisma.modelGeneration.create({ data: row({ status: 'failed', createdAt: t(10) }) })
    const other = await prisma.modelGeneration.create({ data: row({ status: 'failed', photoSetId: 'set-2', createdAt: t(20) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'ready', photoSetId: 'set-3', createdAt: t(1) }) })
    const ids = (await generations.listGenerations(prisma, SHOP, NOW)).map((r) => r.id)
    expect(ids).toContain(mine.id)
    expect(ids).toContain(other.id)
  })

  it('hands back a row stuck saving for over 15 minutes, but not a recent one', async () => {
    const prisma = createFakePrisma()
    const stale = await prisma.modelGeneration.create({
      data: row({ status: 'saving', paid: true, updatedAt: new Date(NOW.getTime() - 16 * 60_000) }),
    })
    const recent = await prisma.modelGeneration.create({
      data: row({ status: 'saving', paid: true, updatedAt: new Date(NOW.getTime() - 10 * 60_000) }),
    })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: stale.id } })).toMatchObject({ status: 'ready', paid: null })
    expect(await prisma.modelGeneration.findUnique({ where: { id: recent.id } })).toMatchObject({ status: 'saving', paid: true })
  })

  it('rolls a stuck saving row forward to saved when its asset exists, then reports the charge', async () => {
    const prisma = createFakePrisma()
    const stale = await prisma.modelGeneration.create({
      data: row({ status: 'saving', paid: true, glbRef: 'generations/s.glb', updatedAt: new Date(NOW.getTime() - 16 * 60_000) }),
    })
    deps.objects.set('generations/s.glb', Buffer.from('s'))
    prisma.modelAsset.assets.set(stale.id, { id: stale.id, shop: SHOP })
    deps.report.mockResolvedValue(undefined)
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: stale.id } })).toMatchObject({
      status: 'saved', paid: true, modelAssetId: stale.id, savedAt: NOW, glbRef: null, chargeReported: true,
    })
    expect(deps.objects.has('generations/s.glb')).toBe(false)
    expect(deps.report).toHaveBeenCalledTimes(1)
    expect(deps.report).toHaveBeenCalledWith({ shopGid: SHOP_GID, idempotencyKey: `aimodel_${stale.id}`, timestamp: NOW })
  })

  it('reverts a stuck saving row whose asset id belongs to another shop', async () => {
    const prisma = createFakePrisma()
    const stale = await prisma.modelGeneration.create({
      data: row({ status: 'saving', paid: true, updatedAt: new Date(NOW.getTime() - 16 * 60_000) }),
    })
    prisma.modelAsset.assets.set(stale.id, { id: stale.id, shop: 'other.myshopify.com' })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: stale.id } })).toMatchObject({ status: 'ready', paid: null })
  })

  it('leaves a saving row that already has its asset alone', async () => {
    const prisma = createFakePrisma()
    const g = await prisma.modelGeneration.create({
      data: row({ status: 'saving', modelAssetId: 'asset-9', updatedAt: new Date(NOW.getTime() - 16 * 60_000) }),
    })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toMatchObject({ status: 'saving' })
  })

  it('does not sweep photos shared with a newer row in the same photo set', async () => {
    const prisma = createFakePrisma()
    const day = 24 * 60 * 60 * 1000
    for (const key of PHOTOS) deps.objects.set(key, Buffer.from('p'))
    const a = await prisma.modelGeneration.create({ data: row({ status: 'failed', createdAt: new Date(NOW.getTime() - 31 * day) }) })
    const b = await prisma.modelGeneration.create({ data: row({ status: 'ready', createdAt: new Date(NOW.getTime() - 1 * day) }) })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: a.id } })).not.toBeNull()
    for (const key of PHOTOS) expect(deps.objects.has(key)).toBe(true)
    expect(await prisma.modelGeneration.findUnique({ where: { id: b.id } })).toMatchObject({ status: 'ready', photoRefs: PHOTOS })
  })

  it('keeps going when deleting an expired object fails', async () => {
    const prisma = createFakePrisma()
    const old = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000)
    for (const key of PHOTOS) deps.objects.set(key, Buffer.from('p'))
    const g = await prisma.modelGeneration.create({ data: row({ status: 'failed', createdAt: old }) })
    const realDelete = deps.objects.delete.bind(deps.objects)
    deps.objects.delete = (key) => {
      if (key === PHOTOS[0]) throw new Error('S3 delete down')
      return realDelete(key)
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(generations.listGenerations(prisma, SHOP, NOW)).resolves.toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
      deps.objects.delete = realDelete
    }
    expect(await prisma.modelGeneration.findUnique({ where: { id: g.id } })).toBeNull()
    expect(deps.objects.has(PHOTOS[1])).toBe(false)
    expect(deps.objects.has(PHOTOS[2])).toBe(false)
  })
})

describe('product-sourced generations', () => {
  beforeEach(() => {
    deps.start.mockResolvedValue({ providerJobId: 'resp_p' })
  })

  it('stores the source and product and asks the generator for product wording', async () => {
    const prisma = createFakePrisma()
    const g = await generations.createGeneration(prisma, {
      shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW,
      photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo',
    })
    expect(g).toMatchObject({ photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo' })
    expect(deps.start.mock.calls[0][0]).toMatchObject({ source: 'product' })
  })

  it('defaults to upload and refuses unknown sources', async () => {
    const prisma = createFakePrisma()
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g.photoSource).toBe('upload')
    expect(deps.start.mock.calls[0][0]).toMatchObject({ source: 'upload' })
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW, photoSource: 'url' }))
      .rejects.toMatchObject({ code: 'BAD_PHOTOS' })
  })

  it('retries and automatic retries keep the product source', async () => {
    const prisma = createFakePrisma()
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'failed', photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo' }) })
    const retry = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW })
    expect(retry).toMatchObject({ photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo' })
    expect(deps.start.mock.calls.at(-1)[0]).toMatchObject({ source: 'product' })

    const running = await prisma.modelGeneration.create({ data: row({ status: 'running', providerJobId: 'resp_9', startedAt: NOW, photoSource: 'product' }) })
    deps.check.mockResolvedValue({ state: 'failed', error: 'no_glb_output' })
    await generations.advanceGeneration(prisma, running, NOW)
    expect(deps.start.mock.calls.at(-1)[0]).toMatchObject({ source: 'product' })
  })

  it('exposes the source and product title to the client', () => {
    const view = generations.toClientGeneration({ id: 'g', status: 'ready', error: null, retryIndex: 0, calibration: null, paid: null, modelAssetId: null, createdAt: NOW, photoSource: 'product', productTitle: 'GRIPZ Pelmo' })
    expect(view).toMatchObject({ photoSource: 'product', productTitle: 'GRIPZ Pelmo' })
  })

  it('save returns the product so the route can map it', async () => {
    const prisma = createFakePrisma()
    const g = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/x.glb', photoSource: 'product', productId: 'gid://shopify/Product/42', productHandle: 'gripz-pelmo' }) })
    deps.objects.set('generations/x.glb', Buffer.from('glb'))
    deps.saveCalibratedModel.mockResolvedValue({ assetId: g.id })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .resolves.toEqual({ assetId: g.id, paid: false, productId: 'gid://shopify/Product/42', productHandle: 'gripz-pelmo' })
  })
})

describe('start queue', () => {
  const t = (min) => new Date(NOW.getTime() - min * 60_000)

  it('starts up to 5 at once and queues the rest without calling OpenAI', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_x' })
    for (let i = 0; i < 5; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `s${i}` }) })
    }
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g.status).toBe('queued')
    expect(g.startedAt).toBeNull()
    expect(deps.start).not.toHaveBeenCalled()
    expect(generations.toClientGeneration(g).status).toBe('queued')
  })

  it('counts a row that is mid-start as holding a slot', async () => {
    const prisma = createFakePrisma()
    for (let i = 0; i < 4; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `s${i}` }) })
    }
    await prisma.modelGeneration.create({ data: row({ status: 'queued', startedAt: NOW, photoSetId: 'starting' }) })
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g.status).toBe('queued')
    expect(g.startedAt).toBeNull()
  })

  it('startQueued starts the oldest waiting rows while slots are free', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_q' })
    for (let i = 0; i < 3; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'running', startedAt: NOW, photoSetId: `s${i}` }) })
    }
    const older = await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(3), photoSetId: 'q1' }) })
    const middle = await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(2), photoSetId: 'q2' }) })
    const newest = await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(1), photoSetId: 'q3' }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(2)
    expect((await prisma.modelGeneration.findUnique({ where: { id: older.id } })).status).toBe('running')
    expect((await prisma.modelGeneration.findUnique({ where: { id: middle.id } })).status).toBe('running')
    expect((await prisma.modelGeneration.findUnique({ where: { id: newest.id } })).status).toBe('queued')
  })

  it('a queued row whose start fails is failed, free', async () => {
    const prisma = createFakePrisma()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      deps.start.mockRejectedValue(new Error('openai down'))
      const q = await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'q' }) })
      expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(0)
      expect(await prisma.modelGeneration.findUnique({ where: { id: q.id } })).toMatchObject({ status: 'failed', error: 'start_failed' })
    } finally {
      logged.mockRestore()
    }
  })

  it('startQueued takes the per-shop lock for each row it considers', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_lock' })
    await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'q' }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(1)
    expect(prisma.locks.length).toBeGreaterThanOrEqual(1)
    expect(prisma.locks.every((l) => l.length === 1 && l[0] === SHOP)).toBe(true)
  })

  it('startQueued discards the ready parent of a retry that waited', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_retry' })
    deps.objects.set('generations/p.glb', Buffer.from('p'))
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/p.glb', createdAt: t(5) }) })
    const retry = await prisma.modelGeneration.create({ data: row({ status: 'queued', retryIndex: 1, createdAt: t(1) }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(1)
    expect((await prisma.modelGeneration.findUnique({ where: { id: retry.id } })).status).toBe('running')
    expect((await prisma.modelGeneration.findUnique({ where: { id: parent.id } })).status).toBe('discarded')
    expect(deps.objects.has('generations/p.glb')).toBe(false)
  })

  it('a failed parent discard is logged and does not undo the start', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_retry' })
    await prisma.modelGeneration.create({ data: row({ status: 'ready', createdAt: t(5) }) })
    const retry = await prisma.modelGeneration.create({ data: row({ status: 'queued', retryIndex: 1, createdAt: t(1) }) })
    prisma.modelGeneration.updateMany = vi.fn().mockRejectedValue(new Error('db blip'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(1)
      expect((await prisma.modelGeneration.findUnique({ where: { id: retry.id } })).status).toBe('running')
      expect(logged).toHaveBeenCalledWith('AI generation parent discard failed', retry.id, expect.any(Error))
    } finally {
      logged.mockRestore()
    }
  })

  it('refuses a retry while another attempt in the photo set is queued, running or collecting', async () => {
    for (const sibling of ['queued', 'running', 'collecting']) {
      const prisma = createFakePrisma()
      const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', createdAt: t(5) }) })
      await prisma.modelGeneration.create({ data: row({ status: sibling, retryIndex: 1, createdAt: t(1) }) })
      await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW }))
        .rejects.toMatchObject({ code: 'NOT_RETRYABLE' })
      expect(await prisma.modelGeneration.count({ where: { shop: SHOP } })).toBe(2)
    }
  })

  it('startQueued discards a waiting retry whose photo set already has a saved row, and starts the next one', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_next' })
    await prisma.modelGeneration.create({ data: row({ status: 'saved', createdAt: t(9) }) })
    const stale = await prisma.modelGeneration.create({ data: row({ status: 'queued', retryIndex: 1, createdAt: t(3) }) })
    const next = await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'other', createdAt: t(2) }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(1)
    expect(deps.start).toHaveBeenCalledTimes(1)
    expect((await prisma.modelGeneration.findUnique({ where: { id: stale.id } })).status).toBe('discarded')
    expect((await prisma.modelGeneration.findUnique({ where: { id: next.id } })).status).toBe('running')
  })

  it('startQueued also discards a waiting retry whose set has a saving row', async () => {
    const prisma = createFakePrisma()
    await prisma.modelGeneration.create({ data: row({ status: 'saving', createdAt: t(9) }) })
    const stale = await prisma.modelGeneration.create({ data: row({ status: 'queued', retryIndex: 1, createdAt: t(3) }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(0)
    expect(deps.start).not.toHaveBeenCalled()
    expect((await prisma.modelGeneration.findUnique({ where: { id: stale.id } })).status).toBe('discarded')
  })

  it('startQueued leaves other photo sets alone for a first attempt', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_first' })
    const other = await prisma.modelGeneration.create({ data: row({ status: 'ready', photoSetId: 'other', createdAt: t(5) }) })
    await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'q', createdAt: t(1) }) })
    expect(await generations.startQueued(prisma, SHOP, NOW)).toBe(1)
    expect((await prisma.modelGeneration.findUnique({ where: { id: other.id } })).status).toBe('ready')
  })

  it('fails a row stuck mid-start for over 5 minutes so it frees its slot', async () => {
    const prisma = createFakePrisma()
    const stuck = await prisma.modelGeneration.create({ data: row({ status: 'queued', startedAt: t(6), photoSetId: 'x' }) })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect(await prisma.modelGeneration.findUnique({ where: { id: stuck.id } })).toMatchObject({ status: 'failed', error: 'start_failed' })
  })

  it('listGenerations starts waiting rows', async () => {
    const prisma = createFakePrisma()
    deps.start.mockResolvedValue({ providerJobId: 'resp_l' })
    const q = await prisma.modelGeneration.create({ data: row({ status: 'queued', photoSetId: 'q' }) })
    await generations.listGenerations(prisma, SHOP, NOW)
    expect((await prisma.modelGeneration.findUnique({ where: { id: q.id } })).status).toBe('running')
  })

  it('still refuses past the daily limit, counting waiting rows', async () => {
    const prisma = createFakePrisma()
    for (let i = 0; i < generations.LIMITS.perDay; i += 1) {
      await prisma.modelGeneration.create({ data: row({ status: 'queued', createdAt: t(10), photoSetId: `d${i}` }) })
    }
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }))
      .rejects.toMatchObject({ code: 'DAILY_LIMIT' })
  })
})

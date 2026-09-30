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

  it('counts starts and automatic retries in the last 24 hours, ignoring older rows', async () => {
    const recent = new Date(NOW.getTime() - 60 * 60 * 1000)
    const old = new Date(NOW.getTime() - 25 * 60 * 60 * 1000)
    const input = { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW }

    // 15 + 2 rows + 2 automatic retries = 19 < 20; the 10 old rows must not count.
    const under = createFakePrisma()
    await seed(under, Array(15).fill('failed'), { createdAt: recent })
    await seed(under, Array(2).fill('failed'), { createdAt: recent, autoRetried: true })
    await seed(under, Array(10).fill('failed'), { createdAt: old, autoRetried: true })
    await expect(generations.createGeneration(under, input)).resolves.toMatchObject({ status: 'running' })

    // 16 + 2 rows + 2 automatic retries = 20 >= 20.
    const over = createFakePrisma()
    await seed(over, Array(16).fill('failed'), { createdAt: recent })
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
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/p.glb' }) })
    deps.objects.set('generations/p.glb', Buffer.from('p'))
    await seed(prisma, ['running', 'running'])
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW }))
      .rejects.toMatchObject({ code: 'TOO_MANY_RUNNING' })
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
})

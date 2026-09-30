import { describe, it, expect, vi } from 'vitest'

// DB-free: saveCalibratedModel's optional fixed id (used by AI generations so a
// re-run save is idempotent). The DB-backed pipeline test is models.server.test.js.
vi.mock('../app/calibration.server.js', () => ({
  calibrateUpload: async () => ({
    storedGlb: Buffer.from('stored'),
    confidence: { overall: 0.9 },
    fitMetadata: { provenance: { source: 'tagged' } },
    needsManual: false,
    validation: { status: 'ok' },
  }),
}))
vi.mock('../app/storage.server.js', () => ({
  saveModelGlb: async () => {},
  readModelGlb: async () => null,
  deleteModelGlb: async () => {},
}))

const { saveCalibratedModel } = await import('../app/models.server.js')

function fakePrisma() {
  const created = []
  return {
    created,
    modelAsset: {
      create: async ({ data }) => {
        created.push(data)
        return { id: data.id ?? 'generated-id', ...data }
      },
    },
  }
}

describe('saveCalibratedModel id option', () => {
  it('creates the asset with the given id', async () => {
    const prisma = fakePrisma()
    const result = await saveCalibratedModel(prisma, 's.myshopify.com', Buffer.from('glb'), 'AI model', { id: 'gen-1' })
    expect(result.assetId).toBe('gen-1')
    expect(prisma.created[0]).toMatchObject({ id: 'gen-1', shop: 's.myshopify.com', filename: 'AI model' })
  })

  it('lets the database pick the id when none is given (existing callers)', async () => {
    const prisma = fakePrisma()
    const result = await saveCalibratedModel(prisma, 's.myshopify.com', Buffer.from('glb'), 'upload.glb')
    expect(result.assetId).toBe('generated-id')
    expect('id' in prisma.created[0]).toBe(false)
  })
})

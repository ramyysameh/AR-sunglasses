import { describe, it, expect } from 'vitest'
import { createFakePrisma } from './helpers/fakePrisma.js'

const BASE = { shop: 's.myshopify.com', shopGid: 'gid://shopify/Shop/1', photoRefs: ['generation-photos/a.jpg'], photoSetId: 'set', status: 'ready' }

describe('fakePrisma', () => {
  it('never matches NULL with lt, gte or not (SQL semantics)', async () => {
    const { modelGeneration } = createFakePrisma()
    await modelGeneration.create({ data: { ...BASE } }) // startedAt and providerJobId default to null
    const later = new Date('2030-01-01T00:00:00Z')
    expect(await modelGeneration.count({ where: { startedAt: { lt: later } } })).toBe(0)
    expect(await modelGeneration.count({ where: { startedAt: { gte: new Date(0) } } })).toBe(0)
    expect(await modelGeneration.count({ where: { providerJobId: { not: 'x' } } })).toBe(0)
    expect(await modelGeneration.count({ where: { status: { not: 'x' } } })).toBe(1)
  })

  it('treats explicit undefined on create as absent so defaults apply', async () => {
    const { modelGeneration } = createFakePrisma()
    const created = await modelGeneration.create({ data: { ...BASE, providerJobId: undefined, retryIndex: undefined } })
    expect(created.providerJobId).toBeNull()
    expect(created.retryIndex).toBe(0)
  })

  it('throws on unsupported where keys and operators', async () => {
    const { modelGeneration } = createFakePrisma()
    const created = await modelGeneration.create({ data: { ...BASE } })
    await expect(modelGeneration.findUnique({ where: { shop: BASE.shop } })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.update({ where: { id: created.id, shop: BASE.shop }, data: {} })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.delete({ where: { shop: BASE.shop } })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.findMany({ where: { OR: [{ status: 'ready' }] } })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.count({ where: { NOT: { status: 'ready' } } })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.count({ where: { status: { contains: 'rea' } } })).rejects.toThrow('fakePrisma: unsupported')
  })

  it('throws on unsupported orderBy but accepts createdAt desc', async () => {
    const { modelGeneration } = createFakePrisma()
    await modelGeneration.create({ data: { ...BASE } })
    await expect(modelGeneration.findMany({ orderBy: { createdAt: 'asc' } })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.findMany({ orderBy: { updatedAt: 'desc' } })).rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.findMany({ orderBy: { createdAt: 'desc' } })).resolves.toHaveLength(1)
  })

  it('throws on operator objects in update data but accepts arrays and the calibration JSON', async () => {
    const { modelGeneration } = createFakePrisma()
    const created = await modelGeneration.create({ data: { ...BASE } })
    await expect(modelGeneration.update({ where: { id: created.id }, data: { retryIndex: { increment: 1 } } }))
      .rejects.toThrow('fakePrisma: unsupported')
    await expect(modelGeneration.updateMany({ where: { shop: BASE.shop }, data: { retryIndex: { increment: 1 } } }))
      .rejects.toThrow('fakePrisma: unsupported')

    const calibration = { confidence: 0.8, anchors: { nose: [0, 1, 2] } }
    const photoRefs = ['generation-photos/b.png']
    const updated = await modelGeneration.update({ where: { id: created.id }, data: { calibration, photoRefs } })
    expect(updated.calibration).toEqual(calibration)
    expect(updated.photoRefs).toEqual(photoRefs)
  })
})

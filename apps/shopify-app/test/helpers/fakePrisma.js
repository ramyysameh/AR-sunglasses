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

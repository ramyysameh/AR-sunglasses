import { randomUUID } from 'node:crypto'

// In-memory stand-in for the parts of Prisma that generations.server.js uses
// (modelGeneration, plus modelAsset.findUnique by id and findMany),
// so its tests never touch the shared Neon database. Supports equality,
// { in }, { not }, { gte } and { lt } filters, orderBy { createdAt: 'desc' },
// and plain-value updates -- nothing more. Anything else THROWS instead of
// quietly matching the wrong rows, and NULL follows SQL: it never satisfies
// gte / lt / not.
const OPERATORS = ['in', 'not', 'gte', 'lt']
const unsupported = (what) => new Error(`fakePrisma: unsupported ${what}`)
const isPlainObject = (v) => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)
const isNil = (v) => v === null || v === undefined

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (['OR', 'AND', 'NOT'].includes(key)) throw unsupported(`where key ${key}`)
    const value = row[key]
    if (isPlainObject(cond)) {
      for (const op of Object.keys(cond)) {
        if (!OPERATORS.includes(op)) throw unsupported(`filter operator ${op} on ${key}`)
      }
      if ('in' in cond && !cond.in.includes(value)) return false
      if ('not' in cond) {
        if (isNil(value)) return false
        if (value === cond.not) return false
      }
      if ('gte' in cond && (isNil(value) || !(value >= cond.gte))) return false
      if ('lt' in cond && (isNil(value) || !(value < cond.lt))) return false
      return true
    }
    if (value instanceof Date && cond instanceof Date) return value.getTime() === cond.getTime()
    if (cond === null) return isNil(value)
    return value === cond
  })
}

function idOnly(where, method) {
  const keys = Object.keys(where ?? {})
  if (keys.length !== 1 || keys[0] !== 'id') throw unsupported(`${method} where ${JSON.stringify(keys)}; only { id } is supported`)
  return where.id
}

function checkOrderBy(orderBy) {
  if (orderBy === undefined) return
  const keys = isPlainObject(orderBy) ? Object.keys(orderBy) : []
  if (keys.length !== 1 || keys[0] !== 'createdAt' || orderBy.createdAt !== 'desc') {
    throw unsupported(`orderBy ${JSON.stringify(orderBy)}; only { createdAt: 'desc' } is supported`)
  }
}

// Prisma ignores undefined fields; operator objects ({ increment: 1 }) are not
// modelled, so refuse them. Arrays (photoRefs) and Json columns (calibration)
// are stored as-is.
const JSON_FIELDS = ['calibration']
function checkedData(data, method) {
  const out = {}
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue
    if (isPlainObject(value) && !JSON_FIELDS.includes(key)) {
      throw unsupported(`${method} data operator object on ${key}`)
    }
    out[key] = value
  }
  return out
}

const DEFAULTS = {
  retryIndex: 0,
  photoSource: 'upload',
  productId: null,
  productTitle: null,
  productHandle: null,
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
      const fields = checkedData(data, 'create')
      const row = { id: randomUUID(), ...DEFAULTS, createdAt: now, ...fields, updatedAt: fields.updatedAt ?? now }
      rows.push(row)
      return copy(row)
    },
    async findUnique({ where }) {
      const id = idOnly(where, 'findUnique')
      return copy(rows.find((row) => row.id === id))
    },
    async findFirst({ where }) {
      return copy(rows.find((row) => matches(row, where)))
    },
    async findMany({ where, orderBy, take } = {}) {
      checkOrderBy(orderBy)
      let out = rows.filter((row) => matches(row, where))
      if (orderBy) out = [...out].sort((a, b) => b.createdAt - a.createdAt)
      if (take) out = out.slice(0, take)
      return out.map(copy)
    },
    async count({ where } = {}) {
      return rows.filter((row) => matches(row, where)).length
    },
    async update({ where, data }) {
      const id = idOnly(where, 'update')
      const fields = checkedData(data, 'update')
      const row = rows.find((r) => r.id === id)
      if (!row) throw new Error(`fakePrisma: no row ${id}`)
      Object.assign(row, fields, { updatedAt: new Date() })
      return copy(row)
    },
    async updateMany({ where, data }) {
      const fields = checkedData(data, 'updateMany')
      const hit = rows.filter((row) => matches(row, where))
      for (const row of hit) Object.assign(row, fields, { updatedAt: new Date() })
      return { count: hit.length }
    },
    async delete({ where }) {
      const id = idOnly(where, 'delete')
      const index = rows.findIndex((row) => row.id === id)
      if (index < 0) throw new Error(`fakePrisma: no row ${id}`)
      return copy(rows.splice(index, 1)[0])
    },
    async deleteMany({ where }) {
      const keep = rows.filter((row) => !matches(row, where))
      const count = rows.length - keep.length
      rows.splice(0, rows.length, ...keep)
      return { count }
    },
  }
  // saveGeneration / listGenerations only look an asset up by id; tests seed
  // `assets` (id -> row) directly. Nothing else is modelled.
  const assets = new Map()
  const modelAsset = {
    assets,
    async findUnique({ where }) {
      const id = idOnly(where, 'modelAsset.findUnique')
      return copy(assets.get(id))
    },
    async findMany({ where } = {}) {
      return [...assets.values()].filter((asset) => matches(asset, where)).map(copy)
    },
  }
  const prisma = {
    modelGeneration,
    modelAsset,
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

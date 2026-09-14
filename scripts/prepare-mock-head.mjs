/**
 * One-off: compress the vendored mock head used by the admin's camera-free fit
 * preview (see app/fitPreview.server.js). Compression only -- this must NOT
 * scale, re-centre, or otherwise normalize the geometry, because the head's
 * real-world size is what makes the fit preview meaningful.
 *
 * Do not reuse scripts/compress-models.mjs for this: it is a hardcoded eyewear
 * pipeline that normalizes its input to TARGET_FRAME_WIDTH = 0.145 m, which
 * would scale the head down to the width of a pair of glasses.
 *
 * Source: D:/AR Sunglasses/test-mock-head/head.glb (3.9 MB, untracked, outside
 * this repo). Output: apps/shopify-app/public/mock-head.glb, budget < 500 KB.
 *
 * meshoptimizer is NOT installed, so `simplify` is unavailable here -- do not
 * add it. Most of the source size is texture, so textureCompress (used below)
 * downscales the texture instead of reaching for a new dependency.
 *
 * Mesh geometry is left un-Draco'd on purpose: fitPreview.server.js reads this
 * file back with a bare `new NodeIO()` (no registered extensions, per its own
 * verbatim spec), so anything requiring KHR_draco_mesh_compression -- or
 * KHR_mesh_quantization, which quantize() would add for POSITION/NORMAL -- at
 * read time would fail there with "Missing required extension". The
 * draco3dgltf wiring below is still registered (matching compress-models.mjs)
 * so this script *could* decode/encode Draco if a future consumer supported
 * it, but the `draco()` transform itself is intentionally not applied here.
 *
 * That constraint means the usual extension-based tricks (Draco, quantized
 * POSITION/NORMAL) are off the table, and dedup()+weld() alone only remove
 * bitwise-duplicate data -- this head mesh has none, so they barely move the
 * needle. The head is 23k-odd vertices of plain float32 position/normal data,
 * which alone is already >700 KB before any texture is counted. So this script
 * also grid-clusters nearby vertices (a plain-JS decimation: bucket vertices
 * into a spatial grid, replace each bucket with one averaged vertex, remap
 * triangles, drop the ones that collapse to a point) to cut vertex count. This
 * is a local simplification, not a global scale/recentre -- the head's overall
 * bounds and position are unchanged, only its density is reduced. TEXCOORD_0
 * is then quantized to a normalized UNSIGNED_BYTE, which core glTF 2.0 allows
 * without any extension (unlike POSITION/NORMAL).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { Accessor, NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, weld, textureCompress } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import sharp from 'sharp'

const SOURCE_PATH = 'D:/AR Sunglasses/test-mock-head/head.glb'
const OUTPUT_PATH = path.join('apps', 'shopify-app', 'public', 'mock-head.glb')
const BUDGET_BYTES = 500 * 1024
const TARGET_VERTEX_COUNT = 10000

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  })

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

// Grid-cluster decimation: merge vertices that fall in the same spatial cell
// into one averaged vertex, then remap the index buffer onto the survivors.
// cellSize is searched (binary search over a few iterations) so the result
// lands near targetVertexCount -- no new dependency, no extension, and the
// mesh's overall bounds/position are untouched.
function clusterVertices(primitive, cellSize) {
  const positionAcc = primitive.getAttribute('POSITION')
  const normalAcc = primitive.getAttribute('NORMAL')
  const uvAcc = primitive.getAttribute('TEXCOORD_0')
  const indicesAcc = primitive.getIndices()
  if (!positionAcc || !indicesAcc) return null

  const positions = positionAcc.getArray()
  const normals = normalAcc ? normalAcc.getArray() : null
  const uvs = uvAcc ? uvAcc.getArray() : null
  const indices = indicesAcc.getArray()
  const vertexCount = positionAcc.getCount()

  const clusterKeyOf = new Int32Array(vertexCount)
  const clusters = new Map() // key -> { count, px,py,pz, nx,ny,nz, u,v, newIndex }
  let nextIndex = 0

  for (let i = 0; i < vertexCount; i++) {
    const px = positions[i * 3], py = positions[i * 3 + 1], pz = positions[i * 3 + 2]
    const cx = Math.round(px / cellSize)
    const cy = Math.round(py / cellSize)
    const cz = Math.round(pz / cellSize)
    const key = `${cx},${cy},${cz}`

    let cluster = clusters.get(key)
    if (!cluster) {
      cluster = { count: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, u: 0, v: 0, newIndex: nextIndex++ }
      clusters.set(key, cluster)
    }
    cluster.count++
    cluster.px += px; cluster.py += py; cluster.pz += pz
    if (normals) { cluster.nx += normals[i * 3]; cluster.ny += normals[i * 3 + 1]; cluster.nz += normals[i * 3 + 2] }
    if (uvs) { cluster.u += uvs[i * 2]; cluster.v += uvs[i * 2 + 1] }
    clusterKeyOf[i] = cluster.newIndex
  }

  const newVertexCount = clusters.size
  const newPositions = new Float32Array(newVertexCount * 3)
  const newNormals = normals ? new Float32Array(newVertexCount * 3) : null
  const newUvs = uvs ? new Float32Array(newVertexCount * 2) : null

  for (const cluster of clusters.values()) {
    const i = cluster.newIndex
    newPositions[i * 3] = cluster.px / cluster.count
    newPositions[i * 3 + 1] = cluster.py / cluster.count
    newPositions[i * 3 + 2] = cluster.pz / cluster.count
    if (newNormals) {
      let nx = cluster.nx / cluster.count, ny = cluster.ny / cluster.count, nz = cluster.nz / cluster.count
      const len = Math.hypot(nx, ny, nz) || 1
      newNormals[i * 3] = nx / len
      newNormals[i * 3 + 1] = ny / len
      newNormals[i * 3 + 2] = nz / len
    }
    if (newUvs) {
      newUvs[i * 2] = cluster.u / cluster.count
      newUvs[i * 2 + 1] = cluster.v / cluster.count
    }
  }

  // Remap triangles onto the clustered vertices, dropping any that collapsed
  // to a line or a point (two or more corners landed in the same cell).
  const newIndices = []
  for (let t = 0; t < indices.length; t += 3) {
    const a = clusterKeyOf[indices[t]]
    const b = clusterKeyOf[indices[t + 1]]
    const c = clusterKeyOf[indices[t + 2]]
    if (a === b || b === c || a === c) continue
    newIndices.push(a, b, c)
  }
  const IndexArray = newVertexCount > 65535 ? Uint32Array : Uint16Array

  return {
    vertexCount: newVertexCount,
    apply() {
      positionAcc.setArray(newPositions)
      if (normalAcc && newNormals) normalAcc.setArray(newNormals)
      if (uvAcc && newUvs) uvAcc.setArray(newUvs)
      indicesAcc.setArray(new IndexArray(newIndices))
    },
  }
}

// Binary-search the cell size so the decimated head lands near
// TARGET_VERTEX_COUNT, then apply it to every primitive in the document.
function decimate(document, targetVertexCount) {
  const root = document.getRoot()
  const primitives = root.listMeshes().flatMap((m) => m.listPrimitives())
  for (const primitive of primitives) {
    const positionAcc = primitive.getAttribute('POSITION')
    if (!positionAcc) continue

    let lo = 0.0002, hi = 0.02 // metres; head is roughly 0.2m across
    let best = null
    for (let iter = 0; iter < 16; iter++) {
      const mid = (lo + hi) / 2
      const result = clusterVertices(primitive, mid)
      if (!result) break
      if (result.vertexCount > targetVertexCount) {
        lo = mid
      } else {
        hi = mid
        best = result
      }
    }
    // Fall back to the last (finest passing) result, or the loosest attempt.
    const chosen = best ?? clusterVertices(primitive, hi)
    if (chosen) chosen.apply()
  }
}

// Quantize TEXCOORD_0 to a normalized UNSIGNED_BYTE. This is plain glTF 2.0
// core spec (unlike POSITION/NORMAL, TEXCOORD_n may be a normalized ubyte or
// ushort) -- no KHR_mesh_quantization extension needed, so it stays readable
// by fitPreview.server.js's bare NodeIO.
function quantizeTexcoord(document) {
  const root = document.getRoot()
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const uvAcc = primitive.getAttribute('TEXCOORD_0')
      if (!uvAcc) continue
      const src = uvAcc.getArray()
      const quantized = new Uint8Array(src.length)
      for (let i = 0; i < src.length; i++) {
        quantized[i] = Math.round(Math.min(1, Math.max(0, src[i])) * 255)
      }
      uvAcc.setArray(quantized)
      uvAcc.setType(Accessor.Type.VEC2)
      uvAcc.setNormalized(true)
    }
  }
}

const before = (await fs.stat(SOURCE_PATH)).size
const document = await io.read(SOURCE_PATH)

// Geometry-only compression. No scale/translation touches -- the head keeps
// its real-world dimensions so the fit preview stays meaningful.
await document.transform(dedup(), weld())

decimate(document, TARGET_VERTEX_COUNT)
quantizeTexcoord(document)
await document.transform(dedup())

await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true })
await io.write(OUTPUT_PATH, document)

let after = (await fs.stat(OUTPUT_PATH)).size
console.log(JSON.stringify({ step: 'dedup+weld+decimate+quantizeUV', before: formatBytes(before), after: formatBytes(after) }))

// Most of what's left is texture -- downscale it rather than add a new
// dependency. Stay on jpeg (no format conversion): fitPreview.server.js reads
// this with a bare NodeIO that has no extensions registered, and a webp
// texture would need EXT_texture_webp.
if (after > BUDGET_BYTES) {
  await document.transform(textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: [512, 512], quality: 70 }))
  await io.write(OUTPUT_PATH, document)
  after = (await fs.stat(OUTPUT_PATH)).size
  console.log(JSON.stringify({ step: '+textureCompress', after: formatBytes(after) }))
}

console.log(JSON.stringify({
  source: SOURCE_PATH,
  output: OUTPUT_PATH,
  before: formatBytes(before),
  after: formatBytes(after),
  withinBudget: after <= BUDGET_BYTES,
}))

if (after > BUDGET_BYTES) {
  console.error(`mock-head.glb is ${formatBytes(after)}, over the ${formatBytes(BUDGET_BYTES)} budget.`)
  process.exitCode = 1
}

/**
 * Asserts the two properties the raw-passthrough change exists to guarantee:
 * the bytes we would persist are the bytes we were given, and nothing in the
 * mesh data moved.
 *
 * Worth keeping rather than deleting after the change lands. The bug it guards
 * against was silent -- bakeNodeTransforms rewrote POSITION and left NORMAL
 * stale, so models rendered with inverted shading while every count (triangles,
 * vertices, materials, textures) stayed identical and every test passed. Only a
 * direct comparison against the source bytes catches a regression like that.
 *
 * Usage:
 *   node scripts/verify-raw-passthrough.mjs public/models/_m-willow.glb ...
 */
import fs from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { calibrateUpload } from '../apps/shopify-app/app/calibration.server.js'

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)

/** Every NORMAL accessor in the document, as comparable strings. */
function normalsOf(doc) {
  return doc
    .getRoot()
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .map((p) => p.getAttribute('NORMAL'))
    .filter(Boolean)
    .map((a) => Buffer.from(Float32Array.from(a.getArray()).buffer).toString('base64'))
}

const files = process.argv.slice(2)
if (!files.length) {
  console.error('usage: node scripts/verify-raw-passthrough.mjs <file.glb>...')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  const raw = fs.readFileSync(file)
  const res = await calibrateUpload(raw)

  const identical = Buffer.from(res.storedGlb).equals(raw)
  const src = await io.readBinary(raw)
  const out = await io.readBinary(Buffer.from(res.storedGlb))
  const normalsSame = JSON.stringify(normalsOf(src)) === JSON.stringify(normalsOf(out))

  const m = res.fitMetadata
  const ok = identical && normalsSame
  if (!ok) failed += 1
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${file}\n` +
      `   bytes identical=${identical}  normals identical=${normalsSame}\n` +
      `   modelScale=${m.modelScale}  frameWidth=${(m.frameWidthMeters * 1000).toFixed(1)}mm  ` +
      `source=${m.provenance.source}  needsManual=${res.needsManual}`,
  )
}

process.exit(failed ? 1 : 0)

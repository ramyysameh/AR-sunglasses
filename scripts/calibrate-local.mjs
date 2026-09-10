// Runs the REAL upload pipeline (validate -> normalize -> calibrate) on a local
// GLB and writes what the app would have stored, so the engine can load it from
// the vite dev server with no Shopify app, no database and no deploy.
//
//   node scripts/calibrate-local.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb"
//
// For each input it writes into public/calibrated/:
//   <name>.glb        the normalized GLB (what saveCalibratedModel would store)
//   <name>-auto.json  fit metadata from the geometric estimator (tags stripped)
//   <name>-hand.json  fit metadata from the model's own AR_* tags, when present
//
// Then, with `npm run dev` running, compare them on your own face:
//   http://localhost:5173/?fit=/calibrated/<name>-auto.json
//   http://localhost:5173/?fit=/calibrated/<name>-hand.json
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import {
  validateModel, normalizeModel, calibrate, readTags, MODELING_SPEC,
} from '@artryon/calibration'

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
const OUT_DIR = path.join(process.cwd(), 'public', 'calibrated')

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/calibrate-local.mjs <model.glb> [...]')
  process.exit(2)
}

// Removes the AR_* anchor nodes so calibrate() takes the geometric path. Done
// on a separately-read copy so the tagged variant is unaffected.
function stripTags(doc) {
  for (const node of doc.getRoot().listNodes()) {
    if (Object.values(MODELING_SPEC.tagNames).includes(node.getName())) {
      node.dispose()
    }
  }
}

await mkdir(OUT_DIR, { recursive: true })

for (const file of files) {
  const name = path.basename(file, path.extname(file)).replace(/[^a-zA-Z0-9_-]/g, '_')
  const modelUrl = `/calibrated/${name}.glb`

  // --- auto: what a merchant upload produces today, with no tags to lean on
  const autoDoc = await io.read(file)
  const validation = validateModel(autoDoc, MODELING_SPEC)
  if (validation.status === 'fail') {
    console.error(`${name}: REJECTED -- ${validation.issues.map((i) => i.message).join('; ')}`)
    continue
  }
  stripTags(autoDoc)
  normalizeModel(autoDoc, MODELING_SPEC)
  const auto = calibrate(autoDoc, MODELING_SPEC)

  // The normalized GLB is written once, from the auto pass. Normalization is
  // identical either way -- it does not read tags, only moves them.
  await writeFile(path.join(OUT_DIR, `${name}.glb`), Buffer.from(await io.writeBinary(autoDoc)))
  await writeFile(
    path.join(OUT_DIR, `${name}-auto.json`),
    JSON.stringify({ modelUrl, fitMetadata: auto.fitMetadata }, null, 2),
  )

  const conf = auto.confidence ? auto.confidence.overall.toFixed(3) : 'n/a'
  console.log(`${name}: validation=${validation.status} auto source=${auto.source} ` +
    `confidence=${conf} needsManual=${auto.needsManual}`)
  console.log(`  -> ${modelUrl}`)
  console.log(`  -> /calibrated/${name}-auto.json`)

  // --- hand: the model's own AR_* tags, for an A/B against the estimator
  const handDoc = await io.read(file)
  normalizeModel(handDoc, MODELING_SPEC)
  if (!readTags(handDoc, MODELING_SPEC).found) {
    console.log('  (no AR_* tags -- no hand variant to compare against)')
    continue
  }
  const hand = calibrate(handDoc, MODELING_SPEC)
  await writeFile(
    path.join(OUT_DIR, `${name}-hand.json`),
    JSON.stringify({ modelUrl, fitMetadata: hand.fitMetadata }, null, 2),
  )
  console.log(`  -> /calibrated/${name}-hand.json  (source=${hand.source})`)
}

console.log('\nStart the engine with `npm run dev`, then open:')
console.log('  http://localhost:5173/?fit=/calibrated/<name>-auto.json')
console.log('  http://localhost:5173/?fit=/calibrated/<name>-hand.json')

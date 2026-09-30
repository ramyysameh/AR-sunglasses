// Quality gate for AI model generation (plan Task 1). Sends 3-4 local photos
// through the real modelGenerator and writes the GLB for an on-face check.
//
//   cd apps/shopify-app
//   node --env-file=.env scripts/ai-generate-spike.mjs front.jpg left.jpg right.jpg [back.jpg]
//
// Needs OPENAI_API_KEY in apps/shopify-app/.env. Photos are sent inline as
// data URLs, so no S3 or database is involved.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { startGeneration, checkGeneration } from '../app/modelGenerator.server.js'

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

const files = process.argv.slice(2)
if (files.length < 3 || files.length > 4) {
  console.error('usage: node --env-file=.env scripts/ai-generate-spike.mjs front left right [back]')
  process.exit(2)
}

const images = await Promise.all(files.map(async (file) => {
  const mime = MIME[path.extname(file).toLowerCase()]
  if (!mime) throw new Error(`unsupported photo type: ${file}`)
  return `data:${mime};base64,${(await readFile(file)).toString('base64')}`
}))

const started = Date.now()
const { providerJobId } = await startGeneration({ images })
console.log(`started ${providerJobId}`)

let result
do {
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  result = await checkGeneration(providerJobId)
  console.log(`${Math.round((Date.now() - started) / 1000)}s: ${result.state}`)
} while (result.state === 'running')

if (result.state === 'failed') {
  console.error(`generation failed: ${result.error}`)
  process.exit(1)
}

// public/calibrated/ at the repo root is gitignored (scripts/calibrate-local.mjs output).
const outDir = path.resolve('../../public/calibrated/raw')
await mkdir(outDir, { recursive: true })
const out = path.join(outDir, `ai-spike-${Date.now()}.glb`)
await writeFile(out, result.glbBytes)
console.log(`wrote ${out} (${result.glbBytes.length} bytes)`)
console.log(`token usage: ${JSON.stringify(result.usage)}`)
console.log('next, from the repo root:')
console.log(`  node scripts/calibrate-local.mjs "${out}"`)

// Measures the geometric estimator against a GLB's own hand-placed AR_* tags.
// The reference models are too large to commit, so this is a local tool, not a
// CI test. It is how the estimator's constants are fitted and verified.
//
//   node scripts/anchor-audit.mjs "D:/Downloads/Larsson_Sunglasses_AR.glb"
//
// Exits non-zero if any anchor is further than TOLERANCE_MM from its tag.
import { NodeIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import {
  validateModel, normalizeModel, readTags, estimateAnchors, scoreConfidence,
  mergedPositions, computeBounds, measureFrontWidth, MODELING_SPEC,
} from '@artryon/calibration'

const TOLERANCE_MM = 3
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS)
const mm = (v) => (v * 1000).toFixed(1)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/anchor-audit.mjs <model.glb> [...]')
  process.exit(2)
}

let worst = 0

for (const file of files) {
  const doc = await io.read(file)
  const validation = validateModel(doc, MODELING_SPEC)
  const { transforms } = normalizeModel(doc, MODELING_SPEC)
  const positions = mergedPositions(doc)
  const bounds = computeBounds(positions)
  const tags = readTags(doc, MODELING_SPEC)
  const { anchors, signals, anchorSources } = estimateAnchors(doc, MODELING_SPEC)
  const confidence = scoreConfidence(signals, MODELING_SPEC)

  console.log(`\n=== ${file}`)
  console.log(`validation=${validation.status} transforms=[${transforms.join(', ')}]`)
  console.log(`frameWidth=${mm(measureFrontWidth(positions))}mm ` +
    `zRange=${mm(bounds.max.z - bounds.min.z)}mm`)
  console.log(`confidence=${confidence.overall.toFixed(3)} ` +
    Object.entries(confidence.breakdown).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '))

  if (!tags.found) {
    console.log('no AR_* tags -- nothing to compare against')
    continue
  }

  for (const key of ['bridge', 'leftHinge', 'rightHinge']) {
    const hand = tags.anchors[key]
    const auto = anchors[key]
    const delta = dist(hand, auto)
    worst = Math.max(worst, delta)
    const source = anchorSources ? ` [${anchorSources[key]}]` : ''
    const flag = delta > TOLERANCE_MM ? ' <-- OVER' : ''
    console.log(
      `  ${key.padEnd(11)} hand(${mm(hand.x)}, ${mm(hand.y)}, ${mm(hand.z)}) ` +
      `auto(${mm(auto.x)}, ${mm(auto.y)}, ${mm(auto.z)}) ` +
      `delta=${delta.toFixed(1)}mm${source}${flag}`
    )
  }
}

console.log(`\nworst delta: ${worst.toFixed(1)}mm (tolerance ${TOLERANCE_MM}mm)`)
process.exit(worst > TOLERANCE_MM ? 1 : 0)

/**
 * Re-measures the anchors of stored models calibrated before the nested-anchor fix.
 *
 * WHY. Create with AI emits GLBs whose meshes AND AR_* tags sit under one non-mesh
 * root node. Calibration used to read those tags in the raw frame while measuring
 * modelBoundsCenter after the normalizer's recenter, so bridgeAnchor -
 * modelBoundsCenter (what the engine places the frame by) came out too large by
 * the frame-top height -- 21 mm on a measured round frame, drawn that much low on
 * every face. See packages/calibration/src/normalizer.js liftAnchorTags.
 *
 * WHAT IT CHANGES. Only the tag-derived fields: bridgeAnchor, leftHinge,
 * rightHinge and lensCenterOffset (derived from the bridge). Everything else in
 * fitMetadata (scaleLimits, modelBoundsCenter, frameWidthMeters, ...) is left as
 * calibrated, and so are the merchant's sizeMultiplier and fit review. Stored GLBs
 * are the merchants' original bytes (raw passthrough), so re-measuring them is
 * exact. Rows whose anchors move by less than 0.5 mm are left alone.
 *
 * Usage:
 *   node scripts/recalibrate-nested-anchors.mjs           # dry run, changes nothing
 *   node scripts/recalibrate-nested-anchors.mjs --apply   # write the corrected anchors
 *   node scripts/recalibrate-nested-anchors.mjs --shop x.myshopify.com
 */
import { PrismaClient } from '@prisma/client'
import { readModelGlb } from '../app/storage.server.js'
import { calibrateUpload } from '../app/calibration.server.js'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const shopArg = args[args.indexOf('--shop') + 1]
const SHOP = args.includes('--shop') && shopArg && !shopArg.startsWith('--') ? shopArg : null
const THRESHOLD_M = 0.0005
const ANCHOR_FIELDS = ['bridgeAnchor', 'leftHinge', 'rightHinge', 'lensCenterOffset']

const mm = (v) => (v * 1000).toFixed(1)
const moved = (a, b) => Math.max(...['x', 'y', 'z'].map((k) => Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0))))

const prisma = new PrismaClient()
try {
  const assets = await prisma.modelAsset.findMany({
    where: { status: 'ready', ...(SHOP ? { shop: SHOP } : {}) },
    include: { _count: { select: { mappings: true } } },
    orderBy: { createdAt: 'asc' },
  })
  // Only tag-sourced, current rows can carry this bug: geometric rows derive their
  // anchors from the same shifted vertices as the bounds.
  const candidates = assets.filter((a) => a.fitMetadata?.provenance?.source === 'tagged' && a.fitMetadata?.modelBoundsCenter)
  console.log(`\nModelAsset rows${SHOP ? ` for ${SHOP}` : ''}: ${assets.length}, tag-sourced: ${candidates.length}`)

  const fixes = []
  let unchanged = 0
  let failed = 0
  for (const a of candidates) {
    try {
      const bytes = await readModelGlb(a.storageRef)
      const { fitMetadata: fresh } = await calibrateUpload(bytes)
      const delta = Math.max(...ANCHOR_FIELDS.map((f) => moved(a.fitMetadata[f], fresh[f])))
      if (delta < THRESHOLD_M) { unchanged++; continue }
      fixes.push({ a, fresh, delta })
      console.log(`  fix   ${a.id}  ${a.shop}  ${a.label ?? a.filename ?? ''}  bridge y ${mm(a.fitMetadata.bridgeAnchor.y)} -> ${mm(fresh.bridgeAnchor.y)} mm (moves ${mm(delta)} mm)${a._count.mappings ? `, on ${a._count.mappings} product(s)` : ''}`)
    } catch (err) {
      failed++
      console.log(`  ERROR ${a.id}  ${a.shop}  ${err.message}`)
    }
  }
  console.log(`\n  needs fixing : ${fixes.length}\n  already fine : ${unchanged}\n  errors       : ${failed}`)

  if (!APPLY) {
    console.log(`\nDry run. Nothing changed. Re-run with --apply to update ${fixes.length} row(s).`)
  } else {
    for (const { a, fresh } of fixes) {
      const patch = Object.fromEntries(ANCHOR_FIELDS.map((f) => [f, fresh[f]]))
      await prisma.modelAsset.update({ where: { id: a.id }, data: { fitMetadata: { ...a.fitMetadata, ...patch } } })
    }
    console.log(`\nUpdated ${fixes.length} row(s).`)
  }
} finally {
  await prisma.$disconnect()
}

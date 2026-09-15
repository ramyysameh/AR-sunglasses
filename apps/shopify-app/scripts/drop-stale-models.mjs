/**
 * Drops ModelAsset rows written by the pre-raw-passthrough calibration pipeline,
 * so they are rebuilt on next use.
 *
 * WHY those rows need dropping. Each one points at a stored GLB the old pipeline
 * REWROTE: bakeNodeTransforms moved POSITION without transforming NORMAL, so any
 * model with a rotated mesh node has its shading inverted in the bytes we serve
 * (measured: 102.7 deg mean normal error over 22 nodes on one merchant file,
 * 98.9% of normals left facing inward on another). The fit metadata is stale too
 * -- scaleLimits from before the clamp was widened, and no modelScale or
 * modelBoundsCenter, so those models take every legacy branch in the engine.
 * Nothing re-derives any of it: registration dedupes on (shop, sourceUrl) and
 * returns the stored row forever.
 *
 * WHAT IS SAFE TO DROP, and what is not:
 *
 *   - sourceUrl set, not mapped  -> DROP. The storefront re-registers from the
 *     merchant's Shopify CDN URL on next view and recalibrates from the original.
 *
 *   - no sourceUrl               -> KEEP, always. These came from an admin
 *     upload, and the pre-bake original was never kept -- we deleted the temp
 *     object after calibrating. Dropping one destroys the only copy and breaks
 *     the merchant's product with no way back. Only a re-upload fixes these.
 *
 *   - mapped to a product        -> KEEP. ProductMapping.modelAsset has no
 *     onDelete rule, so Prisma's default RESTRICT makes the delete throw anyway,
 *     but the real reason is that unmapping silently changes what a merchant's
 *     product shows.
 *
 * Object storage is emptied BEFORE the row, the same order purgeShopData uses
 * and for the same reason: a storage failure then aborts with the row intact, so
 * a retry can still find the object it needs to remove.
 *
 * Usage:
 *   node scripts/drop-stale-models.mjs           # dry run, changes nothing
 *   node scripts/drop-stale-models.mjs --apply   # actually drop
 *   node scripts/drop-stale-models.mjs --shop x.myshopify.com
 */
import { PrismaClient } from '@prisma/client'
import { deleteModelGlb } from '../app/storage.server.js'

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const shopArg = args[args.indexOf('--shop') + 1]
const SHOP = args.includes('--shop') && shopArg && !shopArg.startsWith('--') ? shopArg : null

/** A row is current if calibration stamped it with the fields added alongside raw passthrough. */
function isCurrent(fitMetadata) {
  return Boolean(fitMetadata) && fitMetadata.modelScale !== undefined && fitMetadata.modelBoundsCenter !== undefined
}

const prisma = new PrismaClient()

try {
  const assets = await prisma.modelAsset.findMany({
    where: SHOP ? { shop: SHOP } : {},
    include: { _count: { select: { mappings: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const stale = assets.filter((a) => !isCurrent(a.fitMetadata))
  const droppable = stale.filter((a) => a.sourceUrl && a._count.mappings === 0)
  const mapped = stale.filter((a) => a.sourceUrl && a._count.mappings > 0)
  const orphaned = stale.filter((a) => !a.sourceUrl)

  console.log(`\nModelAsset rows${SHOP ? ` for ${SHOP}` : ''}: ${assets.length}`)
  console.log(`  already current : ${assets.length - stale.length}`)
  console.log(`  stale           : ${stale.length}`)
  console.log(`     droppable (re-registers from sourceUrl) : ${droppable.length}`)
  console.log(`     mapped to a product, left alone         : ${mapped.length}`)
  console.log(`     admin upload, ORIGINAL GONE, kept       : ${orphaned.length}`)

  for (const a of droppable) console.log(`  drop  ${a.id}  ${a.shop}  ${a.filename ?? '(no filename)'}`)
  for (const a of mapped) console.log(`  KEEP  ${a.id}  ${a.shop}  mapped to ${a._count.mappings} product(s)`)
  for (const a of orphaned) {
    console.log(`  KEEP  ${a.id}  ${a.shop}  ${a.filename ?? '(no filename)'} -- no sourceUrl, needs re-upload by the merchant`)
  }

  if (!APPLY) {
    console.log(`\nDry run. Nothing changed. Re-run with --apply to drop ${droppable.length} row(s).`)
  } else {
    let done = 0
    for (const a of droppable) {
      await deleteModelGlb(a.storageRef)
      await prisma.modelAsset.delete({ where: { id: a.id } })
      done += 1
    }
    console.log(`\nDropped ${done} row(s) and their stored objects.`)
    if (orphaned.length) {
      console.log(
        `${orphaned.length} admin-uploaded model(s) still carry the old bake. ` +
          `Those cannot be rebuilt here -- the merchant has to re-upload the GLB.`,
      )
    }
  }
} finally {
  await prisma.$disconnect()
}

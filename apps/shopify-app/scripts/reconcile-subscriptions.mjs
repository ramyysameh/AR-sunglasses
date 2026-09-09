/* global process */
// Safety net for a missed app_subscriptions/update webhook. Re-reads each
// shop's real subscription from Shopify and corrects the local row.
//
//   node scripts/reconcile-subscriptions.mjs            # dry run (default)
//   node scripts/reconcile-subscriptions.mjs --apply    # write the corrections
//   node scripts/reconcile-subscriptions.mjs --apply --shop foo.myshopify.com
//
// Dry run is the default deliberately: correcting a stale ACTIVE row REVOKES
// storefront access for that shop, so you want to see the list first.
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { reconcileAll } from '../app/reconcileSubscriptions.server.js'

for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
}

const apply = process.argv.includes('--apply')
const shopFlag = process.argv.indexOf('--shop')
const shops = shopFlag > -1 ? [process.argv[shopFlag + 1]] : null
const API_VERSION = '2025-10' // must match ApiVersion in app/shopify.server.js

const prisma = new PrismaClient()

// In dry-run, hand reconcileAll a prisma whose writes are no-ops so the same
// code path runs and reports what it WOULD do.
const proxy = apply
  ? prisma
  : {
      session: prisma.session,
      shopSubscription: {
        findUnique: prisma.shopSubscription.findUnique.bind(prisma.shopSubscription),
        upsert: async ({ where: { shop }, update, create }) => {
          const cur = await prisma.shopSubscription.findUnique({ where: { shop } })
          return cur ? { ...cur, ...update } : { ...create }
        },
      },
    }

const results = await reconcileAll(proxy, { apiVersion: API_VERSION, shops })

console.log(apply ? '=== APPLIED ===' : '=== DRY RUN (no writes) ===')
for (const r of results.sort((a, b) => a.action.localeCompare(b.action))) {
  const detail = r.error ? r.error : `${r.before ?? '(none)'} -> ${r.after ?? '(none)'}`
  console.log(`${r.action.padEnd(10)} ${r.shop.padEnd(38)} ${detail}`)
}
const changed = results.filter((r) => r.action === 'corrected').length
console.log(`\n${changed} row(s) ${apply ? 'corrected' : 'would be corrected'}, ${results.length} shop(s) checked`)
if (!apply && changed) console.log('Re-run with --apply to write these corrections.')

await prisma.$disconnect()

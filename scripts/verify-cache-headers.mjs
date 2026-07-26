// Verifies the Phase 4 Slice 1 cache tiers against a live deployment.
//
//   node scripts/verify-cache-headers.mjs [baseUrl] [merchantAssetId]
//
// Checks two independent things per path:
//   1. Cache-Control matches the tier the spec assigns it.
//   2. A second fetch is served from Vercel's edge (x-vercel-cache: HIT, or
//      an age above zero). This is the part that actually proves caching --
//      a correct header on a never-cached response would pass check 1 alone.

const baseUrl = (process.argv[2] ?? 'https://ar-sunglasses-shopify-app.vercel.app').replace(/\/$/, '')
const merchantAssetId = process.argv[3] ?? null

const IMMUTABLE = 'public, max-age=31536000, immutable'
const BOUNDED = 'public, max-age=86400, stale-while-revalidate=604800'
const REVALIDATE = 'public, max-age=0, must-revalidate'

// Discover a hashed bundle from index.html rather than hardcoding a filename
// that changes on every engine rebuild.
async function findHashedAsset() {
  const res = await fetch(`${baseUrl}/tryon/index.html`)
  const html = await res.text()
  const match = html.match(/\/tryon\/assets\/[A-Za-z0-9._-]+\.js/)
  if (!match) throw new Error('no hashed asset found in /tryon/index.html')
  return match[0]
}

async function check({ path, expected, expectEdgeHit }) {
  const url = `${baseUrl}${path}`
  const first = await fetch(url)
  const actual = first.headers.get('cache-control')

  const failures = []
  if (first.status !== 200) failures.push(`status ${first.status}, expected 200`)
  if (actual !== expected) failures.push(`cache-control "${actual}", expected "${expected}"`)

  if (expectEdgeHit) {
    const second = await fetch(url)
    const cacheState = second.headers.get('x-vercel-cache')
    const age = Number(second.headers.get('age') ?? '0')
    if (cacheState !== 'HIT' && !(age > 0)) {
      failures.push(`not served from the edge on refetch (x-vercel-cache: ${cacheState}, age: ${age})`)
    }
  }

  const label = failures.length === 0 ? 'PASS' : 'FAIL'
  console.log(`${label}  ${path}`)
  for (const failure of failures) console.log(`      - ${failure}`)
  return failures.length === 0
}

const hashedAsset = await findHashedAsset()

const targets = [
  { path: hashedAsset, expected: IMMUTABLE, expectEdgeHit: true },
  { path: '/tryon/models/sunglasses-draco.glb', expected: BOUNDED, expectEdgeHit: true },
  { path: '/tryon/draco/gltf/draco_decoder.wasm', expected: BOUNDED, expectEdgeHit: true },
  { path: '/tryon/index.html', expected: REVALIDATE, expectEdgeHit: false },
]

if (merchantAssetId) {
  targets.push({
    path: `/models/${merchantAssetId}.glb`,
    expected: 'public, max-age=31536000, s-maxage=31536000, immutable',
    expectEdgeHit: true,
  })
} else {
  console.log('NOTE  no merchant assetId given; skipping /models/:id.glb')
  console.log('      pass one as the 2nd argument to cover the highest-value header')
}

const results = []
for (const target of targets) results.push(await check(target))

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)

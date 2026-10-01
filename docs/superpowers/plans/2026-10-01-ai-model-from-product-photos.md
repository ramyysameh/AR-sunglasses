# Generate AI Models from Product Photos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Create with AI" can start from a store product: the merchant picks a product, ticks 3–4 of its photos, and the server imports those photos and runs the existing generation pipeline; saving such a model also adds it to that product's try-on.

**Architecture:** A new `productPhotos.server.js` reads a product's images through the Admin API, downloads the ticked ones from Shopify's CDN and stores them under the same shop-scoped S3 photo keys uploads use, so everything downstream is unchanged. `ModelGeneration` remembers the photo source and product; the generator words its request differently for product photos; a new `aiProductMapping.server.js` maps the saved model onto the product. The admin UI gains a source switch.

**Tech Stack:** React Router 7, Prisma 6 (Postgres), Shopify Admin GraphQL (2025-10), App Bridge `resourcePicker`, AWS S3, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-30-ai-model-generation-design.md` — read the section "Addendum (2026-10-01): generate from a product's photos".

## Global Constraints

- Worktree `D:\AR Sunglasses\wt-ai-model-gen`, branch `feature/ai-model-generation` (base for this plan: `3d39f2f`). Never work in `D:\AR Sunglasses\ar-tryon-prototype`. Run `git branch --show-current` before every commit; STOP if it isn't `feature/ai-model-generation`.
- App code lives in `apps/shopify-app/`; run `npx vitest` from there.
- **Never run the full suite (`npm test`) or any DB-backed test; never run `prisma migrate dev|deploy` or `db push`.** Dev and production share one Neon database. New tests are DB-free.
- Photo sources: `'upload'` (default) and `'product'`. A generation needs 3–4 photos. Photo keys: `generation-photos/<shop lower-cased>/<uuid>.<jpg|png|webp>`.
- Product images: only `https://cdn.shopify.com` URLs, content type `image/jpeg|image/png|image/webp`, ≤ `MAX_PHOTO_BYTES` (10 MB), 15 s timeout per download. Product GIDs match `^gid://shopify/Product/\d+$`.
- Auto-map never undoes a save. Outcomes: `{ mapped: true }` or `{ mapped: false, reason: 'product_limit' | 'map_failed' | 'publish_failed' }`.
- Merchant copy never forwards internal error text; failures say what to do.
- React 18 + Polaris web components: no `onChange` on `s-*` elements (use `onInput`/`onClick`, or `addEventListener` via a ref).
- Commit messages end with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## File Structure

| File | Change |
|---|---|
| `app/modelGenerator.server.js` | `buildGenerationRequest`/`startGeneration` take `source` |
| `app/storage.server.js` | + `newPhotoRef`, `savePhoto`; `presignPhotoUpload` reuses `newPhotoRef` |
| `app/productPhotos.server.js` (new) | `PRODUCT_IMAGES_QUERY`, `fetchProductImages`, `importProductPhotos` |
| `prisma/schema.prisma` + migration `20261001000000_generation_product_source` | `photoSource`, `productId`, `productTitle`, `productHandle` |
| `app/generations.server.js` | store/inherit source + product, pass source to generator, expose in client shape, `saveGeneration` returns product |
| `app/aiProductMapping.server.js` (new) | `addGeneratedModelToProduct` |
| `app/routes/api.generations.jsx` | intents `product-images`, `create-from-product`; `save` auto-maps |
| `app/components/AiModelFlow.jsx` | source switch, product picker, image ticking |

---

### Task 1: Generator wording by photo source

**Files:** Modify `apps/shopify-app/app/modelGenerator.server.js`; Test `apps/shopify-app/test/modelGenerator.server.test.js` (append).

**Interfaces — Produces:** `buildGenerationRequest({ images, feedback = null, source = 'upload' })`, `startGeneration({ images, feedback = null, source = 'upload' })`. `PRODUCT_PHOTOS_TEXT` wording is internal.

- [ ] **Step 1: Append failing tests**

```js
describe('buildGenerationRequest by source', () => {
  it('keeps the labelled front/left/right wording for uploads', () => {
    const text = buildGenerationRequest({ images: ['a', 'b', 'c'] }).input[0].content[0].text
    expect(text).toMatch(/front, left side, right side/)
  })

  it('describes product photos as unordered angles and says to model only the glasses', () => {
    const text = buildGenerationRequest({ images: ['a', 'b', 'c', 'd'], source: 'product' }).input[0].content[0].text
    expect(text).not.toMatch(/left side, right side/)
    expect(text).toMatch(/4 product photos/)
    expect(text).toMatch(/different angles/)
    expect(text).toMatch(/only the glasses/)
  })

  it('passes the source through startGeneration', async () => {
    const client = fakeClient()
    setGeneratorClient(client)
    await startGeneration({ images: ['a', 'b', 'c'], source: 'product' })
    expect(client.calls.created[0].input[0].content[0].text).toMatch(/product photos/)
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run test/modelGenerator.server.test.js`.

- [ ] **Step 3: Implement.** Replace the first content item in `buildGenerationRequest` and thread `source`:

```js
function introText(images, source) {
  if (source === 'product') {
    return `These ${images.length} product photos show one pair of glasses from different angles, in no particular order. Some may show the glasses worn by a person or on a background: model only the glasses. Build its 3D model.`
  }
  return `These ${images.length} photos show one pair of glasses: front, left side, right side${images.length > 3 ? ', back' : ''}. Build its 3D model.`
}

export function buildGenerationRequest({ images, feedback = null, source = 'upload' }) {
  const content = [
    { type: 'input_text', text: introText(images, source) },
    ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'high' })),
  ]
  // ...rest unchanged
}

export async function startGeneration({ images, feedback = null, source = 'upload' }) {
  const response = await getClient().responses.create(buildGenerationRequest({ images, feedback, source }))
  return { providerJobId: response.id }
}
```

- [ ] **Step 4: Run, expect PASS** (all tests in the file).
- [ ] **Step 5: Commit** — `feat(ai-models): word the generation request for product photos`.

---

### Task 2: Import a product's photos into storage

**Files:** Modify `apps/shopify-app/app/storage.server.js`; Create `apps/shopify-app/app/productPhotos.server.js`; Tests `apps/shopify-app/test/storagePhotos.server.test.js` (append), `apps/shopify-app/test/productPhotos.server.test.js` (new).

**Interfaces — Produces:**
- `newPhotoRef(shop, contentType) → string` (throws `BAD_PHOTO` for an invalid shop or type) — used by `presignPhotoUpload` too.
- `savePhoto(storageRef, bytes, contentType) → Promise<void>`
- `PRODUCT_IMAGES_QUERY`, `fetchProductImages(admin, productId) → { productId, title, handle, images: [{ id, url, thumbnailUrl, altText }] }` (throws `NOT_FOUND`)
- `importProductPhotos({ admin, shop, productId, imageIds, fetchImpl = fetch }) → { photoRefs, productId, title, handle }` (throws `BAD_PHOTOS` for a wrong count/duplicates/foreign ids, `BAD_PHOTO` for a bad download, `NOT_FOUND`); on any failure deletes photos it already stored.

- [ ] **Step 1: Storage tests (append to `test/storagePhotos.server.test.js`).** The file already mocks `getSignedUrl`; add a mock of `S3Client.prototype.send` capture for `savePhoto`:

```js
describe('newPhotoRef', () => {
  it('builds a shop-scoped key with the type extension, and refuses bad shops and types', async () => {
    const { newPhotoRef } = await import('../app/storage.server.js')
    expect(newPhotoRef('Gen-Test.myshopify.com', 'image/png')).toMatch(/^generation-photos\/gen-test\.myshopify\.com\/[0-9a-f-]+\.png$/)
    expect(() => newPhotoRef('evil/../x', 'image/png')).toThrow(expect.objectContaining({ code: 'BAD_PHOTO' }))
    expect(() => newPhotoRef('gen-test.myshopify.com', 'image/gif')).toThrow(expect.objectContaining({ code: 'BAD_PHOTO' }))
    expect(() => newPhotoRef('gen-test.myshopify.com', 'constructor')).toThrow(expect.objectContaining({ code: 'BAD_PHOTO' }))
  })
})

describe('savePhoto', () => {
  it('puts the bytes with their content type', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3')
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({})
    try {
      const { savePhoto } = await import('../app/storage.server.js')
      await savePhoto('generation-photos/a.myshopify.com/x.jpg', Buffer.from('img'), 'image/jpeg')
      const command = send.mock.calls.at(-1)[0]
      expect(command.constructor.name).toBe('PutObjectCommand')
      expect(command.input).toMatchObject({ Key: 'generation-photos/a.myshopify.com/x.jpg', ContentType: 'image/jpeg' })
    } finally {
      send.mockRestore()
    }
  })
})
```

- [ ] **Step 2: Implement storage.** In `storage.server.js`, extract the key building from `presignPhotoUpload`:

```js
/** generation-photos/<shop>/<uuid>.<ext> — shop-scoped so generations.server.js can refuse other shops' keys. */
export function newPhotoRef(shop, contentType) {
  const shopSegment = typeof shop === 'string' ? shop.toLowerCase() : ''
  if (!MYSHOPIFY_DOMAIN.test(shopSegment)) throw tagged('BAD_PHOTO', `invalid shop for photo: ${shop}`)
  const extension = Object.hasOwn(PHOTO_EXTENSIONS, contentType) ? PHOTO_EXTENSIONS[contentType] : null
  if (!extension) throw tagged('BAD_PHOTO', `unsupported photo type: ${contentType}`)
  return `generation-photos/${shopSegment}/${globalThis.crypto.randomUUID()}.${extension}`
}

/** Server-side photo write (product photo import). */
export async function savePhoto(storageRef, bytes, contentType) {
  await getClient().send(new PutObjectCommand({
    Bucket: process.env.S3_BUCKET,
    Key: storageRef,
    Body: bytes,
    ContentType: contentType,
  }))
}
```

and make `presignPhotoUpload` call `newPhotoRef(shop, contentType)` (keep its size check and existing error behaviour). Run `npx vitest run test/storagePhotos.server.test.js` → PASS.

- [ ] **Step 3: Product photo tests.** Create `test/productPhotos.server.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = vi.hoisted(() => ({ saved: new Map(), deleted: [], failSave: false }))
vi.mock('../app/storage.server.js', () => ({
  MAX_PHOTO_BYTES: 10 * 1024 * 1024,
  newPhotoRef: (shop, type) => `generation-photos/${shop}/${store.saved.size + store.deleted.length}-${Math.random().toString(16).slice(2, 8)}.${type === 'image/png' ? 'png' : 'jpg'}`,
  savePhoto: async (key, bytes, type) => {
    if (store.failSave) throw new Error('s3 down')
    store.saved.set(key, { bytes, type })
  },
  deleteModelGlb: async (key) => { store.deleted.push(key); store.saved.delete(key) },
}))

const { fetchProductImages, importProductPhotos, PRODUCT_IMAGES_QUERY } = await import('../app/productPhotos.server.js')

const SHOP = 'gen-test.myshopify.com'
const PRODUCT = 'gid://shopify/Product/42'
const img = (n, host = 'cdn.shopify.com') => ({
  id: `gid://shopify/MediaImage/${n}`,
  mediaContentType: 'IMAGE',
  image: { url: `https://${host}/s/files/p${n}.jpg?width=2048`, thumbnail: `https://${host}/s/files/p${n}.jpg?width=300`, altText: `angle ${n}` },
})

function adminFor(product) {
  const calls = []
  return {
    calls,
    graphql: async (query, options) => {
      calls.push({ query, options })
      return new Response(JSON.stringify({ data: { product } }))
    },
  }
}

const okFetch = (type = 'image/jpeg', body = 'jpegbytes') => vi.fn(async (url) => new Response(body, { status: 200, headers: { 'content-type': type } }))

beforeEach(() => {
  store.saved.clear()
  store.deleted.length = 0
  store.failSave = false
})

describe('fetchProductImages', () => {
  it('returns the product and only its images, asking for the product by id', async () => {
    const admin = adminFor({
      id: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo',
      media: { nodes: [img(1), { id: 'gid://shopify/Video/9', mediaContentType: 'VIDEO' }, img(2)] },
    })
    const result = await fetchProductImages(admin, PRODUCT)
    expect(admin.calls[0].query).toBe(PRODUCT_IMAGES_QUERY)
    expect(admin.calls[0].options).toEqual({ variables: { id: PRODUCT } })
    expect(result).toEqual({
      productId: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo',
      images: [
        { id: 'gid://shopify/MediaImage/1', url: 'https://cdn.shopify.com/s/files/p1.jpg?width=2048', thumbnailUrl: 'https://cdn.shopify.com/s/files/p1.jpg?width=300', altText: 'angle 1' },
        { id: 'gid://shopify/MediaImage/2', url: 'https://cdn.shopify.com/s/files/p2.jpg?width=2048', thumbnailUrl: 'https://cdn.shopify.com/s/files/p2.jpg?width=300', altText: 'angle 2' },
      ],
    })
  })

  it('refuses malformed ids without calling Shopify, and missing products', async () => {
    const admin = adminFor(null)
    await expect(fetchProductImages(admin, 'gid://shopify/Order/1')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(admin.calls).toHaveLength(0)
    await expect(fetchProductImages(admin, PRODUCT)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('importProductPhotos', () => {
  const product = { id: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo', media: { nodes: [img(1), img(2), img(3), img(4), img(5)] } }
  const ids = (...n) => n.map((k) => `gid://shopify/MediaImage/${k}`)

  it('downloads the ticked images from the CDN and stores them as shop photo keys', async () => {
    const fetchImpl = okFetch()
    const result = await importProductPhotos({ admin: adminFor(product), shop: SHOP, productId: PRODUCT, imageIds: ids(2, 4, 5), fetchImpl })
    expect(fetchImpl.mock.calls.map(([u]) => u)).toEqual([
      'https://cdn.shopify.com/s/files/p2.jpg?width=2048',
      'https://cdn.shopify.com/s/files/p4.jpg?width=2048',
      'https://cdn.shopify.com/s/files/p5.jpg?width=2048',
    ])
    expect(result.photoRefs).toHaveLength(3)
    expect(result).toMatchObject({ productId: PRODUCT, title: 'GRIPZ Pelmo', handle: 'gripz-pelmo' })
    for (const ref of result.photoRefs) expect(store.saved.get(ref).type).toBe('image/jpeg')
  })

  it('needs 3 or 4 distinct images that belong to the product', async () => {
    const run = (imageIds) => importProductPhotos({ admin: adminFor(product), shop: SHOP, productId: PRODUCT, imageIds, fetchImpl: okFetch() })
    await expect(run(ids(1, 2))).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    await expect(run(ids(1, 2, 3, 4, 5))).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    await expect(run(ids(1, 1, 2))).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    await expect(run([...ids(1, 2), 'gid://shopify/MediaImage/999'])).rejects.toMatchObject({ code: 'BAD_PHOTOS' })
    expect(store.saved.size).toBe(0)
  })

  it('refuses images not served from cdn.shopify.com', async () => {
    const evil = { ...product, media: { nodes: [img(1), img(2), img(3, 'evil.example.com')] } }
    await expect(importProductPhotos({ admin: adminFor(evil), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: okFetch() }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })
  })

  it('refuses non-image content, oversize bodies and failed downloads, and cleans up what it stored', async () => {
    const admin = () => adminFor(product)
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: okFetch('text/html') }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })

    let n = 0
    const thirdFails = vi.fn(async () => (++n === 3 ? new Response('nope', { status: 500 }) : new Response('jpg', { status: 200, headers: { 'content-type': 'image/jpeg' } })))
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: thirdFails }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })
    expect(store.deleted).toHaveLength(2)
    expect(store.saved.size).toBe(0)

    const huge = vi.fn(async () => new Response('x', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(11 * 1024 * 1024) } }))
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: huge }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })

    const rejecting = vi.fn(async () => { throw new Error('ECONNRESET') })
    await expect(importProductPhotos({ admin: admin(), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: rejecting }))
      .rejects.toMatchObject({ code: 'BAD_PHOTO' })
  })

  it('cleans up stored photos when storage itself fails', async () => {
    store.failSave = true
    await expect(importProductPhotos({ admin: adminFor(product), shop: SHOP, productId: PRODUCT, imageIds: ids(1, 2, 3), fetchImpl: okFetch() }))
      .rejects.toThrow('s3 down')
  })
})
```

- [ ] **Step 4: Run, expect FAIL** (module missing).

- [ ] **Step 5: Implement `app/productPhotos.server.js`:**

```js
import { tagged } from './errors.server.js'
import { MAX_PHOTO_BYTES, newPhotoRef, savePhoto, deleteModelGlb } from './storage.server.js'

/**
 * "Create with AI" from a store product (spec addendum 2026-10-01): read the
 * product's images through the Admin API, then copy the ones the merchant ticked
 * into the same shop-scoped photo keys an upload produces, so the generation
 * pipeline doesn't know or care where the photos came from.
 */

const PRODUCT_GID = /^gid:\/\/shopify\/Product\/\d+$/
const CDN_HOST = 'cdn.shopify.com'
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const DOWNLOAD_TIMEOUT_MS = 15_000

export const PRODUCT_IMAGES_QUERY = `#graphql
  query ProductImages($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      media(first: 20) {
        nodes {
          id
          mediaContentType
          ... on MediaImage {
            image {
              url(transform: { maxWidth: 2048, maxHeight: 2048, preferredContentType: JPG })
              thumbnail: url(transform: { maxWidth: 300, maxHeight: 300 })
              altText
            }
          }
        }
      }
    }
  }`

export async function fetchProductImages(admin, productId) {
  if (typeof productId !== 'string' || !PRODUCT_GID.test(productId)) {
    throw tagged('NOT_FOUND', `not a product id: ${String(productId)}`)
  }
  const res = await admin.graphql(PRODUCT_IMAGES_QUERY, { variables: { id: productId } })
  const product = (await res.json())?.data?.product
  if (!product) throw tagged('NOT_FOUND', `product ${productId} not found`)
  const images = (product.media?.nodes ?? [])
    .filter((node) => node?.mediaContentType === 'IMAGE' && node.image?.url)
    .map((node) => ({
      id: node.id,
      url: node.image.url,
      thumbnailUrl: node.image.thumbnail ?? node.image.url,
      altText: node.image.altText ?? null,
    }))
  return { productId: product.id, title: product.title, handle: product.handle, images }
}

function isCdnUrl(url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === CDN_HOST
  } catch {
    return false
  }
}

async function download(url, fetchImpl) {
  if (!isCdnUrl(url)) throw tagged('BAD_PHOTO', `product image is not on ${CDN_HOST}`)
  let res
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    throw tagged('BAD_PHOTO', `product image download failed: ${error?.message}`)
  }
  // Redirects are followed; the final address must still be the CDN.
  if (res.url && !isCdnUrl(res.url)) throw tagged('BAD_PHOTO', 'product image redirected off the CDN')
  if (!res.ok) throw tagged('BAD_PHOTO', `product image download failed: ${res.status}`)
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (!PHOTO_TYPES.includes(contentType)) throw tagged('BAD_PHOTO', `product image type ${contentType}`)
  if (Number(res.headers.get('content-length')) > MAX_PHOTO_BYTES) throw tagged('BAD_PHOTO', 'product image too large')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw tagged('BAD_PHOTO', `product image size ${bytes.length}`)
  return { bytes, contentType }
}

export async function importProductPhotos({ admin, shop, productId, imageIds, fetchImpl = fetch }) {
  if (!Array.isArray(imageIds) || imageIds.length < 3 || imageIds.length > 4 || new Set(imageIds).size !== imageIds.length) {
    throw tagged('BAD_PHOTOS', 'choose 3 or 4 different product photos')
  }
  const product = await fetchProductImages(admin, productId)
  const byId = new Map(product.images.map((image) => [image.id, image]))
  const chosen = imageIds.map((id) => byId.get(id))
  if (chosen.some((image) => !image)) throw tagged('BAD_PHOTOS', 'a chosen photo is not on this product')

  const photoRefs = []
  try {
    for (const image of chosen) {
      const { bytes, contentType } = await download(image.url, fetchImpl)
      const ref = newPhotoRef(shop, contentType)
      await savePhoto(ref, bytes, contentType)
      photoRefs.push(ref)
    }
  } catch (error) {
    for (const ref of photoRefs) {
      try {
        await deleteModelGlb(ref)
      } catch (cleanupError) {
        console.error('product photo cleanup failed', ref, cleanupError)
      }
    }
    throw error
  }
  return { photoRefs, productId: product.productId, title: product.title, handle: product.handle }
}
```

- [ ] **Step 6: Run** `npx vitest run test/productPhotos.server.test.js test/storagePhotos.server.test.js` → PASS (pristine).
- [ ] **Step 7: Commit** — `feat(ai-models): import a product's photos into generation storage`.

---

### Task 3: Remember the source and product on each generation

**Files:** Modify `apps/shopify-app/prisma/schema.prisma`; Create `apps/shopify-app/prisma/migrations/20261001000000_generation_product_source/migration.sql`; Modify `apps/shopify-app/app/generations.server.js`; Test `apps/shopify-app/test/generations.server.test.js` (append).

**Interfaces:**
- Consumes: `startGeneration({ images, feedback?, source })` (Task 1).
- Produces: `createGeneration(prisma, { shop, shopGid, photoRefs?, retryOf?, photoSource = 'upload', productId = null, productTitle = null, productHandle = null, now })`; retries inherit the parent's `photoSource/productId/productTitle/productHandle`; `startGeneration` is always called with `source: generation.photoSource` (create and automatic retry); `toClientGeneration` adds `photoSource`, `productTitle`; `saveGeneration` returns `{ assetId, paid, productId, productHandle }` (null when not product-sourced).

- [ ] **Step 1: Schema.** Add to `model ModelGeneration` (after `photoSetId`):

```prisma
  // 'upload' | 'product' (spec addendum 2026-10-01)
  photoSource    String    @default("upload")
  productId      String?
  productTitle   String?
  productHandle  String?
```

- [ ] **Step 2: Migration SQL, generated offline** (dummy env, never a real DB):

```bash
cd "/d/AR Sunglasses/wt-ai-model-gen/apps/shopify-app"
git show HEAD:apps/shopify-app/prisma/schema.prisma > ../../.superpowers/sdd/2026-10-01-ai-model-from-product-photos/schema.before.prisma
mkdir -p prisma/migrations/20261001000000_generation_product_source
DATABASE_URL=postgresql://x@localhost/x DIRECT_URL=postgresql://x@localhost/x npx prisma migrate diff --from-schema-datamodel ../../.superpowers/sdd/2026-10-01-ai-model-from-product-photos/schema.before.prisma --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261001000000_generation_product_source/migration.sql
cat prisma/migrations/20261001000000_generation_product_source/migration.sql
DATABASE_URL=postgresql://x@localhost/x DIRECT_URL=postgresql://x@localhost/x npx prisma validate && npx prisma generate
```

Expected SQL: only `ALTER TABLE "ModelGeneration" ADD COLUMN "photoSource" TEXT NOT NULL DEFAULT 'upload', ADD COLUMN "productId" TEXT, ADD COLUMN "productTitle" TEXT, ADD COLUMN "productHandle" TEXT;` — STOP if it touches anything else. Plain LF, no BOM. (The `.superpowers/` dir is git-ignored; create it if missing.)

- [ ] **Step 3: Append failing tests** to `test/generations.server.test.js` (add `photoSource: 'upload'` etc. defaults to the fake only if the strict fake rejects unknown create fields — it doesn't; `DEFAULTS` in `test/helpers/fakePrisma.js` should gain `photoSource: 'upload', productId: null, productTitle: null, productHandle: null` so rows created without them match Prisma's defaults):

```js
describe('product-sourced generations', () => {
  beforeEach(() => {
    deps.start.mockResolvedValue({ providerJobId: 'resp_p' })
  })

  it('stores the source and product and asks the generator for product wording', async () => {
    const prisma = createFakePrisma()
    const g = await generations.createGeneration(prisma, {
      shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW,
      photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo',
    })
    expect(g).toMatchObject({ photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo' })
    expect(deps.start.mock.calls[0][0]).toMatchObject({ source: 'product' })
  })

  it('defaults to upload and refuses unknown sources', async () => {
    const prisma = createFakePrisma()
    const g = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW })
    expect(g.photoSource).toBe('upload')
    expect(deps.start.mock.calls[0][0]).toMatchObject({ source: 'upload' })
    await expect(generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, photoRefs: PHOTOS, now: NOW, photoSource: 'url' }))
      .rejects.toMatchObject({ code: 'BAD_PHOTOS' })
  })

  it('retries and automatic retries keep the product source', async () => {
    const prisma = createFakePrisma()
    const parent = await prisma.modelGeneration.create({ data: row({ status: 'failed', photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo' }) })
    const retry = await generations.createGeneration(prisma, { shop: SHOP, shopGid: SHOP_GID, retryOf: parent.id, now: NOW })
    expect(retry).toMatchObject({ photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ Pelmo', productHandle: 'gripz-pelmo' })
    expect(deps.start.mock.calls.at(-1)[0]).toMatchObject({ source: 'product' })

    const running = await prisma.modelGeneration.create({ data: row({ status: 'running', providerJobId: 'resp_9', startedAt: NOW, photoSource: 'product' }) })
    deps.check.mockResolvedValue({ state: 'failed', error: 'no_glb_output' })
    await generations.advanceGeneration(prisma, running, NOW)
    expect(deps.start.mock.calls.at(-1)[0]).toMatchObject({ source: 'product' })
  })

  it('exposes the source and product title to the client', () => {
    const view = generations.toClientGeneration({ id: 'g', status: 'ready', error: null, retryIndex: 0, calibration: null, paid: null, modelAssetId: null, createdAt: NOW, photoSource: 'product', productTitle: 'GRIPZ Pelmo' })
    expect(view).toMatchObject({ photoSource: 'product', productTitle: 'GRIPZ Pelmo' })
  })

  it('save returns the product so the route can map it', async () => {
    const prisma = createFakePrisma()
    const g = await prisma.modelGeneration.create({ data: row({ status: 'ready', glbRef: 'generations/x.glb', photoSource: 'product', productId: 'gid://shopify/Product/42', productHandle: 'gripz-pelmo' }) })
    deps.objects.set('generations/x.glb', Buffer.from('glb'))
    deps.saveCalibratedModel.mockResolvedValue({ assetId: g.id })
    await expect(generations.saveGeneration(prisma, { shop: SHOP, generationId: g.id, planName: 'Starter', now: NOW }))
      .resolves.toEqual({ assetId: g.id, paid: false, productId: 'gid://shopify/Product/42', productHandle: 'gripz-pelmo' })
  })
})
```

Also update the existing `saveGeneration` tests whose `toEqual({ assetId, paid })` now also need `productId: null, productHandle: null`.

- [ ] **Step 4: Run, expect FAIL.**

- [ ] **Step 5: Implement in `generations.server.js`:**
  - `const PHOTO_SOURCES = ['upload', 'product']`.
  - `createGeneration` signature adds `photoSource = 'upload', productId = null, productTitle = null, productHandle = null`. Inside the transaction: on retry, take `photoSource/productId/productTitle/productHandle` from `parentRow`; otherwise, if `!PHOTO_SOURCES.includes(photoSource)` throw `tagged('BAD_PHOTOS', 'unknown photo source')`. Write all four into the `create` data.
  - Pass `source: generation.photoSource` to `startGeneration` in `createGeneration` and in `retryOrFail`.
  - `toClientGeneration` adds `photoSource: generation.photoSource ?? 'upload'` and `productTitle: generation.productTitle ?? null`.
  - `saveGeneration` returns `{ assetId: asset.assetId, paid, productId: generation.productId ?? null, productHandle: generation.productHandle ?? null }`.
  - `test/helpers/fakePrisma.js`: add the four defaults to `DEFAULTS`.

- [ ] **Step 6: Run** `npx vitest run test/generations.server.test.js test/fakePrisma.test.js` → PASS.
- [ ] **Step 7: Commit** — `feat(ai-models): remember each generation's photo source and product`.

---

### Task 4: Auto-map on save and the product routes

**Files:** Create `apps/shopify-app/app/aiProductMapping.server.js`; Modify `apps/shopify-app/app/routes/api.generations.jsx`; Tests `apps/shopify-app/test/aiProductMapping.server.test.js` (new), `apps/shopify-app/test/apiGenerations.route.test.js` (append).

**Interfaces:**
- Consumes: `fetchProductImages`, `importProductPhotos` (Task 2); `createGeneration` source/product params, `saveGeneration` return (Task 3); `mapProductToModel(prisma, shop, productId, modelAssetId, productHandle)`, `publishMapping(admin, productId)`, `planLimit(name)` (existing).
- Produces:
  - `addGeneratedModelToProduct({ prisma, admin, shop, planName, productId, productHandle, modelAssetId }) → { mapped: true } | { mapped: false, reason }` (never throws)
  - `POST /api/generations` `intent=product-images`, `productId` → `{ product: { id, title }, images: [{ id, thumbnailUrl, altText }] }`
  - `intent=create-from-product`, `productId`, `imageIds` (JSON) → `{ generation }`
  - `intent=save` → `{ assetId, paid, productId, productHandle, mapping? }` where `mapping` is present only for product-sourced saves

- [ ] **Step 1: Mapping tests** — `test/aiProductMapping.server.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest'

const deps = vi.hoisted(() => ({ map: vi.fn(), publish: vi.fn() }))
vi.mock('../app/models.server.js', () => ({ mapProductToModel: (...a) => deps.map(...a) }))
vi.mock('../app/tryonMetafield.server.js', () => ({ publishMapping: (...a) => deps.publish(...a) }))

const { addGeneratedModelToProduct } = await import('../app/aiProductMapping.server.js')

const SHOP = 'gen-test.myshopify.com'
const PRODUCT = 'gid://shopify/Product/42'
function prismaWith({ existing = null, count = 0 } = {}) {
  return { productMapping: { findUnique: vi.fn(async () => existing), count: vi.fn(async () => count) } }
}
const args = (prisma, planName = 'Starter') => ({ prisma, admin: {}, shop: SHOP, planName, productId: PRODUCT, productHandle: 'gripz-pelmo', modelAssetId: 'asset-1' })

beforeEach(() => {
  vi.resetAllMocks()
  deps.map.mockResolvedValue({})
  deps.publish.mockResolvedValue(undefined)
})

describe('addGeneratedModelToProduct', () => {
  it('maps and publishes a new product within the plan limit', async () => {
    const prisma = prismaWith({ count: 3 })
    await expect(addGeneratedModelToProduct(args(prisma))).resolves.toEqual({ mapped: true })
    expect(deps.map).toHaveBeenCalledWith(prisma, SHOP, PRODUCT, 'asset-1', 'gripz-pelmo')
    expect(deps.publish).toHaveBeenCalledWith({}, PRODUCT)
  })

  it('remaps a product that already has try-on even at the limit', async () => {
    const prisma = prismaWith({ existing: { id: 'm1' }, count: 10 })
    await expect(addGeneratedModelToProduct(args(prisma))).resolves.toEqual({ mapped: true })
    expect(prisma.productMapping.count).not.toHaveBeenCalled()
  })

  it('does not map a new product past the plan limit', async () => {
    const prisma = prismaWith({ count: 10 })
    await expect(addGeneratedModelToProduct(args(prisma))).resolves.toEqual({ mapped: false, reason: 'product_limit' })
    expect(deps.map).not.toHaveBeenCalled()
  })

  it('reports (never throws) map and publish failures', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      deps.map.mockRejectedValueOnce(new Error('db'))
      await expect(addGeneratedModelToProduct(args(prismaWith()))).resolves.toEqual({ mapped: false, reason: 'map_failed' })
      deps.publish.mockRejectedValueOnce(new Error('shopify'))
      await expect(addGeneratedModelToProduct(args(prismaWith()))).resolves.toEqual({ mapped: false, reason: 'publish_failed' })
      expect(spy).toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })
})
```

- [ ] **Step 2: Implement `app/aiProductMapping.server.js`:**

```js
import { planLimit } from './billing.server.js'
import { mapProductToModel } from './models.server.js'
import { publishMapping } from './tryonMetafield.server.js'

/**
 * After a product-sourced AI model is saved, put it on that product's try-on.
 * Same rules as "Add try-on" (productActions.server.js 'map'): the plan's
 * product limit applies only to a product without try-on yet, the mapping
 * upserts, and the $app:tryon metafield is published. Kept separate from
 * productActions because that file's tests are DB-backed. Never throws: the
 * save has already succeeded and must not look like a failure.
 */
export async function addGeneratedModelToProduct({ prisma, admin, shop, planName, productId, productHandle, modelAssetId }) {
  try {
    const existing = await prisma.productMapping.findUnique({ where: { shop_productId: { shop, productId } } })
    if (!existing) {
      const count = await prisma.productMapping.count({ where: { shop } })
      if (count >= planLimit(planName)) return { mapped: false, reason: 'product_limit' }
    }
    await mapProductToModel(prisma, shop, productId, modelAssetId, productHandle ?? undefined)
  } catch (error) {
    console.error('AI model auto-map failed', productId, error)
    return { mapped: false, reason: 'map_failed' }
  }
  try {
    await publishMapping(admin, productId)
  } catch (error) {
    console.error('AI model auto-map: try-on metafield publish failed', productId, error)
    return { mapped: false, reason: 'publish_failed' }
  }
  return { mapped: true }
}
```

Run `npx vitest run test/aiProductMapping.server.test.js` → PASS.

- [ ] **Step 3: Route tests** — append to `test/apiGenerations.route.test.js`. Extend its hoisted `h` with `products: { fetch: vi.fn(), import: vi.fn() }` and `mapping: vi.fn()`, add mocks (keep existing ones):

```js
vi.mock('../app/productPhotos.server.js', () => ({
  fetchProductImages: (...a) => h.products.fetch(...a),
  importProductPhotos: (...a) => h.products.import(...a),
}))
vi.mock('../app/aiProductMapping.server.js', () => ({
  addGeneratedModelToProduct: (...a) => h.mapping(...a),
}))
```

and add `assertCanStartGeneration: (...a) => h.gen.guard(...a)` to the `generations.server.js` mock if not already present (initialise `h.gen.guard = vi.fn()` in `beforeEach`). Tests:

```js
describe('product source', () => {
  it('lists a product\'s images as thumbnails only', async () => {
    h.products.fetch.mockResolvedValue({ productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'g', images: [{ id: 'm1', url: 'https://cdn.shopify.com/big.jpg', thumbnailUrl: 'https://cdn.shopify.com/t.jpg', altText: 'front' }] })
    const body = await (await api.action(post({ intent: 'product-images', productId: 'gid://shopify/Product/42' }))).json()
    expect(body).toEqual({ product: { id: 'gid://shopify/Product/42', title: 'GRIPZ' }, images: [{ id: 'm1', thumbnailUrl: 'https://cdn.shopify.com/t.jpg', altText: 'front' }] })
  })

  it('creates from a product: guard first, then import, then a product-sourced generation', async () => {
    const order = []
    h.gen.guard.mockImplementation(async () => { order.push('guard') })
    h.products.import.mockImplementation(async () => { order.push('import'); return { photoRefs: ['r1', 'r2', 'r3'], productId: 'gid://shopify/Product/42', title: 'GRIPZ', handle: 'gripz' } })
    h.gen.create.mockImplementation(async () => { order.push('create'); return { id: 'g9', status: 'running' } })
    const body = await (await api.action(post({ intent: 'create-from-product', productId: 'gid://shopify/Product/42', imageIds: JSON.stringify(['m1', 'm2', 'm3']) }))).json()
    expect(order).toEqual(['guard', 'import', 'create'])
    expect(h.products.import.mock.calls[0][0]).toMatchObject({ shop: h.shop, productId: 'gid://shopify/Product/42', imageIds: ['m1', 'm2', 'm3'] })
    expect(h.gen.create.mock.calls[0][1]).toMatchObject({ photoRefs: ['r1', 'r2', 'r3'], photoSource: 'product', productId: 'gid://shopify/Product/42', productTitle: 'GRIPZ', productHandle: 'gripz', shopGid: 'gid://shopify/Shop/7' })
    expect(body).toEqual({ generation: { id: 'g9', status: 'running' } })
  })

  it('maps product-sourced saves and leaves upload saves alone', async () => {
    h.gen.save.mockResolvedValue({ assetId: 'a1', paid: false, productId: 'gid://shopify/Product/42', productHandle: 'gripz' })
    h.mapping.mockResolvedValue({ mapped: false, reason: 'product_limit' })
    const body = await (await api.action(post({ intent: 'save', generationId: 'g1' }))).json()
    expect(body.mapping).toEqual({ mapped: false, reason: 'product_limit' })
    expect(h.mapping.mock.calls[0][0]).toMatchObject({ shop: h.shop, planName: 'Starter', productId: 'gid://shopify/Product/42', productHandle: 'gripz', modelAssetId: 'a1' })

    h.mapping.mockClear()
    h.gen.save.mockResolvedValue({ assetId: 'a2', paid: false, productId: null, productHandle: null })
    const plain = await (await api.action(post({ intent: 'save', generationId: 'g2' }))).json()
    expect(plain.mapping).toBeUndefined()
    expect(h.mapping).not.toHaveBeenCalled()
  })

  it('maps product errors to merchant copy', async () => {
    h.products.fetch.mockRejectedValue(Object.assign(new Error('x'), { code: 'NOT_FOUND' }))
    const res = await api.action(post({ intent: 'product-images', productId: 'gid://shopify/Product/1' }))
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: Implement the route.** In `api.generations.jsx`:
  - imports: `assertCanStartGeneration` (already imported), `fetchProductImages, importProductPhotos` from `../productPhotos.server`, `addGeneratedModelToProduct` from `../aiProductMapping.server`.
  - Extract the shop-GID lookup into a local `async function shopGidFor(admin)` used by `create`/`retry`/`create-from-product`.
  - New intents (inside the existing try):

```jsx
    if (intent === 'product-images') {
      const product = await fetchProductImages(admin, form.get('productId')?.toString())
      return Response.json({
        product: { id: product.productId, title: product.title },
        images: product.images.map(({ id, thumbnailUrl, altText }) => ({ id, thumbnailUrl, altText })),
      })
    }

    if (intent === 'create-from-product') {
      // Same reasoning as presign-photos: refuse before anything is stored.
      await assertCanStartGeneration(prisma, shop)
      const shopGid = await shopGidFor(admin)
      const imported = await importProductPhotos({
        admin,
        shop,
        productId: form.get('productId')?.toString(),
        imageIds: parseJson(form.get('imageIds')),
      })
      const generation = await createGeneration(prisma, {
        shop,
        shopGid,
        photoRefs: imported.photoRefs,
        photoSource: 'product',
        productId: imported.productId,
        productTitle: imported.title,
        productHandle: imported.handle,
      })
      return Response.json({ generation: toClientGeneration(generation) })
    }
```

  - `save`: 

```jsx
    if (intent === 'save') {
      const saved = await saveGeneration(prisma, { shop, generationId, planName, acceptCharge: form.get('acceptCharge') === 'true' })
      if (!saved.productId) return Response.json(saved)
      const mapping = await addGeneratedModelToProduct({
        prisma, admin, shop, planName,
        productId: saved.productId,
        productHandle: saved.productHandle,
        modelAssetId: saved.assetId,
      })
      return Response.json({ ...saved, mapping })
    }
```

  - `MESSAGES.NOT_FOUND` stays generic; add `MESSAGES.BAD_PHOTO` wording that covers product photos: "One of the photos couldn't be used. Use JPG, PNG or WebP photos of 10 MB or less, or choose different product photos."; `MESSAGES.BAD_PHOTOS`: "Choose 3 or 4 photos (front and sides work best)."

- [ ] **Step 5: Run** `npx vitest run test/apiGenerations.route.test.js test/aiProductMapping.server.test.js` → PASS (update any existing assertion that pinned the old `BAD_PHOTO`/`BAD_PHOTOS` copy).
- [ ] **Step 6: Build** — `npx react-router build` succeeds; don't commit `build/`.
- [ ] **Step 7: Commit** — `feat(ai-models): generate from product photos and add the model to the product on save`.

---

### Task 5: Admin UI — "From a product" source

**Files:** Modify `apps/shopify-app/app/components/AiModelFlow.jsx`; Test `apps/shopify-app/test/aiModelFlow.ui.test.js` (append).

**Interfaces:** Consumes the Task 4 intents. Produces pure helpers (tested): `defaultImageSelection(images) → string[]` (first 4 ids), `toggleImage(selected, id) → string[]` (adds up to 4, removes if present), `canGenerateFromProduct(selected) → boolean` (3–4), `mappingMessage(mapping, productTitle) → string|null`, `productTooFewPhotos(count) → string`.

- [ ] **Step 1: Append failing tests:**

```js
import { defaultImageSelection, toggleImage, canGenerateFromProduct, mappingMessage, productTooFewPhotos } from '../app/components/AiModelFlow.jsx'

describe('product photo selection', () => {
  const imgs = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))

  it('pre-ticks the first 4 images', () => {
    expect(defaultImageSelection(imgs)).toEqual(['a', 'b', 'c', 'd'])
    expect(defaultImageSelection(imgs.slice(0, 3))).toEqual(['a', 'b', 'c'])
  })

  it('toggles images and never selects more than 4', () => {
    expect(toggleImage(['a', 'b', 'c', 'd'], 'b')).toEqual(['a', 'c', 'd'])
    expect(toggleImage(['a', 'c', 'd'], 'e')).toEqual(['a', 'c', 'd', 'e'])
    expect(toggleImage(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('needs 3 or 4 ticked', () => {
    expect(canGenerateFromProduct(['a', 'b'])).toBe(false)
    expect(canGenerateFromProduct(['a', 'b', 'c'])).toBe(true)
    expect(canGenerateFromProduct(['a', 'b', 'c', 'd'])).toBe(true)
  })

  it('explains a product with too few photos', () => {
    expect(productTooFewPhotos(2)).toMatch(/only 2 photos/)
    expect(productTooFewPhotos(2)).toMatch(/Upload photos/)
  })
})

describe('mappingMessage', () => {
  it('says what happened to the product after a save', () => {
    expect(mappingMessage({ mapped: true }, 'GRIPZ')).toBe('Model saved and added to GRIPZ.')
    expect(mappingMessage({ mapped: false, reason: 'product_limit' }, 'GRIPZ')).toMatch(/product limit/)
    expect(mappingMessage({ mapped: false, reason: 'publish_failed' }, 'GRIPZ')).toMatch(/Add try-on/)
    expect(mappingMessage(undefined, 'GRIPZ')).toBeNull()
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement helpers:**

```jsx
export function defaultImageSelection(images) {
  return images.slice(0, 4).map((image) => image.id)
}

export function toggleImage(selected, id) {
  if (selected.includes(id)) return selected.filter((x) => x !== id)
  return selected.length >= 4 ? selected : [...selected, id]
}

export function canGenerateFromProduct(selected) {
  return selected.length >= 3 && selected.length <= 4
}

export function productTooFewPhotos(count) {
  return `This product has only ${count} ${count === 1 ? 'photo' : 'photos'}. Add more to the product, or use Upload photos instead.`
}

export function mappingMessage(mapping, productTitle) {
  if (!mapping) return null
  const name = productTitle || 'the product'
  if (mapping.mapped) return `Model saved and added to ${name}.`
  if (mapping.reason === 'product_limit') return `Model saved. Your plan's product limit is reached, so it wasn't added to ${name}.`
  return `Model saved, but it couldn't be added to ${name}. Use Add try-on to add it.`
}
```

- [ ] **Step 4: Component.** In `AiModelFlow`:
  - State: `source` (`'product'` default | `'upload'`), `product` (`{ id, title } | null`), `productImages` (`[]`), `selectedImages` (`[]`).
  - Source switch at the top of the section: two `s-button`s (`variant` `primary` for the active one, `secondary` otherwise), labels "From a product" / "Upload photos", `onClick={() => setSource(...)}`; clear `error` on switch.
  - Product source body:
    - `s-button` "Choose product" → `const selection = await shopify.resourcePicker({ type: 'product', action: 'select' })`; if `selection?.[0]`, `postForm({ intent: 'product-images', productId: selection[0].id })` (wrap in the same try/catch/ShownError shape as `generate`, busy-guarded); on success set `product`, `productImages`, `selectedImages = defaultImageSelection(images)`. If `images.length < 3`, set `error` to `productTooFewPhotos(images.length)`.
    - Product title line + "Change product" (same picker).
    - Thumbnails grid: each image is a `<button type="button" aria-pressed={selected} onClick={() => setSelectedImages((s) => toggleImage(s, image.id))}>` wrapping `<img src={image.thumbnailUrl} alt={image.altText || ''} style={{ width: '100%', aspectRatio: '1', objectFit: 'contain' }} />` with a visible selected state (border + "✓" corner badge via inline styles). Native `button`, not `s-*`, so React's onClick works and the toggle is keyboard-accessible.
    - Helper text: "Tick 3 or 4 clear photos of the frame from different angles. Skip lifestyle or worn photos if you can."
    - Generate button: `disabled={busy || !product || !canGenerateFromProduct(selectedImages)}` → `postForm({ intent: 'create-from-product', productId: product.id, imageIds: JSON.stringify(selectedImages) })`, same error/ShownError handling as `generate`; on success clear `product/productImages/selectedImages` and `refresh()`.
  - Upload source body: today's photo slots + Generate, unchanged.
  - `GenerationRow`: when `generation.productTitle`, show `<s-text color="subdued">From {generation.productTitle}</s-text>`.
  - `act` after a successful save: if `res.body.mapping`, `shopify.toast.show(mappingMessage(res.body.mapping, generation.productTitle))` instead of the plain saved toast (keep the paid-charge wording when `res.body.paid`: append " $5 added to your Shopify bill.").
  - The balance line, polling, charge modal and existing error handling stay as they are.

- [ ] **Step 5: Run** `npx vitest run test/aiModelFlow.ui.test.js test/planUsage.ui.test.js test/appModels.ui.test.js test/appIndex.workspace.test.js`, `npx react-router build`, `npx eslint app/components/AiModelFlow.jsx app/routes/api.generations.jsx app/productPhotos.server.js app/aiProductMapping.server.js app/generations.server.js app/storage.server.js app/modelGenerator.server.js` → all clean.
- [ ] **Step 6: Commit** — `feat(ai-models): pick a product and its photos in Create with AI`.

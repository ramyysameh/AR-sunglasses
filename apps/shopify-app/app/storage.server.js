import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { tagged } from './errors.server.js'

/**
 * Object storage for calibrated GLBs.
 *
 * Replaces the dev-slice local-disk store: serverless hosting has an ephemeral
 * filesystem, so anything written to disk is gone on the next invocation and every
 * merchant upload would silently vanish.
 *
 * Talks plain S3 by default. Setting S3_ENDPOINT points the same client at any
 * S3-compatible store (Cloudflare R2, MinIO) — so moving off AWS later, e.g. to R2
 * for its zero egress fees once traffic makes that matter, is a config change
 * rather than a code change.
 *
 * `storageRef` (stored on ModelAsset) is the object key.
 */

let client = null

/**
 * Built lazily, not at module load: importing this file must not throw when the
 * storage env vars are absent (builds, tests, and any code path that never touches
 * storage). Failing at import would take down the whole app instead of one request.
 *
 * Credentials come from the AWS SDK's standard chain — AWS_ACCESS_KEY_ID and
 * AWS_SECRET_ACCESS_KEY, which is how both Vercel and local .env supply them.
 */
function getClient() {
  if (!client) {
    const endpoint = process.env.S3_ENDPOINT
    client = new S3Client({
      region: process.env.AWS_REGION ?? 'us-east-1',
      // S3-compatible stores need path-style addressing; AWS itself does not.
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
    })
  }
  return client
}

/**
 * Presigned PUT URL for a direct browser->storage model upload, bypassing the
 * serverless request-body size cap. The returned key lives under `uploads/` — a
 * transport buffer that `finalizeUpload` consumes (reads + deletes) after the
 * client PUT. Default 5-minute expiry: long enough for a 25 MB upload on a slow
 * connection, short enough that a leaked URL is not a lasting capability.
 */
export async function presignModelUpload({ expiresIn = 300 } = {}) {
  const storageRef = `uploads/${globalThis.crypto.randomUUID()}.glb`
  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageRef,
      ContentType: 'model/gltf-binary',
    }),
    { expiresIn },
  )
  return { uploadUrl, storageRef }
}

// AI model generation photos (spec 2026-09-30). The browser PUTs each photo
// straight to storage; the signed ContentLength makes S3 refuse a body of any
// other size, so the 10 MB cap holds even though the check runs server-side
// before the upload happens.
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024
const PHOTO_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

const MYSHOPIFY_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

// Keys are generation-photos/<shop>/<uuid>.<ext>, so generations.server.js can
// refuse a photo key that belongs to another shop.
export async function presignPhotoUpload({ shop, contentType, size, expiresIn = 300 }) {
  const shopSegment = typeof shop === 'string' ? shop.toLowerCase() : ''
  if (!MYSHOPIFY_DOMAIN.test(shopSegment)) throw tagged('BAD_PHOTO', `invalid shop for photo upload: ${shop}`)
  const extension = Object.hasOwn(PHOTO_EXTENSIONS, contentType) ? PHOTO_EXTENSIONS[contentType] : null
  if (!extension) throw tagged('BAD_PHOTO', `unsupported photo type: ${contentType}`)
  if (!Number.isInteger(size) || size <= 0 || size > MAX_PHOTO_BYTES) {
    throw tagged('BAD_PHOTO', `photo size out of range: ${size}`)
  }
  const storageRef = `generation-photos/${shopSegment}/${globalThis.crypto.randomUUID()}.${extension}`
  const uploadUrl = await getSignedUrl(
    getClient(),
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageRef,
      ContentType: contentType,
      ContentLength: size,
    }),
    { expiresIn },
  )
  return { uploadUrl, storageRef }
}

/**
 * Short-lived GET URL, handed to OpenAI so it can fetch the photos itself.
 * Server-to-server, so bucket CORS doesn't apply.
 */
export async function presignObjectRead(storageRef, { expiresIn = 3600 } = {}) {
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageRef }),
    { expiresIn },
  )
}

export async function saveModelGlb(storageRef, bytes) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: storageRef,
      Body: bytes,
      ContentType: 'model/gltf-binary',
    }),
  )
}

/**
 * @returns {Promise<Buffer | null>} the stored GLB, or null if the object is gone
 * (so the route can 404). Any other failure — credentials, network, permissions —
 * rethrows: an outage must not masquerade as "model not found".
 */
export async function readModelGlb(storageRef) {
  try {
    const result = await getClient().send(
      new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageRef }),
    )
    return Buffer.from(await result.Body.transformToByteArray())
  } catch (error) {
    const missing =
      error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404
    if (missing) {
      return null
    }
    throw error
  }
}

/**
 * Deletes one stored GLB. Used by the shop/redact purge.
 *
 * An absent object resolves successfully: S3 delete is idempotent by design and
 * a redact webhook can be delivered more than once.
 *
 * Every other failure rethrows. This is load-bearing — `purgeShopData` deletes
 * objects before database rows precisely so that a storage failure aborts the
 * purge with the rows still intact, leaving the retry able to recompute the
 * same object list. Swallowing an error here would defeat that.
 */
export async function deleteModelGlb(storageRef) {
  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: storageRef }),
    )
  } catch (error) {
    const missing =
      error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404
    if (!missing) {
      throw error
    }
  }
}

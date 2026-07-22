import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

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

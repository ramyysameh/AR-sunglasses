import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

/**
 * Object storage for calibrated GLBs, backed by Cloudflare R2 (S3-compatible).
 *
 * Replaces the dev-slice local-disk store: serverless hosting has an ephemeral
 * filesystem, so anything written to disk is gone on the next invocation and every
 * merchant upload would silently vanish. R2 specifically (over S3/Blob) because it
 * charges no egress, and each try-on pulls a multi-MB GLB.
 *
 * `storageRef` (stored on ModelAsset) is the object key.
 */

const BUCKET = process.env.R2_BUCKET

let client = null

/**
 * Built lazily, not at module load: importing this file must not throw when the
 * R2 env vars are absent (builds, tests, and any code path that never touches
 * storage). Failing at import would take down the whole app instead of one request.
 */
function getClient() {
  if (!client) {
    client = new S3Client({
      // R2 ignores region, but the SDK requires one.
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  }
  return client
}

export async function saveModelGlb(storageRef, bytes) {
  await getClient().send(
    new PutObjectCommand({
      Bucket: BUCKET,
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
      new GetObjectCommand({ Bucket: BUCKET, Key: storageRef }),
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

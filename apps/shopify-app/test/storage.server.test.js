import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({ sent: [], nextResult: null, nextError: null }))

vi.mock('@aws-sdk/client-s3', () => {
  class FakeClient {
    async send(command) {
      hoisted.sent.push(command)
      if (hoisted.nextError) throw hoisted.nextError
      return hoisted.nextResult
    }
  }
  class PutObjectCommand {
    constructor(input) {
      this.input = input
      this.type = 'Put'
    }
  }
  class GetObjectCommand {
    constructor(input) {
      this.input = input
      this.type = 'Get'
    }
  }
  class DeleteObjectCommand {
    constructor(input) {
      this.input = input
      this.type = 'Delete'
    }
  }
  return { S3Client: FakeClient, PutObjectCommand, GetObjectCommand, DeleteObjectCommand }
})

process.env.AWS_REGION = 'eu-west-3'
process.env.AWS_ACCESS_KEY_ID = 'key'
process.env.AWS_SECRET_ACCESS_KEY = 'secret'
process.env.S3_BUCKET = 'models-bucket'

const { saveModelGlb, readModelGlb, deleteModelGlb } = await import('../app/storage.server.js')

beforeEach(() => {
  hoisted.sent = []
  hoisted.nextResult = null
  hoisted.nextError = null
})

describe('saveModelGlb', () => {
  it('puts the bytes to the configured bucket under the storage ref', async () => {
    const bytes = Buffer.from([1, 2, 3, 4])
    await saveModelGlb('abc-123.glb', bytes)

    expect(hoisted.sent).toHaveLength(1)
    const cmd = hoisted.sent[0]
    expect(cmd.type).toBe('Put')
    expect(cmd.input.Bucket).toBe('models-bucket')
    expect(cmd.input.Key).toBe('abc-123.glb')
    expect(cmd.input.Body).toBe(bytes)
  })

  it('tags the object as a binary glTF so the engine gets the right content type', () => {
    return saveModelGlb('x.glb', Buffer.from([0])).then(() => {
      expect(hoisted.sent[0].input.ContentType).toBe('model/gltf-binary')
    })
  })
})

describe('readModelGlb', () => {
  it('returns the stored bytes', async () => {
    const stored = new Uint8Array([9, 8, 7])
    hoisted.nextResult = { Body: { transformToByteArray: async () => stored } }

    const bytes = await readModelGlb('abc-123.glb')

    expect(hoisted.sent[0].type).toBe('Get')
    expect(hoisted.sent[0].input.Key).toBe('abc-123.glb')
    expect(Buffer.from(bytes).equals(Buffer.from(stored))).toBe(true)
  })

  it('returns null for a missing object so the route can 404', async () => {
    // R2/S3 raise NoSuchKey rather than returning an empty result.
    hoisted.nextError = Object.assign(new Error('missing'), { name: 'NoSuchKey' })
    expect(await readModelGlb('gone.glb')).toBeNull()
  })

  it('returns null on a 404 status even when the error name differs', async () => {
    hoisted.nextError = Object.assign(new Error('nope'), {
      name: 'NotFound',
      $metadata: { httpStatusCode: 404 },
    })
    expect(await readModelGlb('gone.glb')).toBeNull()
  })

  it('rethrows real failures instead of masking them as a missing model', async () => {
    // A credentials or network fault must not look like "model not found" —
    // that would turn an outage into a silent 404 for every merchant.
    hoisted.nextError = Object.assign(new Error('denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    })
    await expect(readModelGlb('x.glb')).rejects.toThrow('denied')
  })
})

describe('deleteModelGlb', () => {
  it('deletes the object from the configured bucket', async () => {
    await deleteModelGlb('abc-123.glb')

    expect(hoisted.sent).toHaveLength(1)
    const cmd = hoisted.sent[0]
    expect(cmd.type).toBe('Delete')
    expect(cmd.input.Bucket).toBe('models-bucket')
    expect(cmd.input.Key).toBe('abc-123.glb')
  })

  it('treats an already-absent object as success so redact retries are idempotent', async () => {
    hoisted.nextError = Object.assign(new Error('missing'), { name: 'NoSuchKey' })
    await expect(deleteModelGlb('gone.glb')).resolves.toBeUndefined()
  })

  it('rethrows real failures so a purge aborts before touching the database', async () => {
    // AccessDenied is the expected error until s3:DeleteObject is granted.
    // It MUST propagate: swallowing it would let the DB purge proceed and
    // orphan the GLBs whose only index is the rows about to be deleted.
    hoisted.nextError = Object.assign(new Error('denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    })
    await expect(deleteModelGlb('x.glb')).rejects.toThrow('denied')
  })
})

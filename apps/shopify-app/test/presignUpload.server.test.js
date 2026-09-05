import { describe, it, expect, vi } from 'vitest'

// Mock the presigner so no signing/network happens; assert we hand it the right command.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(async () => 'https://bucket.example/signed-put'),
}))

process.env.S3_BUCKET = 'test-bucket'

const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner')
const { presignModelUpload } = await import('../app/storage.server.js')

describe('presignModelUpload', () => {
  it('returns a presigned PUT url and an uploads/-prefixed .glb key', async () => {
    const { uploadUrl, storageRef } = await presignModelUpload()
    expect(uploadUrl).toBe('https://bucket.example/signed-put')
    expect(storageRef).toMatch(/^uploads\/[0-9a-f-]+\.glb$/)

    const cmd = getSignedUrl.mock.calls[0][1]
    expect(cmd.input.Bucket).toBe('test-bucket')
    expect(cmd.input.Key).toBe(storageRef)
    expect(cmd.input.ContentType).toBe('model/gltf-binary')
  })

  it('passes the requested expiry through', async () => {
    await presignModelUpload({ expiresIn: 120 })
    const opts = getSignedUrl.mock.calls.at(-1)[2]
    expect(opts.expiresIn).toBe(120)
  })
})

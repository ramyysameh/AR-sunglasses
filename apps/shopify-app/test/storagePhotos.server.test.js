import { describe, it, expect, vi } from 'vitest'

const signed = vi.hoisted(() => [])
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: async (_client, command, options) => {
    signed.push({ name: command.constructor.name, input: command.input, options })
    return `https://s3.example/${command.input.Key}`
  },
}))

const { presignPhotoUpload, presignObjectRead, MAX_PHOTO_BYTES } = await import('../app/storage.server.js')

const SHOP = 'gen-test.myshopify.com'

describe('presignPhotoUpload', () => {
  it('signs a PUT for an image under generation-photos/<shop>/ with its exact type and length', async () => {
    const { uploadUrl, storageRef } = await presignPhotoUpload({ shop: SHOP, contentType: 'image/webp', size: 1234 })
    expect(storageRef).toMatch(/^generation-photos\/gen-test\.myshopify\.com\/[0-9a-f-]+\.webp$/)
    expect(uploadUrl).toBe(`https://s3.example/${storageRef}`)
    const last = signed.at(-1)
    expect(last.name).toBe('PutObjectCommand')
    expect(last.input).toMatchObject({ Key: storageRef, ContentType: 'image/webp', ContentLength: 1234 })
    expect(last.options).toEqual({ expiresIn: 300 })
  })

  it('maps jpeg and png to their extensions', async () => {
    expect((await presignPhotoUpload({ shop: SHOP, contentType: 'image/jpeg', size: 1 })).storageRef).toMatch(/\.jpg$/)
    expect((await presignPhotoUpload({ shop: SHOP, contentType: 'image/png', size: 1 })).storageRef).toMatch(/\.png$/)
  })

  it('rejects other types and out-of-range sizes', async () => {
    await expect(presignPhotoUpload({ shop: SHOP, contentType: 'image/gif', size: 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    await expect(presignPhotoUpload({ shop: SHOP, contentType: 'image/png', size: 0 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    await expect(presignPhotoUpload({ shop: SHOP, contentType: 'image/png', size: MAX_PHOTO_BYTES + 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    await expect(presignPhotoUpload({ shop: SHOP, contentType: 'image/png', size: 1.5 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    expect(MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024)
  })

  it('rejects prototype keys to prevent bypass', async () => {
    await expect(presignPhotoUpload({ shop: SHOP, contentType: 'constructor', size: 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    await expect(presignPhotoUpload({ shop: SHOP, contentType: '__proto__', size: 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
  })

  it('scopes the key to a valid, lower-cased myshopify domain and refuses anything else', async () => {
    const { storageRef } = await presignPhotoUpload({ shop: 'Gen-Test.MyShopify.com', contentType: 'image/png', size: 1 })
    expect(storageRef.startsWith('generation-photos/gen-test.myshopify.com/')).toBe(true)
    const signedBefore = signed.length
    for (const shop of [undefined, '', 'evil.com', '../x.myshopify.com', 'a/b.myshopify.com', '-x.myshopify.com', 'x.myshopify.com.evil.com']) {
      await expect(presignPhotoUpload({ shop, contentType: 'image/png', size: 1 })).rejects.toMatchObject({ code: 'BAD_PHOTO' })
    }
    expect(signed.length).toBe(signedBefore)
  })

  it('accepts the maximum allowed size', async () => {
    const { storageRef } = await presignPhotoUpload({ shop: SHOP, contentType: 'image/png', size: MAX_PHOTO_BYTES })
    expect(storageRef).toMatch(/^generation-photos\/gen-test\.myshopify\.com\/[0-9a-f-]+\.png$/)
  })
})

describe('presignObjectRead', () => {
  it('signs a one-hour GET for the key', async () => {
    const url = await presignObjectRead('generation-photos/gen-test.myshopify.com/abc.jpg')
    expect(url).toBe('https://s3.example/generation-photos/gen-test.myshopify.com/abc.jpg')
    const last = signed.at(-1)
    expect(last.name).toBe('GetObjectCommand')
    expect(last.options).toEqual({ expiresIn: 3600 })
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const config = JSON.parse(
  readFileSync(fileURLToPath(new URL('../vercel.json', import.meta.url)), 'utf8'),
)

const HASHED_ASSETS = '/tryon/assets/(.*)'

const cacheControlFor = (source) =>
  config.headers
    .find((rule) => rule.source === source)
    ?.headers.find((header) => header.key === 'Cache-Control')?.value

describe('vercel.json cache tiers', () => {
  it('marks the content-hashed engine bundles immutable', () => {
    expect(cacheControlFor(HASHED_ASSETS)).toBe(
      'public, max-age=31536000, immutable',
    )
  })

  it('gives the stable-named models a bounded, revalidating ttl', () => {
    expect(cacheControlFor('/tryon/models/(.*)')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    )
  })

  it('gives the stable-named draco decoder the same bounded ttl', () => {
    // Covers /tryon/draco/gltf/* -- the decoder lives one level deeper than
    // the models do.
    expect(cacheControlFor('/tryon/draco/(.*)')).toBe(
      'public, max-age=86400, stale-while-revalidate=604800',
    )
  })

  it('keeps the entry point revalidating so it can point at new bundles', () => {
    expect(cacheControlFor('/tryon/index.html')).toBe(
      'public, max-age=0, must-revalidate',
    )
  })

  it('never marks a non-content-addressed path immutable', () => {
    // The invariant that makes the whole scheme safe. Only Vite-hashed
    // filenames change when their bytes change; marking a stable name
    // immutable would serve a stale model or decoder for a year after a
    // re-export -- the same stale-asset defect the cache-buster existed to
    // prevent, inverted.
    for (const rule of config.headers) {
      const value =
        rule.headers.find((header) => header.key === 'Cache-Control')?.value ?? ''
      if (value.includes('immutable')) {
        expect(rule.source).toBe(HASHED_ASSETS)
      }
    }
  })
})

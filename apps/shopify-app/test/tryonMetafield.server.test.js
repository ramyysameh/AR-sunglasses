import { describe, it, expect } from 'vitest'
import {
  publishMapping,
  publishMappings,
  unpublishMapping,
  syncStorefrontAccess,
  ACCESS_NAMESPACE,
  ACCESS_KEY,
  TRYON_NAMESPACE,
  TRYON_KEY,
} from '../app/tryonMetafield.server.js'

// A stub Admin client that records every call and replies with the payloads the
// test hands it, one per call.
function stubAdmin(...responses) {
  const calls = []
  let i = 0
  return {
    calls,
    graphql: async (query, opts) => {
      calls.push({ query, variables: opts?.variables })
      const body = responses[Math.min(i++, responses.length - 1)] ?? {}
      return new Response(JSON.stringify(body))
    },
  }
}

const ok = (field) => ({ data: { [field]: { userErrors: [] } } })

describe('publishMappings', () => {
  it('sets the app-owned boolean metafield on each product', async () => {
    const admin = stubAdmin(ok('metafieldsSet'))
    await publishMapping(admin, 'gid://shopify/Product/1')

    expect(admin.calls).toHaveLength(1)
    expect(admin.calls[0].variables.metafields).toEqual([
      {
        ownerId: 'gid://shopify/Product/1',
        namespace: TRYON_NAMESPACE,
        key: TRYON_KEY,
        type: 'boolean',
        value: 'true',
      },
    ])
  })

  it('makes no call for an empty list', async () => {
    const admin = stubAdmin(ok('metafieldsSet'))
    await publishMappings(admin, [])
    expect(admin.calls).toHaveLength(0)
  })

  it('de-duplicates product ids', async () => {
    const admin = stubAdmin(ok('metafieldsSet'))
    await publishMappings(admin, ['gid://shopify/Product/1', 'gid://shopify/Product/1'])
    expect(admin.calls[0].variables.metafields).toHaveLength(1)
  })

  // metafieldsSet caps at 25 per call, so the backfill must not hand Shopify a
  // shop's whole mapping list in one mutation.
  it('batches in groups of 25', async () => {
    const admin = stubAdmin(ok('metafieldsSet'))
    const ids = Array.from({ length: 26 }, (_, n) => `gid://shopify/Product/${n}`)
    await publishMappings(admin, ids)

    expect(admin.calls).toHaveLength(2)
    expect(admin.calls[0].variables.metafields).toHaveLength(25)
    expect(admin.calls[1].variables.metafields).toHaveLength(1)
  })

  it('throws a tagged error on userErrors', async () => {
    const admin = stubAdmin({ data: { metafieldsSet: { userErrors: [{ message: 'nope' }] } } })
    await expect(publishMapping(admin, 'gid://shopify/Product/1')).rejects.toMatchObject({
      code: 'METAFIELD_SET_FAILED',
      message: 'nope',
    })
  })

  it('throws on a top-level GraphQL error too', async () => {
    const admin = stubAdmin({ errors: [{ message: 'Throttled' }] })
    await expect(publishMapping(admin, 'gid://shopify/Product/1')).rejects.toMatchObject({
      code: 'METAFIELD_SET_FAILED',
    })
  })
})

describe('unpublishMapping', () => {
  it('deletes by owner, namespace and key', async () => {
    const admin = stubAdmin(ok('metafieldsDelete'))
    await unpublishMapping(admin, 'gid://shopify/Product/7')

    expect(admin.calls[0].variables.metafields).toEqual([
      { ownerId: 'gid://shopify/Product/7', namespace: TRYON_NAMESPACE, key: TRYON_KEY },
    ])
  })

  // Unmapping a product the merchant already deleted must not fail: the end
  // state we want (no metafield) is the state we are in.
  it('treats an already-missing metafield as success', async () => {
    const admin = stubAdmin({
      data: { metafieldsDelete: { userErrors: [{ message: 'Metafield does not exist.' }] } },
    })
    await expect(unpublishMapping(admin, 'gid://shopify/Product/7')).resolves.toBeUndefined()
  })

  it('still throws on a real failure', async () => {
    const admin = stubAdmin({
      data: { metafieldsDelete: { userErrors: [{ message: 'Throttled' }] } },
    })
    await expect(unpublishMapping(admin, 'gid://shopify/Product/7')).rejects.toMatchObject({
      code: 'METAFIELD_DELETE_FAILED',
    })
  })
})

describe('namespace', () => {
  // The Liquid block reads block.settings.product.metafields["$app:tryon"].enabled.
  // If either half moves, the storefront gate silently stops matching.
  it('matches the reserved prefix the theme block reads', () => {
    expect(TRYON_NAMESPACE).toBe('$app:tryon')
    expect(TRYON_KEY).toBe('enabled')
  })
})

describe('syncStorefrontAccess', () => {
  const installation = { data: { currentAppInstallation: { id: 'gid://shopify/AppInstallation/9' } } }
  const identifier = { ownerId: 'gid://shopify/AppInstallation/9', namespace: ACCESS_NAMESPACE, key: ACCESS_KEY }

  it('records when a lapsed shop\'s grace ends, on the app installation', async () => {
    const admin = stubAdmin(installation, ok('metafieldsSet'))
    await syncStorefrontAccess(admin, new Date('2026-10-03T12:00:00Z'))

    expect(admin.calls[1].query).toContain('metafieldsSet')
    expect(admin.calls[1].variables.metafields).toEqual([
      { ...identifier, type: 'date_time', value: '2026-10-03T12:00:00.000Z' },
    ])
  })

  it('clears the limit once the plan is active again', async () => {
    const admin = stubAdmin(installation, ok('metafieldsDelete'))
    await syncStorefrontAccess(admin, null)

    expect(admin.calls[1].query).toContain('metafieldsDelete')
    expect(admin.calls[1].variables.metafields).toEqual([identifier])
  })

  it('treats an already-missing limit as cleared', async () => {
    const admin = stubAdmin(installation, {
      data: { metafieldsDelete: { userErrors: [{ field: null, message: 'Metafield not found' }] } },
    })
    await expect(syncStorefrontAccess(admin, null)).resolves.toBeUndefined()
  })

  it('fails loudly when the installation cannot be resolved or the write is refused', async () => {
    await expect(syncStorefrontAccess(stubAdmin({ data: {} }), null)).rejects.toMatchObject({ code: 'APP_INSTALLATION_MISSING' })
    const refused = stubAdmin(installation, {
      data: { metafieldsSet: { userErrors: [{ field: 'value', message: 'invalid' }] } },
    })
    await expect(syncStorefrontAccess(refused, new Date())).rejects.toMatchObject({ code: 'METAFIELD_SET_FAILED' })
  })
})

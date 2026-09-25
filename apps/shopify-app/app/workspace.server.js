import QRCode from 'qrcode'
import prisma from './db.server.js'
import { themeEditorUrl, previewUrl } from './adminLinks.server.js'
import { getActivePlanName } from './billing.server.js'
import { listMappings } from './models.server.js'
import { planUsage } from './planUsage.server.js'
import { fetchProductsByIds } from './products.server.js'
import { publishMappings } from './tryonMetafield.server.js'
import { productStatus } from './tryonStatus.server.js'

const STATUS_PRIORITY = {
  'model-issue': 0,
  'review-fit': 1,
  'add-to-theme': 2,
  live: 3,
}

export function normalizeWorkspaceStatus(status) {
  const id = typeof status === 'string' ? status : status?.id
  if (id === 'live') return 'live'
  if (id === 'not_on_theme' || id === 'add-to-theme') return 'add-to-theme'
  // A model that needs its fit reviewed is not broken: it keeps the same
  // "Review fit" name and warning weight it has on the Models page, and
  // resolves through the fit review rather than a model swap.
  if (id === 'check_fit' || id === 'review-fit') return 'review-fit'
  return 'model-issue'
}

export function workspaceCounts(mappings) {
  const live = mappings.filter((mapping) => mapping.status === 'live').length
  return { all: mappings.length, live, needsAttention: mappings.length - live }
}

export function sortWorkspaceMappings(mappings) {
  return [...mappings].sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])
}

export function workspaceGuide({ assets, mappings, usage }) {
  if (!assets.length) {
    return {
      kind: 'setup',
      title: 'Upload your first model',
      detail: 'Add a ready-to-use eyewear model.',
      action: { id: 'add-try-on', label: 'Upload model' },
    }
  }
  if (!mappings.length) {
    return {
      kind: 'setup',
      title: 'Add try-on to a product',
      detail: 'Choose a model, then a Shopify product.',
      action: { id: 'add-try-on', label: 'Add try-on' },
    }
  }
  const issue = mappings.find((mapping) => mapping.status === 'model-issue')
  if (issue) {
    return {
      kind: 'recovery',
      title: 'A model needs attention',
      detail: issue.product?.title,
      action: { id: 'choose-model', mappingId: issue.id, label: 'Choose model' },
    }
  }
  const review = mappings.find((mapping) => mapping.status === 'review-fit')
  if (review) {
    return {
      kind: 'recovery',
      title: 'Review how a model fits',
      detail: review.product?.title,
      action: { id: 'review-fit', mappingId: review.id, label: 'Review fit' },
    }
  }
  const theme = mappings.find((mapping) => mapping.status === 'add-to-theme')
  if (theme) {
    return {
      kind: 'recovery',
      title: 'Finish storefront setup',
      detail: theme.product?.title,
      action: { id: 'theme', href: theme.themeUrl, label: 'Add to theme' },
    }
  }
  if (usage.atLimit) {
    return {
      kind: 'recovery',
      title: 'Your plan limit is reached',
      detail: 'Upgrade before adding another product.',
      action: { id: 'plans', href: usage.pricingUrl, label: 'View plans' },
    }
  }
  return {
    kind: 'complete',
    title: 'Everything is live',
    detail: `${mappings.length} ${mappings.length === 1 ? 'product is' : 'products are'} ready`,
    action: null,
  }
}

export function emptyWorkspace(shop) {
  const assets = []
  const mappings = []
  const usage = planUsage({ planName: null, used: 0, shop })
  return {
    assets,
    mappings,
    counts: workspaceCounts(mappings),
    usage,
    guide: workspaceGuide({ assets, mappings, usage }),
    themeUrl: themeEditorUrl(shop),
  }
}

export async function loadWorkspace({ admin, shop, engineUrl }) {
  const activePlan = await getActivePlanName(admin, shop)
  if (!activePlan) return emptyWorkspace(shop)

  const [rawMappings, assets] = await Promise.all([
    listMappings(prisma, shop),
    prisma.modelAsset.findMany({ where: { shop }, orderBy: { createdAt: 'desc' } }),
  ])

  try {
    await publishMappings(admin, rawMappings.map((mapping) => mapping.productId))
  } catch (error) {
    console.error('try-on metafield sync failed', error)
  }

  let products = new Map()
  try {
    products = await fetchProductsByIds(admin, rawMappings.map((mapping) => mapping.productId))
  } catch (error) {
    console.error('product enrichment failed', error)
  }

  const enriched = await Promise.all(rawMappings.map(async (mapping) => {
    const merchantStatus = productStatus(mapping)
    const status = normalizeWorkspaceStatus(merchantStatus)
    const product = products.get(mapping.productId) ?? null
    const mappingThemeUrl = themeEditorUrl(shop, product?.handle || mapping.productHandle)
    const base = {
      ...mapping,
      product,
      modelAsset: mapping.modelAsset,
      status,
      merchantStatus,
      themeUrl: mappingThemeUrl,
    }

    try {
      const url = previewUrl({ engineUrl, shop, productId: mapping.productId })
      return {
        ...base,
        previewUrl: url,
        qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }),
      }
    } catch (error) {
      console.error('preview URL/QR generation failed', error)
      return { ...base, previewUrl: null, qr: null }
    }
  }))

  const mappings = sortWorkspaceMappings(enriched)
  const usage = planUsage({ planName: activePlan, used: mappings.length, shop })

  return {
    assets,
    mappings,
    counts: workspaceCounts(mappings),
    usage,
    guide: workspaceGuide({ assets, mappings, usage }),
    themeUrl: themeEditorUrl(shop),
  }
}

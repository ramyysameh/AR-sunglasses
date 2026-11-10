import QRCode from 'qrcode'
import prisma from './db.server.js'
import { themeEditorUrl, embedActivationUrl, previewUrl } from './adminLinks.server.js'
import { getActivePlanName } from './billing.server.js'
import { listMappings } from './models.server.js'
import { planUsage } from './planUsage.server.js'
import { fetchProductsByIds } from './products.server.js'
import { publishMappings } from './tryonMetafield.server.js'
import { isOnTheme, productStatus } from './tryonStatus.server.js'
import {
  normalizeWorkspaceStatus,
  setupSteps,
  sortWorkspaceMappings,
  workspaceCounts,
  workspaceGuide,
} from './workspaceState.js'

// The pure helpers live in workspaceState.js (the browser uses them too);
// re-exported so existing server imports keep working.
export { normalizeWorkspaceStatus, setupSteps, sortWorkspaceMappings, workspaceCounts, workspaceGuide }

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
    setup: setupSteps({ assets, mappings, storeLive: false }),
    embedUrl: embedActivationUrl(shop),
    storefrontUrl: `https://${shop}`,
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

  const storeLive = rawMappings.some((mapping) => isOnTheme(mapping))
  const embedUrl = embedActivationUrl(shop)

  const enriched = await Promise.all(rawMappings.map(async (mapping) => {
    const merchantStatus = productStatus(mapping, { storeLive })
    const status = normalizeWorkspaceStatus(merchantStatus)
    const product = products.get(mapping.productId) ?? null
    const base = {
      ...mapping,
      product,
      modelAsset: mapping.modelAsset,
      status,
      merchantStatus,
      themeUrl: embedUrl,
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
  const handle = rawMappings.find((mapping) => mapping.productHandle)?.productHandle
    ?? enriched.find((mapping) => mapping.product?.handle)?.product.handle
  const storefrontUrl = handle ? `https://${shop}/products/${handle}` : `https://${shop}`

  return {
    assets,
    mappings,
    counts: workspaceCounts(mappings),
    usage,
    guide: workspaceGuide({ assets, mappings, usage }),
    themeUrl: themeEditorUrl(shop),
    setup: setupSteps({ assets, mappings, storeLive }),
    embedUrl,
    storefrontUrl,
  }
}

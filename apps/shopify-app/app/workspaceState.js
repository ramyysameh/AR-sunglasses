// Pure workspace state helpers: no database, no Shopify calls. Kept out of
// *.server.js so the Workspace page can recompute setup, statuses and the guide
// in the browser once App Bridge confirms the app embed is switched on.

const isReadyAsset = (asset) => Boolean(asset.fitReviewedAt) || String(asset.status).toLowerCase() === 'ready'

/**
 * The three setup steps on the home page: create models, save one (which maps
 * it to its product), switch try-on on in the store. Each is done/current/upcoming.
 */
export function setupSteps({ assets, mappings, storeLive }) {
  // A mapped product proves a model was created, even if that model is no longer
  // listed as ready (existing merchants), so it counts for step one too.
  const done = [assets.some(isReadyAsset) || mappings.length > 0, mappings.length > 0, storeLive]
  const current = done.indexOf(false)
  const titles = [
    ['create', 'Create 3D models'],
    ['save', 'Review and save'],
    ['turn-on', 'Turn on try-on in your store'],
  ]
  return {
    done: current === -1,
    steps: titles.map(([id, title], i) => ({
      id,
      title,
      state: done[i] ? 'done' : i === current ? 'current' : 'upcoming',
    })),
  }
}

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
      title: 'Turn on try-on in your store',
      detail: 'In the theme editor, click Save.',
      action: { id: 'theme', mappingId: theme.id, href: theme.themeUrl, label: 'Turn on try-on' },
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

// Liquid file names in extensions/tryon-button/blocks. Either one being active
// on the published theme means shoppers can see the Try-on button.
const TRYON_BLOCK_HANDLES = new Set(['tryon_embed', 'tryon_button'])

/**
 * Reads App Bridge's `shopify.app.extensions()` result. true when the try-on
 * embed (or the older product-page block) is active on the published theme,
 * false when Shopify says it is not, null when the answer is missing or
 * malformed (old App Bridge, outside the admin) so callers keep the
 * proof-of-life signal instead.
 * @param {unknown} extensions
 * @returns {boolean|null}
 */
export function tryOnActiveFromExtensions(extensions) {
  if (!Array.isArray(extensions)) return null
  const theme = extensions.filter((extension) => extension?.type === 'theme_app_extension')
  if (!theme.length) return null
  return theme.some((extension) => (extension.activations ?? []).some(
    (block) => TRYON_BLOCK_HANDLES.has(block?.handle) && block?.status === 'active',
  ))
}

/**
 * The loader decides "live" from proof-of-life (the button has rendered on a
 * product page), which lags right after the merchant switches the embed on.
 * When App Bridge confirms the embed is active, mark setup step 3 done and the
 * "Not live yet" rows live, then rebuild the counts and guide from that.
 * Only ever upgrades: a false/null answer leaves the loader's view untouched.
 * @template {{ assets: any[], mappings: any[], usage: any, setup: any, counts: any, guide: any }} T
 * @param {T} data
 * @param {boolean|null} embedActive
 * @returns {T}
 */
export function withEmbedActive(data, embedActive) {
  if (embedActive !== true || !data?.setup) return data
  const mappings = sortWorkspaceMappings(data.mappings.map((mapping) => (
    mapping.status === 'add-to-theme' ? { ...mapping, status: 'live' } : mapping
  )))
  return {
    ...data,
    mappings,
    counts: workspaceCounts(mappings),
    guide: workspaceGuide({ assets: data.assets, mappings, usage: data.usage }),
    setup: setupSteps({ assets: data.assets, mappings, storeLive: true }),
  }
}

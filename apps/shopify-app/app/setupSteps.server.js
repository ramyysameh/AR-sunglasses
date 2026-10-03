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

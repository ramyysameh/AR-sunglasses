import path from 'node:path'
import { glassesConfig } from '../src/config/arConfig.js'
import {
  DEFAULT_FRAME_WIDTH_METERS,
  exportSceneGlb,
  formatVector,
  loadGlbScene,
  measureScene,
  normalizeSceneToFrameWidth,
} from './model-utils.mjs'

async function normalizeModel(key, config) {
  const source = path.join('public', config.modelPath)
  const output = path.join('public', config.normalizedModelPath ?? `models/normalized/${key}.glb`)
  const targetFrameWidth = config.frameWidthMeters ?? DEFAULT_FRAME_WIDTH_METERS
  const depthPivot = config.depthPivot ?? 'frontMaxZ'

  const scene = await loadGlbScene(source)
  const before = measureScene(scene)
  const normalization = normalizeSceneToFrameWidth(scene, { targetFrameWidth, depthPivot })
  const after = measureScene(scene)

  await exportSceneGlb(scene, output)

  return {
    key,
    source,
    output,
    targetFrameWidth,
    depthPivot,
    sourceWidth: normalization.sourceWidth,
    scaleFactor: normalization.scaleFactor,
    before: {
      size: formatVector(before.size),
      meshes: before.meshes,
      vertices: before.vertices,
    },
    after: {
      size: formatVector(after.size),
      meshes: after.meshes,
      vertices: after.vertices,
    },
  }
}

const results = []
for (const [key, config] of Object.entries(glassesConfig)) {
  if (!config.modelPath || !config.normalizedModelPath) {
    continue
  }

  try {
    results.push(await normalizeModel(key, config))
  } catch (error) {
    results.push({
      key,
      error: error.message,
    })
  }
}

for (const result of results) {
  console.log(JSON.stringify(result))
}

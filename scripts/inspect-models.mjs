import path from 'node:path'
import { glassesConfig } from '../src/config/arConfig.js'
import { formatVector, loadGlbScene, measureScene, readGlbJson } from './model-utils.mjs'

async function inspectModel(key, config, sourceKind, file) {
  const result = {
    key,
    sourceKind,
    file,
    exists: true,
    dracoCompressed: false,
  }

  try {
    const json = await readGlbJson(file)
    result.extensionsUsed = json.extensionsUsed ?? []
    result.dracoCompressed = JSON.stringify(json).includes('KHR_draco_mesh_compression')
  } catch (error) {
    result.exists = false
    result.error = error.message
    return result
  }

  try {
    const scene = await loadGlbScene(file)
    const measurement = measureScene(scene)
    result.meshes = measurement.meshes
    result.vertices = measurement.vertices
    result.bounds = {
      min: formatVector(measurement.box.min),
      max: formatVector(measurement.box.max),
      size: formatVector(measurement.size),
    }
    result.frameWidthMeters = config.frameWidthMeters ?? null
    result.depthPivot = config.depthPivot ?? 'center'
  } catch (error) {
    result.loadError = error.message
  }

  return result
}

const inspections = []
for (const [key, config] of Object.entries(glassesConfig)) {
  const files = [
    ['source', config.modelPath],
    ['optimized', config.optimizedModelPath],
    ['normalized', config.normalizedModelPath],
  ].filter(([, file]) => Boolean(file))

  for (const [sourceKind, file] of files) {
    inspections.push(await inspectModel(key, config, sourceKind, path.join('public', file)))
  }
}

for (const inspection of inspections) {
  console.log(JSON.stringify(inspection))
}

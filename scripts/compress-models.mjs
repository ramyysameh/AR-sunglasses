/**
 * Produces Draco-compressed runtime GLBs from the normalized glasses models.
 *
 * The normalized models in public/models/normalized are the canonical, full-precision
 * assets used by the Node tooling (inspect/validate/normalize). This script welds,
 * dedups, prunes, and Draco-compresses them into small runtime files that the browser
 * loads via GlassesModelLoader's DRACOLoader.
 *
 * Geometry is unchanged: Draco quantization on a ~0.145 m frame is sub-10-micron,
 * well below any perceptible fit difference.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, weld, draco } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { glassesConfig } from '../src/config/arConfig.js'

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  })

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

async function compress(key, config) {
  const sourceRel = config.normalizedModelPath
  const outputRel = config.runtimeModelPath ?? `models/${key}-draco.glb`
  const sourcePath = path.join('public', sourceRel)
  const outputPath = path.join('public', outputRel)

  const before = (await fs.stat(sourcePath)).size

  const document = await io.read(sourcePath)
  await document.transform(dedup(), weld(), prune(), draco())
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await io.write(outputPath, document)

  const after = (await fs.stat(outputPath)).size

  return {
    key,
    source: sourcePath,
    output: outputPath,
    before: formatBytes(before),
    after: formatBytes(after),
    reduction: `${(100 * (1 - after / before)).toFixed(1)}%`,
  }
}

for (const [key, config] of Object.entries(glassesConfig)) {
  if (!config.normalizedModelPath) {
    continue
  }

  try {
    const result = await compress(key, config)
    console.log(JSON.stringify(result))
  } catch (error) {
    console.error(`Failed to compress ${key}:`, error.message)
    process.exitCode = 1
  }
}

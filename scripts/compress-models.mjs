/**
 * Produces normalized, Draco-compressed runtime GLBs directly from the textured
 * SOURCE models.
 *
 * Why not from public/models/normalized? Those were generated with three.js'
 * Node GLTF exporter, which can't load the source's embedded texture blobs and
 * silently strips them (the frames come out white). gltf-transform loads textures
 * correctly, so we normalize + compress from source here and keep the texture.
 *
 * Normalization matches the original pipeline: scale the frame to TARGET_FRAME_WIDTH
 * and place the front of the frame at z=0 (frontMaxZ pivot). The scale is applied as
 * a node transform — the mesh-local vertex coordinates stay at source scale, which
 * the temple-fade shader (GlassesModelLoader) depends on.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { NodeIO, getBounds } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, weld, draco } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import { glassesConfig } from '../src/config/arConfig.js'

const TARGET_FRAME_WIDTH = 0.145

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
  const sourceRel = config.modelPath
  const outputRel = config.runtimeModelPath ?? `models/${key}-draco.glb`
  const sourcePath = path.join('public', sourceRel)
  const outputPath = path.join('public', outputRel)

  const before = (await fs.stat(sourcePath)).size

  const document = await io.read(sourcePath)
  const root = document.getRoot()
  const scene = root.listScenes()[0]

  // Normalize: scale to target frame width, front of frame (max Z) at the origin.
  const { min, max } = getBounds(scene)
  const width = max[0] - min[0]
  const scaleFactor = TARGET_FRAME_WIDTH / width
  const pivot = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, max[2]]

  const wrapper = document.createNode(`${key}-normalize`)
    .setScale([scaleFactor, scaleFactor, scaleFactor])
    .setTranslation([-pivot[0] * scaleFactor, -pivot[1] * scaleFactor, -pivot[2] * scaleFactor])

  for (const child of scene.listChildren()) {
    scene.removeChild(child)
    wrapper.addChild(child)
  }
  scene.addChild(wrapper)

  // weld + dedup shrink geometry; draco compresses mesh. Textures are preserved
  // as-is (source JPEG). Shrinking them further (resize + WebP via gltf-transform
  // textureCompress) needs a working `sharp` build — deferred, see TEXTURE NOTE below.
  await document.transform(dedup(), weld(), draco())
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await io.write(outputPath, document)

  const after = (await fs.stat(outputPath)).size
  const textures = root.listTextures().length

  return {
    key,
    source: sourcePath,
    output: outputPath,
    before: formatBytes(before),
    after: formatBytes(after),
    textures,
    worldWidth: +( (max[0] - min[0]) * scaleFactor ).toFixed(4),
  }
}

for (const [key, config] of Object.entries(glassesConfig)) {
  if (!config.modelPath) {
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

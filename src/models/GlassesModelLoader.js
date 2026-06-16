/**
 * Loads GLB/GLTF glasses assets, recenters the pivot, and applies SKU-specific transforms.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { getGlassesConfig } from '../config/arConfig.js'

/**
 * Fades the rear of the temple arms to transparent based on the model's local Z.
 * The ear-hook tips can't be hidden by a face occluder (the MediaPipe face mesh
 * has no ears/hair), so we taper them out instead of letting them clip the cheeks.
 * Operates in model-local space, so it holds at any head angle with no per-frame cost.
 * @param {THREE.MeshStandardMaterial} material
 * @param {{ start: number, end: number }} fade start = last fully-opaque local Z; end = fully-gone (more negative)
 */
function applyTempleFade(material, fade) {
  material.transparent = true
  material.customProgramCacheKey = () => `templeFade:${fade.start}:${fade.end}`
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTempleFadeStart = { value: fade.start }
    shader.uniforms.uTempleFadeEnd = { value: fade.end }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vTempleZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vTempleZ = position.z;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vTempleZ;\nuniform float uTempleFadeStart;\nuniform float uTempleFadeEnd;')
      .replace(
        '#include <dithering_fragment>',
        '  float templeFade = smoothstep(uTempleFadeEnd, uTempleFadeStart, vTempleZ);\n  if (templeFade <= 0.002) discard;\n  gl_FragColor.a *= templeFade;\n#include <dithering_fragment>'
      )
  }
}

export class GlassesModelLoader {
  constructor(options = {}) {
    this.dracoDecoderPath = options.dracoDecoderPath ?? 'draco/gltf/'
    this.loader = null
    this.dracoLoader = null
    this.cache = new Map()
  }

  async init() {
    if (!this.loader) {
      this.dracoLoader = new DRACOLoader()
      this.dracoLoader.setDecoderPath(this.dracoDecoderPath)

      this.loader = new GLTFLoader()
      this.loader.setDRACOLoader(this.dracoLoader)
    }

    return this
  }

  dispose() {
    this.dracoLoader?.dispose()
    this.dracoLoader = null
    this.loader = null
  }

  async load(url, configKey) {
    if (!this.loader) {
      await this.init()
    }

    const cacheKey = `${url}::${configKey ?? 'default'}`

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey).clone(true)
    }

    const gltf = await this.loader.loadAsync(url)
    const model = gltf.scene ?? gltf.scenes?.[0]
    const modelConfig = getGlassesConfig(configKey)
    const materialProfile = modelConfig.materialProfile ?? {}
    const templeFade = modelConfig.templeFade ?? { start: -0.08, end: -0.12 }

    if (!model) {
      throw new Error(`No scene found in model: ${url}`)
    }

    model.traverse((node) => {
      const child = /** @type {THREE.Mesh} */ (node)
      if (!child.isMesh) {
        return
      }

      child.frustumCulled = false

      const materials = Array.isArray(child.material) ? child.material : [child.material]
      for (const baseMaterial of materials) {
        if (!baseMaterial) {
          continue
        }

        // Glasses use PBR (standard/physical) materials, which expose map,
        // roughness, metalness, etc. that the base Material type does not.
        const material = /** @type {THREE.MeshStandardMaterial} */ (baseMaterial)

        if (material?.map) {
          material.map.colorSpace = THREE.SRGBColorSpace
          material.map.needsUpdate = true
        }

        if ('roughness' in material && Number.isFinite(materialProfile.frameRoughness)) {
          material.roughness = materialProfile.frameRoughness ?? 0.38
        }

        if ('metalness' in material && Number.isFinite(materialProfile.frameMetalness)) {
          material.metalness = materialProfile.frameMetalness ?? 0.12
        }

        const materialName = `${material.name ?? ''} ${child.name ?? ''}`.toLowerCase()
        if (materialName.includes('lens') || materialName.includes('glass')) {
          if ('roughness' in material) {
            material.roughness = materialProfile.lensRoughness ?? 0.08
          }

          if ('transparent' in material) {
            material.transparent = true
          }

          if ('opacity' in material) {
            material.opacity = materialProfile.lensOpacity ?? 0.62
          }
        }

        applyTempleFade(material, templeFade)
        material.needsUpdate = true
      }
    })

    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const pivot = center.clone()
    const shouldRecenter = !modelConfig.useNormalizedModel

    if (modelConfig.depthPivot === 'frontMaxZ') {
      pivot.z = box.max.z
    } else if (modelConfig.depthPivot === 'frontMinZ') {
      pivot.z = box.min.z
    }

    if (shouldRecenter) {
      model.traverse((child) => {
        if (child.parent === model) {
          child.position.sub(pivot)
        }
      })
    }

    const finalBox = new THREE.Box3().setFromObject(model)
    const finalSize = finalBox.getSize(new THREE.Vector3())
    const frameWidthMeters = Number.isFinite(modelConfig.frameWidthMeters)
      ? modelConfig.frameWidthMeters
      : finalSize.x

    model.userData.naturalWidth = frameWidthMeters
    model.userData.naturalHeight = finalSize.y
    model.userData.naturalDepth = finalSize.z
    model.userData.frameWidthMeters = frameWidthMeters
    model.userData.frontFrameBounds = {
      width: frameWidthMeters,
      height: finalSize.y,
      depth: finalSize.z,
    }
    model.userData.rawBounds = {
      min: box.min.toArray(),
      max: box.max.toArray(),
      size: size.toArray(),
    }
    model.userData.normalizedBounds = {
      min: finalBox.min.toArray(),
      max: finalBox.max.toArray(),
      size: finalSize.toArray(),
    }

    model.userData.depthPivot = modelConfig.depthPivot ?? 'center'
    model.userData.configKey = configKey
    model.userData.sourceUrl = url

    this.cache.set(cacheKey, model)

    return model.clone(true)
  }
}

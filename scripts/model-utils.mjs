import fs from 'node:fs/promises'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'

export const DEFAULT_FRAME_WIDTH_METERS = 0.145

export function installFileReaderPolyfill() {
  globalThis.self ??= globalThis

  if (globalThis.FileReader) {
    return
  }

  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer()
        .then((buffer) => {
          this.result = buffer
          this.onloadend?.({ target: this })
        })
        .catch((error) => this.onerror?.(error))
    }

    readAsDataURL(blob) {
      blob.arrayBuffer()
        .then((buffer) => {
          this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`
          this.onloadend?.({ target: this })
        })
        .catch((error) => this.onerror?.(error))
    }
  }
}

export async function readGlbJson(file) {
  const data = await fs.readFile(file)
  const magic = data.toString('utf8', 0, 4)

  if (magic !== 'glTF') {
    throw new Error(`${file} is not a binary GLB`)
  }

  const jsonChunkLength = data.readUInt32LE(12)
  const jsonChunkType = data.toString('utf8', 16, 20).trim()

  if (jsonChunkType !== 'JSON') {
    throw new Error(`${file} does not start with a JSON chunk`)
  }

  return JSON.parse(data.toString('utf8', 20, 20 + jsonChunkLength))
}

export async function loadGlbScene(file) {
  installFileReaderPolyfill()

  const data = await fs.readFile(file)
  const loader = new GLTFLoader()
  const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)

  const gltf = await new Promise((resolve, reject) => {
    loader.parse(arrayBuffer, `${path.dirname(file).replaceAll('\\', '/')}/`, resolve, reject)
  })

  const scene = gltf.scene ?? gltf.scenes?.[0]
  if (!scene) {
    throw new Error(`No scene found in ${file}`)
  }

  return scene
}

export function measureScene(scene) {
  const box = new THREE.Box3().setFromObject(scene)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  let meshes = 0
  let vertices = 0

  scene.traverse((child) => {
    if (!child.isMesh) {
      return
    }

    meshes += 1
    vertices += child.geometry?.attributes?.position?.count ?? 0
  })

  return {
    box,
    size,
    center,
    meshes,
    vertices,
  }
}

export function normalizeSceneToFrameWidth(scene, options = {}) {
  const targetFrameWidth = options.targetFrameWidth ?? DEFAULT_FRAME_WIDTH_METERS
  const depthPivot = options.depthPivot ?? 'frontMaxZ'
  const measurement = measureScene(scene)
  const sourceWidth = measurement.size.x

  if (!Number.isFinite(sourceWidth) || sourceWidth <= 0) {
    throw new Error('Cannot normalize model with invalid source width')
  }

  const pivot = measurement.center.clone()
  if (depthPivot === 'frontMaxZ') {
    pivot.z = measurement.box.max.z
  } else if (depthPivot === 'frontMinZ') {
    pivot.z = measurement.box.min.z
  }

  const scaleFactor = targetFrameWidth / sourceWidth

  scene.traverse((child) => {
    if (child.parent === scene) {
      child.position.sub(pivot).multiplyScalar(scaleFactor)
      child.scale.multiplyScalar(scaleFactor)
      child.updateMatrixWorld(true)
    }
  })

  scene.userData.normalization = {
    targetFrameWidth,
    sourceWidth,
    scaleFactor,
    depthPivot,
    sourceBounds: {
      min: measurement.box.min.toArray(),
      max: measurement.box.max.toArray(),
      size: measurement.size.toArray(),
    },
  }

  return {
    sourceWidth,
    scaleFactor,
    depthPivot,
  }
}

export async function exportSceneGlb(scene, outFile) {
  installFileReaderPolyfill()
  const exporter = new GLTFExporter()
  const glb = await new Promise((resolve, reject) => {
    exporter.parse(scene, resolve, reject, {
      binary: true,
      onlyVisible: false,
      truncateDrawRange: false,
    })
  })

  await fs.mkdir(path.dirname(outFile), { recursive: true })
  await fs.writeFile(outFile, Buffer.from(glb))
}

export function formatVector(vector) {
  return vector.toArray().map((value) => Number(value.toFixed(6)))
}

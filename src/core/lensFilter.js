/**
 * Colour-filter lenses: tint the face behind a clear lens the way glass does.
 *
 * Why this exists. A GLB lens authored as glass (KHR_materials_transmission)
 * MULTIPLIES what is behind it by its colour: an orange lens passes red, blocks
 * blue, and the eyes stay bright and visible, just orange. The engine cannot use
 * transmission (it stalls WebGL, and the camera feed is a separate <video> the
 * GPU never sees), so it drew every lens as a semi-transparent layer of paint.
 * For a dark smoke lens that is close enough. For a bright, saturated, highly
 * transmissive tint it is not: one alpha value cannot pass red while blocking
 * blue, so the lens came out as an opaque-looking orange smear over the eyes.
 *
 * How. The browser CAN multiply per channel: CSS `mix-blend-mode: multiply`.
 * So a filter lens gets a tint-only twin mesh on FILTER_LAYER. Each frame the
 * twins (plus the depth-only head occluders, so the far lens still hides behind
 * the nose) are rendered over opaque white, copied onto a 2D canvas that sits
 * between the video and the 3D canvas, and that canvas multiplies the video.
 * White multiplies to nothing, so everywhere but the lenses is untouched. The
 * lens itself stays in the main pass at a low opacity, which keeps its
 * reflections, Fresnel rim and gradient.
 *
 * Only lenses that really are clear glass take this path (transmission >=
 * FILTER_MIN_TRANSMISSION, untextured, not authored as alpha). Dark smoke
 * lenses (transmission ~0.35-0.42 on the AI models) keep deriveLensOpacity, which
 * was tuned for them. ?lensfilter=0 turns the filter off everywhere.
 */
import * as THREE from 'three'

export const FILTER_LAYER = 1
export const FILTER_MIN_TRANSMISSION = 0.5
// What is left of the lens in the main pass: enough to carry reflections and a
// hint of the lens surface, without painting colour back over the filtered eye.
export const FILTER_RESIDUAL_MIN = 0.08
export const FILTER_RESIDUAL_MAX = 0.3

/**
 * @param {string} search
 * @returns {boolean}
 */
export function isLensFilterEnabled(search) {
  return new URLSearchParams(search).get('lensfilter') !== '0'
}

/**
 * Reads a lens material as authored and decides whether it is a colour filter.
 * Must run BEFORE the loader zeroes transmission. Cached on the material, since
 * Lens_L and Lens_R usually share one.
 *
 * glTF tints transmitted light by the base colour, so what reaches the eye is
 * background x baseColor x transmission: that product is the filter colour
 * (linear). The part that does not transmit is the residual main-pass opacity.
 *
 * @param {THREE.MeshPhysicalMaterial} material
 * @returns {{ color: THREE.Color, residualOpacity: number } | null}
 */
export function deriveLensFilter(material) {
  if (!material) return null
  if (material.userData && 'lensFilter' in material.userData) return material.userData.lensFilter
  let filter = null
  const transmission = Number(material.transmission) || 0
  const authoredAlpha = material.transparent && material.opacity < 1
  if (transmission >= FILTER_MIN_TRANSMISSION && !material.map && !authoredAlpha && material.color) {
    filter = {
      color: material.color.clone().multiplyScalar(transmission),
      residualOpacity: Math.min(Math.max(1 - transmission, FILTER_RESIDUAL_MIN), FILTER_RESIDUAL_MAX),
    }
  }
  if (material.userData) material.userData.lensFilter = filter
  return filter
}

/**
 * The tint-only twin of a lens mesh. Shares the lens geometry and sits at the
 * lens's own transform (child, identity), so bounds and fit are unaffected. It
 * lives ONLY on FILTER_LAYER: the main pass and shadow maps never see it.
 *
 * Unlit and not tone mapped: the colour written is exactly the filter, encoded
 * to sRGB, which is the space mix-blend-mode multiplies in.
 *
 * @param {THREE.Mesh} lensMesh
 * @param {THREE.Color} color linear filter colour
 * @returns {THREE.Mesh}
 */
export function createLensFilterMesh(lensMesh, color) {
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.DoubleSide,
    toneMapped: false,
    depthWrite: false,
  })
  material.name = 'tint-filter'
  const mesh = new THREE.Mesh(lensMesh.geometry, material)
  mesh.name = 'TintFilter'
  mesh.userData.isLensFilter = true
  mesh.layers.set(FILTER_LAYER)
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.frustumCulled = false
  return mesh
}

/**
 * Owns the multiply canvas and draws the filter pass into it.
 */
export class LensFilterLayer {
  /**
   * @param {HTMLCanvasElement} glCanvas the renderer's (overlay) canvas
   */
  constructor(glCanvas) {
    this.glCanvas = glCanvas
    this.canvas = null
    this.ctx = null
    this.showing = false
    this._clear = new THREE.Color()
  }

  _ensureCanvas() {
    if (this.canvas || typeof document === 'undefined' || !this.glCanvas?.parentNode) return Boolean(this.canvas)
    const canvas = document.createElement('canvas')
    canvas.id = 'lens-filter-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    // Same box as the overlay canvas, directly beneath it, multiplying the video.
    Object.assign(canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      mixBlendMode: 'multiply',
      display: 'none',
    })
    this.glCanvas.parentNode.insertBefore(canvas, this.glCanvas)
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { alpha: false })
    return true
  }

  hide() {
    if (this.showing && this.canvas) this.canvas.style.display = 'none'
    this.showing = false
  }

  /**
   * Renders the filter pass and copies it to the multiply canvas. Call right
   * before the main render: it clears the GL canvas to white, and the main pass
   * clears it again.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.Camera} camera
   * @param {THREE.Object3D|null} glassesRoot
   */
  render(renderer, scene, camera, glassesRoot) {
    let active = false
    glassesRoot?.traverseVisible((o) => {
      if (o.userData?.isLensFilter) active = true
    })
    if (!active || !glassesRoot.visible) {
      this.hide()
      return
    }
    if (!this._ensureCanvas()) return

    const w = this.glCanvas.width
    const h = this.glCanvas.height
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }

    // Depth-only occluders (colorWrite off) join the filter pass so a lens
    // behind the nose or cheek is hidden there too. Cheap to re-check: the
    // occluder meshes can be created after the glasses.
    scene.traverse((o) => {
      const m = o.material
      if (o.isMesh && m && !Array.isArray(m) && m.colorWrite === false && m.depthWrite) {
        o.layers.enable(FILTER_LAYER)
      }
    })

    renderer.getClearColor(this._clear)
    const clearAlpha = renderer.getClearAlpha()
    const mask = camera.layers.mask
    renderer.setClearColor(0xffffff, 1)
    camera.layers.set(FILTER_LAYER)
    renderer.render(scene, camera)
    camera.layers.mask = mask
    renderer.setClearColor(this._clear, clearAlpha)

    this.ctx.drawImage(this.glCanvas, 0, 0)
    if (!this.showing) {
      this.canvas.style.display = 'block'
      this.showing = true
    }
  }

  dispose() {
    this.canvas?.remove()
    this.canvas = null
    this.ctx = null
    this.showing = false
  }
}

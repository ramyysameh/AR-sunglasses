/**
 * Soft contact shadow of the frame on the wearer's face.
 *
 * Replaces the old flat CircleGeometry "shadow", which read as a grey disc on the
 * nose because it was a disc: it had no idea where the frame actually was. This
 * one is a real shadow map. The frame (and only the frame) casts from a key light
 * above the camera, and the shadow lands on the wearer's own face surface -- the
 * same 468-landmark tessellation the occluder is built from, so it follows the
 * nose, brow and cheeks of this particular face rather than an average one.
 *
 * Nothing about it lights anything. The light exists purely to own a shadow
 * camera: its intensity is 0, so the frame's shading is exactly what it was
 * before (2e12c0f removed directional light from the frame for the white streak
 * it threw, and this must not bring that back). The receiver is a ShadowMaterial,
 * which draws black at the shadowed pixels and nothing anywhere else -- over the
 * transparent canvas that darkens the camera image underneath, which is all a
 * contact shadow is.
 *
 * World-fixed light direction, not head-relative: a room's light does not turn
 * with the head, so as the wearer turns the shadow slides across the cheek the
 * way a real one does.
 *
 * Tuning (all live on a phone, like ?gscale):
 *   ?shadow=0              off
 *   ?shadowopacity=<0..1>  darkness at full occlusion (default 0.24)
 *   ?shadowel=<deg>        key light elevation above the camera axis (default 20)
 *   ?shadowaz=<deg>        key light azimuth, + = from the wearer's left (default 0)
 *   ?shadowmap=<px>        shadow map size (default 256: soft and cheap)
 *   ?shadowsoft=<n>        PCF filter radius in texels (default 4)
 */
import * as THREE from 'three'
import { resolveParam } from './lensReflection.js'

const DEFAULTS = {
  enabled: true,
  // A pair of sunglasses never casts a hard black shadow indoors: room light
  // comes from a large area, so the shadow is partial. 0.32 read as a grey band
  // on the realistic mock head; ~1/4 reads as "sitting on the face" without
  // looking painted on.
  opacity: 0.24,
  // Above the camera, the way ceiling light and most windows sit relative to a
  // face looking at a screen -- but LOW. The cheek sits 2 cm or more behind the
  // lower rim, so the shadow's drop is that gap times tan(elevation): at 38 deg it
  // landed ~2 cm down the cheek and the frame looked like it was floating. At 20
  // it hugs the rim, which is where a real one sits.
  elevationDeg: 20,
  azimuthDeg: 0,
  // Deliberately LOW resolution. The frustum spans ~0.25 m, so 256 px is ~1 mm
  // per texel and a 4-texel PCF radius blurs the edge over ~4 mm -- about the
  // penumbra a frame 1-2 cm off the skin gets under broad room light. A 1024 map
  // gives a razor edge that looks like a decal.
  mapSize: 256,
  softness: 4,
}

// How far the shadow camera sits from the glasses. Only the ratio to the frustum
// depth matters for an orthographic shadow; this just keeps near > 0.
const LIGHT_DISTANCE_M = 0.6
// Frustum margin around the frame's bounding sphere, so the shadow of a temple
// hinge at the edge of the box is not clipped off.
const FRUSTUM_MARGIN = 1.15
// Below this the frame's bounds are not plausible yet (model still loading).
const MIN_RADIUS_M = 0.03

const MAP_SIZES = [128, 256, 512, 1024]

// Facing ratio |N.V| below which the shadow fades out. MediaPipe keeps placing
// the far side of the face after it has turned out of view, so at yaw the mesh
// overhangs the real silhouette, and a shadow there lands on the background
// beside the nose. Those triangles are exactly the grazing ones, so fading on
// the facing ratio trims them without needing a silhouette test.
const FACING_FADE_START = 0.15
const FACING_FADE_END = 0.45

/**
 * ShadowMaterial with a grazing-angle fade. abs() because the tessellation's
 * winding (and so its computed normals) faces away from the camera.
 *
 * Exported for the test, which runs it against three's real shader source.
 * @param {{ vertexShader: string, fragmentShader: string }} shader
 */
export function patchShadowShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vShadowFacing;')
    .replace(
      '#include <project_vertex>',
      '#include <project_vertex>\n\tvShadowFacing = abs( dot( normalize( transformedNormal ), normalize( -mvPosition.xyz ) ) );',
    )
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vShadowFacing;')
    .replace(
      '#include <tonemapping_fragment>',
      `gl_FragColor.a *= smoothstep( ${FACING_FADE_START.toFixed(2)}, ${FACING_FADE_END.toFixed(2)}, vShadowFacing );\n\t#include <tonemapping_fragment>`,
    )
}

/**
 * @param {string} search
 * @returns {{enabled: boolean, opacity: number, elevationDeg: number, azimuthDeg: number, mapSize: number, softness: number}}
 */
export function resolveContactShadowConfig(search) {
  const params = new URLSearchParams(search)
  const requestedSize = resolveParam(search, 'shadowmap', DEFAULTS.mapSize, (v) => v > 0)
  // Snap to a power of two the GPU will accept everywhere; an arbitrary size is
  // a non-power-of-two depth target on old iOS WebGL.
  const mapSize = MAP_SIZES.reduce((best, s) => (Math.abs(s - requestedSize) < Math.abs(best - requestedSize) ? s : best))
  return {
    // The occlusion probe counts pixels in an offscreen render of the whole
    // scene; a shadow on the face would show up as pixels it did not draw.
    enabled: params.get('shadow') !== '0' && params.get('probe') !== '1',
    opacity: resolveParam(search, 'shadowopacity', DEFAULTS.opacity, (v) => v >= 0 && v <= 1),
    elevationDeg: resolveParam(search, 'shadowel', DEFAULTS.elevationDeg, (v) => v >= 0 && v <= 89),
    azimuthDeg: resolveParam(search, 'shadowaz', DEFAULTS.azimuthDeg, (v) => v >= -89 && v <= 89),
    mapSize,
    softness: resolveParam(search, 'shadowsoft', DEFAULTS.softness, (v) => v >= 0 && v <= 16),
  }
}

/**
 * Unit vector from the glasses toward the key light, in camera/world space
 * (camera looks down -Z, so +Z is "toward the camera").
 *
 * @param {number} elevationDeg
 * @param {number} azimuthDeg
 * @returns {{x:number, y:number, z:number}}
 */
export function keyLightDirection(elevationDeg, azimuthDeg) {
  const el = THREE.MathUtils.degToRad(elevationDeg)
  const az = THREE.MathUtils.degToRad(azimuthDeg)
  // The selfie view is mirrored, so "from the wearer's left" is -X on screen.
  return {
    x: -Math.sin(az) * Math.cos(el),
    y: Math.sin(el),
    z: Math.cos(az) * Math.cos(el),
  }
}

/**
 * True for meshes that should NOT cast: the lenses. A tinted lens transmits most
 * light, and casting it would put a solid dark lens-shaped blot on each cheek.
 * Matched by name, the same way GlassesModelLoader decides what is a lens.
 */
export function isLensMesh(mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.some((m) => {
    const name = `${m?.name ?? ''} ${mesh.name ?? ''}`.toLowerCase()
    return name.includes('lens') || name.includes('glass')
  })
}

export class ContactShadow {
  /**
   * @param {{
   *   scene: THREE.Scene,
   *   renderer: THREE.WebGLRenderer,
   *   faceGeometry: THREE.BufferGeometry,
   *   faceIndexCount: number,
   *   config: ReturnType<typeof resolveContactShadowConfig>,
   * }} options
   *   faceGeometry is the occluder's geometry; only its position attribute is
   *   shared, and only its first faceIndexCount indices (the face, not the shell
   *   behind it) receive.
   */
  constructor({ scene, renderer, faceGeometry, faceIndexCount, config }) {
    this.config = config
    this.scene = scene
    this._visible = false
    this._casterRoot = null
    this._box = new THREE.Box3()
    this._sphere = new THREE.Sphere()

    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap

    const light = new THREE.DirectionalLight(0xffffff, 0)
    light.castShadow = true
    light.shadow.mapSize.set(config.mapSize, config.mapSize)
    light.shadow.radius = config.softness
    // The receiver never casts, so there is no self-shadowing to bias against;
    // a bias here would only detach the shadow from the rim it belongs to.
    light.shadow.bias = 0
    light.shadow.normalBias = 0
    this.light = light
    this.direction = keyLightDirection(config.elevationDeg, config.azimuthDeg)

    // Own geometry, SHARED position attribute: three uploads one GPU buffer per
    // attribute object, so this costs no extra upload and moves with every
    // landmark update the occluder makes. The index is the face tessellation
    // only -- the extruded shell is behind the face and would just catch the
    // temples' shadows on the inside of an invisible bucket.
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', faceGeometry.getAttribute('position'))
    const fullIndex = faceGeometry.getIndex()
    geometry.setIndex(Array.from(fullIndex.array.slice(0, faceIndexCount)))
    this.geometry = geometry

    const material = new THREE.ShadowMaterial({
      color: 0x000000,
      opacity: config.opacity,
      depthWrite: false,
      // MediaPipe's tessellation is wound away from the camera, which is why the
      // occluder is DoubleSide too. Front-side only, the whole receiver is
      // back-face culled and the shadow silently never appears.
      side: THREE.DoubleSide,
    })
    material.onBeforeCompile = patchShadowShader
    material.customProgramCacheKey = () => 'contactShadowFacingFade'
    this.receiver = new THREE.Mesh(geometry, material)
    this.receiver.name = 'contactShadowReceiver'
    this.receiver.receiveShadow = true
    this.receiver.castShadow = false
    this.receiver.matrixAutoUpdate = false
    this.receiver.frustumCulled = false
    // Transparent pass: draw before the lenses (also transparent, no depth
    // write) so a lens tints the shadowed skin behind it instead of the shadow
    // being painted over the lens.
    this.receiver.renderOrder = -10
    this.receiver.visible = false

    scene.add(light, light.target, this.receiver)
  }

  get visible() {
    return this._visible
  }

  set visible(value) {
    // Only the receiver toggles. light.castShadow stays on for the session:
    // flipping it changes the shadow-light count every lit material is compiled
    // against, so each track loss and re-acquire would recompile the frame's
    // shaders -- a visible hitch exactly when the glasses reappear.
    this._visible = Boolean(value)
    this.receiver.visible = this._visible
  }

  /** Marks which meshes cast. Call again whenever the glasses model changes. */
  setCasters(root) {
    this._casterRoot = root ?? null
    root?.traverse((child) => {
      if (!child.isMesh) return
      child.castShadow = !isLensMesh(child)
      child.receiveShadow = false
    })
  }

  /**
   * Re-aims the shadow camera at the frame and refreshes the receiver's normals.
   * Call once per frame after the glasses and occluder have their new pose.
   *
   * @param {boolean} show whether frame and occluder are both on screen
   */
  update(show) {
    const root = this._casterRoot
    if (!this.config.enabled || !show || !root?.visible) {
      this.visible = false
      return
    }

    this._box.setFromObject(root)
    if (this._box.isEmpty()) {
      this.visible = false
      return
    }
    this._box.getBoundingSphere(this._sphere)
    const radius = this._sphere.radius * FRUSTUM_MARGIN
    if (!(radius > MIN_RADIUS_M)) {
      this.visible = false
      return
    }

    const c = this._sphere.center
    const d = this.direction
    this.light.target.position.copy(c)
    this.light.position.set(
      c.x + d.x * LIGHT_DISTANCE_M,
      c.y + d.y * LIGHT_DISTANCE_M,
      c.z + d.z * LIGHT_DISTANCE_M,
    )
    this.light.target.updateMatrixWorld()
    this.light.updateMatrixWorld()

    const cam = this.light.shadow.camera
    // Only resize when the frame's size actually changed: updateProjectionMatrix
    // every frame is cheap, but it is wasted work for a value that holds still.
    if (Math.abs(cam.right - radius) > 1e-4) {
      cam.left = -radius
      cam.right = radius
      cam.top = radius
      cam.bottom = -radius
      cam.near = Math.max(0.01, LIGHT_DISTANCE_M - radius * 2)
      cam.far = LIGHT_DISTANCE_M + radius * 2
      cam.updateProjectionMatrix()
    }

    // ShadowMaterial needs vertex normals: three offsets the shadow lookup along
    // them, and a missing normal attribute normalises to NaN on some drivers.
    // ~900 triangles; the occluder skips this because it never shades.
    this.geometry.computeVertexNormals()
    this.receiver.matrixWorldNeedsUpdate = true
    this.visible = true
  }

  dispose() {
    this.scene.remove(this.light, this.light.target, this.receiver)
    this.light.shadow.map?.dispose?.()
    this.light.dispose?.()
    this.geometry.dispose()
    this.receiver.material.dispose()
  }
}

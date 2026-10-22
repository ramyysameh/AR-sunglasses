/**
 * View-dependent lens coverage and optional gradient tint.
 *
 * The lens is a flat alpha layer over the camera image (glTF transmission is
 * forced off: it stalls WebGL, and the GPU never sees the camera pixels it would
 * need to refract anyway -- see FINDINGS.md on Meta drawing the video INSIDE its
 * scene so transmission can sample it). A single opacity everywhere is what
 * makes it read as a tinted film rather than glass. Two things real lenses do
 * that alpha can still do:
 *
 *  1. FRESNEL. Glass reflects ~4% straight on and far more at grazing angles, so
 *     it transmits less there. Coverage rises toward the lens edges and as the
 *     head turns, which is the cue that it is a curved surface in front of the
 *     eye. Schlick with F0 = 0.04 (n ~ 1.5). The reflection itself is still the
 *     clearcoat lobe in lensReflection.js; this only changes how much of the eye
 *     shows through.
 *
 *  2. GRADIENT. Gradient lenses are darker at the top. Opacity is scaled along
 *     the lens's own vertical extent, measured from its geometry, so it follows
 *     the lens however the model was authored. Off unless the SKU or URL asks.
 *
 * The tint colour is untouched: both effects only scale alpha.
 *
 * Tuning:
 *   ?lensfresnel=<0..1>  how much of the Fresnel coverage to apply (default 0.6)
 *   ?lensgrad=<0..1>     how much lighter the bottom is than the top (default:
 *                        materialProfile.lensGradient, else 0 = no gradient)
 */
import { resolveParam } from './lensReflection.js'

const DEFAULTS = {
  // Full Schlick coverage makes a low-opacity lens go nearly opaque at the rim,
  // which reads as a black outline on a dark tint. 0.6 keeps the rim visible
  // without it.
  fresnel: 0.6,
  gradient: 0,
}

const F0 = 0.04

/**
 * @param {string} search
 * @param {{ lensGradient?: number }} [materialProfile]
 * @returns {{ fresnel: number, gradient: number }}
 */
export function resolveLensShadingConfig(search, materialProfile = {}) {
  const skuGradient = Number.isFinite(materialProfile?.lensGradient) &&
    materialProfile.lensGradient >= 0 && materialProfile.lensGradient <= 1
    ? materialProfile.lensGradient
    : DEFAULTS.gradient
  return {
    fresnel: resolveParam(search, 'lensfresnel', DEFAULTS.fresnel, (v) => v >= 0 && v <= 1),
    gradient: resolveParam(search, 'lensgrad', skuGradient, (v) => v >= 0 && v <= 1),
  }
}

// Lens coverage derived from the model is kept inside this range. The top stops a
// near-black authored lens from hiding the eyes completely (shoppers still want
// to see their eyes through dark sunglasses, as with category-3 lenses, which
// pass 8-18% of light); the bottom stops a pale tint from vanishing.
export const DERIVED_LENS_OPACITY_MIN = 0.3
export const DERIVED_LENS_OPACITY_MAX = 0.85

/**
 * How opaque an uploaded model's lens should be, read from its AUTHORED material.
 *
 * Uploaded lenses are authored as glass: a tint colour plus glTF transmission.
 * Transmission is switched off at render time (see the header), and the lens
 * used to get one flat opacity for every model, so a dark smoke lens and a pale
 * yellow one both came out as the same light film. glTF tints transmitted light
 * by the base colour, so the light that gets through is roughly
 * transmission x luminance(baseColor), and coverage is the rest.
 *
 *  - Authored alpha below 1 (alphaMode BLEND) is taken as the designer's choice.
 *  - A base-colour texture hides the real tint, so it gets `fallback`.
 *  - No transmission on an untextured lens is treated as fully transmissive
 *    glass, so its darkness alone sets the coverage.
 *
 * Read BEFORE the loader zeroes transmission and overwrites opacity, and cached
 * on the material: Lens_L and Lens_R usually share one material, and the second
 * visit would otherwise read the values the first visit wrote.
 *
 * @param {import('three').MeshPhysicalMaterial} material
 * @param {number} fallback
 * @returns {number}
 */
export function deriveLensOpacity(material, fallback) {
  if (Number.isFinite(material?.userData?.derivedLensOpacity)) {
    return material.userData.derivedLensOpacity
  }
  let opacity = fallback
  if (material?.transparent && material.opacity < 1) {
    opacity = material.opacity
  } else if (material?.color && !material.map) {
    const { r, g, b } = material.color
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const transmission = material.transmission > 0 ? material.transmission : 1
    opacity = 1 - transmission * luminance
  }
  opacity = Math.min(Math.max(opacity, DERIVED_LENS_OPACITY_MIN), DERIVED_LENS_OPACITY_MAX)
  if (material?.userData) material.userData.derivedLensOpacity = opacity
  return opacity
}

/**
 * CPU mirror of the shader's coverage, for tests and for reasoning about values.
 *
 * @param {number} opacity authored lens opacity
 * @param {number} cosTheta |N.V|, 1 = facing the camera
 * @param {number} t vertical position in the lens, 0 = bottom, 1 = top
 * @param {{ fresnel: number, gradient: number }} config
 */
export function lensCoverage(opacity, cosTheta, t, config) {
  const fresnel = F0 + (1 - F0) * (1 - Math.min(Math.max(cosTheta, 0), 1)) ** 5
  const gradient = 1 - config.gradient * (1 - Math.min(Math.max(t, 0), 1))
  const base = opacity * gradient
  return base + (1 - base) * fresnel * config.fresnel
}

/**
 * Patches one lens material. The mesh is needed for its geometry's vertical
 * extent; the gradient runs between the lowest and highest lens vertex.
 *
 * Idempotent per material. A GLB usually has Lens_L and Lens_R share ONE
 * material and the loader calls this once per mesh; wrapping onBeforeCompile a
 * second time injected every declaration twice, so the lens program failed to
 * compile ('vLensY' : redefinition) and the lenses did not draw at all. A
 * repeat call now only widens the gradient's extent to cover both meshes and
 * takes the latest config. One extent for both is right for a mirrored pair
 * authored in the same space (all the current GLBs: identical y ranges, no node
 * transforms); a pair at different heights would need the material cloned.
 *
 * @param {import('three').Material} material
 * @param {import('three').Mesh} mesh
 * @param {{ fresnel: number, gradient: number }} config
 */
export function applyLensShading(material, mesh, config) {
  if (!material || !config || (config.fresnel <= 0 && config.gradient <= 0)) return

  const geometry = mesh?.geometry
  if (geometry && !geometry.boundingBox) geometry.computeBoundingBox?.()
  const box = geometry?.boundingBox
  let bottom = box ? box.min.y : 0
  let top = box ? box.max.y : 1

  const existing = material.userData.lensShading
  if (existing) {
    if (box) {
      bottom = Math.min(bottom, existing.uLensBottom.value)
      top = Math.max(top, existing.uLensBottom.value + existing.uLensHeight.value)
    }
    existing.uLensFresnel.value = config.fresnel
    existing.uLensGradient.value = config.gradient
    existing.uLensBottom.value = bottom
    existing.uLensHeight.value = Math.max(top - bottom, 1e-6)
    return
  }

  // A degenerate (flat or missing) extent would divide by zero in the shader;
  // a tiny height just puts the whole lens at the "top" end of the gradient.
  const height = Math.max(top - bottom, 1e-6)

  const uniforms = {
    uLensFresnel: { value: config.fresnel },
    uLensGradient: { value: config.gradient },
    uLensBottom: { value: bottom },
    uLensHeight: { value: height },
  }
  material.userData.lensShading = uniforms

  const previous = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    previous?.call(material, shader, renderer)
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vLensY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvLensY = position.y;')
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        [
          '#include <common>',
          'varying float vLensY;',
          'uniform float uLensFresnel;',
          'uniform float uLensGradient;',
          'uniform float uLensBottom;',
          'uniform float uLensHeight;',
        ].join('\n'),
      )
      .replace(
        '#include <opaque_fragment>',
        [
          '{',
          // abs(): lenses are often double-sided, and the back face's normal is
          // already flipped by three, but a mis-wound lens should not go clear.
          '\tfloat lensCos = clamp( abs( dot( normalize( normal ), normalize( vViewPosition ) ) ), 0.0, 1.0 );',
          `\tfloat lensF = ${F0.toFixed(2)} + ${(1 - F0).toFixed(2)} * pow( 1.0 - lensCos, 5.0 );`,
          '\tfloat lensT = clamp( ( vLensY - uLensBottom ) / uLensHeight, 0.0, 1.0 );',
          '\tdiffuseColor.a *= 1.0 - uLensGradient * ( 1.0 - lensT );',
          '\tdiffuseColor.a += ( 1.0 - diffuseColor.a ) * lensF * uLensFresnel;',
          '}',
          '#include <opaque_fragment>',
        ].join('\n'),
      )
  }
  const previousKey = material.customProgramCacheKey?.bind(material)
  material.customProgramCacheKey = () =>
    `${previousKey ? previousKey() : ''}|lensShading`
  material.needsUpdate = true
}

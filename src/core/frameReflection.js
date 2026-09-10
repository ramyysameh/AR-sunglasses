/**
 * Frame reflection tuning.
 *
 * HISTORY: 2e12c0f deliberately gave the frame a dead-flat look -- ambient-only
 * lighting, no envMap -- because a glossy frame lit by DIRECTIONAL light threw a
 * hard white streak that slid across the frame as the head turned. That fixed the
 * glare but also meant authored gloss (roughness/clearcoat in the GLB) had no
 * visible effect whatsoever: AmbientLight contributes zero specular, the three
 * directionals sit at intensity 0, and scene.environment is never set. A polished
 * piano-black frame rendered identically to a matte one.
 *
 * This restores gloss WITHOUT bringing the streak back, by reusing what the lens
 * tuning already learned the hard way (see lensReflection.js): a flat
 * envMapIntensity washes the whole surface uniformly and reads as glare, while
 * the `clearcoat` lobe is Fresnel-weighted -- near-zero face-on, strong at grazing
 * angles -- so it reads as a moving edge highlight along the frame's bevels
 * rather than a sheet of white sliding across it.
 *
 * Set ?framerefl=0 to restore the old completely-flat frame.
 */
import { resolveParam } from './lensReflection.js'

const DEFAULTS = {
  // Deliberately low, for the reason spelled out in lensReflection.js: this is a
  // FLAT multiplier applied even at normal incidence, so pushing it up to make
  // the reflection more obvious washes the frame out when the wearer is facing
  // the camera dead-on. The angle-dependent punch comes from clearcoat instead.
  intensity: 0.25,
  // Roughness floor. A frame authored near-mirror turns the sky's sun into a
  // hard aliased dot; a little roughness blooms it into a highlight.
  roughness: 0.06,
  // Same lesson as the lens: an authored clearcoatRoughness of 0 is a perfect
  // mirror coat and aliases badly against a small bright sun. Floor it.
  clearcoatRoughness: 0.1,
}

export function resolveFrameReflectionConfig(search) {
  return {
    intensity: resolveParam(search, 'framerefl', DEFAULTS.intensity, (v) => v >= 0),
    roughness: resolveParam(search, 'framerough', DEFAULTS.roughness, (v) => v >= 0 && v <= 1),
    clearcoatRoughness: resolveParam(search, 'frameccrough', DEFAULTS.clearcoatRoughness, (v) => v >= 0 && v <= 1),
  }
}

/**
 * Applies the environment reflection to ONE frame material.
 *
 * Only ever raises roughness to the floor -- never lowers it -- so a matte frame
 * stays matte and only an authored-glossy frame actually picks up a highlight.
 * The GLB stays the source of truth for how shiny the frame is; this just gives
 * that authored gloss something to reflect.
 *
 * Typed as the Standard material because that is what the loader hands us; the
 * physical-only fields (clearcoat) are feature-detected with `in` rather than
 * assumed, so a plain Standard material is handled correctly.
 *
 * @param {import('three').MeshStandardMaterial} material
 * @param {import('three').Texture|null} envMap
 * @param {{ intensity: number, roughness: number, clearcoatRoughness: number }|null} config
 */
export function applyFrameReflection(material, envMap, config) {
  // envMap and config are separately nullable (GlassesModelLoader defaults both
  // to null independently), so a present envMap does not imply a present config.
  if (!material || !envMap || !config || config.intensity <= 0) {
    return
  }

  material.envMap = envMap
  material.envMapIntensity = config.intensity

  if ('roughness' in material && material.roughness < config.roughness) {
    material.roughness = config.roughness
  }

  // Do NOT switch clearcoat on here. Whether the frame has a coat is the GLB's
  // call -- forcing it would make every matte acetate frame look lacquered. We
  // only stop an authored coat from being a razor-sharp mirror.
  if ('clearcoat' in material) {
    // Clearcoat lives on the Physical material only; narrow to it the same way
    // GlassesModelLoader narrows the base Material it gets back from the loader.
    const coated = /** @type {import('three').MeshPhysicalMaterial} */ (/** @type {unknown} */ (material))
    if (coated.clearcoat > 0 && coated.clearcoatRoughness < config.clearcoatRoughness) {
      coated.clearcoatRoughness = config.clearcoatRoughness
    }
  }
}

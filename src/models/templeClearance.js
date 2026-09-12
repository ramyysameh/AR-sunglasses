/**
 * Pushes temple arms out of the head, per vertex, only where they are inside it.
 *
 * WHY PER-VERTEX, after two failed global attempts. Measuring the head's width
 * along the arm rather than as one number shows the intrusion is local:
 *
 *   depth from ear line   +90  +60  +40  +20    0   -60   -80   (mm)
 *   arm half-width         85   86   86   86   85    74    69
 *   head half-width        51   79   87   93   96    27    19
 *   clearance             +35   +8    0   -7  -11   +47   +50
 *
 * The arm is buried by 4-11 mm in a narrow band around the ear and is already
 * clear by up to 35 mm at the front. A single splay big enough to fix the band
 * therefore shoves the rest of the arm far outside the skull -- which is exactly
 * what the first two attempts did, and why they looked like the frame was
 * hanging in the air. Only the buried vertices should move.
 *
 * The tip is deliberately excluded. Behind the ear the arm SHOULD be inside the
 * head -- that is what lets the occluder hide it -- so clearing it there would
 * trade this bug for the temple-tip bug and drop the occlusion harness back to
 * zero rear trim.
 *
 * Pure geometry: no Three.js scene objects, so the profile and the displacement
 * can be tested without a renderer.
 */

import * as THREE from 'three'

const TEMPLE_NAME = /temple|hinge/i

/** Fraction of the model's Z range treated as the frame front. */
const FRONT_SLAB_RATIO = 0.25

/**
 * Fraction of the model's half-width that a mesh's NEAREST-to-centre vertex must
 * exceed for the mesh to count as an arm.
 *
 * Deliberately the minimum |x| and not the maximum: the test is "every vertex of
 * this part is out at the side", which is true of an arm and false of anything
 * belonging to the front. A monolithic front mesh spans the full width, so its
 * MAXIMUM |x| looks exactly like an arm's -- and one real model ships the whole
 * front as a single `frame` mesh, which a max-based test happily selected.
 *
 * That matters because clearance runs per VERTEX once a mesh is selected. Admit
 * a front mesh and its bridge vertices, sitting near the centreline, get pushed:
 * the head profile is a silhouette (max lateral per depth bin), so near the
 * centreline the "head width" is the CHEEK width and the bridge is flung ~60 mm
 * sideways. The nose pads fail this test for the same reason, and must.
 *
 * Measured on four real models, minimum |x| as a fraction of half-width:
 *   arms      0.58 .. 0.97      lenses   0.12 .. 0.18      bridges/pads ~0
 */
export const ARM_LATERAL_MIN_RATIO = 0.3

/** Depth bin size for the head profile, metres. */
export const PROFILE_BIN_M = 0.01

/**
 * Gap left between arm and skin. Landmark noise is a few mm, and an arm exactly
 * on the surface flickers in and out of the occluder.
 */
export const SKIN_CLEARANCE_M = 0.004

/**
 * Fraction along the arm past which clearance is NOT enforced.
 *
 * Behind this the arm is tucking behind the ear and belongs inside the head.
 */
export const HOOK_FROM = 0.72

export function isTempleMesh(mesh) {
  return Boolean(mesh?.isMesh) && TEMPLE_NAME.test(`${mesh.name ?? ''} ${mesh.parent?.name ?? ''}`)
}

/**
 * Picks the arms out of a frame by where its parts sit, not what they are called.
 *
 * Two passes, because one fixed depth threshold cannot do it. A frame's Z range
 * is dominated by the arms -- on one real model they are 157 mm of a 158 mm span
 * -- so a "front quarter" threshold lands far behind the actual front assembly
 * and misses anything mounted on the arm's front half. Measured on that model
 * (mm, model frame):
 *
 *   front assembly (bridge, lenses, pads, mounts)   all end by z = -11.7
 *   arms (forepart, shaft, sleeve)                  -9.9 back to -156.9
 *   medallion, mounted on the arm                   -28.7 .. -22.1
 *   fixed 25% threshold                             -38.3   <- behind the medallion
 *
 * So: seed on the parts that unambiguously ARE arms -- lateral and reaching
 * behind the front quarter -- then take the frontmost point of those seeds as
 * the hinge line and admit any lateral part behind it. On that model the hinge
 * line lands at -9.9, which separates the medallion (-28.7) from the outer
 * attachment (-8.7) with nothing in between.
 *
 * Laterality is what excludes the NOSE PADS, and that matters more than it
 * looks: the head profile is a silhouette (max lateral per depth bin), so at a
 * pad's depth the "head width" is the CHEEK width, and clearing a pad would
 * fling it ~60 mm sideways off the nose.
 *
 * @param {Array<{zBack:number, zFront:number, minAbsX:number}>} candidates
 * @param {{minZ:number, maxZ:number, halfWidth:number}} bounds whole-model extent
 */
export function selectArms(candidates, bounds) {
  const frontZ = bounds.maxZ - (bounds.maxZ - bounds.minZ) * FRONT_SLAB_RATIO
  const lateral = (c) => c.minAbsX > bounds.halfWidth * ARM_LATERAL_MIN_RATIO

  const seeds = candidates.filter((c) => lateral(c) && c.zBack < frontZ)
  if (!seeds.length) return []

  let hingeZ = -Infinity
  for (const seed of seeds) if (seed.zFront > hingeZ) hingeZ = seed.zFront

  return candidates.filter((c) => lateral(c) && c.zBack < hingeZ)
}

/**
 * Head half-width as a function of depth, in the head's own frame.
 *
 * @param {{count:number, getX:Function, getY:Function, getZ:Function}} position occluder vertices
 * @param {{x:number,y:number,z:number}} mid origin (temple midpoint)
 * @param {{x:number,y:number,z:number}} axX head's lateral axis, unit
 * @param {{x:number,y:number,z:number}} axZ head's front/back axis, unit
 * @returns {Map<number, number>} depth bin -> max |lateral|
 */
export function buildHeadProfile(position, mid, axX, axZ, bin = PROFILE_BIN_M) {
  const profile = new Map()

  for (let i = 0; i < position.count; i += 1) {
    const dx = position.getX(i) - mid.x
    const dy = position.getY(i) - mid.y
    const dz = position.getZ(i) - mid.z
    const depth = dx * axZ.x + dy * axZ.y + dz * axZ.z
    const lateral = Math.abs(dx * axX.x + dy * axX.y + dz * axX.z)
    const key = Math.round(depth / bin)
    const current = profile.get(key)
    if (current === undefined || lateral > current) profile.set(key, lateral)
  }

  return profile
}

/**
 * Head half-width at a depth, interpolated between bins.
 *
 * Returns 0 outside the profile's range: no data means no constraint, which is
 * the safe direction -- inventing a width there would push arms out against a
 * head that was never measured.
 */
export function headWidthAt(profile, depth, bin = PROFILE_BIN_M) {
  const exact = depth / bin
  const lo = Math.floor(exact)
  const hi = lo + 1
  const a = profile.get(lo)
  const b = profile.get(hi)
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return b
  if (b === undefined) return a
  return a + (b - a) * (exact - lo)
}

/**
 * Outward displacement for one vertex, in the same units as the inputs.
 *
 * Never negative: an arm already outside the head is left alone. Pulling it in
 * would be a styling change, not a fix.
 */
export function clearanceFor(lateral, depth, t, profile, clearance = SKIN_CLEARANCE_M, hookFrom = HOOK_FROM) {
  if (t >= hookFrom) return 0
  const required = headWidthAt(profile, depth)
  if (!(required > 0)) return 0
  return Math.max(0, required + clearance - Math.abs(lateral))
}

/**
 * Collects temple meshes and caches their untouched vertices.
 *
 * The cache is the baseline every solve rebuilds from, so repeated application
 * cannot accumulate and a shrinking correction actually shrinks.
 */
export function collectTemples(glassesRoot) {
  if (!glassesRoot?.traverse) return []
  glassesRoot.updateMatrixWorld?.(true)

  // Classify in the ROOT'S own frame, not world space: this runs before the root
  // is placed on a face, and must not depend on where that happens to leave it.
  const toRoot = new THREE.Matrix4().copy(glassesRoot.matrixWorld).invert()
  const local = new THREE.Matrix4()
  const v = new THREE.Vector3()

  const candidates = []
  const bounds = { minZ: Infinity, maxZ: -Infinity, halfWidth: 0 }

  glassesRoot.traverse((object) => {
    const attribute = object.geometry?.attributes?.position
    if (!object.isMesh || !attribute) return

    local.copy(toRoot).multiply(object.matrixWorld)
    let zFront = -Infinity
    let zBack = Infinity
    let maxAbsX = 0
    let minAbsX = Infinity
    for (let i = 0; i < attribute.count; i += 1) {
      v.fromBufferAttribute(attribute, i).applyMatrix4(local)
      if (v.z > zFront) zFront = v.z
      if (v.z < zBack) zBack = v.z
      const absX = Math.abs(v.x)
      if (absX > maxAbsX) maxAbsX = absX
      if (absX < minAbsX) minAbsX = absX
    }

    if (zBack < bounds.minZ) bounds.minZ = zBack
    if (zFront > bounds.maxZ) bounds.maxZ = zFront
    if (maxAbsX > bounds.halfWidth) bounds.halfWidth = maxAbsX

    candidates.push({
      mesh: object,
      original: Float32Array.from(attribute.array),
      zFront,
      zBack,
      minAbsX,
      named: isTempleMesh(object),
    })
  })

  if (!candidates.length) return []

  // Trust the names only when they actually produced an ARM. A model that names
  // its hinge pins but calls the arms "Branche" would otherwise hand the
  // clearance pass two specks at the front and no arms at all -- and, because the
  // pass is silent, look exactly like a model with nothing to correct.
  const named = candidates.filter((c) => c.named)
  const geometric = selectArms(candidates, bounds)
  const chosen = named.some((c) => geometric.includes(c)) ? named : geometric

  return chosen.map(({ mesh, original, zFront, zBack }) => ({ mesh, original, zFront, zBack }))
}

/**
 * Maps a WORLD direction into a mesh's local space.
 *
 * The push is computed along the head's lateral axis in world space, but must be
 * written into local vertex coordinates. Adding it straight to local X is only
 * correct when the mesh has no rotation or non-uniform scale of its own -- true
 * for flat two-mesh exports, false for a real merchant file with a nested rig.
 * On one such model (44 meshes, temples split into forepart/shaft/sleeve) the
 * naive version moved vertices along the wrong axis and left the arm 15 mm
 * inside the head while reporting success.
 *
 * Inverts the upper 3x3 of the world matrix, which carries rotation and scale
 * together -- so the result is exactly `push` metres in world space, and no
 * separate division by the render scale is needed.
 *
 * @returns {boolean} false if the matrix is singular and the vertex must be left alone
 */
export function worldDirToLocal(e, wx, wy, wz, out) {
  const a = e[0], b = e[4], c = e[8]
  const d = e[1], f = e[5], g = e[9]
  const h = e[2], i = e[6], j = e[10]

  const A = f * j - g * i
  const B = g * h - d * j
  const C = d * i - f * h
  const det = a * A + b * B + c * C
  if (!det || !Number.isFinite(det)) return false
  const inv = 1 / det

  out.x = (A * wx + (c * i - b * j) * wy + (b * g - c * f) * wz) * inv
  out.y = (B * wx + (a * j - c * h) * wy + (c * d - a * g) * wz) * inv
  out.z = (C * wx + (b * h - a * i) * wy + (a * f - b * d) * wz) * inv
  return true
}

/**
 * Rebuilds the arms from their originals, pushing buried vertices clear.
 *
 * @param {object[]} temples from collectTemples
 * @param {Map<number,number>} profile from buildHeadProfile
 * @param {object} frame { mid, axX, axZ, scale } describing the head's frame
 * @returns {{moved:number, maxPushM:number}} so a caller can log or gate on it
 */
export function applyClearance(temples, profile, { mid, axX, axZ, tmp, local }) {
  let moved = 0
  let maxPush = 0

  // Position along the arm is measured across ALL temple meshes together, in the
  // head's depth axis -- never per mesh.
  //
  // A real merchant export splits each arm into forepart / shaft / sleeve /
  // medallion. Per-mesh, every one of those spans t = 0..1 on its own, so the
  // sleeve's rear vertices score t ~ 1 and get skipped as "the tip" while
  // actually sitting at the hinge. That left a four-part arm 15 mm inside the
  // head with the code reporting it had run. Single-mesh arms never showed it.
  let depthMax = -Infinity
  let depthMin = Infinity
  for (const entry of temples) {
    const original = entry.original
    const matrix = entry.mesh.matrixWorld
    for (let j = 0; j < original.length; j += 3) {
      tmp.set(original[j], original[j + 1], original[j + 2]).applyMatrix4(matrix)
      const d = (tmp.x - mid.x) * axZ.x + (tmp.y - mid.y) * axZ.y + (tmp.z - mid.z) * axZ.z
      if (d > depthMax) depthMax = d
      if (d < depthMin) depthMin = d
    }
  }
  const armSpan = depthMax - depthMin

  for (const entry of temples) {
    const attribute = entry.mesh.geometry.attributes.position
    const original = entry.original
    const matrix = entry.mesh.matrixWorld

    for (let i = 0; i < attribute.count; i += 1) {
      const j = i * 3
      const lx = original[j]
      const ly = original[j + 1]
      const lz = original[j + 2]

      // World position of the UNMODIFIED vertex, so the push is measured against
      // the arm's true shape rather than against a previous push.
      tmp.set(lx, ly, lz).applyMatrix4(matrix)
      const dx = tmp.x - mid.x
      const dy = tmp.y - mid.y
      const dz = tmp.z - mid.z
      const depth = dx * axZ.x + dy * axZ.y + dz * axZ.z
      const lateral = dx * axX.x + dy * axX.y + dz * axX.z
      // t = 0 at the hinge (frontmost point of the whole arm), 1 at the tip.
      const t = armSpan > 1e-6 ? (depthMax - depth) / armSpan : 0

      const push = clearanceFor(lateral, depth, t, profile)

      attribute.array[j] = lx
      attribute.array[j + 1] = ly
      attribute.array[j + 2] = lz

      if (push > 0) {
        const sign = Math.sign(lateral || lx || 1)
        const ok = worldDirToLocal(
          matrix.elements,
          axX.x * push * sign,
          axX.y * push * sign,
          axX.z * push * sign,
          local
        )
        if (ok) {
          attribute.array[j] = lx + local.x
          attribute.array[j + 1] = ly + local.y
          attribute.array[j + 2] = lz + local.z
          moved += 1
          if (push > maxPush) maxPush = push
        }
      }
    }

    attribute.needsUpdate = true
    entry.mesh.geometry.computeBoundingSphere()
  }

  return { moved, maxPushM: maxPush }
}

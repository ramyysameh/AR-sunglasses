/**
 * Opens the temple arms on their hinges so they clear the head.
 *
 * WHY THIS EXISTS. A frame's arms are modelled straight, at roughly the width of
 * the frame front. A head is wider than that: measured on one real model, the
 * arms sit 166 mm apart while the head is 190 mm across at its widest, so the
 * arms run INSIDE the skull from about 60 mm behind the frame front. The
 * occluder then does its job and hides them, and a merchant sees an arm that
 * stops dead just past the hinge.
 *
 * Real eyewear solves this physically: you put the glasses on and the temples
 * flex outward at the hinge. This does the same thing, and nothing more. Each
 * arm is reparented under a pivot placed at its own hinge and ROTATED as a rigid
 * body -- no vertex is moved relative to any other, so the merchant's geometry,
 * silhouette and detail survive exactly as modelled.
 *
 * That is the difference from the per-vertex clearance pass this replaces. That
 * one worked, but it rewrote the model to get there: 11.4% of one model's temple
 * vertices displaced by up to 27.6 mm.
 *
 * WHAT IS NOT ENFORCED. Only the span from the hinge back to the widest point of
 * the head -- the ear line. Behind that the arm is hooking in behind the ear and
 * BELONGS inside the head silhouette; that is what lets the occluder hide the
 * tip. Pushing the hook out too would trade this bug for the temple-tip bug.
 *
 * The solve is pure geometry and takes plain numbers, so the angle can be tested
 * without a renderer or a scene.
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
 * this part is out at the side", true of an arm and false of anything belonging
 * to the front. A monolithic front mesh spans the full width, so its MAXIMUM |x|
 * looks exactly like an arm's -- and one real model ships its whole front as a
 * single `frame` mesh, which a max-based test happily selected.
 *
 * Measured on four real models, minimum |x| as a fraction of half-width:
 *   arms      0.58 .. 0.97      lenses   0.12 .. 0.18      bridges/pads ~0
 */
export const ARM_LATERAL_MIN_RATIO = 0.3

/** Depth bin size for the head profile, metres. */
export const PROFILE_BIN_M = 0.01

/** Gap left between arm and skin, metres. Landmark noise is a few mm. */
export const SKIN_CLEARANCE_M = 0.004

/**
 * Most a temple may be opened, radians (~14 deg).
 *
 * A real temple has some flex and then it is a lever on the wearer's head. An
 * angle beyond this means the measurement is wrong, not that the frame needs it,
 * so the cap is a guard rather than a preference.
 */
export const MAX_SPLAY_RAD = 0.25

/** Resolution of the angle search, radians (~0.29 deg). */
const SPLAY_STEP_RAD = 0.005

export function isTempleMesh(mesh) {
  return Boolean(mesh?.isMesh) && TEMPLE_NAME.test(`${mesh.name ?? ''} ${mesh.parent?.name ?? ''}`)
}

/**
 * Picks the arms out of a frame by where its parts sit, not what they are called.
 *
 * Two passes, because one fixed depth threshold cannot do it. A frame's Z range
 * is dominated by the arms -- on one real model they are 157 mm of a 158 mm span
 * -- so a "front quarter" line lands behind the actual front assembly and misses
 * anything mounted on the arm's front half:
 *
 *   front assembly (bridge, lenses, pads, mounts)   all end by z = -11.7
 *   arms (forepart, shaft, sleeve)                  -9.9 back to -156.9
 *   medallion, mounted on the arm                   -28.7 .. -22.1
 *   fixed 25% threshold                             -38.3   <- behind the medallion
 *
 * So seed on parts that unambiguously ARE arms -- lateral and reaching behind the
 * front quarter -- then take the frontmost seed point as the hinge line and admit
 * any lateral part behind it.
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
 * Head half-width by depth, in the head's own frame.
 *
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
 * Returns 0 outside the measured range: no data means no constraint, which is
 * the safe direction -- inventing a width there would splay an arm against a
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
 * Depth at which the head is widest -- the ear line.
 *
 * Clearance is enforced only in front of this. Behind it the arm is tucking in
 * behind the ear and is meant to be inside the silhouette.
 */
export function earLineDepth(profile, bin = PROFILE_BIN_M) {
  let bestKey = null
  let best = -Infinity
  for (const [key, width] of profile) {
    // Ties resolve to the DEEPEST bin. A real head has one clear widest slice,
    // but a flat or noisy profile otherwise resolves to whichever bin Map
    // iteration happened to yield first -- and if that is the frontmost, the
    // enforced span collapses to nothing and the arm is never opened at all.
    if (width > best || (width === best && key < bestKey)) { best = width; bestKey = key }
  }
  return bestKey === null ? null : bestKey * bin
}

/**
 * Smallest outward hinge angle that lifts an arm clear of the head.
 *
 * Rotation is about the vertical axis through the hinge, so a sample at
 * (lateral, depth) moves to
 *   lateral' = hingeLateral + dx*cos(a) + |dz|*sin(a)
 *   depth'   = hingeDepth   + dx*sin(a) + dz*cos(a)
 * with dx, dz measured from the hinge and dz <= 0 behind it. Depth moves too,
 * which is why this searches rather than solving in closed form -- the head is
 * wider further back, so the target moves as the arm swings.
 *
 * @param {Array<{lateral:number, depth:number}>} samples arm points, head frame, lateral >= 0
 * @param {{lateral:number, depth:number}} hinge
 * @param {Map<number,number>} profile head half-width by depth bin
 * @returns {number} radians, 0 when the arm already clears
 */
export function solveSplay(samples, hinge, profile, {
  clearance = SKIN_CLEARANCE_M,
  maxAngle = MAX_SPLAY_RAD,
  step = SPLAY_STEP_RAD,
} = {}) {
  const ear = earLineDepth(profile)
  if (ear === null) return 0

  // Only the run between hinge and ear line is load-bearing.
  const enforced = samples.filter((s) => s.depth <= hinge.depth && s.depth >= ear)
  if (!enforced.length) return 0

  const clears = (angle) => {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    for (const sample of enforced) {
      const dx = sample.lateral - hinge.lateral
      const dz = sample.depth - hinge.depth
      const lateral = hinge.lateral + dx * c + Math.abs(dz) * s
      const depth = hinge.depth + dx * s + dz * c
      const required = headWidthAt(profile, depth)
      if (required > 0 && lateral < required + clearance) return false
    }
    return true
  }

  if (clears(0)) return 0
  for (let angle = step; angle <= maxAngle; angle += step) {
    if (clears(angle)) return angle
  }
  return maxAngle
}

/**
 * Reparents each arm under a pivot at its own hinge so it can be rotated rigidly.
 *
 * `attach` rather than `add`: it preserves each mesh's world transform, so
 * grouping changes nothing until an angle is applied.
 *
 * @returns {Array<{side:number, group:THREE.Group, samples:Array}>} one entry per arm
 */
export function buildHinges(glassesRoot) {
  if (!glassesRoot?.traverse) return []
  glassesRoot.updateMatrixWorld?.(true)

  const toRoot = new THREE.Matrix4().copy(glassesRoot.matrixWorld).invert()
  const local = new THREE.Matrix4()
  const v = new THREE.Vector3()

  const candidates = []
  const bounds = { minZ: Infinity, maxZ: -Infinity, halfWidth: 0 }

  glassesRoot.traverse((object) => {
    const attribute = object.geometry?.attributes?.position
    if (!object.isMesh || !attribute) return
    local.copy(toRoot).multiply(object.matrixWorld)

    let zFront = -Infinity, zBack = Infinity, maxAbsX = 0, minAbsX = Infinity, sumX = 0
    const points = []
    for (let i = 0; i < attribute.count; i += 1) {
      v.fromBufferAttribute(attribute, i).applyMatrix4(local)
      if (v.z > zFront) zFront = v.z
      if (v.z < zBack) zBack = v.z
      const absX = Math.abs(v.x)
      if (absX > maxAbsX) maxAbsX = absX
      if (absX < minAbsX) minAbsX = absX
      sumX += v.x
      points.push(v.clone())
    }
    if (zBack < bounds.minZ) bounds.minZ = zBack
    if (zFront > bounds.maxZ) bounds.maxZ = zFront
    if (maxAbsX > bounds.halfWidth) bounds.halfWidth = maxAbsX

    candidates.push({
      mesh: object, points, zFront, zBack, minAbsX,
      meanX: sumX / attribute.count,
      named: isTempleMesh(object),
    })
  })

  if (!candidates.length) return []

  // Trust the names only when they actually produced an ARM. A model that names
  // its hinge pins but calls the arms "Branche" would otherwise hand this two
  // specks at the front and no arms at all.
  const named = candidates.filter((c) => c.named)
  const geometric = selectArms(candidates, bounds)
  const arms = named.some((c) => geometric.includes(c)) ? named : geometric
  if (!arms.length) return []

  const hinges = []
  for (const side of [-1, 1]) {
    const mine = arms.filter((c) => Math.sign(c.meanX) === side)
    if (!mine.length) continue

    // The hinge is the frontmost point of the arm cluster.
    let hingeZ = -Infinity
    for (const c of mine) if (c.zFront > hingeZ) hingeZ = c.zFront
    let hx = 0, hy = 0, n = 0
    for (const c of mine) {
      for (const p of c.points) {
        if (p.z < hingeZ - 0.002) continue
        hx += p.x; hy += p.y; n += 1
      }
    }
    if (!n) continue

    const group = new THREE.Group()
    group.name = `templeHinge${side < 0 ? 'Left' : 'Right'}`
    group.position.set(hx / n, hy / n, hingeZ)
    glassesRoot.add(group)
    for (const c of mine) group.attach(c.mesh)

    hinges.push({
      side,
      group,
      meshes: mine.map((c) => c.mesh),
      hingeLocal: { x: hx / n, y: hy / n, z: hingeZ },
    })
  }

  return hinges
}

/** Sets each arm's opening angle. Sign is per side so both swing outward. */
export function applySplay(hinges, angle) {
  for (const hinge of hinges) {
    hinge.group.rotation.y = -hinge.side * angle
  }
}

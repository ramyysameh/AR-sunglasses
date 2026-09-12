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
import { splitAtPlane } from './templeSplit.js'

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
 * How far each temple is opened at the HINGE, radians (~20 deg).
 *
 * Half of a two-part articulation; read it with TEMPLE_CURL_RAD. The front
 * segment swings out to carry the arm clear of the cheekbone, and the rear
 * segment then curls back in so the tip hides behind the ear. Neither angle
 * makes sense alone: at this opening with no curl the tip is drawn 0.18-0.37
 * spans BEHIND the ear plane and never hides.
 *
 * Why two angles rather than one. The arm has to move 13-17 mm outward over the
 * cheek, and that requirement grows FASTER than the distance from the hinge, so
 * a single rotation that satisfies the middle overshoots the tip badly. Swept on
 * GRIPZ against the head-frame end metric, one transform never passed:
 *
 *   splay only        4     8    14.32   20     26 deg
 *   judged ok       0/14  0/8    0/8    0/8    3/8
 *   end             +0.25 +0.22  mixed  -0.31  -0.27
 *
 *   shift only        0    14     18     21     24 mm
 *   judged ok       0/14  0/8    0/8    0/8    1/8
 *   end             +0.25 +0.19  +0.16  +0.14  +0.08
 *
 * Two angles pass comfortably, and the curl is what does it:
 *
 *   splay/curl    16/0  16/12  16/20  16/28  18/22  20/20  20/24  24/20
 *   judged ok     1/7    6/8    6/8    5/8    7/8    6/8    8/8    1/8
 *   hole           14     22      2     13      0      2      0      0
 *
 * 20/24 is the only 8/8, with the arm's end landing -0.138..-0.006 -- just
 * inside the ear plane, where a temple belongs.
 */
export const TEMPLE_OPEN_RAD = 0.349

/**
 * How far the rear segment curls back IN from the front segment, radians (~28).
 *
 * This is the angle that makes the arm hide at the ear instead of sailing past
 * the head. See TEMPLE_OPEN_RAD for the sweep the pair was chosen from.
 */
export const TEMPLE_CURL_RAD = 0.489

/**
 * Where along the arm the second pivot sits, as a fraction of hinge-to-tip.
 *
 * Placed near the ear, because that is where a temple stops running back and
 * starts curving in. Cutting further forward makes the front piece too short to
 * carry the arm clear of the cheek; further back leaves too little behind the
 * joint to tuck away.
 */
export const TEMPLE_CUT_RATIO = 0.62

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

    // Second pivot, at the ear end of the arm. Everything behind the cut is
    // reparented under it so it can curl back in independently -- see
    // TEMPLE_CURL_RAD for why one pivot is not enough.
    let zBack = Infinity
    for (const c of mine) if (c.zBack < zBack) zBack = c.zBack
    const cutZ = hingeZ - (hingeZ - zBack) * TEMPLE_CUT_RATIO

    const curl = new THREE.Group()
    curl.name = `templeCurl${side < 0 ? 'Left' : 'Right'}`
    group.add(curl)
    curl.position.set(0, 0, cutZ - hingeZ)

    const frontMeshes = []
    const rearMeshes = []
    for (const c of mine) {
      const pieces = splitArm(c.mesh, group, cutZ)
      if (!pieces) { frontMeshes.push(c.mesh); continue }
      frontMeshes.push(pieces.front)
      rearMeshes.push(pieces.rear)
      curl.attach(pieces.rear)
    }

    hinges.push({
      side,
      group,
      curl,
      meshes: [...frontMeshes, ...rearMeshes],
      frontMeshes,
      rearMeshes,
      hingeLocal: { x: hx / n, y: hy / n, z: hingeZ },
      cutZ,
      baseX: group.position.x,
    })
  }

  return hinges
}

/**
 * Cuts one arm mesh at `cutZ` (measured in the hinge group's space) and leaves
 * the two halves in the scene in its place.
 *
 * Returns null when the cut lands off the end of this mesh, which is normal: an
 * arm is often several parts, and a hinge screw sitting entirely in front of the
 * cut simply stays whole and rides with the front piece.
 */
function splitArm(mesh, group, cutZ) {
  const geometry = mesh.geometry
  if (!geometry?.attributes?.position) return null

  // The cut is a plane of constant z in the GROUP's space; express it as a
  // signed distance over the mesh's own vertices so the split needs no transform.
  const toGroup = new THREE.Matrix4().copy(group.matrixWorld).invert().multiply(mesh.matrixWorld)
  const e = toGroup.elements
  const distance = (x, y, z) => (e[2] * x + e[6] * y + e[10] * z + e[14]) - cutZ

  const position = geometry.attributes.position
  let front = false, rear = false
  for (let i = 0; i < position.count && !(front && rear); i += 1) {
    if (distance(position.getX(i), position.getY(i), position.getZ(i)) >= 0) front = true
    else rear = true
  }
  if (!front || !rear) return null

  const pieces = splitAtPlane(geometry, distance)
  const parent = mesh.parent
  const made = {}
  for (const side of ['front', 'rear']) {
    const part = new THREE.Mesh(pieces[side], mesh.material)
    part.name = `${mesh.name}__${side}`
    part.applyMatrix4(mesh.matrix)
    part.castShadow = mesh.castShadow
    part.receiveShadow = mesh.receiveShadow
    part.renderOrder = mesh.renderOrder
    parent.add(part)
    made[side] = part
  }
  parent.remove(mesh)
  return made
}



/** Sets the rear segment's inward angle, relative to the front segment. */
export function applyCurl(hinges, angle) {
  for (const hinge of hinges) {
    if (hinge.curl) hinge.curl.rotation.y = hinge.side * angle
  }
}

/** Sets each arm's opening angle. Sign is per side so both swing outward. */
export function applySplay(hinges, angle) {
  for (const hinge of hinges) {
    hinge.group.rotation.y = -hinge.side * angle
  }
}

/**
 * Sets each arm's outward shift, in the frame's own local units.
 *
 * Rebuilt from the pivot's original position every time, so repeated solves
 * cannot accumulate.
 */
export function applyOffset(hinges, offsetLocal) {
  for (const hinge of hinges) {
    hinge.group.position.x = hinge.baseX + hinge.side * offsetLocal
  }
}

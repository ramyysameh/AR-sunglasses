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
 * How far outside the head's surface the arm is placed, as a fraction of the
 * head's half-width AT THE TEMPLE'S HEIGHT.
 *
 * This is now only about where the temple should LOOK like it sits -- resting on
 * the head rather than cutting through the cheek. It used to carry a much larger
 * grazing allowance, plus a term in the arm's own thickness, because the arm had
 * to stand clear of the occluder to survive at all: a thin arm loses more of
 * itself to a near-tangent occluder, so WILLOW's 1.65 mm wire needed MORE
 * opening than GRIPZ's 4.85 mm acetate. That was real and it was measured, but
 * it is obsolete -- applyNearArmClip draws the near arm in front of the occluder,
 * so nothing shaves it and none of that margin is needed.
 *
 * What is left is the skin gap, and it is small.
 */
export const TEMPLE_GRAZE_HEAD_RATIO = 0.16



/**
 * Ceiling on the opening, radians (~34 deg).
 *
 * A guard on a bad head measurement, not a target. The solve asks for 28 degrees
 * at the widest frame-to-head ratio tested, so this sits clear of the working
 * range.
 */
export const MAX_SPLAY_RAD = 0.6

/**
 * How far the rear segment curls back IN from the front segment, radians (~22).
 *
 * A fixed relative angle, and two attempts at making it per-model were both
 * refuted by measurement rather than abandoned on taste:
 *
 *   aim the rear segment at a fixed absolute lean, subtracting each model's
 *   own authored hook -- predicts WILLOW (hook 25.2 deg) needs LESS curl than
 *   GRIPZ (16.5). Measured, Willow needs MORE. Applied, it gave Willow 2.8
 *   degrees of curl and 0/16 judged poses, end -0.48..-0.39.
 *
 *   target the tip's inward DISPLACEMENT instead, length x sin(angle) -- but
 *   the two rear segments are 65.3 mm and 66.0 mm long, so that predicts the
 *   same angle for both, which is what a fixed curl already does.
 *
 * So the per-model spread is driven by something neither the rear segment's
 * direction nor its length explains, and a third guess fitted to three models
 * would be worth less than the honest constant. See occlusionProbe for where
 * Willow's remaining margin came from instead.
 */
export const TEMPLE_CURL_RAD = 0.384

/**
 * Ceiling on the curl, radians (~40 deg).
 *
 * A guard, not a target: the alternative to clamping a bad angle is a rear
 * segment folded through the skull.
 */
export const MAX_CURL_RAD = 0.7

export const TEMPLE_CUT_RATIO = 0.66

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

    const frontMeshes = []
    const rearMeshes = []
    for (const c of mine) {
      const pieces = splitArm(c.mesh, group, cutZ)
      if (!pieces) { frontMeshes.push(c.mesh); continue }
      frontMeshes.push(pieces.front)
      rearMeshes.push(pieces.rear)
    }

    // splitArm added fresh meshes, whose world matrices are not computed until
    // asked for. Measuring the cut before this update silently found no vertices
    // on the plane at all and fell back to the group axis -- the exact placement
    // the joint is meant to avoid.
    glassesRoot.updateMatrixWorld(true)

    // The pivot goes ON the arm, at the centre of the cut face. Putting it on
    // the group's own axis instead is off to one side of a tapering temple, and
    // rotating about an axis beside the arm translates it as well as turning it.
    const joint = cutCentre(rearMeshes, group, cutZ - hingeZ)
    const curl = new THREE.Group()
    curl.name = `templeCurl${side < 0 ? 'Left' : 'Right'}`
    group.add(curl)
    curl.position.set(joint.x, joint.y, cutZ - hingeZ)
    for (const mesh of rearMeshes) curl.attach(mesh)

    hinges.push({
      side,
      group,
      curl,
      meshes: [...frontMeshes, ...rearMeshes],
      frontMeshes,
      rearMeshes,
      hingeLocal: { x: hx / n, y: hy / n, z: hingeZ },
      cutZ,
      // Where the arm actually SITS at the joint, and how far back that is. The
      // splay is solved from these rather than fixed, so it adapts to both the
      // frame and the head -- see solveSplay.
      armLateral: armLateralAt(rearMeshes.concat(frontMeshes), glassesRoot, cutZ),
      jointDepth: Math.abs(cutZ),
      armThickness: armThicknessOf(rearMeshes.concat(frontMeshes), glassesRoot, hingeZ, cutZ),
      // The lean the rear segment ALREADY has, as the model was authored. This
      // is what lets one target angle suit every frame: a temple that already
      // hooks hard inward needs little curl added, one that runs straight back
      // needs a lot, and a fixed curl gave the two extremes opposite errors.
      rearAngle: rearLean(rearMeshes, group, curl, side),
      baseX: group.position.x,
    })
  }

  return hinges
}

/**
 * How close to the cut plane a vertex must sit to count as ON it, metres.
 *
 * The cut vertices are exact in the geometry, but they are read back through a
 * local -> world -> group round trip in float32, so an exact comparison finds
 * nothing.
 */
const CUT_PLANE_EPSILON_M = 1e-4

/** Half-thickness of the slice averaged to locate the arm at the joint. */
const JOINT_SLICE_M = 0.004

/**
 * How thick the arm is side-to-side, in the frame's own space.
 *
 * Sampled at three points along the run and taken as the median, so a chunky
 * hinge boss or a decorative flare does not stand in for the arm.
 *
 * This is what decides how much clearance the arm needs, which is not obvious
 * and is the opposite of what shape alone suggests -- see TEMPLE_GRAZE_*.
 */
function armThicknessOf(meshes, glassesRoot, hingeZ, cutZ) {
  const v = new THREE.Vector3()
  const span = (hingeZ - cutZ) / TEMPLE_CUT_RATIO
  const widths = []
  for (const frac of [0.3, 0.5, 0.7]) {
    const z = hingeZ - span * frac
    let lo = Infinity, hi = -Infinity
    for (const mesh of meshes) {
      const attribute = mesh.geometry?.attributes?.position
      if (!attribute) continue
      for (let i = 0; i < attribute.count; i += 1) {
        v.fromBufferAttribute(attribute, i)
        mesh.localToWorld(v)
        glassesRoot.worldToLocal(v)
        if (Math.abs(v.z - z) > JOINT_SLICE_M / 2) continue
        if (v.x < lo) lo = v.x
        if (v.x > hi) hi = v.x
      }
    }
    if (hi > lo) widths.push(hi - lo)
  }
  if (!widths.length) return 0
  widths.sort((a, b) => a - b)
  return widths[Math.floor(widths.length / 2)]
}

/**
 * Mean |lateral| of the arm where the joint cuts it, in the frame's own space.
 *
 * This, not the frame's overall half-width, is where the arm has to reach OUT
 * from. The two are not the same and only one of them is a property of the arm:
 * normalizeModel forces every model to the same 0.145 m front, so GRIPZ and
 * WILLOW both measure 85 mm across and tell you nothing, while their arms sit at
 * 78.6 mm and 78.9 mm -- which is the number the geometry actually turns on.
 */
function armLateralAt(meshes, glassesRoot, cutZ) {
  const v = new THREE.Vector3()
  let sum = 0, n = 0
  for (const mesh of meshes) {
    const attribute = mesh.geometry?.attributes?.position
    if (!attribute) continue
    for (let i = 0; i < attribute.count; i += 1) {
      v.fromBufferAttribute(attribute, i)
      mesh.localToWorld(v)
      glassesRoot.worldToLocal(v)
      if (Math.abs(v.z - cutZ) > JOINT_SLICE_M) continue
      sum += Math.abs(v.x); n += 1
    }
  }
  return n ? sum / n : 0
}

/**
 * Mean x,y of the rear piece's vertices lying on the cut plane.
 *
 * Those vertices are exactly the ones splitAtPlane generated, so this is the
 * centre of the cut face rather than an approximation of it.
 */
function cutCentre(rearMeshes, group, cutLocalZ) {
  const v = new THREE.Vector3()
  let sx = 0, sy = 0, n = 0
  for (const mesh of rearMeshes) {
    const attribute = mesh.geometry?.attributes?.position
    if (!attribute) continue
    for (let i = 0; i < attribute.count; i += 1) {
      v.fromBufferAttribute(attribute, i)
      mesh.localToWorld(v)
      group.worldToLocal(v)
      if (Math.abs(v.z - cutLocalZ) > CUT_PLANE_EPSILON_M) continue
      sx += v.x; sy += v.y; n += 1
    }
  }
  return n ? { x: sx / n, y: sy / n } : { x: 0, y: 0 }
}

/**
 * Inward angle of the rear segment as authored, measured at the joint.
 *
 * Zero means it runs straight back; positive means it already hooks toward the
 * head. Sign is folded per side so both arms report the same way.
 */
function rearLean(rearMeshes, group, curl, side) {
  const v = new THREE.Vector3()
  let tip = null
  for (const mesh of rearMeshes) {
    const attribute = mesh.geometry?.attributes?.position
    if (!attribute) continue
    for (let i = 0; i < attribute.count; i += 1) {
      v.fromBufferAttribute(attribute, i)
      mesh.localToWorld(v)
      curl.worldToLocal(v)
      if (!tip || v.z < tip.z) tip = v.clone()
    }
  }
  if (!tip || !(tip.z < 0)) return 0
  return Math.atan2(-side * tip.x, -tip.z)
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



/**
 * The opening angle each arm needs, solved from the head it is being worn on.
 *
 * A fixed angle cannot be right, and the cost of pretending otherwise is not
 * subtle. Scaling the frame is equivalent to changing the head's width relative
 * to it, and swept that way on GRIPZ the required angle moves from 12 to 28
 * degrees over a 25% range -- while the angle that suits this mock head, 20,
 * leaves a NARROWER head with 43.6 px of temple hanging past the silhouette and
 * 0/8 judged poses, the tip sailing clear of the ear. Real head breadth averages
 * 145-155 mm and this fixture is 162, so that broken case is the common one.
 *
 * What has to happen is a REACH: the arm starts at `armLateral` and must arrive
 * at the head's half-width plus a grazing margin, and the angle is whatever
 * delivers that at the joint. Validated by predicting before measuring --
 *
 *   frame scale     0.90    1.00    1.12
 *   predicted       28.6    20.0    14.5 deg
 *   measured        28      18-20   12-16
 *   (at 0.90, 24 scores 2/7 and 28 scores 8/8; at 1.12, 20 scores 0/8)
 *
 * @param {number} headHalf measured head half-width, world units
 * @param {number} armLateral where the arm sits at the joint, world units
 * @param {number} jointDepth how far back the joint is, world units
 * @returns {number} radians
 */
export function solveSplay(headHalf, armLateral, jointDepth) {
  if (!(jointDepth > 0) || !(headHalf > 0)) return 0
  const reach = headHalf * (1 + TEMPLE_GRAZE_HEAD_RATIO) - armLateral
  const sine = Math.min(Math.max(reach / jointDepth, 0), 1)
  return Math.min(Math.asin(sine), MAX_SPLAY_RAD)
}

/**
 * Sets the rear segment's inward angle, relative to the front segment.
 *
 * Clamped, so a bad angle cannot fold an arm through the head.
 */
export function applyCurl(hinges, angle) {
  for (const hinge of hinges) {
    if (!hinge.curl) continue
    hinge.curl.rotation.y = hinge.side * Math.min(Math.max(angle, 0), MAX_CURL_RAD)
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

/**
 * Render order for the near arm, which must be BEFORE the occluder's -1.
 *
 * The occluder is colorWrite:false, so it can only write depth -- anything drawn
 * before it keeps its pixels. That is the whole mechanism.
 */
export const TEMPLE_ON_TOP_ORDER = -2

/**
 * Draws the arm nearest the camera in front of the occluder, cut at the ear.
 *
 * A real temple is NEVER hidden by the face in front of the ear -- it lies
 * outside the skin the whole way -- and is ALWAYS hidden behind it. The occluder
 * cannot express that: it is one closed surface, so it hides the arm wherever
 * the arm passes inside it, which on a frame whose temples are narrower than the
 * head is most of the run. The measured consequence was a hard choice between an
 * arm eaten from mid-cheek back and an arm standing 21 px proud of the ear, and
 * no combination of splay, curl, joint position, shell bulge or frame scale
 * escaped it.
 *
 * So the rule is applied directly instead: the near arm is drawn before the
 * occluder and clipped at the ear plane. In front of the ear it is always
 * visible, behind it nothing is drawn at all -- which is the same thing the
 * occluder was there to achieve for that stretch.
 *
 * Only the NEAR arm. Applied to both, the far arm shows through the head: 651 of
 * its 1529 pixels drew straight through the skull. Restricted to the near one,
 * the far arm's occlusion is bit-for-bit what it was (614/1480 either way).
 *
 * @param {Array} hinges
 * @param {number} nearSide -1, 1, or 0 for "too frontal to say"
 * @param {THREE.Plane|null} earPlane world-space, normal pointing out of the face
 */
export function applyNearArmClip(hinges, nearSide, earPlane, behindPlane) {
  for (const hinge of hinges) {
    const near = nearSide !== 0 && hinge.side === nearSide && earPlane
    for (const mesh of hinge.meshes) {
      // Clone once: the merchant's material may be shared with the frame front,
      // and clipping it there would cut the lenses in half.
      if (!mesh.userData.templeClipMaterial) {
        mesh.material = mesh.material.clone()
        mesh.userData.templeClipMaterial = true
      }
      mesh.renderOrder = near ? TEMPLE_ON_TOP_ORDER : 0
      setClip(mesh.material, near ? [earPlane] : null)

      // The stretch BEHIND the ear plane, drawn normally so the head and ear
      // hide it. Discarding it instead leaves the cut edge showing wherever the
      // ear does not happen to cover it -- at +/-25 degrees of pitch the arm
      // ended in mid-air with a hard diagonal edge on the cheek.
      const behind = nearArmRemainder(mesh)
      behind.visible = Boolean(near && behindPlane)
      behind.renderOrder = 0
      // Cleared, not just hidden. A plane left on an invisible piece is the
      // LAST head pose's, so the first frame that makes the piece visible again
      // without re-clipping draws it cut at where the ear used to be.
      setClip(behind.material, behind.visible ? [behindPlane] : null)
    }
  }
}

/** Adds or removes clipping planes, recompiling only when the count changes. */
function setClip(material, planes) {
  const before = material.clippingPlanes
  if ((before ? before.length : 0) !== (planes ? planes.length : 0)) {
    material.needsUpdate = true
  }
  material.clippingPlanes = planes
}

/**
 * The sibling that draws the part of an arm behind the ear plane.
 *
 * Shares the geometry -- only the material and the clipping differ -- so this
 * costs a draw call on one arm, not a copy of the mesh.
 */
function nearArmRemainder(mesh) {
  if (mesh.userData.templeBehind) return mesh.userData.templeBehind
  const behind = new THREE.Mesh(mesh.geometry, mesh.material.clone())
  behind.name = `${mesh.name}__behind`
  behind.castShadow = mesh.castShadow
  behind.receiveShadow = mesh.receiveShadow
  behind.position.copy(mesh.position)
  behind.quaternion.copy(mesh.quaternion)
  behind.scale.copy(mesh.scale)
  mesh.parent?.add(behind)
  mesh.userData.templeBehind = behind
  return behind
}

/**
 * Below this yaw neither arm is meaningfully nearer, and the temples are hidden
 * behind the frame and the head anyway. Flipping sides here would only pop.
 */
export const NEAR_ARM_YAW_DEG = 8

/**
 * How far BEHIND the tragion the near arm is cut, metres.
 *
 * The tragion is the front of the ear, so cutting exactly there leaves the cut
 * edge on the skin rather than tucked behind anything -- at +/-25 degrees of
 * pitch the arm visibly ended in mid-air with a hard diagonal edge, about 40 px
 * short of where the ear actually looked. Moving the cut back puts it inside the
 * ear's own outline, where the ear covers it.
 */
export const TEMPLE_CUT_BEHIND_EAR_M = 0.012

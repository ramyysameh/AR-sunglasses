/**
 * The probe reel's camera, framing and neck rig, shared by the reel renderer
 * (probereel.html) and the pose gate (poseGate.js) that scores a try-on against
 * the reel's truth.csv.
 *
 * Shared rather than copied because the gate's ground truth IS this geometry:
 * where the bust's nose bridge projects at frame i is only known if the gate
 * moves it exactly the way the renderer did. A second copy would be one edit
 * away from scoring the engine against a head that was never rendered.
 */
import * as THREE from 'three'

/** Vertical FOV of the reel camera, degrees. truth.csv poses are seen through it. */
export const PROBE_FOV_DEG = 30

/**
 * Where the bust sits and how far the camera stands. The model is moved by
 * -headCenter (the caller applies it); the camera looks at the origin from
 * (0, 0, baseCamZ * dist).
 */
export function frameBust(model, { dist, headY }) {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const headCenter = new THREE.Vector3(center.x, box.max.y - size.y * headY, center.z)
  // Framing is sized to the frame HEIGHT, so landscape and portrait reels show the
  // head at the same apparent size against the vertical FOV.
  const baseCamZ = (size.y * 0.30 * dist) / Math.tan(THREE.MathUtils.degToRad(PROBE_FOV_DEG / 2))
  return { size, center, headCenter, baseCamZ }
}

/**
 * The neck rig's blend band, as fractions of the bust's height above (top) and
 * below (bottom) the narrowest slice of the neck. LEGACY_RIG is what every reel
 * rendered before 2026-10-20 used, and what a params.json without a `rig` entry
 * means: its top reaches into the jaw, so past ~50 degrees of yaw the chin lags
 * the face and the jaw smears. WIDE_RIG twists the neck instead, as a real neck
 * does, and keeps the face rigid out to profile.
 */
export const LEGACY_RIG = Object.freeze({ top: 0.09, bottom: 0.06 })
export const WIDE_RIG = Object.freeze({ top: 0.02, bottom: 0.12 })

/**
 * Neck rig geometry for the unrigged bust: full rotation above `top` (skull
 * base), none below `bottom` (shoulders), smoothstep between, all about `pivot`.
 * Works in mesh-local coordinates, as the rig does.
 */
export function neckRig(meshes, center, headCenter, band = LEGACY_RIG) {
  let minY = Infinity
  let maxY = -Infinity
  for (const m of meshes) {
    const p = m.geometry.attributes.position
    for (let i = 0; i < p.count; i += 1) {
      const y = p.getY(i)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
  }
  const Hh = maxY - minY
  const BINS = 40
  const width = new Array(BINS).fill(0)
  for (const m of meshes) {
    const p = m.geometry.attributes.position
    for (let i = 0; i < p.count; i += 1) {
      const b = Math.min(BINS - 1, Math.floor(((p.getY(i) - minY) / Hh) * BINS))
      width[b] = Math.max(width[b], Math.abs(p.getX(i)))
    }
  }
  let neckBin = -1
  let neckWidth = Infinity
  for (let b = 0; b < BINS; b += 1) {
    const fromTop = (BINS - 1 - b) / (BINS - 1)
    if (fromTop < 0.35 || fromTop > 0.65) continue
    if (width[b] < neckWidth) {
      neckWidth = width[b]
      neckBin = b
    }
  }
  const neckY = minY + ((neckBin + 0.5) / BINS) * Hh
  const top = neckY + (band?.top ?? LEGACY_RIG.top) * Hh
  const bottom = neckY - (band?.bottom ?? LEGACY_RIG.bottom) * Hh
  const pivot = new THREE.Vector3(0, top, center.z - headCenter.z)
  return { pivot, top, bottom }
}

/** The rig's blend weight for a mesh-local height. */
export function rigWeight(y, { top, bottom }) {
  const c = Math.max(0, Math.min(1, (y - bottom) / (top - bottom)))
  return c * c * (3 - 2 * c)
}

/** A truth.csv row's head orientation, as the renderer builds it. */
export function truthQuaternion({ yaw, pitch, roll }, target = new THREE.Quaternion()) {
  // Yaw positive = head turns to ITS left = toward camera-right in a raw (unmirrored) feed.
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(pitch),
    THREE.MathUtils.degToRad(yaw),
    THREE.MathUtils.degToRad(roll),
    'YXZ',
  )
  return target.setFromEuler(euler)
}

/**
 * Where a point of the bust's geometry (mesh-local, the space the rig deforms
 * in) is in the world at a truth pose: rotated about the neck pivot by the rig,
 * then placed by the mesh's world matrix.
 */
export function rigPoint(local, quaternion, rig, meshMatrixWorld, target = new THREE.Vector3()) {
  const w = rigWeight(local.y, rig)
  const q = new THREE.Quaternion().slerp(quaternion, w)
  return target.copy(local).sub(rig.pivot).applyQuaternion(q).add(rig.pivot).applyMatrix4(meshMatrixWorld)
}

/** The reel camera for a frame of the given size at a distance factor. */
export function probeCamera(width, height, baseCamZ, dist = 1, camera = new THREE.PerspectiveCamera()) {
  camera.fov = PROBE_FOV_DEG
  camera.aspect = width / height
  camera.near = 0.01
  camera.far = 100
  camera.position.set(0, 0, baseCamZ * dist)
  camera.lookAt(0, 0, 0)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

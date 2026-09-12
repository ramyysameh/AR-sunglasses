/**
 * Landmark-derived invisible face shell that writes depth for glasses occlusion.
 */
import * as THREE from 'three'
import { FaceLandmarker } from '@mediapipe/tasks-vision'
import {
  FACE_OVAL_RING,
  RING_LENGTH,
  TEMPLE_SPAN_LANDMARKS,
  resolveShellDepthRatio,
  resolveShellLateralRatio,
  resolveShellTaper,
  resolveShellEarDepth,
  shellTriangles,
  tessellationTriangles,
  templeSpan,
} from './headShell.js'

// The occluder's FRONT surface is MediaPipe's own face mesh -- all 468
// landmarks, tessellated with the table MediaPipe ships. It replaces a
// hand-written 22-vertex mask that was too coarse to work as a depth surface:
// measured at 38 degrees of yaw, 100% of the far temple's pixels fell inside
// the occluder's silhouette while only 1% were actually hidden, because a
// cartoon of a face cannot put the nose and cheek in front of an arm passing
// behind them. The real mesh has the relief that depth test needs.
const FACE_VERTEX_COUNT = 468

const OCCLUDER_POINTS = Array.from({ length: FACE_VERTEX_COUNT }, (_, index) => ({
  key: null,
  index,
}))

// Ring vertices are the face-oval landmarks THEMSELVES -- no separate copies,
// since the full mesh already contains them. The wall is stitched from those
// vertices to their extruded partners, which keeps the shell welded to the face
// surface instead of meeting it at a seam.
const EAR_RING_START = FACE_VERTEX_COUNT
const BACK_RING_START = EAR_RING_START + RING_LENGTH
const CAP_VERTEX = BACK_RING_START + RING_LENGTH
const VERTEX_COUNT = CAP_VERTEX + 1
// Kept for the tests and the collapse loop, which only care where the shell starts.
const EXTRUDED_START = EAR_RING_START

const TEMPLE_SPAN_VERTEX = {
  left: TEMPLE_SPAN_LANDMARKS.left,
  right: TEMPLE_SPAN_LANDMARKS.right,
}

/**
 * Central landmarks used as the head's origin for shell shaping.
 *
 * NOT the temple midpoint, which is the obvious choice and the wrong one. The
 * face-oval sides sit on the silhouette edge and are half self-occluded through
 * a turn, which makes them the noisiest landmarks on the face. Measured in
 * head-local space over 90 frames of live turning, movement per frame that a
 * rigid head should not have at all:
 *
 *   nose tip (1)        0.57 mm mean,  5.7 mm peak
 *   forehead (10)       0.57 mm mean,  4.4 mm peak
 *   face oval (234)     2.55 mm mean, 27.3 mm peak   <- silhouette edge
 *   face oval (454)     2.52 mm mean, 25.2 mm peak   <- silhouette edge
 *
 * Anchoring on the central points keeps that 4x noise out of the shell's origin.
 */
const HEAD_ORIGIN_VERTICES = [1, 4, 10, 168]

/**
 * Smoothing on the shell's SHAPE, held in head-local space.
 *
 * A head's shape does not change; only its pose does. The shell was rebuilt from
 * the face-oval ring every frame, so it inherited those landmarks' noise one for
 * one -- the extruded ring measured 2.63 mm mean / 27.7 mm peak of head-local
 * movement, essentially identical to the oval it is built from. The temple tip
 * is cut exactly at that boundary, by design, so the visible end of the arm
 * danced with it.
 *
 * Smoothing here costs no tracking latency: POSE still comes straight from the
 * frame's quaternion and the head origin every frame. Only the shape is held.
 */
const SHELL_SHAPE_ALPHA = 0.08

const OCCLUDER_INDICES = [
  ...tessellationTriangles(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
  ...shellTriangles(FACE_OVAL_RING, EAR_RING_START, BACK_RING_START, CAP_VERTEX),
]

/** Reads one vertex out of the flat smoothed-position array. */
function readPoint(positions, vertex) {
  const i = vertex * 3
  return { x: positions[i], y: positions[i + 1], z: positions[i + 2] }
}

function createOcclusionGeometry() {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(VERTEX_COUNT * 3)

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(OCCLUDER_INDICES)
  geometry.computeBoundingSphere()

  return geometry
}

export class FaceOccluder {
  constructor(options = {}) {
    this.scene = null
    this.occluderMesh = null
    this.shellDepthRatio = Number.isFinite(options.shellDepthRatio)
      ? options.shellDepthRatio
      : resolveShellDepthRatio(typeof window !== 'undefined' ? window.location.search : '')
    this.shellLateralRatio = Number.isFinite(options.shellLateralRatio)
      ? options.shellLateralRatio
      : resolveShellLateralRatio(typeof window !== 'undefined' ? window.location.search : '')
    this.shellTaper = Number.isFinite(options.shellTaper)
      ? options.shellTaper
      : resolveShellTaper(typeof window !== 'undefined' ? window.location.search : '')
    this.shellEarDepth = Number.isFinite(options.shellEarDepth)
      ? options.shellEarDepth
      : resolveShellEarDepth(typeof window !== 'undefined' ? window.location.search : '')
    this.debugVisible = options.debugVisible ?? (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('occdbg') === '1'
    )
  }

  async init(scene) {
    this.scene = scene

    const geometry = createOcclusionGeometry()
    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    })

    this.occluderMesh = new THREE.Mesh(geometry, material)
    this.occluderMesh.renderOrder = -1
    this.occluderMesh.matrixAutoUpdate = false
    this.occluderMesh.frustumCulled = false
    this.occluderMesh.visible = false
    this.occluderMesh.matrix.identity()

    // ?occdbg=1 paints the normally-invisible occluder as wireframe, so the
    // shell's size and placement can be judged on a real face -- it is the one
    // part of this mesh you cannot infer from the render.
    // Only colorWrite/wireframe change: renderOrder and depthTest stay as they
    // are, so the mesh still draws FIRST and still occludes. Forcing it in front
    // (renderOrder 999 + depthTest off) shows the shell but stops it masking
    // anything -- a debug view that quietly disables the thing being debugged.
    if (this.debugVisible) {
      material.colorWrite = true
      material.wireframe = true
      material.color.setHex(0xff2266)
    }

    this.scene.add(this.occluderMesh)

    return this
  }

  update(matrix) {
    if (!this.occluderMesh || !matrix) {
      return
    }

    // Same reasoning as updateFromAnchors: this path carries no ring landmarks,
    // so the shell folds away instead of being dragged around by the matrix.
    const position = this.occluderMesh.geometry.attributes.position
    this._collapseShell(position)
    position.needsUpdate = true

    this.occluderMesh.matrix.copy(matrix)
    this.occluderMesh.matrixAutoUpdate = false
    this.occluderMesh.matrixWorldNeedsUpdate = true
    this.show()
  }

  updateFromAnchors(anchorWorldPoints) {
    if (!this.occluderMesh || !anchorWorldPoints) {
      return
    }

    const position = this.occluderMesh.geometry.attributes.position

    OCCLUDER_POINTS.forEach((definition, index) => {
      const point = definition.key ? anchorWorldPoints[definition.key] : null
      if (!point) {
        return
      }

      position.setXYZ(index, point.x, point.y, point.z)
    })

    // No ring landmarks on the anchor path -- fold the shell away rather than
    // leaving the last face-mesh frame's volume standing in the scene.
    this._collapseShell(position)

    position.needsUpdate = true
    // No computeVertexNormals: the occluder is a MeshBasicMaterial that never
    // reads normals, and recomputing them for ~960 triangles every frame was
    // pure waste. Bounding sphere still matters for culling correctness.
    this.occluderMesh.geometry.computeBoundingSphere()
    this.occluderMesh.matrix.identity()
    this.occluderMesh.matrixWorldNeedsUpdate = true
    this.show()
  }

  /**
   * Flattens every shell vertex onto the mask's first vertex.
   *
   * The ring landmarks only arrive on the face-mesh path; the anchor and matrix
   * paths have no data for them. Collapsing ring, extruded and cap vertices onto
   * one point makes every shell triangle zero-area, so it draws nothing instead
   * of smearing stale positions across the scene as a depth-writing volume.
   */
  _collapseShell(position) {
    const x = position.getX(0)
    const y = position.getY(0)
    const z = position.getZ(0)

    for (let vertex = EXTRUDED_START; vertex < VERTEX_COUNT; vertex += 1) {
      position.setXYZ(vertex, x, y, z)
    }
  }

  /**
   * Builds the closed shell: ring pushed outward at the ears, extruded back
   * along the head's own -Z, sealed with a cap.
   *
   * The direction comes from the FRAME's quaternion, not from a separately
   * derived head pose: the same reasoning as `correction` below, one step up in
   * rotation rather than position. Extruding along the arm's own axis means the
   * surface the arm disappears behind cannot rotate out from under it, however
   * the two smoothing curves happen to be tuned.
   */
  _updateShell(position, headQuaternion, cx, cy, cz) {
    const s = this._smoothedPts
    const templeL = readPoint(s, TEMPLE_SPAN_VERTEX.left)
    const templeR = readPoint(s, TEMPLE_SPAN_VERTEX.right)
    const rawSpan = templeSpan(templeL, templeR)

    if (!headQuaternion || !(rawSpan > 0)) {
      this._collapseShell(position)
      return
    }

    // Head origin from central landmarks only -- see HEAD_ORIGIN_VERTICES.
    let ox = 0, oy = 0, oz = 0
    for (const vertex of HEAD_ORIGIN_VERTICES) {
      const i = vertex * 3
      ox += s[i]; oy += s[i + 1]; oz += s[i + 2]
    }
    ox /= HEAD_ORIGIN_VERTICES.length
    oy /= HEAD_ORIGIN_VERTICES.length
    oz /= HEAD_ORIGIN_VERTICES.length

    const seeded = this._ringLocal != null
    if (!seeded) this._ringLocal = new Float32Array(RING_LENGTH * 3)
    const alpha = seeded ? SHELL_SHAPE_ALPHA : 1

    // Span is a shape measurement too, and it is taken from the same noisy
    // silhouette landmarks, so it gets the same treatment. Left unsmoothed it
    // breathes the whole shell in and out, since it scales both the extrusion
    // depth and the ear bulge.
    this._shellSpan = seeded ? this._shellSpan + (rawSpan - this._shellSpan) * alpha : rawSpan
    const span = this._shellSpan
    const depth = span * this.shellDepthRatio
    const widen = span * this.shellLateralRatio
    const halfSpan = span * 0.5

    const inverse = (this._invQuat ??= new THREE.Quaternion()).copy(headQuaternion).invert()
    const v = (this._shellTmp ??= new THREE.Vector3())

    let capX = 0
    let capY = 0
    let capZ = 0

    for (let k = 0; k < RING_LENGTH; k += 1) {
      const i = FACE_OVAL_RING[k] * 3
      const j = k * 3

      // Into the head's own frame, where the ring is a fixed shape, and average
      // it there. Smoothing in WORLD space -- which is what the face mesh does --
      // cannot do this job: through a turn the world position of a rigid point
      // changes legitimately and fast, so a world-space average lags the head
      // instead of removing shape noise.
      v.set(s[i] - ox, s[i + 1] - oy, s[i + 2] - oz).applyQuaternion(inverse)
      this._ringLocal[j] += (v.x - this._ringLocal[j]) * alpha
      this._ringLocal[j + 1] += (v.y - this._ringLocal[j + 1]) * alpha
      this._ringLocal[j + 2] += (v.z - this._ringLocal[j + 2]) * alpha

      // Bulge and extrusion are now plain axis operations: in head-local space
      // +X IS lateral and -Z IS backward, so no projection onto a rotated axis
      // is needed and none of that arithmetic can pick up pose noise.
      const lx = this._ringLocal[j]
      const w = halfSpan > 1e-6
        ? widen * Math.max(Math.min(lx / halfSpan, 1), -1)
        : 0

      // Ear ring: bulged outward, a third of the way back, where a head is
      // widest and where the temple tip has to disappear.
      v.set(lx + w, this._ringLocal[j + 1], this._ringLocal[j + 2] - depth * this.shellEarDepth)
        .applyQuaternion(headQuaternion)
      // Only the EXTRUDED copies are written. The ring vertex itself is a shared
      // face-mesh vertex; moving it would tear a hole in the face surface.
      position.setXYZ(EAR_RING_START + k, ox + v.x + cx, oy + v.y + cy, oz + v.z + cz)

      // Back ring: tapered in toward the occiput. A cylinder here is what
      // swallowed the arm from the cheekbone backwards.
      const taper = this.shellTaper
      v.set(lx * taper, this._ringLocal[j + 1] * taper, this._ringLocal[j + 2] - depth)
        .applyQuaternion(headQuaternion)

      const ex = ox + v.x + cx
      const ey = oy + v.y + cy
      const ez = oz + v.z + cz
      position.setXYZ(BACK_RING_START + k, ex, ey, ez)

      capX += ex
      capY += ey
      capZ += ez
    }

    // Single vertex closing the back: the mean of the extruded ring, which keeps
    // the cap flat and inside the ring's own silhouette. It only has to seal the
    // volume, not model the back of the skull.
    position.setXYZ(CAP_VERTEX, capX / RING_LENGTH, capY / RING_LENGTH, capZ / RING_LENGTH)
  }

  updateFromFaceMesh(
    faceWorldPoints,
    anchorWorldPoints = {},
    smoothingAlpha = 1,
    correction = null,
    headQuaternion = null
  ) {
    if (!this.occluderMesh || !Array.isArray(faceWorldPoints)) {
      return
    }

    const position = this.occluderMesh.geometry.attributes.position

    // The mask vertices come from RAW per-frame landmarks (unlike the frame, which
    // is One-Euro filtered), so at rest their noise shimmers the mask edge against
    // the steady frame — visible as jitter where the bridge meets the nose. Smooth
    // each vertex toward its target: alpha≈0 (rest) is heavy smoothing, alpha≈1
    // (motion) tracks tightly, and a large jump snaps (face re-acquisition) so the
    // mask never eases in from a stale pose.
    const a = Number.isFinite(smoothingAlpha) ? Math.min(Math.max(smoothingAlpha, 0), 1) : 1
    // `correction` is the frame's OWN filtered/predicted position minus its raw
    // tracked position -- i.e. exactly what the frame's smoothing pipeline just
    // did. The per-vertex smoothing above only damps SHAPE noise (independent of
    // the frame); it doesn't make the mask's overall position track the frame's
    // particular smoothing curve. Applying the identical delta here, AFTER shape
    // smoothing and unsmoothed itself (it's already exactly frame-synced, so
    // smoothing it again would just reintroduce lag), locks the mask's position
    // to the frame's by construction rather than by matching two tuned curves.
    const cx = correction?.x ?? 0
    const cy = correction?.y ?? 0
    const cz = correction?.z ?? 0
    const SNAP_DIST_SQ = 0.05 * 0.05 // >5 cm jump = re-acquisition, not jitter
    if (!this._smoothedPts || this._smoothedPts.length !== OCCLUDER_POINTS.length * 3) {
      this._smoothedPts = null
    }
    const seed = !this._smoothedPts
    if (seed) this._smoothedPts = new Float32Array(OCCLUDER_POINTS.length * 3)
    const s = this._smoothedPts

    OCCLUDER_POINTS.forEach((definition, vertexIndex) => {
      const point = faceWorldPoints[definition.index] ??
        (definition.key ? anchorWorldPoints[definition.key] : null)
      if (!point) {
        return
      }

      const i = vertexIndex * 3
      const dx = point.x - s[i]
      const dy = point.y - s[i + 1]
      const dz = point.z - s[i + 2]
      if (seed || dx * dx + dy * dy + dz * dz > SNAP_DIST_SQ) {
        s[i] = point.x
        s[i + 1] = point.y
        s[i + 2] = point.z
      } else {
        s[i] += dx * a
        s[i + 1] += dy * a
        s[i + 2] += dz * a
      }
      position.setXYZ(vertexIndex, s[i] + cx, s[i + 1] + cy, s[i + 2] + cz)
    })

    this._updateShell(position, headQuaternion, cx, cy, cz)

    position.needsUpdate = true
    // No computeVertexNormals: the occluder is a MeshBasicMaterial that never
    // reads normals, and recomputing them for ~960 triangles every frame was
    // pure waste. Bounding sphere still matters for culling correctness.
    this.occluderMesh.geometry.computeBoundingSphere()
    this.occluderMesh.matrix.identity()
    this.occluderMesh.matrixWorldNeedsUpdate = true
    this.show()
  }

  hide() {
    if (this.occluderMesh) {
      this.occluderMesh.visible = false
    }
  }

  show() {
    if (this.occluderMesh) {
      this.occluderMesh.visible = true
    }
  }
}

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
const EXTRUDED_START = FACE_VERTEX_COUNT
const CAP_VERTEX = EXTRUDED_START + RING_LENGTH
const VERTEX_COUNT = CAP_VERTEX + 1

const TEMPLE_SPAN_VERTEX = {
  left: TEMPLE_SPAN_LANDMARKS.left,
  right: TEMPLE_SPAN_LANDMARKS.right,
}

const OCCLUDER_INDICES = [
  ...tessellationTriangles(FaceLandmarker.FACE_LANDMARKS_TESSELATION),
  ...shellTriangles(FACE_OVAL_RING, EXTRUDED_START, CAP_VERTEX),
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
    this.debugVisible = options.debugVisible ?? (
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('occdbg') === '1'
    )
    this._backward = new THREE.Vector3()
    this._outward = new THREE.Vector3()
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
    const span = templeSpan(templeL, templeR)
    const depth = span * this.shellDepthRatio

    if (!headQuaternion || !(depth > 0)) {
      this._collapseShell(position)
      return
    }

    const back = this._backward.set(0, 0, -1).applyQuaternion(headQuaternion).multiplyScalar(depth)

    // Lateral bulge, so the wall sits where the EARS are rather than on the face
    // oval, which traces the narrower face. Weighted by how lateral each ring
    // point already is (its projection onto the head's own X), so the sides push
    // out and the chin and forehead stay put instead of inflating the whole
    // head. The sign comes from that same projection rather than a hardcoded
    // axis: which MediaPipe side maps to which world sign depends on mirroring,
    // and guessing wrong would pull the wall INTO the head.
    const axis = this._outward.set(1, 0, 0).applyQuaternion(headQuaternion)
    const midX = (templeL.x + templeR.x) / 2
    const midY = (templeL.y + templeR.y) / 2
    const midZ = (templeL.z + templeR.z) / 2
    const widen = span * this.shellLateralRatio
    const halfSpan = span * 0.5

    let capX = 0
    let capY = 0
    let capZ = 0

    for (let k = 0; k < RING_LENGTH; k += 1) {
      // The ring vertex IS the face-oval landmark, already smoothed as part of
      // the face mesh, so the wall starts exactly on the face surface.
      const i = FACE_OVAL_RING[k] * 3
      const lateral = halfSpan > 1e-6
        ? ((s[i] - midX) * axis.x + (s[i + 1] - midY) * axis.y + (s[i + 2] - midZ) * axis.z) / halfSpan
        : 0
      const w = widen * Math.max(Math.min(lateral, 1), -1)
      const rx = s[i] + axis.x * w + cx
      const ry = s[i + 1] + axis.y * w + cy
      const rz = s[i + 2] + axis.z * w + cz

      // Only the EXTRUDED copy moves outward. Widening the ring vertex itself
      // would drag the shared face-mesh vertex with it and tear a hole in the
      // face surface, since the tessellation uses the same vertex.
      position.setXYZ(EXTRUDED_START + k, rx + back.x, ry + back.y, rz + back.z)

      capX += rx + back.x
      capY += ry + back.y
      capZ += rz + back.z
    }

    // Single vertex closing the back. Its position is the mean of the extruded
    // ring, which keeps the cap flat and inside the ring's own silhouette -- the
    // cap only has to seal the volume, not model the back of the skull.
    const n = RING_LENGTH
    position.setXYZ(CAP_VERTEX, capX / n, capY / n, capZ / n)
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

/**
 * Landmark-derived invisible face shell that writes depth for glasses occlusion.
 */
import * as THREE from 'three'

const OCCLUDER_POINTS = [
  { key: 'forehead', index: 10 },
  { key: 'leftTemple', index: 234 },
  { key: null, index: 70 },
  { key: 'browCenter', index: 9 },
  { key: null, index: 300 },
  { key: 'rightTemple', index: 454 },
  { key: null, index: 33 },
  { key: 'leftIris', index: 468 },
  { key: 'bridgeTop', index: 168 },
  { key: 'rightIris', index: 473 },
  { key: null, index: 263 },
  { key: 'leftCheek', index: 123 },
  { key: 'bridgeCenter', index: 6 },
  { key: 'rightCheek', index: 352 },
  { key: null, index: 129 },
  { key: 'noseTip', index: 1 },
  { key: null, index: 358 },
  { key: null, index: 152 },
  { key: null, index: 172 },
  { key: null, index: 397 },
  { key: null, index: 205 },
  { key: null, index: 425 },
]

const OCCLUDER_INDICES = [
  0, 1, 2,
  0, 2, 3,
  0, 3, 4,
  0, 4, 5,
  2, 6, 7,
  2, 7, 8,
  4, 8, 9,
  4, 9, 10,
  6, 11, 7,
  7, 11, 12,
  7, 12, 8,
  8, 12, 9,
  9, 12, 13,
  9, 13, 10,
  11, 14, 12,
  12, 14, 15,
  12, 15, 16,
  12, 16, 13,
  11, 18, 14,
  14, 18, 17,
  14, 17, 15,
  15, 17, 16,
  16, 17, 19,
  16, 19, 13,
  11, 20, 14,
  13, 16, 21,
]

function createOcclusionGeometry() {
  const geometry = new THREE.BufferGeometry()
  const positions = new Float32Array(OCCLUDER_POINTS.length * 3)

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setIndex(OCCLUDER_INDICES)
  geometry.computeBoundingSphere()

  return geometry
}

export class FaceOccluder {
  constructor() {
    this.scene = null
    this.occluderMesh = null
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

    this.scene.add(this.occluderMesh)

    return this
  }

  update(matrix) {
    if (!this.occluderMesh || !matrix) {
      return
    }

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

    position.needsUpdate = true
    this.occluderMesh.geometry.computeVertexNormals()
    this.occluderMesh.geometry.computeBoundingSphere()
    this.occluderMesh.matrix.identity()
    this.occluderMesh.matrixWorldNeedsUpdate = true
    this.show()
  }

  updateFromFaceMesh(faceWorldPoints, anchorWorldPoints = {}, smoothingAlpha = 1) {
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
      position.setXYZ(vertexIndex, s[i], s[i + 1], s[i + 2])
    })

    position.needsUpdate = true
    this.occluderMesh.geometry.computeVertexNormals()
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

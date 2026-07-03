import { mergedPositions } from './glbAccess.js'
import { computeBounds } from './geometry.js'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function transformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ]
}

// Bake each mesh node's world transform into its vertex data so all downstream
// geometry reads one consistent space and node transforms are identity. Handles the
// flat (direct scene-child) node layout the modeling spec expects and that exported
// eyewear GLBs use; deeply-nested rigs would need a full scene-graph flatten (A2).
function bakeNodeTransforms(doc) {
  let baked = false
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const m = node.getWorldMatrix()
    if (m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)) continue
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION')
      if (!acc) continue
      const arr = acc.getArray().slice()
      for (let i = 0; i < arr.length; i += 3) {
        const [x, y, z] = transformPoint(m, arr[i], arr[i + 1], arr[i + 2])
        arr[i] = x
        arr[i + 1] = y
        arr[i + 2] = z
      }
      acc.setArray(arr)
    }
    node.setTranslation([0, 0, 0])
    node.setRotation([0, 0, 0, 1])
    node.setScale([1, 1, 1])
    baked = true
  }
  return baked
}

export function normalizeModel(doc, spec) {
  const transforms = []
  if (bakeNodeTransforms(doc)) transforms.push('flatten')
  const positions = mergedPositions(doc)
  if (positions.length === 0) return { doc, transforms }

  const { min, max } = computeBounds(positions)
  // Front slab X-center → 0; bridge-top (max.y at front) → y 0; front plane keeps +z.
  const frontZThreshold = max.z - (max.z - min.z) * 0.25
  let frontMinX = Infinity
  let frontMaxX = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= frontZThreshold) {
      frontMinX = Math.min(frontMinX, positions[i])
      frontMaxX = Math.max(frontMaxX, positions[i])
    }
  }
  const dx = -(frontMinX + frontMaxX) / 2
  const dy = -max.y
  const dz = 0

  if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
    // Non-mesh nodes (e.g. anchor tags) shift by translation so they stay aligned
    // with the recentered mesh. Mesh-bearing nodes are excluded here: their vertex
    // data gets the offset baked directly below, and bakeNodeTransforms already
    // reset their node transform to identity — bumping translation here would
    // double-apply the offset and break the identity invariant.
    for (const node of doc.getRoot().listScenes()[0].listChildren()) {
      if (node.getMesh()) continue
      const t = node.getTranslation()
      node.setTranslation([t[0] + dx, t[1] + dy, t[2] + dz])
    }
    // Bake the translation into positions too so downstream reads see it.
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const acc = prim.getAttribute('POSITION')
        const arr = acc.getArray().slice()
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] += dx
          arr[i + 1] += dy
          arr[i + 2] += dz
        }
        acc.setArray(arr)
      }
    }
    transforms.push('recenter')
  }

  return { doc, transforms }
}

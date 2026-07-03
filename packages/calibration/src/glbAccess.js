export function mergedPositions(doc) {
  const chunks = []
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const accessor = prim.getAttribute('POSITION')
      if (accessor) chunks.push(accessor.getArray())
    }
  }
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

export function countTriangles(doc) {
  let verts = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices()
      const pos = prim.getAttribute('POSITION')
      verts += idx ? idx.getCount() : (pos ? pos.getCount() : 0)
    }
  }
  return Math.floor(verts / 3)
}

export function findNode(doc, name) {
  return doc.getRoot().listNodes().find((n) => n.getName() === name) ?? null
}

import { Document } from '@gltf-transform/core'

// Build a minimal glTF Document from a flat position array (one triangle-list
// mesh). Optional named empty nodes place anchor tags at given {x,y,z}.
export function buildDoc(positions, tags = {}) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const accessor = doc
    .createAccessor()
    .setType('VEC3')
    .setArray(new Float32Array(positions))
    .setBuffer(buffer)
  const prim = doc.createPrimitive().setAttribute('POSITION', accessor)
  const mesh = doc.createMesh('frame').addPrimitive(prim)
  const node = doc.createNode('frameNode').setMesh(mesh)
  const scene = doc.createScene().addChild(node)
  for (const [name, p] of Object.entries(tags)) {
    scene.addChild(doc.createNode(name).setTranslation([p.x, p.y, p.z]))
  }
  return doc
}

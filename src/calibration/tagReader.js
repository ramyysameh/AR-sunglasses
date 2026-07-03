import { findNode } from './glbAccess.js'

function anchorOf(node) {
  const t = node.getTranslation()
  return { x: t[0], y: t[1], z: t[2] }
}

export function readTags(doc, spec) {
  const bridge = findNode(doc, spec.tagNames.bridge)
  const left = findNode(doc, spec.tagNames.hingeL)
  const right = findNode(doc, spec.tagNames.hingeR)
  if (!bridge || !left || !right) {
    return { found: false, anchors: null }
  }
  return {
    found: true,
    anchors: {
      bridge: anchorOf(bridge),
      leftHinge: anchorOf(left),
      rightHinge: anchorOf(right),
    },
  }
}

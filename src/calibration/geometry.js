export function computeBounds(positions) {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < min.x) min.x = x
    if (y < min.y) min.y = y
    if (z < min.z) min.z = z
    if (x > max.x) max.x = x
    if (y > max.y) max.y = y
    if (z > max.z) max.z = z
  }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }
  const center = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 }
  return { min, max, size, center }
}

// Voxel-occupancy mirror symmetry about the X=0 plane: bucket vertices into a
// coarse grid and measure the fraction whose X-mirror voxel is unoccupied.
// 0 = every occupied region has a mirror across X=0 (symmetric); grows toward 1
// as geometry lacks a mirror counterpart. Tessellation-independent (vertex-count
// differences collapse into the same voxel) and scale-invariant (voxel ~ width/32).
export function measureSymmetryDeviation(positions) {
  const { size } = computeBounds(positions)
  const width = size.x || 1
  const voxel = Math.max(width / 32, 1e-9)
  const key = (x, y, z) =>
    `${Math.round(x / voxel)},${Math.round(y / voxel)},${Math.round(z / voxel)}`

  const occupied = new Set()
  for (let i = 0; i < positions.length; i += 3) {
    occupied.add(key(positions[i], positions[i + 1], positions[i + 2]))
  }

  let mismatched = 0
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    count += 1
    if (!occupied.has(key(-positions[i], positions[i + 1], positions[i + 2]))) {
      mismatched += 1
    }
  }
  return count ? mismatched / count : 0
}

// The front slab = vertices within the front 25% of the Z range. Its X extent is
// the frame width.
export function measureFrontWidth(positions) {
  const { min, max } = computeBounds(positions)
  const zThreshold = max.z - (max.z - min.z) * 0.25
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 2] >= zThreshold) {
      minX = Math.min(minX, positions[i])
      maxX = Math.max(maxX, positions[i])
    }
  }
  return maxX - minX
}

// Hinges = the outermost front-slab vertex on each side. Certainty rises with how
// far the mesh extends rearward (−Z) past the front slab ON BOTH sides — a single
// arm, an off-axis rear spike, or a flat front all score low, since real eyewear
// has two temple arms. Distinguishing genuine thin arms from an unusually deep
// front slab is left to A2 tuning against real GLBs.
export function detectTemples(positions) {
  const { min, max } = computeBounds(positions)
  const zRange = max.z - min.z || 1
  const zThreshold = max.z - zRange * 0.25
  let left = null
  let right = null
  let leftRearDepth = 0
  let rightRearDepth = 0
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (z >= zThreshold) {
      if (x < 0 && (left === null || x < left.x)) left = { x, y, z }
      if (x > 0 && (right === null || x > right.x)) right = { x, y, z }
    }
    const rear = zThreshold - z
    if (rear > 0) {
      if (x < 0) leftRearDepth = Math.max(leftRearDepth, rear)
      else if (x > 0) rightRearDepth = Math.max(rightRearDepth, rear)
    }
  }
  const bothArms = Math.min(leftRearDepth, rightRearDepth)
  const certainty = Math.max(0, Math.min(1, bothArms / (zRange * 0.5)))
  return {
    leftHinge: left ?? { x: 0, y: 0, z: 0 },
    rightHinge: right ?? { x: 0, y: 0, z: 0 },
    certainty,
  }
}

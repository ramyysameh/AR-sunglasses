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

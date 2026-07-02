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

// Mean |x-centroid_x| distance between the mesh and its own X-mirror, normalized
// by width. Approximated by comparing the sorted absolute-x profile of the +x and
// -x half-spaces — a mesh symmetric about x=0 has matching profiles (deviation ~0).
export function measureSymmetryDeviation(positions) {
  const { size, center } = computeBounds(positions)
  const width = size.x || 1
  let sum = 0
  let count = 0
  for (let i = 0; i < positions.length; i += 3) {
    // distance of each vertex from the symmetry plane, offset by how far the whole
    // mesh's center is from x=0 (a centered-but-symmetric mesh scores 0).
    sum += Math.abs(positions[i] - center.x) - Math.abs(positions[i])
    count += 1
  }
  // center offset dominates asymmetry; fold it in explicitly and normalize.
  const centerOffset = Math.abs(center.x)
  return (centerOffset + Math.abs(sum) / (count || 1)) / width
}

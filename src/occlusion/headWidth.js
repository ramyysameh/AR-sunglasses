/**
 * The head's half-width at a height, by ray cast against the shell's triangles.
 *
 * The splay solve needs to know how wide the head is where the temple runs. The
 * measurement it used before took the widest shell VERTEX inside an 8 mm slab,
 * and the shell is built from a few sparse rings, so the answer jumped with
 * height in a way a head does not: sampled every 9 mm it read
 *
 *   80.2  75.0  80.3  73.8  80.6  70.9  81.1  81.1  79.5  76.4  68.7  57.6 mm
 *
 * -- alternating by five millimetres depending on whether the slab happened to
 * catch a ring or fall between two. Downstream that put the SAME head at 72.5,
 * 84.9 and 94.4 mm depending only on how high the loaded frame's temple rides,
 * and the splay solve opened Willow's arms 25 mm wider than Gripz's on one face.
 *
 * A ray hits the interpolated surface, so its answer is continuous in height and
 * says nothing about where the vertices happen to be.
 *
 * Pure arithmetic on arrays, no Three.js, so it can be tested headlessly.
 */

/**
 * Transforms a flat xyz position array by a column-major 4x4.
 *
 * @param {ArrayLike<number>} positions flat xyz, length divisible by 3
 * @param {ArrayLike<number>} matrix column-major 16
 * @param {Float64Array} [out] reusable buffer of the same length
 * @returns {Float64Array}
 */
export function toWorldPositions(positions, matrix, out) {
  const target = out && out.length === positions.length ? out : new Float64Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    target[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]
    target[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]
    target[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]
  }
  return target
}

/**
 * Distance from `origin` to the nearest triangle along `+direction`.
 *
 * Moller-Trumbore, two-sided: the shell is drawn DoubleSide and the origin sits
 * inside it, so a one-sided test would miss every wall it is meant to find.
 *
 * @returns {number} distance in the positions' own units, or Infinity
 */
export function castDistance(world, indices, origin, direction) {
  let nearest = Infinity
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3

    const e1x = world[b] - world[a], e1y = world[b + 1] - world[a + 1], e1z = world[b + 2] - world[a + 2]
    const e2x = world[c] - world[a], e2y = world[c + 1] - world[a + 1], e2z = world[c + 2] - world[a + 2]

    const hx = direction[1] * e2z - direction[2] * e2y
    const hy = direction[2] * e2x - direction[0] * e2z
    const hz = direction[0] * e2y - direction[1] * e2x

    const det = e1x * hx + e1y * hy + e1z * hz
    if (det > -1e-12 && det < 1e-12) continue
    const inv = 1 / det

    const sx = origin[0] - world[a], sy = origin[1] - world[a + 1], sz = origin[2] - world[a + 2]
    const u = (sx * hx + sy * hy + sz * hz) * inv
    if (u < 0 || u > 1) continue

    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inv
    if (v < 0 || u + v > 1) continue

    // Self-hit epsilon. Positions arrive in a Float32Array at roughly half a
    // metre from the origin, where float32 quantisation is ~3e-8 m -- a
    // one-nanometre (1e-9) epsilon sits ~30x below that noise floor, so a ray
    // starting ON a surface (as both casts here do, from a point derived from
    // the same mesh) can register a spurious near-zero self-hit.
    const distance = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (distance > 1e-6 && distance < nearest) nearest = distance
  }
  return nearest
}

/**
 * Half-width of the shell at `height` above `origin`, along `lateral`.
 *
 * Both sides are cast and averaged: the ear midpoint is not exactly on the
 * mid-sagittal plane, and averaging cancels that offset to first order where
 * taking one side would carry it straight into the splay angle.
 *
 * @param {Float64Array} world positions already in the same space as origin
 * @param {ArrayLike<number>} indices triangle indices
 * @param {number[]} origin a point near the mid-sagittal plane
 * @param {number[]} lateral side to side; need not be unit length
 * @param {number[]} up unit, perpendicular to lateral
 * @param {number} height how far above origin to measure
 * @returns {number | null} null if either cast misses, or if `lateral` has no
 *   length to normalise -- a half-measurement is worse than none, because the
 *   solve cannot tell the two apart
 */
export function halfWidthAt(world, indices, origin, lateral, up, height) {
  const from = [
    origin[0] + up[0] * height,
    origin[1] + up[1] * height,
    origin[2] + up[2] * height,
  ]
  // castDistance returns distance in units of |direction|. The caller's axis
  // comes off a filtered head quaternion, and a 2% norm drift there would be a
  // 1.6 mm error against a 4 mm resolve threshold -- normalise here so the
  // measurement cannot inherit the filter's own drift.
  const len = Math.hypot(lateral[0], lateral[1], lateral[2])
  if (!(len > 0)) return null
  const unitLateral = [lateral[0] / len, lateral[1] / len, lateral[2] / len]
  const right = castDistance(world, indices, from, unitLateral)
  const left = castDistance(world, indices, from, [-unitLateral[0], -unitLateral[1], -unitLateral[2]])
  if (!Number.isFinite(right) || !Number.isFinite(left)) return null
  return (right + left) / 2
}

/**
 * Splits a temple arm into two rigid pieces so it can be articulated.
 *
 * The arm needs 13-17 mm of outward movement that is ZERO at the hinge and
 * grows toward the ear, and then has to come back in so the tip hides behind the
 * ear. One rigid body cannot do that: a rotation big enough to lift the middle
 * clear of the cheek throws the tip out past the head, and a shift big enough to
 * clear the cheek steps the arm sideways at the hinge, where it should meet the
 * front flush. Measured on GRIPZ, every single-transform option failed -- 0/14
 * judged poses either way.
 *
 * Two pieces on two pivots does what a real temple does: bow outward over the
 * cheekbone, then curve back in around the ear.
 *
 * This CUTS the mesh, it does not deform it. Every vertex keeps its position
 * relative to its neighbours inside a piece; the only new vertices are the ones
 * on the cut plane itself, interpolated exactly along the edges they split, so
 * the two pieces still describe the arm the merchant supplied.
 */
import * as THREE from 'three'

/**
 * Reads one vertex's attributes into a plain array-of-arrays, in `names` order.
 */
function readVertex(attributes, names, index) {
  return names.map((name) => {
    const attribute = attributes[name]
    const out = new Array(attribute.itemSize)
    for (let c = 0; c < attribute.itemSize; c += 1) {
      out[c] = attribute.array[index * attribute.itemSize + c]
    }
    return out
  })
}

/** Linear blend of two such vertices. */
function mix(a, b, t) {
  return a.map((values, k) => values.map((v, c) => v + (b[k][c] - v) * t))
}

/**
 * Cuts a geometry in two along a plane.
 *
 * Triangles that straddle the plane are clipped rather than assigned whole to
 * one side. Assigning by centroid is far simpler and is wrong here for a visible
 * reason: it leaves the seam ragged by up to a triangle's width, and the moment
 * the rear piece rotates that raggedness becomes a torn edge along the arm.
 *
 * Every attribute is interpolated, not just position, so normals and UVs survive
 * the cut; normals are renormalised afterwards because a linear blend of two
 * unit vectors is not a unit vector.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {(x:number, y:number, z:number) => number} signedDistance
 *   positive on the FRONT side, negative on the REAR side, in the geometry's own
 *   local space
 * @returns {{front: THREE.BufferGeometry, rear: THREE.BufferGeometry}}
 */
export function splitAtPlane(geometry, signedDistance) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry
  const names = Object.keys(source.attributes)
  const position = source.attributes.position

  const distances = new Float64Array(position.count)
  for (let i = 0; i < position.count; i += 1) {
    distances[i] = signedDistance(position.getX(i), position.getY(i), position.getZ(i))
  }

  const buckets = {
    front: names.map(() => []),
    rear: names.map(() => []),
  }
  const emit = (side, ...vertices) => {
    for (const vertex of vertices) {
      vertex.forEach((values, k) => buckets[side][k].push(...values))
    }
  }

  // Whole triangles only. A buffer whose vertex count is not a multiple of 3
  // cannot describe one, and reading past the end yields undefined -- which
  // becomes NaN in the output and takes the entire mesh off screen.
  for (let t = 0; t + 2 < position.count; t += 3) {
    const index = [t, t + 1, t + 2]
    const vertex = index.map((i) => readVertex(source.attributes, names, i))
    const d = index.map((i) => distances[i])
    const isFront = d.map((value) => value >= 0)
    const frontCount = isFront.filter(Boolean).length

    if (frontCount === 3) {
      emit('front', vertex[0], vertex[1], vertex[2])
      continue
    }
    if (frontCount === 0) {
      emit('rear', vertex[0], vertex[1], vertex[2])
      continue
    }

    // One vertex is alone on its side of the plane; call it A and keep the
    // triangle's winding by taking B and C in their original order after it.
    const lone = frontCount === 1 ? isFront.indexOf(true) : isFront.indexOf(false)
    const a = lone
    const b = (lone + 1) % 3
    const c = (lone + 2) % 3
    const p = mix(vertex[a], vertex[b], d[a] / (d[a] - d[b]))
    const q = mix(vertex[a], vertex[c], d[a] / (d[a] - d[c]))

    const loneSide = isFront[a] ? 'front' : 'rear'
    const otherSide = isFront[a] ? 'rear' : 'front'
    emit(loneSide, vertex[a], p, q)
    emit(otherSide, p, vertex[b], vertex[c])
    emit(otherSide, p, vertex[c], q)
  }

  const build = (side) => {
    const out = new THREE.BufferGeometry()
    names.forEach((name, k) => {
      const itemSize = source.attributes[name].itemSize
      out.setAttribute(name, new THREE.BufferAttribute(Float32Array.from(buckets[side][k]), itemSize))
    })
    const normal = out.getAttribute('normal')
    if (normal) {
      const v = new THREE.Vector3()
      for (let i = 0; i < normal.count; i += 1) {
        v.fromBufferAttribute(normal, i)
        if (v.lengthSq() > 0) v.normalize()
        normal.setXYZ(i, v.x, v.y, v.z)
      }
    }
    return out
  }

  return { front: build('front'), rear: build('rear') }
}

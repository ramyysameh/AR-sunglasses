/**
 * Closed head shell for glasses occlusion.
 *
 * Replaces the earlier open "ear skirt" strip, which measurably did not work:
 * with ?pixdbg=1 it removed 6-24% of temple pixels but left the arm's rear
 * screen extent unchanged (0 px of trim at every angle), because an open strip
 * cannot hide a hook that reaches past its edge -- and scaling the strip up
 * 2.5x changed nothing. Occlusion needs a closed volume.
 *
 * So: take MediaPipe's full face-oval ring, push it outward where the head is
 * widest (the ears), extrude it backwards along the head's own -Z, and cap the
 * back. Together with the landmark face mask that already fills the front, that
 * is a sealed bucket the size and shape of the head. The temple arm stays
 * visible where it runs outside that surface and disappears where it passes
 * inside it, which is what an ear physically does.
 *
 * Landmark-driven rather than an authored canonical head on purpose: it scales
 * to each face for free, where a rigid mesh would need its own fitting pass and
 * would still be wrong for faces away from the average.
 *
 * Pure geometry, free of Three.js scene objects so it can be tested headlessly.
 */

/**
 * MediaPipe's FACE_OVAL, as a single connected loop starting at the forehead
 * and running down the subject's left side, across the chin, and back up.
 * Order matters: the wall triangles stitch consecutive entries.
 */
export const FACE_OVAL_RING = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21,
  54, 103, 67, 109,
]

export const RING_LENGTH = FACE_OVAL_RING.length

/** Landmark pair spanning the face, used to size the shell against the head. */
export const TEMPLE_SPAN_LANDMARKS = { left: 234, right: 454 }

/**
 * How far back the shell reaches, as a fraction of the temple span.
 *
 * Sized to contain the temple TIP, not to match anatomy: measured against a
 * 0.147 m frame the rearmost glasses vertex sat ~0.09 past the ring in the
 * mask's (depth-compressed) space, against a span of ~0.174 -- so ~0.52 is the
 * floor and this carries margin for longer temples. Over-extruding is cheap:
 * the shell only grows further behind the head, where there is nothing left to
 * wrongly hide. Tunable with ?shelldepth.
 */
export const DEFAULT_SHELL_DEPTH_RATIO = 0.8

/**
 * How far the widest part of the ring stands out past the face oval.
 *
 * The face oval traces the FACE, which is narrower than the head: it has no
 * ears, and ears protrude ~15-20 mm. Without this the shell's side wall sits
 * inboard of the temple arm and the arm never intersects it. Applied weighted
 * by how lateral each ring point is, so the sides bulge and the chin and
 * forehead stay put rather than inflating the whole head. Tunable with ?shellwide.
 *
 * Sized to an actual ear. Measured frontal on the mock head: the face mesh has a
 * 97 mm half-width and the frame's temples sit at 107 mm, so the arms already
 * clear the FACE comfortably. At 0.12 this bulge put the shell at 122 mm -- a
 * head wider than any real one -- and the arms then ran inside a skull that did
 * not exist, which is what made them look like they were sinking into the skin.
 * An ear protrudes ~15 mm past the face oval, which against a ~193 mm temple
 * span is this ratio.
 *
 * It had briefly been 0.36, inflated to compensate for the old flat 22-vertex
 * mask; with MediaPipe's real face mesh doing the occluding that was both wrong
 * and inert.
 */
export const DEFAULT_SHELL_LATERAL_RATIO = 0.078

function resolve(search, key, fallback, max) {
  const raw = parseFloat(new URLSearchParams(search).get(key))
  // 0 is meaningful for both (flat on the oval / no depth), so only cap above.
  return Number.isFinite(raw) && raw >= 0 && raw <= max ? raw : fallback
}

export function resolveShellDepthRatio(search) {
  return resolve(search, 'shelldepth', DEFAULT_SHELL_DEPTH_RATIO, 3)
}

export function resolveShellLateralRatio(search) {
  return resolve(search, 'shellwide', DEFAULT_SHELL_LATERAL_RATIO, 1)
}

/**
 * Wall + back cap for the extruded ring.
 *
 * The occluder material is DoubleSide and only ever writes depth, so winding is
 * irrelevant here; what matters is that the surface is closed, since that is
 * the whole reason this replaced the open strip.
 *
 * @param {number} ringStart first ring vertex index
 * @param {number} extrudedStart first extruded vertex index (same order)
 * @param {number} capCenter index of the single vertex closing the back
 * @param {number} length ring vertex count
 * @returns {number[]} flat triangle index list
 */
export function shellTriangles(ringVertices, extrudedStart, capCenter) {
  const indices = []
  const length = ringVertices.length

  for (let i = 0; i < length; i += 1) {
    const next = (i + 1) % length // wraps: the ring is a closed loop
    const r0 = ringVertices[i]
    const r1 = ringVertices[next]
    const e0 = extrudedStart + i
    const e1 = extrudedStart + next

    // Side wall
    indices.push(r0, r1, e1, r0, e1, e0)
    // Back cap, as a fan around a single centre vertex
    indices.push(e0, e1, capCenter)
  }

  return indices
}

/**
 * MediaPipe's face tessellation, as triangles.
 *
 * Shipped as a connection (edge) list, but consecutive triples are the three
 * edges of one triangle -- a->b, b->c, c->a -- so the starts of each triple are
 * its corners. Verified against the data rather than assumed.
 *
 * This is what the occluder's front surface is built from. The previous
 * hand-written 22-vertex mask was far too coarse to act as a depth surface: it
 * could not put the nose and cheeks in front of a temple arm passing behind
 * them, so the far temple stayed visible through every turn.
 *
 * @param {Array<{start:number,end:number}>} tessellation FACE_LANDMARKS_TESSELATION
 * @returns {number[]} flat triangle index list
 */
export function tessellationTriangles(tessellation) {
  const indices = []

  for (let i = 0; i + 2 < tessellation.length; i += 3) {
    const a = tessellation[i]
    const b = tessellation[i + 1]
    const c = tessellation[i + 2]
    // Only accept genuinely closed triples, so a malformed or reordered table
    // degrades to fewer triangles instead of silently producing garbage ones.
    if (a.end === b.start && b.end === c.start && c.end === a.start) {
      indices.push(a.start, b.start, c.start)
    }
  }

  return indices
}

/** Distance between two points, tolerating either being missing. */
export function templeSpan(left, right) {
  if (!left || !right) {
    return 0
  }

  const dx = left.x - right.x
  const dy = left.y - right.y
  const dz = left.z - right.z

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

// Regenerates src/tracking/rigidFaceModel.js: the 3D model the PnP head-pose
// solver fits MediaPipe's 2D landmarks against.
//
//   node scripts/extract-rigid-face-model.mjs [path/to/face_landmarker.task]
//
// The geometry is MediaPipe's own canonical face mesh, read out of the same
// face_landmarker.task bundle the engine already downloads (FaceTracker.js), so
// the model and the landmark detector always describe the same 468 points. With
// no argument the bundle is fetched from that same URL.
//
// Only the vertex positions and the per-vertex normals of the chosen subset are
// written. WHICH vertices are used, and how much each is trusted, is decided
// here in RIGID_SUBSET -- see the comment on it.
import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

const TASK_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'
const GEOMETRY_ENTRY = 'geometry_pipeline_metadata_landmarks.binarypb'
const OUT_FILE = path.join(process.cwd(), 'src', 'tracking', 'rigidFaceModel.js')

/**
 * The rigid subset: points that sit on bone or stiff cartilage and that the
 * landmark network localises on real surface features, so they move with the
 * skull and nothing else. Grouped so the trust weights read as a decision.
 *
 * Deliberately left out:
 *  - the face-oval contour (234/454, 93/323, 127/356, the jaw line...). A
 *    contour landmark is defined by the SILHOUETTE, not by a point on the skin:
 *    as the head yaws the far-side contour slides around the cheek toward the
 *    ear. Fitting a fixed 3D point to it is the ¾-yaw failure in miniature.
 *  - lips, mouth corners, chin, jaw: speech and jaw opening.
 *  - eyelids, irises, brows: blinks, gaze, brow raise and frown.
 *  - lower cheeks (205/425, 187/411...): a smile lifts them by centimetres.
 */
const RIGID_SUBSET = [
  // Midline, forehead to nose tip. Never self-occluded at any yaw a tracker
  // survives, and the 5 cm of depth they span is the main lever on pitch.
  { group: 'midline', weight: 1.0, indices: [151, 9, 168, 6, 197, 195, 5, 4, 1] },
  // Eye corners. The canthi are tied to the orbital rim by ligaments and are the
  // sharpest features the network sees; they carry roll and most of yaw.
  { group: 'canthi', weight: 1.0, indices: [33, 133, 362, 263] },
  // Alar base: stiff cartilage beside the nostrils, a second depth layer under
  // the canthi. A sneer moves it, ordinary speech does not.
  { group: 'alar', weight: 0.8, indices: [98, 327, 129, 358] },
  // Maxilla below the orbit and the malar eminence (cheekbone). Bone close under
  // thin skin; wide laterally, so they resolve yaw. Trusted less: a broad smile
  // bunches the skin over them, and the outer pair nears the silhouette at ¾.
  { group: 'malar', weight: 0.7, indices: [101, 330, 118, 347, 117, 346, 116, 345] },
  // Frontal bone above the brows, below the hairline. Wide and high: pitch and
  // yaw together. Trusted less because a brow raise creases the skin here.
  { group: 'forehead', weight: 0.7, indices: [108, 337, 69, 299] },
]

async function loadTask(file) {
  if (file) return new Uint8Array(await readFile(file))
  const response = await fetch(TASK_URL)
  if (!response.ok) throw new Error(`fetch ${TASK_URL}: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Reads one entry out of a zip archive (the .task bundle is a plain zip). */
function readZipEntry(bytes, name) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive')
  const count = view.getUint16(eocd + 10, true)
  let p = view.getUint32(eocd + 16, true)
  for (let n = 0; n < count; n += 1) {
    const method = view.getUint16(p + 10, true)
    const compressed = view.getUint32(p + 20, true)
    const nameLen = view.getUint16(p + 28, true)
    const extraLen = view.getUint16(p + 30, true)
    const commentLen = view.getUint16(p + 32, true)
    const local = view.getUint32(p + 42, true)
    const entry = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    if (entry === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
      const data = bytes.subarray(start, start + compressed)
      return method === 0 ? data : new Uint8Array(inflateRawSync(data))
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`${name} not found in bundle`)
}

/** Minimal protobuf wire-format reader: yields [field, wireType, value]. */
function* protoFields(bytes) {
  let i = 0
  const varint = () => {
    let result = 0n
    let shift = 0n
    for (;;) {
      const b = bytes[i++]
      result |= BigInt(b & 0x7f) << shift
      if (!(b & 0x80)) return result
      shift += 7n
    }
  }
  while (i < bytes.length) {
    const key = Number(varint())
    const field = key >> 3
    const wire = key & 7
    if (wire === 0) yield [field, wire, varint()]
    else if (wire === 2) {
      const len = Number(varint())
      yield [field, wire, bytes.subarray(i, i + len)]
      i += len
    } else if (wire === 5) {
      yield [field, wire, bytes.subarray(i, i + 4)]
      i += 4
    } else if (wire === 1) {
      yield [field, wire, bytes.subarray(i, i + 8)]
      i += 8
    } else throw new Error(`unsupported wire type ${wire}`)
  }
}

/**
 * GeometryPipelineMetadata.canonical_mesh (field 1) -> Mesh3d: vertex_buffer
 * (field 3, five floats per vertex: x y z u v, centimetres) and index_buffer
 * (field 4, triangles).
 */
function parseCanonicalMesh(metadata) {
  let mesh = null
  for (const [field, wire, value] of protoFields(metadata)) {
    if (field === 1 && wire === 2) mesh = value
  }
  if (!mesh) throw new Error('canonical_mesh not found')
  const floats = []
  const indices = []
  for (const [field, wire, value] of protoFields(mesh)) {
    if (field === 3) {
      const dv = new DataView(value.buffer, value.byteOffset, value.byteLength)
      for (let k = 0; k < value.byteLength; k += 4) floats.push(dv.getFloat32(k, true))
    } else if (field === 4) {
      if (wire === 0) indices.push(Number(value))
      else for (const [, , v] of protoFields(packedVarints(value))) indices.push(Number(v))
    }
  }
  const vertices = []
  for (let k = 0; k + 4 < floats.length; k += 5) vertices.push([floats[k], floats[k + 1], floats[k + 2]])
  return { vertices, indices }
}

/** Re-wraps a packed varint run as field-1 varints so protoFields can read it. */
function packedVarints(bytes) {
  const out = []
  let start = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (!(bytes[i] & 0x80)) {
      out.push(0x08, ...bytes.subarray(start, i + 1))
      start = i + 1
    }
  }
  return Uint8Array.from(out)
}

/** Area-weighted vertex normals, oriented to point out of the face (+z at the nose tip). */
function vertexNormals({ vertices, indices }) {
  const normals = vertices.map(() => [0, 0, 0])
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]]
    const [pa, pb, pc] = [vertices[a], vertices[b], vertices[c]]
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    for (const i of [a, b, c]) for (let k = 0; k < 3; k += 1) normals[i][k] += n[k]
  }
  // Winding is not guaranteed; the nose tip must face the viewer (+z).
  const flip = normals[1][2] < 0 ? -1 : 1
  return normals.map((n) => {
    const len = Math.hypot(...n) || 1
    return n.map((x) => (x * flip) / len)
  })
}

const round = (x) => Math.round(x * 1e5) / 1e5

const task = await loadTask(process.argv[2])
const mesh = parseCanonicalMesh(readZipEntry(task, GEOMETRY_ENTRY))
if (mesh.vertices.length !== 468) throw new Error(`expected 468 vertices, got ${mesh.vertices.length}`)
const normals = vertexNormals(mesh)

const points = RIGID_SUBSET.flatMap(({ group, weight, indices }) => indices.map((index) => ({
  index,
  group,
  weight,
  // Centimetres -> metres. Axes as MediaPipe's canonical face: x toward image
  // right (the subject's left), y up, z out of the face toward the camera.
  position: mesh.vertices[index].map((c) => round(c / 100)),
  normal: normals[index].map(round),
})))

const body = `// GENERATED by scripts/extract-rigid-face-model.mjs -- do not edit by hand.
//
// The rigid landmark subset the PnP head-pose solver (headPoseSolver.js) fits
// against: MediaPipe's canonical face mesh (from face_landmarker.task, the same
// bundle FaceTracker loads), restricted to ${points.length} points on bone or stiff
// cartilage. Why these points, and their trust weights, are documented in the
// generator's RIGID_SUBSET.
//
// position: metres, canonical-face axes (x toward image right, y up, z out of
//           the face toward the camera). normal: unit outward surface normal.
export const RIGID_FACE_POINTS = Object.freeze([
${points.map((p) => `  { index: ${p.index}, group: '${p.group}', weight: ${p.weight}, position: [${p.position.join(', ')}], normal: [${p.normal.join(', ')}] },`).join('\n')}
])
`

await writeFile(OUT_FILE, body)
console.log(`wrote ${points.length} points to ${path.relative(process.cwd(), OUT_FILE)}`)

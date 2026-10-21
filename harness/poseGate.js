/**
 * Pose gate driver (served as /harness/posegate.html).
 *
 * Feeds a reel's frames through the REAL engine -- FaceTracker, LandmarkProcessor,
 * RenderLoop, FaceFitSolver, the filters -- one frame per step, and records what
 * it solved next to the reel's truth.csv. scripts/pose-gate.mjs drives it over
 * CDP and scores the rows (poseGateStats.js).
 *
 * Deterministic on purpose. Frames are pushed by hand rather than played, and
 * performance.now() is replaced with a clock that advances exactly one frame
 * interval per step, so the time-based filters see a true 30 fps sequence no
 * matter how fast this machine runs or whether the window is painted.
 *
 * Params: ?reel=<dir under test-mock-head> (default probe-landscape),
 *         ?fov=<vertical degrees the engine assumes; default the probe reel's
 *         own, else the engine's default>, ?pose=pnp (the engine's
 *         own switch, read by LandmarkProcessor), ?fps=30,
 *         ?fit=<json under public/> (default /calibrated/ai-classic-aviator.json,
 *         a Create-with-AI model with its production fit), or ?model=<glb under
 *         public/> to calibrate a GLB through the register-model path
 *         (?model= with no value: the built-in default SKU), ?lms=1 to put every
 *         landmark in the rows (raw-image px) for tuning signals offline,
 *         ?profileguard=0 to run without the profile guard (on by default),
 *         ?rvfc=0 to detect inline in _step (the engine's fallback when a video
 *         has no requestVideoFrameCallback) instead of per presented frame.
 *
 * Near-arm diagnostics: ?diag=1 marks the ear cut plane and the ear landmarks
 * on the shots and records the cut, plus how deep the lifted arm sits behind
 * the head shell, in the rows; ?hidearm=-1|1 draws without that side's arm;
 * ?nofloor=1 / ?floor=<world units> turn the temple floor off or move it.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FaceTracker } from '/src/tracking/FaceTracker.js'
import { LandmarkProcessor } from '/src/tracking/LandmarkProcessor.js'
import { VectorFilter } from '/src/filters/VectorFilter.js'
import { QuaternionFilter } from '/src/filters/QuaternionFilter.js'
import { FaceOccluder } from '/src/occlusion/FaceOccluder.js'
import { GlassesModelLoader } from '/src/models/GlassesModelLoader.js'
import { RenderLoop } from '/src/core/RenderLoop.js'
import { getGlassesConfig, getGlassesModelUrl, defaultGlassesKey, registerRuntimeGlassesConfig } from '/src/config/arConfig.js'
import { toEngineModelConfig } from '/src/tryon/fitMetadataAdapter.js'
import { FrameSampler, profileSignals } from '/src/tracking/profileGuard.js'
import { intrinsicsFromFov } from '/src/tracking/headPoseSolver.js'
import { irisPdSample } from '/src/fit/pupillaryDistance.js'
import { PROBE_FOV_DEG, frameBust, neckRig, probeCamera, rigPoint, truthQuaternion } from '/harness/probeGeometry.js'

const q = new URLSearchParams(location.search)
const REEL = (q.get('reel') ?? 'probe-landscape').replace(/[^a-zA-Z0-9_-]/g, '')
const FPS = parseFloat(q.get('fps') ?? '30')
const FRAME_MS = 1000 / FPS
const MODEL = q.get('model')
// ?fit=<json> wears a model exactly as production configured it: the file holds
// a stored ModelAsset's fitMetadata + modelUrl (main.js's ?fit= shape), so
// nothing is re-calibrated locally. Takes precedence over ?model=. The default
// is a Create-with-AI model, because that is what merchants' shoppers wear.
const FIT = q.has('fit') || q.has('model') ? q.get('fit') : '/calibrated/ai-classic-aviator.json'
const DUMP_LANDMARKS = q.get('lms') === '1'
// ?diag=1: mark the near-arm cut on the shots and put it in the rows.
const DIAG = q.get('diag') === '1'
const HIDE_ARM = Number(q.get('hidearm')) || 0
// ?truthlms=168.6....: give these landmarks the nasion's treatment -- the bust
// surface under each on the frontal anchor frame, carried through every truth
// pose -- so any landmark's drift can be scored, not just 168's. Rows then carry
// lmPx / lmTruth: {index: [u, v]} in raw-image px. Dots as well as commas,
// because pose-gate.mjs splits --modes on commas.
const TRUTH_LANDMARKS = (q.get('truthlms') ?? '')
  .split(/[,.]/)
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isInteger(n) && n >= 0 && n < 478)
const statusEl = document.getElementById('status')
const status = (text) => { statusEl.textContent = text }

// ---- virtual clock ---------------------------------------------------------
let clock = 1000
performance.now = () => clock

// ---- reel metadata ---------------------------------------------------------
async function fetchText(url) {
  const r = await fetch(url, { cache: 'no-store' })
  return r.ok ? r.text() : null
}

function parseTruth(csv) {
  if (!csv) return null
  const [header, ...lines] = csv.trim().split(/\r?\n/)
  const cols = header.split(',')
  return lines.map((line) => {
    const v = line.split(',')
    const row = Object.fromEntries(cols.map((c, i) => [c, v[i]]))
    return {
      frame: Number(row.frame), seg: row.segment,
      yaw: Number(row.yaw), pitch: Number(row.pitch), roll: Number(row.roll), dist: Number(row.dist),
    }
  })
}

async function loadFrame(i) {
  const r = await fetch(`/mockhead/${REEL}/frame-${i}.jpg`)
  if (!r.ok) return null
  return createImageBitmap(await r.blob())
}

// ---- truth geometry (probe reels only) --------------------------------------
async function loadBust(params) {
  const gltf = await new GLTFLoader().loadAsync('/mockhead/head.glb')
  const model = gltf.scene
  const { center, headCenter, baseCamZ, size } = frameBust(model, { dist: params.dist, headY: params.heady })
  model.position.sub(headCenter)
  model.updateMatrixWorld(true)
  const meshes = []
  model.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o) })
  // The band the reel was rendered with (params.json); older reels have none.
  const rig = neckRig(meshes, center, headCenter, params.rig)
  return { model, meshes, rig, baseCamZ, size }
}

/**
 * Finds the bust surface point under a raw-image pixel at the truth pose of a
 * frontal frame, returned in mesh-local coordinates (the space the rig uses).
 */
function surfacePointUnder(bust, u, v, W, H) {
  const camera = probeCamera(W, H, bust.baseCamZ, 1)
  const ray = new THREE.Raycaster()
  ray.setFromCamera(new THREE.Vector2((u / W) * 2 - 1, 1 - (v / H) * 2), camera)
  const hit = ray.intersectObjects(bust.meshes, false)[0]
  if (!hit) return null
  return { local: hit.object.worldToLocal(hit.point.clone()), matrixWorld: hit.object.matrixWorld.clone() }
}

/**
 * The bust is not modelled in metres (it is ~1.9 units tall), so millimetres
 * come from its own eyes: the pupils' surface distance, raycast on the frontal
 * frame, is taken as an average adult IPD.
 */
const REFERENCE_IPD_M = 0.063

function metresPerUnit(bust, landmarks, W, H) {
  const a = landmarks?.[468]
  const b = landmarks?.[473]
  if (!a || !b) return null
  const pa = surfacePointUnder(bust, a.x * W, a.y * H, W, H)
  const pb = surfacePointUnder(bust, b.x * W, b.y * H, W, H)
  if (!pa || !pb) return null
  const wa = pa.local.clone().applyMatrix4(pa.matrixWorld)
  const wb = pb.local.clone().applyMatrix4(pb.matrixWorld)
  const d = wa.distanceTo(wb)
  return d > 0 ? REFERENCE_IPD_M / d : null
}

function projectTruth(bust, anchor, truth, W, H) {
  const world = rigPoint(anchor.local, truthQuaternion(truth), bust.rig, anchor.matrixWorld)
  const camera = probeCamera(W, H, bust.baseCamZ, truth.dist)
  const ndc = world.clone().project(camera)
  const depth = camera.position.z - world.z
  // Image px -> mm at the nasion's depth, in real millimetres (see metresPerUnit).
  const mmPerPx = ((2 * Math.tan(THREE.MathUtils.degToRad(PROBE_FOV_DEG / 2)) * depth) / H) * 1000 * anchor.metresPerUnit
  return { u: ((ndc.x + 1) / 2) * W, v: ((1 - ndc.y) / 2) * H, mmPerPx }
}

/** projectTruth for each ?truthlms anchor: {index: [u, v]}, or null if none. */
function truthLandmarks(bust, lmAnchors, truth, W, H) {
  const keys = Object.keys(lmAnchors)
  if (!bust || !keys.length) return null
  return Object.fromEntries(keys.map((k) => {
    const t = projectTruth(bust, lmAnchors[k], truth, W, H)
    return [k, [t.u, t.v]]
  }))
}

// ---- engine -----------------------------------------------------------------
const eulerDeg = (quaternion) => {
  const e = new THREE.Euler().setFromQuaternion(quaternion, 'YXZ')
  const d = THREE.MathUtils.radToDeg
  return { yaw: d(e.y), pitch: d(e.x), roll: d(e.z) }
}

/** Registers a GLB the way main.js does for ?model= (validate, normalize, calibrate). */
async function registerModel(modelUrl) {
  const r = await fetch(`/api/register-model?url=${encodeURIComponent(modelUrl)}`)
  if (!r.ok) throw new Error(`register-model ${modelUrl}: ${await r.text()}`)
  const { fitMetadata, modelUrl: servedUrl } = await r.json()
  return registerRuntimeGlassesConfig('gate-model', toEngineModelConfig(fitMetadata, servedUrl))
}

/** Registers a stored fit (fitMetadata + modelUrl) without re-calibrating. */
async function registerFit(fitUrl) {
  const r = await fetch(fitUrl, { cache: 'no-store' })
  if (!r.ok) throw new Error(`fit ${fitUrl}: ${r.status}`)
  const { fitMetadata, modelUrl, sizeMultiplier } = await r.json()
  return registerRuntimeGlassesConfig('gate-model', toEngineModelConfig(fitMetadata, modelUrl, { sizeMultiplier }))
}

async function buildEngine(W, H, fovDeg) {
  // The "video" is a canvas the driver paints each frame into, dressed up with
  // the HTMLVideoElement fields the engine reads.
  const video = document.createElement('canvas')
  video.width = W
  video.height = H
  let frameIndex = -1
  Object.defineProperties(video, {
    videoWidth: { get: () => W },
    videoHeight: { get: () => H },
    readyState: { get: () => 4 },
    currentTime: { get: () => frameIndex / FPS },
  })
  // The engine detects from requestVideoFrameCallback. A canvas has none, and
  // a real one would fire on the page's paint clock, not this virtual one, so
  // the driver presents each frame itself (presentVideoFrame, in step()).
  // ?rvfc=0 leaves it off: the engine then detects inline in _step, its
  // fallback path. Both paths must score the same.
  let videoFrameCallbacks = []
  if (q.get('rvfc') !== '0') {
    video.requestVideoFrameCallback = (cb) => videoFrameCallbacks.push(cb)
    video.cancelVideoFrameCallback = () => { videoFrameCallbacks = [] }
  }
  const presentVideoFrame = () => {
    const due = videoFrameCallbacks
    videoFrameCallbacks = []
    for (const cb of due) {
      cb(clock, { presentedFrames: frameIndex + 1, mediaTime: frameIndex / FPS, expectedDisplayTime: clock + FRAME_MS })
    }
  }
  const videoCtx = video.getContext('2d')
  const sampler = new FrameSampler()

  const canvas = document.getElementById('view')
  canvas.style.width = `${W}px`
  canvas.style.height = `${H}px`
  document.getElementById('stage').style.height = `${H}px`

  const tracker = await new FaceTracker().init()
  const landmarkProcessor = new LandmarkProcessor()
  const loop = await new RenderLoop({
    canvas,
    video,
    positionFilter: new VectorFilter(),
    rotationFilter: new QuaternionFilter(),
    // The production scanner, not the provider's mock-camera shortcut: a reel
    // that turns to profile loses the face, and how long the glasses then stay
    // hidden (until the scan re-locks on a frontal face) is part of what a
    // shopper sees.
  }).init()
  const camera = new THREE.PerspectiveCamera(fovDeg, W / H, 0.001, 1000)
  camera.position.set(0, 0, 0)
  camera.lookAt(0, 0, -1)
  loop.camera = camera

  const loader = await new GlassesModelLoader({
    lensEnvMap: loop.lensEnvMap,
    lensReflection: loop.lensReflection,
    frameReflection: loop.frameReflection,
  }).init()
  const skuKey = FIT ? await registerFit(FIT) : MODEL ? await registerModel(MODEL) : defaultGlassesKey
  const modelConfig = getGlassesConfig(skuKey)
  const glassesRoot = await loader.load(getGlassesModelUrl(skuKey), skuKey)
  loop.setModelConfig(modelConfig)
  loop.setGlassesRoot(glassesRoot)
  loop.setFaceOccluder(await new FaceOccluder().init(loop.scene))
  loop.faceTracker = tracker
  loop.landmarkProcessor = landmarkProcessor
  loop.modelConfig = modelConfig
  // Register for the first video frame now, as start() would.
  loop._detectionScheduler()

  // Taps: the raw pose and the fit, as the loop computed them this step.
  const taps = { pose: null, fit: null }
  const processLandmarks = landmarkProcessor.processLandmarks.bind(landmarkProcessor)
  landmarkProcessor.processLandmarks = (...args) => (taps.pose = processLandmarks(...args))
  const solve = loop.faceFitSolver.solve.bind(loop.faceFitSolver)
  loop.faceFitSolver.solve = (input) => (taps.fit = solve(input))

  // ?hidearm=-1|1: draw without that side's temple arm (both of its pieces),
  // to tell which arm a stray fragment belongs to.
  if (HIDE_ARM) {
    const clip = loop._clipNearArm.bind(loop)
    loop._clipNearArm = (transform) => {
      clip(transform)
      for (const hinge of loop._hinges ?? []) {
        if (hinge.side !== HIDE_ARM) continue
        for (const mesh of hinge.meshes) {
          mesh.visible = false
          if (mesh.userData.templeBehind) mesh.userData.templeBehind.visible = false
        }
      }
    }
  }

  // ?nofloor=1: never aim the temple floor, to see what it hides;
  // ?floor=<world units>: aim it at that depth instead.
  if (q.get('nofloor') === '1' || q.has('floor')) {
    const aim = loop.faceOccluder.aimTempleFloor.bind(loop.faceOccluder)
    const bound = parseFloat(q.get('floor'))
    loop.faceOccluder.aimTempleFloor = (view) => aim(q.get('nofloor') === '1' ? null : view, bound)
  }

  const pivot = modelConfig.bridgePivot?.clone?.() ?? new THREE.Vector3()

  /** The frame's nose-contact point in raw-image pixels (the view is mirrored). */
  const toImage = (world) => {
    const ndc = world.clone().project(camera)
    return { u: ((1 - ndc.x) / 2) * W, v: ((1 - ndc.y) / 2) * H }
  }

  function step(bitmap, index) {
    frameIndex = index
    clock += FRAME_MS
    videoCtx.drawImage(bitmap, 0, 0, W, H)
    taps.pose = null
    taps.fit = null
    presentVideoFrame()
    loop._step()

    const shown = glassesRoot.visible && taps.fit
    let shownAnchor = null
    let rawAnchor = null
    if (shown) {
      glassesRoot.updateMatrixWorld(true)
      shownAnchor = toImage(glassesRoot.localToWorld(pivot.clone()))
      const t = taps.fit.glassesTransform
      const s = glassesRoot.scale.x
      const world = t.position.clone().add(pivot.clone().multiplyScalar(s).applyQuaternion(t.quaternion))
      world.y += loop._urlVerticalOffset ?? modelConfig.verticalOffset ?? 0
      rawAnchor = toImage(world)
    }
    const lms = tracker.lastResult?.faceLandmarks?.[0]
    const nasion = lms?.[168]
    diag = DIAG ? readDiag(lms) : null
    // Candidate "landmarks are guessing" signals, recorded for tuning the guard.
    // overrun is read on every frame here (the guard itself only reads pixels
    // once the face is turned), so the rows show it head-on too.
    const signals = lms
      ? profileSignals(lms, intrinsicsFromFov(W, H, camera.fov), tracker.lastResult.facialTransformationMatrixes?.[0]?.data, sampler.read(video))
      : null
    return {
      tracked: Boolean(shown),
      // On screen, fresh fit or not: a detection miss holds the last pose.
      visible: Boolean(glassesRoot.visible),
      source: taps.pose?.poseSource ?? (taps.pose ? 'mediapipe' : null),
      raw: taps.pose ? eulerDeg(taps.pose.quaternion) : null,
      shown: shown ? eulerDeg(glassesRoot.quaternion) : null,
      rawAnchor,
      shownAnchor,
      nasionPx: nasion ? { u: nasion.x * W, v: nasion.y * H } : null,
      // ?lms=1: every landmark in raw-image pixels, for tuning signals offline
      // against the reel's frames.
      lms: DUMP_LANDMARKS && lms ? lms.map((p) => [Math.round(p.x * W * 10) / 10, Math.round(p.y * H * 10) / 10]) : undefined,
      signals,
      guardOpacity: loop.profileGuard ? loop._appliedGuardOpacity ?? 1 : null,
      // True size: the wearer's PD estimate and the scale actually drawn.
      pd: taps.fit?.pd ?? null,
      drawnScale: shown ? glassesRoot.scale.x : null,
      // This frame's own PD reading and iris size, gated or not, for tuning the
      // estimate against face size.
      pdSample: lms ? irisPdSample(lms, W, H) : null,
      irisPx: lms?.length > 476
        ? (Math.hypot((lms[469].x - lms[471].x) * W, (lms[469].y - lms[471].y) * H) +
          Math.hypot((lms[474].x - lms[476].x) * W, (lms[474].y - lms[476].y) * H)) / 2
        : null,
      // Ungated: each iris, and the PD the pair reads before any gate.
      irisPair: lms?.length > 476
        ? [Math.hypot((lms[469].x - lms[471].x) * W, (lms[469].y - lms[471].y) * H),
          Math.hypot((lms[474].x - lms[476].x) * W, (lms[474].y - lms[476].y) * H)]
        : null,
      pupilPx: lms?.length > 476 ? Math.hypot((lms[468].x - lms[473].x) * W, (lms[468].y - lms[473].y) * H) : null,
      diag,
    }
  }

  // In VIEW pixels (the mirrored, composited picture the shots show).
  const toView = (world) => {
    const ndc = world.clone().project(camera)
    return { u: ((ndc.x + 1) / 2) * W, v: ((1 - ndc.y) / 2) * H }
  }
  let diag = null
  function readDiag(lms) {
    const side = loop._nearArmSide ?? 0
    const out = { side, mp: {} }
    for (const i of [234, 454, 127, 356, 93, 323]) {
      if (lms?.[i]) out.mp[i] = { u: (1 - lms[i].x) * W, v: lms[i].y * H }
    }
    if (side !== 0 && loop._clipCutAt && loop._clipForward) {
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(glassesRoot.quaternion)
      // The cut plane's trace through the NEAR ear (the plane holds both ears),
      // 12 mm back, running up the plane.
      const f = loop._clipForward
      const inPlaneUp = up.clone().addScaledVector(f, -up.dot(f)).normalize()
      const nearEar = loop._clipA.distanceTo(camera.position) < loop._clipB.distanceTo(camera.position) ? loop._clipA : loop._clipB
      const cutNear = nearEar.clone().addScaledVector(f, loop._clipCutAt.distanceTo(loop._clipMid) * -1)
      out.cut = toView(cutNear)
      out.cutUp = toView(cutNear.clone().addScaledVector(inPlaneUp, 0.04))
      out.cutDown = toView(cutNear.clone().addScaledVector(inPlaneUp, -0.02))
      out.earA = toView(loop._clipA)
      out.earB = toView(loop._clipB)
      out.origin = toView(loop._clipMid)
      out.forward = loop._clipForward.toArray()
      // Forward axis vs the frame's own +Z, and its pitch out of the frame's XZ.
      const fz = new THREE.Vector3(0, 0, 1).applyQuaternion(glassesRoot.quaternion)
      out.fwdVsFrameDeg = THREE.MathUtils.radToDeg(loop._clipForward.angleTo(fz))
      out.fwdPitchDeg = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(loop._clipForward.dot(up), -1, 1)))
      out.depth = liftedArmDepth(side)
    }
    return out
  }
  /**
   * How far the lifted near arm sits BEHIND the head shell, along the view:
   * for each arm vertex in front of the cut, the first shell surface on the
   * camera ray to it, and the vertex's depth past that surface. The depth
   * buffer's own opinion, which is what the temple floor is compared against
   * (it hides what lies more than its bound past the shell).
   */
  const ray = new THREE.Raycaster()
  const viewDir = new THREE.Vector3()
  function liftedArmDepth(side) {
    const occ = loop.faceOccluder.occluderMesh
    const plane = loop._clipPlane
    if (!occ?.visible || !plane) return null
    occ.updateMatrixWorld(true)
    // The shell is rewritten every frame; a stale sphere makes every ray miss.
    occ.geometry.computeBoundingSphere()
    camera.getWorldDirection(viewDir)
    const v = new THREE.Vector3()
    const dir = new THREE.Vector3()
    const depths = []
    for (const hinge of loop._hinges ?? []) {
      if (hinge.side !== side) continue
      for (const mesh of hinge.meshes) {
        const pos = mesh.geometry.attributes.position
        const stride = Math.max(1, Math.floor(pos.count / 300))
        mesh.updateWorldMatrix(true, false)
        for (let i = 0; i < pos.count; i += stride) {
          v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
          if (plane.distanceToPoint(v) < 0) continue
          dir.subVectors(v, camera.position)
          const far = dir.length()
          ray.set(camera.position, dir.normalize())
          ray.far = far
          const hit = ray.intersectObject(occ, false)[0]
          // Nothing of the shell in front of it: the arm is clear of the head.
          depths.push(hit ? v.clone().sub(hit.point).dot(viewDir) : 0)
        }
      }
    }
    if (!depths.length) return null
    depths.sort((a, b) => a - b)
    return { max: depths[depths.length - 1], p95: depths[Math.floor(depths.length * 0.95)], n: depths.length }
  }

  function drawDiag(ctx) {
    if (!diag) return
    const dot = (p, color, r = 4) => {
      if (!p) return
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(p.u, p.v, r, 0, Math.PI * 2)
      ctx.fill()
    }
    for (const p of Object.values(diag.mp)) dot(p, '#ff0', 3)
    dot(diag.earA, '#0af', 5)
    dot(diag.earB, '#0f0', 5)
    dot(diag.origin, '#fff', 3)
    if (diag.cut) {
      ctx.strokeStyle = '#f00'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(diag.cutUp.u, diag.cutUp.v)
      ctx.lineTo(diag.cutDown.u, diag.cutDown.v)
      ctx.stroke()
      dot(diag.cut, '#f00', 4)
    }
  }

  const lastLandmarks = () => tracker.lastResult?.faceLandmarks?.[0] ?? null

  /** The composited view, mirrored like the page, posted to the harness shot sink. */
  async function shot(name) {
    const out = document.createElement('canvas')
    out.width = W
    out.height = H
    const ctx = out.getContext('2d')
    ctx.save()
    ctx.translate(W, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(video, 0, 0)
    ctx.restore()
    // Same task as the render, so the drawing buffer is still intact.
    ctx.drawImage(loop.renderer.domElement, 0, 0, W, H)
    drawDiag(ctx)
    const r = await fetch('/__shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, dataUrl: out.toDataURL('image/jpeg', 0.9) }),
    })
    return (await r.json()).file
  }

  return { step, shot, loop, glassesRoot, modelConfig, pivot, lastLandmarks }
}

// ---- run ----------------------------------------------------------------------
async function run({ from = 0, to = Infinity, shotsAt = [], shotPrefix = 'gate', anchorFrame = 30 } = {}) {
  const started = Date.now()
  const params = JSON.parse((await fetchText(`/mockhead/${REEL}/params.json`)) ?? '{}')
  const truthRows = parseTruth(await fetchText(`/mockhead/${REEL}/truth.csv`))
  const W = params.w
  const H = params.h
  // Probe reels are rendered through a known camera; anything else falls back
  // to the engine's own default (fy = 1.2 * height, as the provider assumes).
  const engineDefaultFov = THREE.MathUtils.radToDeg(2 * Math.atan(1 / 2.4))
  const reelFov = params.kind === 'probe-reel' ? (params.fov ?? PROBE_FOV_DEG) : null
  const fovDeg = parseFloat(q.get('fov') ?? '') || reelFov || engineDefaultFov
  const total = Math.min(params.frames ?? truthRows?.length ?? 0, to)
  const bust = truthRows && params.kind === 'probe-reel' ? await loadBust(params) : null
  const engine = await buildEngine(W, H, fovDeg)
  const shots = new Set(shotsAt)
  const shotFiles = {}

  const rows = []
  let anchor = null
  const lmAnchors = {}
  const ahead = new Map()
  const prefetch = (i) => {
    if (i < total && !ahead.has(i)) ahead.set(i, loadFrame(i))
  }
  for (let i = 0; i < Math.min(8, total); i += 1) prefetch(from + i)

  for (let i = from; i < total; i += 1) {
    prefetch(i + 8)
    const bitmap = await ahead.get(i)
    ahead.delete(i)
    if (!bitmap) break
    const reading = engine.step(bitmap, i)
    bitmap.close()
    const truth = truthRows?.[i] ?? null

    // The true nasion: the bust surface under MediaPipe's landmark 168 on a
    // frontal frame, then carried through every later truth pose by the rig.
    if (bust && !anchor && i >= anchorFrame && reading.nasionPx && truth &&
      truth.yaw === 0 && truth.pitch === 0 && truth.roll === 0) {
      anchor = surfacePointUnder(bust, reading.nasionPx.u, reading.nasionPx.v, W, H)
      if (anchor) {
        anchor.metresPerUnit = metresPerUnit(bust, engine.lastLandmarks(), W, H)
        if (!anchor.metresPerUnit) anchor = null
      }
      if (anchor && TRUTH_LANDMARKS.length) {
        const lms = engine.lastLandmarks()
        for (const k of TRUTH_LANDMARKS) {
          const hit = lms?.[k] ? surfacePointUnder(bust, lms[k].x * W, lms[k].y * H, W, H) : null
          if (hit) lmAnchors[k] = { ...hit, metresPerUnit: anchor.metresPerUnit }
        }
      }
    }
    const truthAnchor = bust && anchor && truth ? projectTruth(bust, anchor, truth, W, H) : null
    const lmTruth = truth ? truthLandmarks(bust, lmAnchors, truth, W, H) : null
    const lmNow = engine.lastLandmarks()
    const lmPx = TRUTH_LANDMARKS.length && lmNow
      ? Object.fromEntries(TRUTH_LANDMARKS.filter((k) => lmNow[k]).map((k) => [k, [lmNow[k].x * W, lmNow[k].y * H]]))
      : null

    rows.push({
      frame: i,
      seg: truth?.seg ?? 'reel',
      truth: truth ? { yaw: truth.yaw, pitch: truth.pitch, roll: truth.roll, dist: truth.dist } : null,
      tracked: reading.tracked,
      visible: reading.visible,
      source: reading.source,
      raw: reading.raw,
      shown: reading.shown,
      rawAnchor: reading.rawAnchor,
      shownAnchor: reading.shownAnchor,
      truthAnchor: truthAnchor ? { u: truthAnchor.u, v: truthAnchor.v } : null,
      // MediaPipe's own nasion landmark: separates "the tracker lost the nose"
      // from "the fit put the frame somewhere else".
      nasionPx: reading.nasionPx,
      lmPx,
      lmTruth,
      lms: reading.lms,
      signals: reading.signals,
      diag: reading.diag ?? undefined,
      guardOpacity: reading.guardOpacity,
      pd: reading.pd,
      drawnScale: reading.drawnScale,
      pdSample: reading.pdSample,
      irisPx: reading.irisPx,
      irisPair: reading.irisPair,
      pupilPx: reading.pupilPx,
      mmPerPx: truthAnchor?.mmPerPx ?? null,
    })
    if (shots.has(i)) shotFiles[i] = await engine.shot(`${shotPrefix}-f${String(i).padStart(4, '0')}`)
    if (i % 30 === 0) status(`${REEL} ${q.get('pose') ?? 'mediapipe'}  frame ${i}/${total}  ${truth?.seg ?? ''}`)
  }

  // Rows before the anchor existed get it retroactively: the bust did not move
  // during the hold, so the same point applies.
  if (bust && anchor) {
    for (const row of rows) {
      if (row.truthAnchor || !row.truth) continue
      const t = projectTruth(bust, anchor, row.truth, W, H)
      row.truthAnchor = { u: t.u, v: t.v }
      row.mmPerPx = t.mmPerPx
      row.lmTruth = truthLandmarks(bust, lmAnchors, row.truth, W, H)
    }
  }

  const meta = {
    reel: REEL,
    pose: q.get('pose') ?? 'mediapipe',
    w: W,
    h: H,
    engineFovDeg: fovDeg,
    reelFovDeg: reelFov,
    frames: rows.length,
    bustSizeM: bust ? bust.size.toArray() : null,
    nasionLocal: anchor ? anchor.local.toArray() : null,
    bustMetresPerUnit: anchor?.metresPerUnit ?? null,
    bridgePivot: engine.pivot.toArray(),
    sku: FIT || MODEL || (engine.modelConfig.name ?? defaultGlassesKey),
    anchorMode: engine.modelConfig.anchorMode ?? 'legacy',
    seconds: (Date.now() - started) / 1000,
    shots: shotFiles,
  }
  status(`done: ${rows.length} frames in ${meta.seconds.toFixed(0)} s`)
  return { meta, rows }
}

window.__gate = { run, ready: true }
status(`ready: ${REEL} (pose=${q.get('pose') ?? 'mediapipe'})`)

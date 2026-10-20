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
 *         (?model= with no value: the built-in default SKU).
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
import { profileSignals } from '/src/tracking/profileGuard.js'
import { intrinsicsFromFov } from '/src/tracking/headPoseSolver.js'
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
  const rig = neckRig(meshes, center, headCenter)
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
  const videoCtx = video.getContext('2d')

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

  // Taps: the raw pose and the fit, as the loop computed them this step.
  const taps = { pose: null, fit: null }
  const processLandmarks = landmarkProcessor.processLandmarks.bind(landmarkProcessor)
  landmarkProcessor.processLandmarks = (...args) => (taps.pose = processLandmarks(...args))
  const solve = loop.faceFitSolver.solve.bind(loop.faceFitSolver)
  loop.faceFitSolver.solve = (input) => (taps.fit = solve(input))

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
    // Candidate "landmarks are guessing" signals, recorded for tuning the guard.
    const signals = lms
      ? profileSignals(lms, intrinsicsFromFov(W, H, camera.fov), tracker.lastResult.facialTransformationMatrixes?.[0]?.data)
      : null
    return {
      tracked: Boolean(shown),
      source: taps.pose?.poseSource ?? (taps.pose ? 'mediapipe' : null),
      raw: taps.pose ? eulerDeg(taps.pose.quaternion) : null,
      shown: shown ? eulerDeg(glassesRoot.quaternion) : null,
      rawAnchor,
      shownAnchor,
      nasionPx: nasion ? { u: nasion.x * W, v: nasion.y * H } : null,
      signals,
      guardOpacity: loop.profileGuard ? loop._appliedGuardOpacity ?? 1 : null,
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
    }
    const truthAnchor = bust && anchor && truth ? projectTruth(bust, anchor, truth, W, H) : null

    rows.push({
      frame: i,
      seg: truth?.seg ?? 'reel',
      truth: truth ? { yaw: truth.yaw, pitch: truth.pitch, roll: truth.roll, dist: truth.dist } : null,
      tracked: reading.tracked,
      source: reading.source,
      raw: reading.raw,
      shown: reading.shown,
      rawAnchor: reading.rawAnchor,
      shownAnchor: reading.shownAnchor,
      truthAnchor: truthAnchor ? { u: truthAnchor.u, v: truthAnchor.v } : null,
      // MediaPipe's own nasion landmark: separates "the tracker lost the nose"
      // from "the fit put the frame somewhere else".
      nasionPx: reading.nasionPx,
      signals: reading.signals,
      guardOpacity: reading.guardOpacity,
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

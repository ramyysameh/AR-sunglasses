# FINDINGS — meta.com virtual try-on vs. AR Try-On

Date: 2026-10-20 · Branch: `feat/meta-informed-render` (off `origin/main` 9509c3a)

Clean-room note: this document records **techniques and parameters** learned by
observing what meta.com's public try-on downloads in a normal visitor session. No
Meta source, shaders, models, weights, meshes, HDRIs or textures were copied into
this repo, and none were saved to disk (an attempt to save the downloaded assets
locally was blocked by the session's permission policy and was not retried; all
inspection below was done in-page, returning only metadata).

Labels: **[confirmed]** = directly observed in the downloaded bytes / config values;
**[hypothesis]** = inferred, not proven by what was observed.

---

## 1. The tool (REA) and how it was used

REA ("reverse engineering assistant", `rea-agents` MCP server, connected in this
session) analyses: native binaries (Ghidra/IDA/Hopper/Kuna providers), archives
(ZIP/APK/IPA/DMG/MSIX), managed .NET assemblies, Android packages, firmware,
**JavaScript/Electron applications and web bundles**, **WASM** (via WABT),
EVM bytecode, SQLite, packet/HAR/qlog captures, and **live browser/Electron
runtimes over the Chrome DevTools Protocol** (passive observation, scripted
scenarios, script export, bundle chunk graphs).

It handles web assets fine. Workflow used:

1. Launched a throwaway Chrome profile (scratch dir) with `--remote-debugging-port`
   and a **fake camera** fed by an existing marketing face clip
   (`--use-file-for-fake-video-capture`), because the try-on requests the camera
   before it loads its engine (the in-app browser pane blocks camera access).
2. `list_browser_targets` → `capture_browser_scenario` (connect mode): load
   `meta.com/ai-glasses/ray-ban-meta/`, click **"Try on virtually"**, wait 25 s,
   record network/workers/frames. Evidence `ev_57c545a3…d134fb` (1,372 events,
   49 s).
3. Follow-up metadata-only inspection in the page over CDP: `WebAssembly.compile`
   (never instantiated) for import/export counts, keyword string hits, glTF JSON
   chunk headers, ZIP central-directory names, and resolution of named config
   constants. Only names/numbers/short snippets left the page.
4. One session, single load; no repeated hammering, no auth, nothing behind a login.

Limitations: no WAT disassembly (WABT not installed, and the binaries were not kept);
JS was minified so a few behaviours are inferred from call shapes; the fake camera is
a single person in daylight, so lighting-adaptation behaviour could not be stressed.

---

## 2. What meta.com's try-on is built from

### Downloaded on "Try on virtually" (after camera grant) [confirmed]

| Asset | Size | What it is |
|---|---|---|
| `…/y_/r/eUXEsmaZXYc.wasm` | 9.6 MB (2.4 MB br) | **MediaPipe Tasks Vision** WASM (`third_party/mediapipe/tasks/web/vision`), contains WebGPU "ML Drift" inference path |
| `…/y9/r/Q2uatriIak_.bin` | 3.76 MB | **`face_landmarker.task`** ZIP: `face_detector.tflite`, `face_landmarks_detector.tflite`, `geometry_pipeline_metadata_landmarks.binarypb`, `face_blendshapes.tflite` |
| `…/yx/r/mJdAOUcvQPp.wasm` | 4.3 MB (1.2 MB br) | **OpenCV.js** (calib3d present: `solvePnP`, `Rodrigues`) |
| `…/yT/r/OmcD_XQD_RU.wasm` | 286 KB | **Draco** mesh decoder |
| `…/yz/r/l_aJD6E6Fu4.glb` | 14.7 KB | **Head occluder**: 1 mesh, 382 verts / 760 tris, POSITION+NORMAL only |
| scontent `…` (radiance) | 1.6 MB | **1024×512 RGBE `.hdr`** environment ("Made with Adobe Photoshop") |
| ~16× scontent GLBs | 220–300 KB each | One per colour/lens variant, all prefetched |
| `…/y4/r/OZRusvMi817.webm` | 56 KB | UI animation (not engine) |
| 3D lib chunk `2jWfdqXeDpd.js` | 3.4 MB | **three.js r183** WebGPU build (`window.__THREE__ === "183"`), aliased `GalaxyThreeGpu` |

### Engine modules (names visible in the bundle) [confirmed]
`ShopVirtualTryOnDialog.react`, `ShopVirtualTryOn3DCanvas`, `ShopVirtualTryOnConfig`,
`ShopVirtualTryOnFacePosePnPSolver`, `ShopVirtualTryOnLandmarkUtils`,
`ShopVirtualTryOnFacemeshGeometry`, `MDCGlasses3DProd…`.

### Glasses asset format [confirmed]
- glTF-Transform 4.4.2 output, `KHR_draco_mesh_compression`,
  `KHR_materials_transmission`, `KHR_materials_specular`, `EXT_texture_webp`.
- ~14.7k triangles total per frame; ~11k verts. Temples ≈ 6.6k tris **each**, front
  only ~380 tris (the temples carry the hinge/speaker/camera detail).
- **Skinned**: `Armature` → `root_bone`, `bridge_L/R`, `arm_L/R`, `end_IK_L/R`;
  meshes `Frame`, `LensL`, `LensR`, `TempleL`, `TempleR`.
- Materials are **factor-only PBR** (no textures) except acetate base-colour WebP
  (`WayfarerM_TransparentBlack_BC`, `WayfarerL_Havana_BC`). Named finishes:
  `shinyBlack` (rough 0), `matteBlack` (0.39), `gunMetal`, `softGold`, `nosepad*`
  (≈0.66), plus an `Invisible` MASK material.
- **Lens material** `Glass_Lenses`: `alphaMode BLEND`, base alpha 0.90–0.95, very
  dark tinted base colour per variant (e.g. G-15-ish `[0.014, 0.138, 0.107]`),
  `transmissionFactor 1`, roughness 0, metalness 0; some variants also set
  `KHR_materials_specular.specularFactor 0`. `LensL` has a second UV set used by a
  `Glass_Etching` (lens logo) material.
- Size variants ("Standard size" / "Large") are separate GLBs (`WayfarerM_*` vs
  `WayfarerL_*`).

### Config values (`ShopVirtualTryOnConfig`) [confirmed]

| Parameter | Value | Meaning (my reading) |
|---|---|---|
| `VERTICAL_FOV` | 63° | assumed camera vFOV for intrinsics and the camera |
| `VIDEO_PLANE_DEPTH` | 500 | camera image drawn as an in-scene textured plane at z = −500 |
| `IDEAL_WEB_CAM_VIDEO_WIDTH/HEIGHT` | 1280×720 | getUserMedia request |
| `GLASS_OFFSETS` | T(0, 2.33, 6), rotX −3.5°, scale 100 | glasses pose in **canonical-face space (cm)** |
| `HEAD_OCCLUDER_OFFSETS` | T(0, 2.49, 7.18) | occluder pose in canonical-face space |
| `TEMPLE_ARM_FADE_START/END_DEPTH` | −0.10 / −0.11 | temple tip fade window (model space) |
| `TEMPLE_ARM_BENDING_DEFORMATION_FACTOR` | 0.75 | scales the solved splay angle |
| `ARM_/BRIDGE_JOINT_BENDING_WEIGHT` | 0.5 / 0.5 | splay split between hinge and ear joints |
| `ARM_/BRIDGE_JOINT_MAX_BENDING_DELTA` | 10° / 4° | per-joint clamp |
| `BENDING_ANGLE_SMOOTHING_ALPHA` | 0.5 | EMA on the bend angle |
| `SMOOTHING_ALPHA` | 0.9 | EMA (pose-guidance / PD path) |
| `ONE_EURO_DERIVATIVE_CUTOFF` | 1 | 1€ filter dcutoff |
| `TRACKER_MIN_FACE_DETECTION/TRACKING/PRESENCE_CONFIDENCE` | 0.9 / 0.9 / 0.9 | MediaPipe thresholds |
| `DETECTION_FAILURE_WINDOW_SIZE` | 20 | frames before declaring loss |
| `IRIS_SIZE_METERS` | 0.01177 | human iris diameter, metric reference |
| `PUPILLARY_DISTANCE_CONVERGENCE_FACTOR` | 1.02625 | near-vs-far PD correction |
| `CANONICAL_FACE_PUPILLARY_DISTANCE` / `DEFAULT_…` | 63.2 / 63 mm | |
| `MAX_SUCCESSFUL_ESTIMATES` | 60 | PD samples kept |
| `MAX_CONSECUTIVE_SUCCESSFUL_COARSE_PD_ESTIMATES` / `COARSE_PD_DIFFERENCE_THRESHOLD` | 30 / 5 | convergence test |
| `MAX_FACE_ORIENTATION_YAW/PITCH/ROLL` | 6° / 8° / 6° | calibration pose gate |
| `MIN_AVERAGE_EYE_ASPECT_RATIO` | 0.175 | eyes-open gate |
| `MIN/MAX_FACE_SIZE_PERCENT`, `MAX_FACE_CENTER_DIFFERENCE_PERCENT` | 0.6 / 1.0 / 0.2 | framing gate vs target oval (`FACE_TARGET_HEIGHT_RATIO` 0.625, aspect 0.8) |
| `POSE_GUIDANCE_STABILIZATION_(NO_)ERROR_FRAME_COUNT` | 20 / 5 | hysteresis on guidance prompts |
| `HDRI_Y_ROTATION_DEGREES` | 260 | env rotation |
| `RBM/HSTN/VANGUARD/BELLINI/MODELO/FIRE_HDRI_PATH` | — | **one HDRI per product family** |

---

## 3. Area-by-area: Meta vs. mine

| Area | meta.com | AR Try-On (origin/main) |
|---|---|---|
| **Face tracking** | MediaPipe FaceLandmarker, VIDEO mode, 1 face, GPU delegate with `reinitializeWithCPU` fallback, blendshapes off, all confidences 0.9 [confirmed] | MediaPipe FaceLandmarker (same model family, float16 task), 1 face |
| **Head pose** | **OpenCV `solvePnP` (ITERATIVE)** on a ~33-point rigid landmark subset vs. canonical mesh vertices; intrinsics f = (h/2)/tan(31.5°), principal point = image centre, zero distortion; falls back to MediaPipe `facialTransformationMatrixes` when OpenCV isn't ready [confirmed] | MediaPipe `facialTransformationMatrixes` + IPD-derived metric depth (`FaceFitSolver`) |
| **Renderer** | three.js r183 **WebGPURenderer** (antialias), TSL node materials [confirmed]; WebGL fallback from three's WebGPU build [hypothesis] | three.js WebGLRenderer, transparent canvas over `<video>`, AgX tone mapping |
| **Compositing** | Camera frame is a **textured plane inside the 3D scene** (z = −500, `toneMapped=false`, no depth) [confirmed] → lens transmission can sample the real video behind it [hypothesis, strongly implied] | Alpha canvas over the DOM video: the GPU never sees the camera pixels |
| **Lens shader** | glTF transmission = 1 on a tinted, alpha 0.9–0.95, roughness-0 material; per-lens **HDRI override** (env, intensity, rotation); per-variant lens state (rgb, clearcoat, clearcoatRoughness, transmission) swapped for the **Transitions** toggle; etched logo on UV1 [confirmed] | `transmission` forced to 0 (it stalled WebGL), flat `opacity` 0.18, procedural studio env at intensity 0.15 + clearcoat 1 for a Fresnel rim |
| **Frame shader** | Factor PBR (+ `KHR_materials_specular`), env-map lit; no textures except acetate WebP [confirmed] | Ambient light only + low-intensity env (0.25) and authored clearcoat |
| **Occlusion** | Authored **382-vertex head proxy** GLB in canonical space, `colorWrite=false`, glasses `renderOrder=1` [confirmed]; temple tips faded with TSL `smoothstep` on model-space z + **`alphaHash`** (dithered, sort-free) [confirmed] | Per-user: all 468 landmarks tessellated + extruded closed head shell, near-arm clip at the ear plane, temple-fade shader with blended alpha. **Mine is at or above parity here.** |
| **Lighting / env** | Static authored 1024×512 HDRI **per product family**, rotated 260° [confirmed]. No camera light estimation found in the engine chunk (no SH/LightProbe use outside the three.js library) [hypothesis] | Procedural studio equirect (128×64 → PMREM), ambient 1.0, no estimation |
| **Contact shadows** | None found (no shadow code in the engine chunk; shadow strings only inside three.js) [hypothesis] | Off: the old flat disc read as a grey blob |
| **Fit: placement** | Fixed offset in canonical-face cm: up 2.33, forward 6, pitch −3.5° [confirmed] | Landmark-anchored solve (`FaceFitSolver` / `FaceSurfaceSolver`) with calibrated offsets |
| **Fit: scale** | **Per-user PD from iris diameter**: PD = 1.02625 × (pupil distance px ÷ iris diameter px) × 11.77 mm; pose/eye/framing-gated; up to 60 samples, converge when 30 consecutive coarse estimates agree within 5 mm; scale ∝ canonical PD 63.2 / PD [confirmed formula; scale use is hypothesis] | Metric depth from a **fixed 63 mm IPD** plus a 3-metric width blend. Every face is effectively normalised to an average face, so a narrow face is not shown that the frame is wide on it |
| **Fit: temples** | Skinned bones: angle = asin(gap/temple length) × 0.75, split 50/50 across bridge and arm joints, clamped 4°/10°, EMA 0.5 [confirmed] | Rigid hinge pivots, splay solved against the measured head width, curl, near-arm clip |
| **Smoothing** | 1€ filter (dcutoff 1) + EMAs; tracking driven by **`requestVideoFrameCallback`** (one detection per real video frame) with rAF fallback [confirmed] | Adaptive 1€ (still/moving modes) + time-based prediction lead + PoseInterpolator; rAF-driven, 30 Hz detection throttle |
| **Perf** | WebGPU, MediaPipe GPU delegate, rVFC, Draco, all variants prefetched (~16 × 230 KB), 1280×720 camera [confirmed] | WebGL, DPR capped at 2, parallel init (a482ab1); GLB compression still open |
| **Assets** | ~14.7k tris, Draco, 220–300 KB, factor PBR, 7-bone rig, separate size GLBs [confirmed] | Merchant-uploaded GLBs normalised to 0.145 m; hinge split from geometry; auto-anchors |

---

## 4. Ranked improvements (visual impact ÷ effort)

| # | Improvement | Impact | Effort | Ratio | Gap |
|---|---|---|---|---|---|
| 1 | **Soft contact shadows**: shadow-map the frame onto the landmark face mesh (shadow-only receiver) | High | M | ★★★★ | #3 |
| 2 | **Camera-feed light estimation**: match exposure and white balance by modulating ambient and env intensity/colour (no directional light) | High (dim/warm rooms) | S–M | ★★★★ | #4 |
| 3 | **Physically based lens** (within alpha compositing): Fresnel-weighted opacity, optional vertical gradient tint, tint preserved | Med–High | S | ★★★★ | #2 |
| 4 | Per-user PD from iris diameter, pose-gated with a convergence test (true-to-scale size) | Med–High | M | ★★★ | #5 |
| 5 | `requestVideoFrameCallback`-driven detection with real frame timestamps into the 1€ filter | Med (jitter) | S | ★★★ | #5 |
| 6 | Dithered (`alphaHash`) temple fade instead of blended alpha (no sort artefacts at the hinge) | Low–Med | S | ★★ | #1 |
| 7 | Composite the video inside WebGL so lenses can do real coloured transmission/refraction | Med | L (embed, capture, mirroring) | ★★ | #2 |
| 8 | Optional skinned-temple GLB convention (bridge/arm bones) for merchant models | Med | L (**changes the GLB calibration contract: needs sign-off**) | ★ | #5 |
| 9 | Per-collection authored HDRI environments | Med | M (needs assets) | ★★ | #4 |

### Plans and files touched

**1. Contact shadows** (implemented)
- `src/core/contactShadow.js` (new): config resolver plus a shadow-only receiver
  material and light rig.
- `src/occlusion/FaceOccluder.js`: expose the face-surface geometry (front 468
  landmarks) so a second, shadow-receiving mesh can share it.
- `src/core/RenderLoop.js`: enable `renderer.shadowMap` (PCFSoft), add a
  zero-intensity-contribution directional light from above-front that only casts
  (glasses meshes `castShadow`), a `ShadowMaterial` receiver on the face surface,
  and per-frame light re-targeting to the head. URL tuning: `?shadow=0`,
  `?shadowopacity=`, `?shadowsize=`.
- `src/models/GlassesModelLoader.js`: opaque frame meshes cast; lenses don't.

**2. Light estimation** (implemented)
- `src/core/cameraLightEstimate.js` (new, pure): downsampled RGBA → luminance and
  chromaticity of the background ring (face down-weighted) → clamped,
  neutral-blended ambient colour/intensity and env-intensity multiplier.
- `src/core/RenderLoop.js`: sample the video into a 32×18 2D canvas every ~250 ms,
  temporally EMA the estimate, apply it to the ambient light and to each
  material's `envMapIntensity` relative to its base. `?lightest=0` disables.
- Never touches directional lights (2e12c0f's streak).

**3. Lens upgrade** (implemented)
- `src/core/lensShading.js` (new): `onBeforeCompile` patch on lens materials:
  view-angle Fresnel (Schlick, F0 0.04) raises opacity at grazing angles; optional
  vertical gradient (top darker → bottom lighter) in lens-local Y; tint kept.
- `src/core/lensReflection.js`: `?lensgrad=`, `?lensfresnel=` overrides.
- `src/models/GlassesModelLoader.js`: apply after the existing opacity/reflection.
- Per-SKU values read from the existing optional `materialProfile` (no GLB change).

**4–9:** see table; 4 touches `src/fit/FaceFitSolver.js` (`realIPD_m` becomes a
per-session estimate) plus a new `src/fit/pupillaryDistance.js`; 5 touches
`src/tracking/FaceTracker.js` and `src/core/RenderLoop.js`; 6 touches
`GlassesModelLoader.applyTempleFade`; 7 touches `RenderLoop`, `coverMap`, the
provider's capture path and the storefront embed CSS.

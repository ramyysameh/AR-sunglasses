# FINDINGS — meta.com and Fittingbox virtual try-ons vs. AR Try-On

Date: 2026-10-20 · Branch: `feat/meta-informed-render` (off `origin/main` 9509c3a)

Clean-room note: this document records **techniques and parameters** learned by
observing what meta.com's public try-on downloads in a normal visitor session. No
Meta source, shaders, models, weights, meshes, HDRIs or textures were copied into
this repo, and none were saved to disk (an attempt to save the downloaded assets
locally was blocked by the session's permission policy and was not retried; all
inspection below was done in-page, returning only metadata).

Sections 1–4 are the meta.com teardown; **section 5 adds Fittingbox** (same
clean-room rules), **section 6 the fake-camera probe reels** used to read all
three engines, and **section 7 the three-way readings and the revised plan**.

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

**1. Contact shadows** (implemented, commit "feat(render): soft contact shadow…")
- `src/core/contactShadow.js` (new): `ContactShadow` = zero-intensity
  directional light that only owns a `PCFShadowMap` (256², radius 4 → ~4 mm
  penumbra), a `ShadowMaterial` receiver whose geometry **shares the occluder's
  position buffer** but indexes only the 468-landmark face tessellation, and a
  grazing-angle fade (|N·V| 0.15→0.45) so mesh overhang past the silhouette at
  yaw never shadows the background. Lenses don't cast. Light is world-fixed
  20° above the camera axis.
- `src/core/RenderLoop.js`: replaces the disabled flat disc; one `_render()`
  path re-aims the shadow each frame and shows it only while frame and face
  surface are both visible. `light.castShadow` never toggles (avoids shader
  recompiles on track loss).
- No loader or occluder changes were needed. Off under `?probe=1` so the
  occlusion probe's pixel counts are unaffected.
- Tuning: `?shadow=0`, `?shadowopacity=` (0.24), `?shadowel=` (20),
  `?shadowaz=`, `?shadowmap=`, `?shadowsoft=`.
- Measured: +0.2 ms per render on desktop; no repeatable fps change under
  mobile emulation (emulation runs on the desktop GPU: real-phone cost unverified).

**2. Light estimation** (implemented, commit "feat(render): match the frame's exposure…")
- `src/core/cameraLightEstimate.js` (new, pure): 32×18 RGBA → linear luminance
  with the centre (face) down-weighted to 0.35 → intensity =
  clamp((L/0.18)^0.4, 0.6, 1.15); colour = per-channel chromaticity, capped at
  ±12 % and half-applied (≤ ±6 %). `LightEstimateSmoother` is a time-based EMA
  (τ = 1.2 s) so auto-exposure hunting can't flicker the frame.
- `src/core/RenderLoop.js`: samples the video 4×/s into an OffscreenCanvas,
  applies the estimate to the ambient light's colour and intensity and scales
  every glasses material's `envMapIntensity` from its loader-tuned base
  (captured per model in `setGlassesRoot`). Readback failure disables it once
  and falls back to the fixed look. `?lightest=0` disables.
- Never adds a directional light (2e12c0f's streak).
- Measured on the mock head with a simulated dim tungsten room
  (brightness 0.42, sepia 0.45): intensity 0.82, colour (1.06, 0.99, 0.94).

**3. Lens upgrade** (implemented, commit "feat(render): Fresnel lens coverage…")
- `src/core/lensShading.js` (new): `onBeforeCompile` patch on lens materials,
  applied just before three writes `gl_FragColor`: Schlick Fresnel (F0 0.04,
  60 % strength) raises coverage toward grazing angles (0.18 → ~0.48 at
  cosθ = 0.1, +2 % face-on); optional vertical gradient across the lens mesh's
  own bounding-box height. Tint colour untouched; chains any existing
  `onBeforeCompile`.
- `src/models/GlassesModelLoader.js`: applied after the existing opacity and
  reflection in both lens branches.
- Overrides `?lensfresnel=`, `?lensgrad=`; per-SKU gradient from an optional
  `materialProfile.lensGradient` (additive runtime-config field, **not** a GLB or
  calibration-format change; merchant models simply don't set it → no gradient).

**Combined cost** (desktop, mock head): render 0.2 → 0.6 ms. In the live loop
one `_step` already takes ~27 ms, dominated by synchronous MediaPipe detection on
the main thread, so the extra ~0.4 ms sometimes misses a 33 ms vsync (≈ −2 fps
measured here; light estimate and lens shading measured as free, shadow is the
whole delta). The real fix for frame budget is item 5 below plus moving
detection off the render path; see "next".

**4–9:** see table; 4 touches `src/fit/FaceFitSolver.js` (`realIPD_m` becomes a
per-session estimate) plus a new `src/fit/pupillaryDistance.js`; 5 touches
`src/tracking/FaceTracker.js` and `src/core/RenderLoop.js`; 6 touches
`GlassesModelLoader.applyTempleFade`; 7 touches `RenderLoop`, `coverMap`, the
provider's capture path and the storefront embed CSS.

---

## 5. Fittingbox (demo.fittingbox.com, "vto-advanced")

Observed the same way as Meta: temp Chrome profile, synthetic fake camera, one
session. The demo's privacy consent was accepted in that throwaway profile with the
owner's approval. Inspection was metadata-only and in-frame; nothing was saved.
Evidence: REA scenario `ev_780ffd56…edef63`. Frame assets are delivered as an
encrypted `data4` format with a per-request key and were **not inspected**
(protected content).

### Architecture [confirmed]
- The try-on is an iframe app (`vto-advanced.fittingbox.com`, integration API
  1.10) around a **proprietary C++ engine compiled to WASM**: `FBxLive` 11.4.0
  (`FBxLive.wasm` 11.0 MB, `FBxLive.data` 1.4 MB Emscripten package,
  `fbx-streamgrabber.js` for the camera). It has its own GLES renderer (shader
  cross-compiler strings) on WebGL2. No MediaPipe, no three.js.
- **Recognition is server-side first.** The client POSTs one ~28 KB 640×480 JPEG
  to `vto-customer-application-detectionservice-v11.fittingbox.com/detection/<apiKey>`.
  The response carries `cameraFocal` 595.2 px at 640×480 (≈ 44° assumed vertical
  FOV), principal point at centre, 2 eye points, **68** face points (dlib-style
  layout), ear points, face region, `faceReconstructionConfidence` and
  `glassesDetectionResult`. Confidence rose 0 → 0.33 → 0.66 over successive
  submissions of a moving head, which reads as a **multi-view face reconstruction
  that accumulates views** (values confirmed; the mechanism is a hypothesis). Local
  tracking only starts after that (`live:success`), with `live:recovery`
  re-detections when it loses the face.
- Packaged engine data (names and sizes only): `DENSE_5_PERCENT/dataMM.bin` (a
  dense face **morphable model**, 5 % subsample), `GLASSES_MODES_20/dataMM.bin` (a
  20-mode statistical model of **glasses** shape, probably for detecting and
  removing the user's own frames [hypothesis]), per-frame-type rule files
  (`BinocularRim`, `RimLess`, `SplitRim`, `OneLens`, clip-ons), `GGX-DFG-LUT.ktx`,
  two env maps (`pixar_campus_legacy` and a **desaturated** `schadowplatz`),
  `zorro.png` (eye-region mask) and `zoneActivationInfo` (tracking zones).
- Lens colours are separate packs (`Sample_Brown`, `…Gradient`, `…bicolor`,
  `MirrorPurple`, `PhotochromaticBrown/Green` .zip) applied to any frame.

### Rendering techniques named in the engine [confirmed by pass/class names]
- **Split-sum PBR IBL** (GGX DFG LUT, irradiance map, env transform, IBL exposure,
  tone mapping), with spatially varying materials via `roughnessGradient`,
  `metallicGradient`, `clearcoatRoughnessGradient` and `SpecularColorMetalGradient`.
- **Lenses: two-layer depth peeling** (`DepthPeel1/2`, `MetalRoughTransparentPeel1/2`
  with separate *Reflection* and *Transmission* passes) plus
  **`ScreenSpaceRefraction`** into a `refractionBuffer`. The camera image behind
  the lens is refracted, not just alpha-blended.
- **Shadows on the face**: `ShadowMap`, `ShadowOcclusion`, `ShadowBlending` and
  `shadowColor`, blended through a **`FaceMaskGradient`** (soft fall-off at the
  face edge). Same idea as our new contact shadow's facing fade.
- **Frame removal**: `BackgroundInpainter`, `PatchInpainter`, a temporal
  `CopyPasteInpainter` (with history), `InpaintableAreaGradient`, `BackgroundMask`.
- **PD measurement with a credit card** (`waitingForCardAndMeasurementPoseReady`,
  `Protocol_CardPoseNotOk`, `humanPupilCount`), offered as a separate demo
  (`pd-measurement-demo.fittingbox.com`).

### Observed live behaviour (probe reel `real-turn-hf-fb640`, see §6) [confirmed]
- It would not start on our CG bust, or on a feed where the face sat small or low
  in its 4:3 framing box. It started once the face filled ~70 % of frame height,
  centred.
- It tracks through **near-profile (~80°)**, with the temples ending correctly in
  the hair and ear. It lost the face once at full profile and re-acquired in
  0.4–4.5 s.
- The lens shows a strong, view-dependent env reflection (a window/sky panel) at
  turned poses; the tint lets the eyes show through; the metal frame picks up env
  highlights.
- Contact shadow: not visible at the captured resolution [hypothesis: subtle].

---

## 6. Better fake camera: probe reels (new tooling in this branch)

The old fake camera (`face.y4m`, a near-static selfie) gave no known pose and no
lighting change. New:

- **`harness/probereel.html`** (served at `/probe/` by the harness) renders the
  mock bust through a scripted 40 s timeline: hold, yaw ±45°, pitch ±25°, roll
  ±20°, distance 0.75–1.3×, light normal/dim/warm/bright, a dead-still hold, and a
  1.5 Hz shake. It renders at any size (`?w=1280&h=720` or `?w=720&h=1280`), burns
  the frame number and pose into the corner, and writes **`truth.csv`** (per-frame
  yaw, pitch, roll, distance, light) beside the frames.
- **`scripts/build-probe-reel.mjs`** turns frames into a `.y4m` for
  `--use-file-for-fake-video-capture` (plus an `.mp4` preview). `--from-video <clip>`
  turns any footage into real-face reels (as-is → dimmed/warm → frozen still, with
  the frame counter burned in), in portrait and 1280×720 landscape (padded so a 4:3
  centre crop keeps the whole head).
- The assets live outside the repo, in `test-mock-head/`:
  - `probe-landscape.y4m` and `probe-portrait.y4m` (CG, with truth).
  - `real-turn-hf.mp4`: a 15 s Higgsfield (Seedance 2.5) **no-glasses** selfie
    turning left and right to profile and nodding, generated from
    `marketing/assets/ai/cut_hero_noglasses.png` (105 credits).
  - Its reels `real-turn-hf-{portrait,landscape,fb640}.y4m`. `fb640` is native
    640×480 with the face framed for Fittingbox's box.
- Lessons:
  - A CG bust is fine for MediaPipe engines (ours, Meta), but proprietary trackers
    may refuse it.
  - A getUserMedia 640×480 request makes Chrome centre-crop a 16:9 file to 4:3.
  - 1.6 GB y4m files work.

---

## 7. Three-way readings and revised plan

The same feed (`real-turn-hf-fb640.y4m`) went through all three, with screenshots
every 2.5 s (sheets in `test-shots/vto-compare-2026-10-20/`):

| Moment | meta.com | Fittingbox | Ours (dev harness, Gripz Pelmo) |
|---|---|---|---|
| Frontal | seated on the nose bridge | seated | seated; frame reads small for the face |
| ¾ yaw (~45°) | holds | holds | **frame slides off the face sideways** |
| Chin up (pitch) | holds on the eyes | holds | **frame rides up onto the forehead** |
| Profile (~80–90°) | hides glasses, shows a "good lighting / eye level" hint | **keeps tracking** | drops (MediaPipe limit) |
| Re-acquire | fast | 0.4–4.5 s (server round trip) | fast |

The biggest gap is **pose accuracy under yaw and pitch on a realistic face**, not
rendering. Meta's answer is OpenCV `solvePnP` on a rigid landmark subset with
FOV-derived intrinsics; Fittingbox fits a per-user reconstructed 3D face. Revised
ranking (replaces the tail of §4):

| # | Improvement | Why now | Effort |
|---|---|---|---|
| A | **Rigid-landmark PnP head pose**: our own solver, ~30 stable landmarks against the canonical face, intrinsics from the real video FOV, MediaPipe matrix as fallback | fixes the ¾-yaw slide and chin-up drift seen above; measurable with `truth.csv` | M |
| B | Per-user PD from iris diameter (was #4) | true-to-scale sizing; both Meta and Fittingbox measure it | M |
| C | `requestVideoFrameCallback`-driven detection (was #5) | frame budget and stable timestamps | S |
| D | Dithered temple fade (was #6) | sort-free | S |
| E | Probe-reel regression gate: run `probe-landscape.y4m` through the harness and compare solved yaw/pitch/position against `truth.csv` per frame | turns "looks off at ¾" into a number CI can hold | S–M |
| F | Screen-space lens refraction / in-scene video (was #7; Fittingbox does refraction) | lens realism | L |
| G | Frame removal (inpaint the user's own glasses), Fittingbox's differentiator | hard: needs segmentation plus inpainting; propose an open model | L |

---

## 8. Pose gate, PnP head pose and the profile guard (branch feat/pnp-head-pose)

### The gate (item E)
`node scripts/pose-gate.mjs` pushes every reel frame through the real engine
(`harness/posegate.html`, virtual 30 fps clock, so runs are reproducible) and scores
it against `truth.csv` per segment: yaw/pitch/roll error, and the frame's nose
contact against the bust's true nasion in mm (truth carried by the same rig code
as the renderer, `harness/probeGeometry.js`; mm scaled by the bust's own IPD).
`--check` enforces `harness/pose-gate.limits.json`. The default frame is a
Create-with-AI model (dev store Classic Aviator, production fit), because that is
what shoppers wear. `--reel real-turn-hf-fb640` runs the real-face reel
(frames extracted from the y4m) for frame-matched before/after sheets.

### Baseline (CG reel, true 30° FOV, MediaPipe matrix), drawn frame
| segment | yaw° | pitch° | roll° | drift mm mean / p95 |
|---|---|---|---|---|
| yaw ±45 | 2.0 | 1.0 | 0.5 | 3.3 / 5.0 |
| pitch ±25 | 0.4 | 1.2 | 0.2 | 1.9 / 5.6 |
| shake | 5.2 | 0.7 | 0.6 | 5.2 / 8.2 |

On a clean face up to 45°, MediaPipe's matrix is already accurate.

### PnP (item A), `?pose=pnp`: built, NOT better, left opt-in
Own Levenberg-Marquardt solver over 29 rigid landmarks (bone and stiff cartilage;
silhouette, lips, lids, brows excluded, see `scripts/extract-rigid-face-model.mjs`),
Huber loss, facing-camera weights, and a per-wearer model built in the silent
frontal scan. On the CG reel it is worse than MediaPipe (yaw segment 2.4° yaw /
4.4° pitch vs 2.0 / 1.0): a frontal scan cannot see the face's depth, and depth
error couples into pitch during turns.

### Why the frame floats off at ¾ on a real face
Near profile, MediaPipe's 2D landmarks collapse: on the real reel a face visibly
turned ~65° solves to ~30° with MediaPipe AND with PnP. The input is wrong, so no
pose solver fixes it. Same on all three AI models.

### Profile guard, `?profileguard=1`: opt-in
Fades the frame out when the landmark layout says it is guessing (far/near eye
width ratio, rigid-fit reprojection error). Real reel, all three AI models:
frames drawn while floating 42 → 3 (all mid-fade), seated frames unchanged
(275/338). But on the CG bust the same thresholds hide 55% of an ordinary ±45°
turn: a collapsed near-profile face is self-consistent, and per frame looks like
an honest ~32° face. The gate fails it (`--check`: yaw tracked 44.6%). A default-on
guard needs evidence beyond the landmark layout (image silhouette, or motion over
time), measured on a CG reel extended to ±75° yaw.

## 9. Wide-yaw probe reel and a default-on profile guard

### The wide reel
`harness/probereel.html` gained a `wide` segment, appended last so every earlier
frame keeps its index: 0 → −75° → 0 → +75° → 0 with a second held at each end
(14 s, frames 1200–1619). The old neck rig's blend band reached into the jaw, so
past ~50° the chin lagged the face and the jaw smeared. The band is now a
parameter (`?rig=wide`, the default: `harness/probeGeometry.js` `WIDE_RIG`, the
twist lives in the neck), written to `params.json`, and the gate rebuilds truth
with the same band (reels without one use `LEGACY_RIG`, so probe-landscape's truth
is unchanged). Rendered to `test-mock-head/probe-wide` (1620 frames + truth.csv;
no y4m built). Evidence: `test-shots/guard-v3/rig-legacy-vs-wide.jpg`.

### Where MediaPipe stops following a clean face (CG bust, guard off)
| true yaw | solved yaw | drift mm (mean) | shown yaw error |
|---|---|---|---|
| 30–40 | follows | 4.5 | 0.7° |
| 40–50 | 38–44 | 5.4 | 4.3° |
| 50–60 | 44–48 | 9.7 | 9.1° |
| 60–70 | 47–51 | 14.2 | 14.9° |
| 70–75 | 51, then lost | 17.9 | 20° |

No collapse on the CG bust: tracking is good to ~45°, then the solved yaw lags
the real turn by a steadily growing amount but keeps RISING. The face is lost at
~72° (left) / ~60° (right). After a loss the glasses stay hidden until the
production scan re-locks on a near-frontal face.

### The real-face "¾ collapse" was largely the clip leaving its own frame
`real-turn-hf-fb640` is a portrait clip pasted into the middle (x 162–476) of a
blurred copy of itself. In every one of its floating frames (205–232, 350–368)
the face runs off that clip's edge and MediaPipe puts landmarks out on the
blurred copy (x up to 515, down to 76); on the honest frames they stay inside.
`test-shots/guard-v3/composite-landmarks-past-clip-edge.jpg` shows frame 214:
the nose cut by the clip edge, landmarks beyond it. The same clip at its native
framing (`real-turn-hf-portrait`, extracted to frames for the gate, where the
clip edge IS the image edge) keeps the glasses seated through the ¾ turn
(`portrait-guard-off-sheet.jpg`); they only leave the face once the face is half
out of the picture and the landmark hull sits up to 128 px past the image edge.
So the 640 reel's floats are a pasted-clip artifact: no camera produces a hard
edge with a skin-coloured copy of the face beyond it.

### Signals tried
- Landmark layout (eye-width ratio, rigid-fit RMS, nose offset): face-dependent,
  as §8 found. Rigid RMS also climbs to 0.047 on the CG bust's honest 25° nod,
  so it hid 31% of the pitch segment.
- Skin overrun (`faceOverrun`): on the side the nose points, how far
  skin-coloured pixels carry on past the landmark hull (face-oval polygon plus
  nearby landmarks), in face heights, on four rows (nasion, mid-nose, tip, lip),
  second-largest row. Honest frames read ≤0.03 on both the CG bust (to 70°) and
  the real face. Two traps found and closed: a warm-lit grey wall reads as skin
  (light segment, 15° yaw, run never ends) → a run with no edge is UNREAD, not
  overrun; and a cheek that reaches the image edge is an ordinary ¾ view
  (portrait 74–92, 232–238) → skin running into the edge is unread too. What
  remains is "landmarks placed past the edge of the picture, by how far".
- The engine's own yaw (`matrixYawDeg`, from MediaPipe's matrix; matches the
  engine's yaw exactly). Face-independent but blunt: the CG bust reads 44.6° at
  a true 45°, so it cannot hide 50–60° without hiding an ordinary ±45° turn.
- Motion over time (solved yaw stalling while the image keeps moving) was not
  needed once the real-reel cause was clear, and was not built.

### Profile guard: now ON by default (`?profileguard=0` turns it off)
Trust = min(yaw ceiling 44→52°, overrun 0.05→0.12); pixels are read (one
270-row downscale of the frame) only while the face is turned (eye ratio < 0.9).
Results (three Create-with-AI fits, `test-shots/guard-v3/`):

| reel | guard off | guard on |
|---|---|---|
| probe-landscape `--check` | passes | passes (yaw 100% tracked; was 44.6% with the §8 guard) |
| probe-wide, true ≤50° | all drawn | all drawn |
| probe-wide, true 60–75° | 19 drawn (14–18 mm drift) | 13 |
| real portrait | 520 drawn | 503: hides the face-half-out-of-frame frames (98–102, 245–254) and their dim-copy repeats, keeps every ordinary ¾ frame |
| real fb640, floating spans | 42/47 drawn | 42/47 drawn (all three fits) |

The fb640 floats are NOT hidden: the landmarks there spill past the pasted
clip's edge, not the image's, and the run beyond is the blurred skin copy, so
overrun reads unread. The §8 guard's 3/42 on that reel came from the eye-ratio
threshold that also hid half of an honest ±45° turn. Use `real-turn-hf-portrait`
(true image edge) as the real-face benchmark, or rebuild the landscape reel with
a non-face pad, rather than tuning a production guard to the pasted-clip edge.

Still open: CG 50–60° (≈10 mm drift) is drawn, because nothing face-independent
tells it from 45°. A real head-turn filmed straight from a phone/webcam, framed
with room around the head, would show whether real faces collapse earlier than
the CG bust when nothing truncates them.

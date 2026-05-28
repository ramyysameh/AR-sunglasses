Project: AR Try-On Prototype

This file lists the project layout and brief descriptions for each top-level item.

Root files
- index.html: App entry HTML.
- main.js: Main application bootstrap.
- package.json: Node project metadata and scripts.
- style.css: Global styles.

public/
- models/: Prebuilt 3D or AR assets served statically.

src/
- config/
  - arConfig.js: AR configuration parameters.
- core/
  - RenderLoop.js: Main render/update loop.
- debug/
  - DebugHUD.js: On-screen debug HUD utilities.
- filters/
  - OneEuroFilter.js: Smoothing filter implementation.
  - QuaternionFilter.js: Quaternion smoothing/filters.
  - VectorFilter.js: Vector smoothing/filters.
- fit/
  - DepthEstimator.js: Depth estimation for fitting.
  - FitCalibrator.js: Session calibration for stable face anchors and scale baseline.
- models/
  - GlassesModelLoader.js: Loads glasses 3D models and materials.
- occlusion/
  - FaceOccluder.js: Occlusion mesh and logic for faces.
- tracking/
  - FaceTracker.js: Face tracking main module.
  - LandmarkProcessor.js: Processes facial landmarks for placement.

Notes
- Use `public/models` for any large binary assets so they can be served directly.
- Keep runtime code in `src` and split per feature area (tracking, occlusion, models, etc.).
- Add tests or examples in a `tests/` or `examples/` folder if you add CI later.

Generated on: 2026-05-26

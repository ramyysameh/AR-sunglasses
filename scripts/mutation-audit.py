"""Mutation audit of the fit / occlusion subsystem.

Each entry is a plausible regression. If the suite does not go red, that
regression could land unnoticed.
"""
import io, subprocess

MUTS = [
    ("clearance drifts 0.0148 -> 0.0100", "src/models/templeHinge.js",
     "export const TEMPLE_SHELL_CLEARANCE = 0.0148", "export const TEMPLE_SHELL_CLEARANCE = 0.0100"),
    ("splay zero-clamp removed", "src/models/templeHinge.js",
     "const sine = Math.min(Math.max(reach / jointDepth, 0), 1)", "const sine = Math.min(reach / jointDepth, 1)"),
    ("curl flips outward", "src/models/templeHinge.js",
     "hinge.curl.rotation.y = hinge.side * Math.min(Math.max(angle, 0), MAX_CURL_RAD)",
     "hinge.curl.rotation.y = -hinge.side * Math.min(Math.max(angle, 0), MAX_CURL_RAD)"),
    ("lift order -2 -> 0 (lift disabled)", "src/models/templeHinge.js",
     "export const TEMPLE_ON_TOP_ORDER = -2", "export const TEMPLE_ON_TOP_ORDER = 0"),
    ("BOTH arms lifted", "src/models/templeHinge.js",
     "const near = nearSide !== 0 && hinge.side === nearSide && earPlane",
     "const near = nearSide !== 0 && earPlane"),
    ("temple cut ratio 0.66 -> 0.40", "src/models/templeHinge.js",
     "export const TEMPLE_CUT_RATIO = 0.66", "export const TEMPLE_CUT_RATIO = 0.40"),
    ("occluder order -1 -> -3", "src/occlusion/FaceOccluder.js",
     "export const OCCLUDER_RENDER_ORDER = -1", "export const OCCLUDER_RENDER_ORDER = -3"),
    ("head width one-sided", "src/occlusion/headWidth.js",
     "return (right + left) / 2", "return right"),
    ("temple floor pushes TOWARD camera", "src/occlusion/templeFloor.js",
     "export const TEMPLE_FLOOR_DEPTH = 0.015", "export const TEMPLE_FLOOR_DEPTH = -0.015"),
    ("frame-swap latch clear reverted", "src/core/RenderLoop.js",
     "    this._splayForWidth = null", "    // this._splayForWidth = null"),
    ("splay never re-solves (latch always set)", "src/core/RenderLoop.js",
     "    if (this._headWidthCount >= HEAD_WIDTH_MIN_SAMPLES) {",
     "    if (true) {"),
    ("head width ignores temple height", "src/core/RenderLoop.js",
     "      armHeight,\n    )", "      0,\n    )"),
]

results = []
for name, path, old, new in MUTS:
    source = io.open(path, encoding="utf-8").read()
    if old not in source:
        results.append((name, "PATTERN-MISS"))
        continue
    io.open(path, "w", encoding="utf-8", newline="").write(source.replace(old, new, 1))
    run = subprocess.run("npx vitest run --reporter=dot",
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, shell=True)
    results.append((name, "caught" if run.returncode != 0 else "SURVIVED"))
    subprocess.run(f'git checkout -- "{path}"', shell=True)

survived = sum(1 for _, v in results if v == "SURVIVED")
for name, verdict in results:
    print(f"{verdict:14} {name}")
print(f"\nscore: {len(results) - survived}/{len(results)} caught, {survived} SURVIVED")

# Checking a newly uploaded frame

What generalises, what does not, and the five minutes of harness work that tells
you which one you are looking at.

## What the engine already normalises

Every uploaded GLB is scaled to a 0.145 m frame width and auto-anchored, so
placement on the face does not depend on how the merchant modelled it. The splay
solve reads the frame's own `armLateral` and `jointDepth` and a head width
measured by ray cast against the occluder shell, which is a property of the face
rather than of the frame. `test/tryon/templeHinge.test.js` covers the envelope of
frames this can produce.

## What does not generalise, and has to be looked at

- **Where the temple's rear sits relative to the shell.** Frames whose arms run
  high or flare late can leave the shell's reach, and the shell cannot hide what
  is outside it.
- **Material response.** A flat facet can catch the studio key head-on; Larsson
  shows this on its right hinge and nothing in the fit pipeline knows about it.
- **Ear hooks.** A pronounced hook is the part most likely to be eaten, and it is
  the part a customer notices.

## The check

1. `npm run harness`
2. Load unpinned and let the scan settle ~15 s:
   `http://localhost:5175/?probe=1&mock=turn&mockframes=25&shop=dev.myshopify.com&model=<url>`
   The `shop` parameter is required; without it the engine silently loads the
   default model and you will audit the wrong frame.
3. Discard the first sweep, then take a real one:
   ```js
   await window.__probe.sweep({ step: 2 })
   const { rows } = await window.__probe.sweep({ step: 2 })
   ```
4. Repeat with `&mock=pitchyaw&mockframes=14&mockhold=13` for the pitch axis.

## Pass marks

| Measure | Pass | Why |
|---|---|---|
| `armHolePx` | 0 at every pose | The arm coming apart mid-cheek is the worst-looking failure. Deliberately stricter than the code's own `MAX_ARM_HOLE_PX = 8` gate, because no hole has ever been observed on a passing frame. |
| `occluderAteWorld` | < 0.020 at every judged pose (worst pose currently measured is 0.017, at +25° of pitch on Larsson) | More than that and the shell is removing arm the customer should see. |
| `earGapRatio` | between −0.25 and +0.05 | Positive stops short of the ear, negative hooks past it. |
| splay solved | within 6° of the three reference frames | Outside that, the temples read as too wide or clipped into the head. |

The rear-standoff measurement described above exists only as an ad-hoc snippet
in `docs/superpowers/plans/2026-09-13-temple-fit-and-occluder-angles.md`; it is
not part of the routine check and emits no metric here.

## Measured on the mock head, post-fix

Ray-cast head half-width and solved splay for the three reference frames, plus
the yaw −38.6° occlusion numbers used to judge them, all after the shell-only
cast landed:

```
frame     head half-width   splay     at yaw -38.6: gap / ate / holes
gripz         79.2 mm       13.9 deg      -0.014 / 0.007 / 0
larsson       78.4 mm       13.4 deg      -0.019 / 0.008 / 0
willow        78.8 mm       13.4 deg      -0.064 / 0.000 / 0
```

The pitch axis was re-measured and settled on Larsson at current HEAD:

```
pitch   -25    -17     -8      0     +8     +17    +25
gap   -0.064 -0.041 -0.012 -0.012 +0.015 -0.020 +0.027
ate    0.001  0.004  0.010  0.009  0.000  0.007  0.017
holes  0 at every pose
```

## Why the numbers used to disagree

Worth recording for whoever next finds two runs of this check disagreeing: the
head's half-width used to be taken from the widest shell *vertex* inside an 8 mm
slab around the temple's height. The shell is built from a few sparse rings, so
that measurement stepped by about 5 mm for every ring boundary it crossed —
the same head read 72.5 / 84.9 / 94.4 mm depending only on how high the loaded
frame's temple happened to ride, and nothing about the actual face had changed.
Feeding that into the splay solve meant the solve was answering a question about
which ring the vertex sampler landed on, not about the head: on one face it
opened Willow's arms 25 mm wider than Gripz's, an artifact of ring height rather
than of anything either frame did differently.

It is now a ray cast against the shell's triangles rather than a vertex lookup,
which is continuous in height, so the same head reads the same width regardless
of which frame is loaded or how its temple sits.

## Reading the numbers honestly

- `earGapRatio` drifts up to 0.06 between sweeps. Anything finer needs a paired
  A/B/A at one pinned frame. `occluderAteWorld` and `hiddenPct` are steadier.
- Poses inside |yaw| < 25° are not judged: head-on the arm is foreshortened and
  its rear extent is set by the hinge rather than the tip.
- Near and far arm are decided by the sign of the yaw, so at yaw ≈ 0 the far-arm
  figures are a coin flip. Ignore them.
- All of this runs against one synthetic head. It catches frames that are wrong
  everywhere; it does not tell you how the frame sits on a narrow face.

## Checking against a narrower or wider head

`harness/headrender.html` takes `?headwide=<factor>`, which scales the skull
laterally in the GEOMETRY before the neck rig and the camera framing read it —
so a sweep rendered at two widths differs in exactly one variable. Human head
breadth runs roughly 135–165 mm about a ~150 mm mean, so 0.88 and 1.12 bracket
the population:

```
/render?axis=yaw&count=25&range=60&dist=1.45&heady=0.3&neck=1&headwide=0.88&save=1&dir=turn-narrow
/render?axis=yaw&count=25&range=60&dist=1.45&heady=0.3&neck=1&headwide=1.12&save=1&dir=turn-wide
```

then load with `?mock=turn-narrow` or `?mock=turn-wide`.

**A caveat that matters more than the sweep does.** Rendering a narrower head
does not test what you would expect. The pipeline estimates depth monocularly
from apparent face size, so a narrower head largely reads as a head further
away: across a 27% geometry change from narrow to wide, the measured half-width
moved 2.7% (77.9 → 80.0 mm) and the glasses scale moved 1.3%. The fit stays
self-consistent, which is why it still looks right — but head width and camera
distance are close to degenerate here, and a mock sweep cannot separate them.

**What does stress the solve is the frame-to-head RATIO**, and `?gscale=<n>`
varies that directly. On GRIPZ, at yaw −39:

| head | gscale | splay | earGapRatio | ate | holes |
|---|---|---|---|---|---|
| narrow | 1.15 | 8.0° | −0.041 | 0.004 | 0 |
| narrow | 1.00 | 14.7° | **+0.050** | 0.021 | 0 |
| wide | 1.00 | 15.0° | −0.005 | 0.000 | 0 |
| wide | 0.85 | 24.6° | −0.019 | 0.009 | 0 |

The solve spans 8° to 25° across that range and every case stays inside the
gate — a wide frame on a narrow head barely opens, a narrow frame on a wide head
opens right up. The one marginal case is GRIPZ at its natural size on the narrow
head: `earGapRatio` +0.050 sits exactly on the "stops short of the ear"
threshold, stable across repeated reads (0.050, 0.051), with a visible strip of
skin between the arm's end and the ear. It is the worst case found and it is
still passing; treat it as the value to watch if the clearance is ever retuned.

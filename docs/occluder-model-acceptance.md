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
  is outside it. The rear standoff check below is the one that catches this.
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
| `armHolePx` | 0 at every pose | The arm coming apart mid-cheek is the worst-looking failure. |
| `occluderAteWorld` | < 0.015 at every judged pose | More than that and the shell is removing arm the customer should see. |
| `earGapRatio` | between −0.25 and +0.05 | Positive stops short of the ear, negative hooks past it. |
| splay solved | within 6° of the three reference frames | Outside that, the temples read as too wide or clipped into the head. |
| rear standoff p90 | ≤ 0 mm | The rear of the arm must be inboard of the shell wall or the ear cannot hide it. |

## Measured on the mock head, post-fix

Ray-cast head half-width and solved splay for the three reference frames, plus
the yaw −38.6° occlusion numbers used to judge them:

```
frame     head half-width   splay    yaw -38.6: gap / ate / holes
gripz         78.9 mm       14.0 deg     -0.026 / 0.002 / 0
larsson       78.7 mm       12.7 deg     +0.001 / 0.012 / 0
willow        79.5 mm       14.0 deg     -0.067 / 0.000 / 0
```

The pitch axis was re-measured and settled on Larsson across −25°…+25°: every
pose is inside the gate, max `occluderAteWorld` is 0.016, and there are no
`armHolePx` holes anywhere in the sweep.

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

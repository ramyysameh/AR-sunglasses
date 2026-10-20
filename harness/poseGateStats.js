/**
 * Scoring for the probe-reel pose gate: turns per-frame engine readings and the
 * reel's truth.csv into per-segment error numbers. Pure, so it runs in the
 * browser driver, the CLI and the tests alike.
 *
 * A row (one reel frame, from poseGate.js):
 *   { frame, seg, truth: {yaw, pitch, roll, dist},
 *     tracked, source,                 // glasses shown; 'pnp' | 'mediapipe'
 *     raw:   {yaw, pitch, roll} | null, // solver output, before any smoothing
 *     shown: {yaw, pitch, roll} | null, // what the glasses were drawn with
 *     rawAnchor, shownAnchor: {u, v} | null, // frame's nose-contact point, image px
 *     truthAnchor: {u, v},              // where the bust's nasion really was, image px
 *     mmPerPx }                         // image px -> mm at the nasion's depth
 *
 * Angles are three.js 'YXZ' Euler degrees in the engine's mirrored world, which
 * flips the sign of yaw and roll against the reel's; see AXIS_SIGNS.
 */

/** Engine angle = sign * truth angle (the selfie mirror flips yaw and roll). */
export const AXIS_SIGNS = Object.freeze({ yaw: -1, pitch: 1, roll: -1 })
export const AXES = Object.freeze(['yaw', 'pitch', 'roll'])
export const KINDS = Object.freeze(['raw', 'shown'])

/**
 * The frames that define "seated": the second half of the opening hold, when
 * the scan has locked and the fit has settled. A constant offset there (the
 * bust's neutral head tilt against the canonical face, where the frame sits on
 * this nose) is calibration, not tracking error, and is removed from every row.
 */
export const DEFAULT_BIAS_FRAMES = Object.freeze([60, 120])

function percentile(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

function std(values) {
  if (values.length < 2) return null
  const m = mean(values)
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / (values.length - 1))
}

/** Summary of absolute errors: mean, 95th percentile, worst. */
export function summarize(values) {
  const abs = values.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b)
  if (!abs.length) return { n: 0, mae: null, p95: null, max: null }
  return { n: abs.length, mae: mean(abs), p95: percentile(abs, 95), max: abs[abs.length - 1] }
}

/** Wraps an angle difference into (-180, 180]. */
export function wrapDeg(d) {
  let x = ((d + 180) % 360 + 360) % 360 - 180
  if (x === -180) x = 180
  return x
}

function angleError(row, kind, axis, signs) {
  const solved = row[kind]?.[axis]
  if (!Number.isFinite(solved)) return null
  return wrapDeg(solved - signs[axis] * row.truth[axis])
}

function anchorOffset(row, kind) {
  const a = row[`${kind}Anchor`]
  const t = row.truthAnchor
  if (!a || !t || !Number.isFinite(a.u) || !Number.isFinite(t.u)) return null
  return { du: a.u - t.u, dv: a.v - t.v }
}

/** Constant offsets over the seated frames, per output kind. */
export function computeBias(rows, { biasFrames = DEFAULT_BIAS_FRAMES, signs = AXIS_SIGNS } = {}) {
  const seated = rows.filter((r) => r.frame >= biasFrames[0] && r.frame < biasFrames[1] && r.tracked)
  const bias = {}
  for (const kind of KINDS) {
    const b = {}
    for (const axis of AXES) b[axis] = mean(seated.map((r) => angleError(r, kind, axis, signs)).filter(Number.isFinite)) ?? 0
    const offsets = seated.map((r) => anchorOffset(r, kind)).filter(Boolean)
    b.du = mean(offsets.map((o) => o.du)) ?? 0
    b.dv = mean(offsets.map((o) => o.dv)) ?? 0
    b.frames = seated.length
    bias[kind] = b
  }
  return bias
}

/**
 * Per-frame errors with the seated bias removed: degrees per axis, and the nose
 * contact point's drift off the true nasion in mm (dxMm right, dyMm DOWN in the
 * raw image; a frame riding up onto the forehead reads negative dy).
 */
export function frameErrors(row, bias, signs = AXIS_SIGNS) {
  const out = {}
  for (const kind of KINDS) {
    const e = {}
    for (const axis of AXES) {
      const a = angleError(row, kind, axis, signs)
      e[axis] = a == null ? null : wrapDeg(a - bias[kind][axis])
    }
    const o = anchorOffset(row, kind)
    if (o && Number.isFinite(row.mmPerPx)) {
      e.dxMm = (o.du - bias[kind].du) * row.mmPerPx
      e.dyMm = (o.dv - bias[kind].dv) * row.mmPerPx
      e.driftMm = Math.hypot(e.dxMm, e.dyMm)
    } else {
      e.dxMm = e.dyMm = e.driftMm = null
    }
    out[kind] = e
  }
  return out
}

/**
 * Scores a run: bias, then per-segment error summaries for both the raw solve
 * and what was drawn, tracking coverage, how often PnP was the source, and the
 * jitter floor on the dead-still segment.
 */
export function scorePoseRun(rows, options = {}) {
  const signs = options.signs ?? AXIS_SIGNS
  const bias = computeBias(rows, { ...options, signs })
  const order = []
  const bySeg = new Map()
  for (const row of rows) {
    if (!bySeg.has(row.seg)) {
      bySeg.set(row.seg, [])
      order.push(row.seg)
    }
    bySeg.get(row.seg).push(row)
  }

  const segments = {}
  for (const seg of order) {
    const segRows = bySeg.get(seg)
    const tracked = segRows.filter((r) => r.tracked)
    const errors = tracked.map((r) => frameErrors(r, bias, signs))
    const entry = {
      frames: segRows.length,
      trackedPct: (100 * tracked.length) / segRows.length,
      pnpPct: tracked.length ? (100 * tracked.filter((r) => r.source === 'pnp').length) / tracked.length : 0,
    }
    for (const kind of KINDS) {
      const k = {}
      for (const axis of AXES) k[axis] = summarize(errors.map((e) => e[kind][axis]))
      k.drift = summarize(errors.map((e) => e[kind].driftMm))
      k.meanDxMm = mean(errors.map((e) => e[kind].dxMm).filter(Number.isFinite))
      k.meanDyMm = mean(errors.map((e) => e[kind].dyMm).filter(Number.isFinite))
      entry[kind] = k
    }
    // Jitter: how much the drawn frame moves while nothing in the scene does.
    // Second half only: the reel cuts straight from the previous segment's last
    // pose into this one, and the settle from that jump is lag, not jitter.
    const settled = tracked.slice(Math.floor(tracked.length / 2))
    const still = settled.filter((r) => r.shownAnchor && Number.isFinite(r.mmPerPx))
    const su = std(still.map((r) => r.shownAnchor.u * r.mmPerPx))
    const sv = std(still.map((r) => r.shownAnchor.v * r.mmPerPx))
    entry.jitter = {
      anchorMm: su == null ? null : Math.hypot(su, sv),
      yawDeg: std(settled.map((r) => r.shown?.yaw).filter(Number.isFinite)),
      pitchDeg: std(settled.map((r) => r.shown?.pitch).filter(Number.isFinite)),
    }
    segments[seg] = entry
  }

  return { bias, segments, sanity: axisSanity(rows, signs) }
}

/**
 * Correlation of solved against truth on the segment that moves each axis. A
 * negative value means AXIS_SIGNS (the mirror convention) is wrong for this
 * engine and every number above is meaningless -- the CLI refuses to report.
 */
export function axisSanity(rows, signs = AXIS_SIGNS) {
  const out = {}
  for (const axis of AXES) {
    const pairs = rows
      .filter((r) => r.seg === axis && r.tracked && Number.isFinite(r.raw?.[axis]))
      .map((r) => [signs[axis] * r.truth[axis], r.raw[axis]])
    if (pairs.length < 3) {
      out[axis] = null
      continue
    }
    const mx = mean(pairs.map((p) => p[0]))
    const my = mean(pairs.map((p) => p[1]))
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (const [x, y] of pairs) {
      sxy += (x - mx) * (y - my)
      sxx += (x - mx) ** 2
      syy += (y - my) ** 2
    }
    out[axis] = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
  }
  return out
}

function lookup(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

/**
 * Checks a score against limits shaped like
 *   { "kind": "shown", "segments": { "yaw": { "yaw.mae": 4, "drift.p95": 8 } } }
 * where each key is a path inside score.segments[seg][kind] -- or, prefixed with
 * "/", inside score.segments[seg] itself (e.g. "/trackedPct" with a minimum
 * given as {"min": 95}). Returns the list of violations; empty means pass.
 */
export function checkThresholds(score, limits) {
  const failures = []
  const kind = limits.kind ?? 'shown'
  for (const [seg, checks] of Object.entries(limits.segments ?? {})) {
    const entry = score.segments[seg]
    if (!entry) {
      failures.push({ seg, key: '*', reason: 'segment missing from run' })
      continue
    }
    for (const [key, limit] of Object.entries(checks)) {
      const value = key.startsWith('/') ? lookup(entry, key.slice(1)) : lookup(entry[kind], key)
      const bound = typeof limit === 'object' ? limit : { max: limit }
      if (!Number.isFinite(value)) failures.push({ seg, key, value, reason: 'not measured' })
      else if (bound.max != null && value > bound.max) failures.push({ seg, key, value, limit: bound.max, reason: 'above max' })
      else if (bound.min != null && value < bound.min) failures.push({ seg, key, value, limit: bound.min, reason: 'below min' })
    }
  }
  return failures
}

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–')

/**
 * Markdown comparison table: one row per segment, one column group per run.
 * `runs` is { label: score }.
 */
export function formatComparison(runs, kind = 'shown') {
  const labels = Object.keys(runs)
  const segs = Object.keys(runs[labels[0]].segments)
  const cols = ['yaw MAE°', 'pitch MAE°', 'roll MAE°', 'drift mm (mean / p95)', 'dy mm', 'tracked %']
  const head = ['segment', ...labels.flatMap((l) => cols.map((c) => `${l} ${c}`))]
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`]
  for (const seg of segs) {
    const cells = [seg]
    for (const l of labels) {
      const e = runs[l].segments[seg]
      const k = e?.[kind]
      cells.push(
        fmt(k?.yaw.mae), fmt(k?.pitch.mae), fmt(k?.roll.mae),
        `${fmt(k?.drift.mae)} / ${fmt(k?.drift.p95)}`, fmt(k?.meanDyMm), fmt(e?.trackedPct, 0),
      )
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return lines.join('\n')
}

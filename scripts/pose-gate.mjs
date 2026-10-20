// Probe-reel pose gate: scores the try-on's solved head pose and frame placement
// against the probe reel's ground truth, per timeline segment.
//
//   node scripts/pose-gate.mjs                       # baseline + ?pose=pnp, report, check limits
//   node scripts/pose-gate.mjs --modes pnp --check   # CI-style: exit 1 when a limit is broken
//   node scripts/pose-gate.mjs --reel real-turn-hf-fb640 --modes mediapipe,pnp \
//        --shots 60,135,210,285,360 --no-score       # frame-matched screenshot sheet only
//
// It starts the harness dev server (harness/mock-server.config.mjs) on a spare
// port and a throwaway-profile Chrome, opens /harness/posegate.html once per
// mode, and lets poseGate.js push every reel frame through the engine under a
// virtual 30 fps clock. Rows are scored by harness/poseGateStats.js.
//
// Options:
//   --reel <dir>         reel under test-mock-head/ (default probe-landscape)
//   --modes a,b          pose modes to run: mediapipe (no ?pose), pnp (default both);
//                        the profile guard is on by default: mediapipe:profileguard=0 runs without it;
//                        extra engine params after a colon, e.g. pnp:pnpdepth=canonical
//   --fov <deg>          vertical FOV the ENGINE assumes. Default: the reel's own
//                        (probe reels record it) -- pass 45.24 to see the engine default
//   --model <glb>        calibrate and wear a GLB under public/ ('' = built-in SKU)
//   --fit <json>         wear a stored production model: {fitMetadata, modelUrl}
//                        under public/ (e.g. /calibrated/ai-round-black.json)
//   --shots f1,f2,...    frames to capture; a sheet is built per mode and stacked
//   --out <dir>          output folder (default test-shots/pose-gate-<reel>)
//   --limits <file>      threshold file (default harness/pose-gate.limits.json)
//   --check              exit 1 if the limits file's mode (default: the shipping
//                        engine, mediapipe) breaks a limit
//   --no-score           skip scoring (reels without truth.csv)
//   --url <base>         use an already running harness instead of starting one
//   --chrome <path>      Chrome binary
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkThresholds, formatComparison, scorePoseRun } from '../harness/poseGateStats.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHOT_DIR = path.resolve(ROOT, '..', 'test-shots')

function parseArgs(argv) {
  const args = { modes: ['mediapipe', 'pnp'], reel: 'probe-landscape', shots: [], score: true, check: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--reel') args.reel = next()
    else if (a === '--modes') args.modes = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--fov') args.fov = parseFloat(next())
    else if (a === '--model') args.model = next()
    else if (a === '--fit') args.fit = next()
    else if (a === '--shots') args.shots = next().split(',').map(Number).filter(Number.isFinite)
    else if (a === '--out') args.out = path.resolve(next())
    else if (a === '--limits') args.limits = path.resolve(next())
    else if (a === '--check') args.check = true
    else if (a === '--no-score') args.score = false
    else if (a === '--url') args.url = next()
    else if (a === '--chrome') args.chrome = next()
    else throw new Error(`unknown option ${a}`)
  }
  args.out ??= path.join(SHOT_DIR, `pose-gate-${args.reel}`)
  args.limits ??= path.join(ROOT, 'harness', 'pose-gate.limits.json')
  return args
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function waitFor(fn, { timeoutMs = 60000, label = 'condition' } = {}) {
  const until = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* not yet */ }
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await sleep(250)
  }
}

async function startHarness() {
  const port = await freePort()
  const child = spawn(process.execPath, [
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--config', path.join(ROOT, 'harness', 'mock-server.config.mjs'),
    '--port', String(port), '--strictPort',
  ], { cwd: ROOT, env: { ...process.env, HARNESS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  const url = `http://127.0.0.1:${port}`
  await waitFor(async () => (await fetch(`${url}/harness/posegate.html`)).ok, { label: `harness on ${port}\n${log}` })
  return { url, stop: () => child.kill() }
}

function chromePath(explicit) {
  const candidates = [
    explicit,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('Chrome not found; pass --chrome')
  return found
}

async function startChrome(binary) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'pose-gate-'))
  const child = spawn(binary, [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check',
    // The run is driven, not watched: keep timers and rendering at full speed
    // even when the window is covered or minimised.
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' })
  const portFile = path.join(profile, 'DevToolsActivePort')
  const [port] = (await waitFor(async () => existsSync(portFile) && (await readFile(portFile, 'utf8')).trim(), { label: 'Chrome DevTools port' })).split('\n')
  const version = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).json(), { label: 'Chrome /json/version' })
  return {
    wsUrl: version.webSocketDebuggerUrl,
    stop: async () => {
      child.kill()
      await sleep(500)
      await rm(profile, { recursive: true, force: true }).catch(() => {})
    },
  }
}

/** A minimal CDP client over Node's built-in WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`))
      else resolve(msg.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    id += 1
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
  return { send, close: () => ws.close() }
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (exceptionDetails) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  }
  return result.value
}

async function runMode(cdp, base, args, mode) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Runtime.enable', {}, sessionId)
  const qs = new URLSearchParams({ reel: args.reel })
  // A mode may carry engine params after a colon: pnp:pnpdepth=canonical
  const [poseMode, extra] = mode.split(':')
  if (poseMode !== 'mediapipe') qs.set('pose', poseMode)
  for (const kv of (extra ?? '').split('&').filter(Boolean)) qs.set(...kv.split('='))
  if (Number.isFinite(args.fov)) qs.set('fov', String(args.fov))
  if (args.model != null) qs.set('model', args.model)
  if (args.fit) qs.set('fit', args.fit)
  await cdp.send('Page.navigate', { url: `${base}/harness/posegate.html?${qs}` }, sessionId)
  await waitFor(() => evaluate(cdp, sessionId, 'window.__gate?.ready === true'), { timeoutMs: 120000, label: 'gate page' })
  const prefix = `pose-gate-${args.reel}-${mode}`
  const result = await evaluate(cdp, sessionId,
    `window.__gate.run(${JSON.stringify({ shotsAt: args.shots, shotPrefix: prefix })})`)
  await cdp.send('Target.closeTarget', { targetId })
  return result
}

async function buildSheet(runs, args) {
  const { default: sharp } = await import('sharp')
  const modes = Object.keys(runs)
  const frames = args.shots
  const TILE_H = 300
  const first = runs[modes[0]].meta
  const tileW = Math.round((TILE_H * first.w) / first.h)
  const LABEL_W = 150
  const composites = []
  for (const [r, mode] of modes.entries()) {
    const label = Buffer.from(`<svg width="${LABEL_W}" height="${TILE_H}"><rect width="100%" height="100%" fill="#111"/><text x="12" y="${TILE_H / 2}" font-family="Consolas, monospace" font-size="22" fill="#fff">${r === 0 ? 'before' : 'after'}</text><text x="12" y="${TILE_H / 2 + 28}" font-family="Consolas, monospace" font-size="13" fill="#aaa">${mode.replace(/&/g, '&amp;')}</text></svg>`)
    composites.push({ input: label, left: 0, top: r * TILE_H })
    for (const [c, frame] of frames.entries()) {
      const file = runs[mode].meta.shots?.[frame]
      if (!file) continue
      const tile = await sharp(file).resize(tileW, TILE_H).toBuffer()
      composites.push({ input: tile, left: LABEL_W + c * tileW, top: r * TILE_H })
    }
  }
  const sheet = path.join(args.out, `sheet-${args.reel}.jpg`)
  await sharp({ create: { width: LABEL_W + frames.length * tileW, height: modes.length * TILE_H, channels: 3, background: '#000' } })
    .composite(composites).jpeg({ quality: 88 }).toFile(sheet)
  return sheet
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await mkdir(args.out, { recursive: true })
  const harness = args.url ? { url: args.url, stop: () => {} } : await startHarness()
  const chrome = await startChrome(chromePath(args.chrome))
  const cdp = await connect(chrome.wsUrl)
  const runs = {}
  try {
    for (const mode of args.modes) {
      process.stdout.write(`running ${args.reel} pose=${mode} ... `)
      const result = await runMode(cdp, harness.url, args, mode)
      process.stdout.write(`${result.rows.length} frames, ${result.meta.seconds.toFixed(0)} s\n`)
      // Move the captures into the output folder.
      for (const [frame, file] of Object.entries(result.meta.shots ?? {})) {
        const dest = path.join(args.out, `${mode.replace(/[^a-z0-9=-]/gi, '_')}-f${String(frame).padStart(4, '0')}.jpg`)
        await rename(file, dest)
        result.meta.shots[frame] = dest
      }
      runs[mode] = result
      await writeFile(path.join(args.out, `rows-${mode.replace(/[^a-z0-9=-]/gi, '_')}.json`), JSON.stringify(result))
    }
  } finally {
    cdp.close()
    await chrome.stop()
    harness.stop()
  }

  if (args.shots.length) console.log(`sheet: ${await buildSheet(runs, args)}`)
  if (!args.score) return

  const scores = Object.fromEntries(Object.entries(runs).map(([mode, r]) => [mode, scorePoseRun(r.rows)]))
  for (const [mode, s] of Object.entries(scores)) {
    const bad = Object.entries(s.sanity).filter(([, c]) => c != null && c < 0.5)
    if (bad.length) {
      console.error(`${mode}: solved angles do not follow truth (${bad.map(([a, c]) => `${a} r=${c.toFixed(2)}`).join(', ')}); axis convention is wrong, refusing to score`)
      process.exitCode = 2
      return
    }
  }
  const meta = runs[args.modes[0]].meta
  const report = [
    `# Pose gate: ${args.reel}`,
    '',
    `Engine FOV ${meta.engineFovDeg.toFixed(2)}°, reel FOV ${meta.reelFovDeg ?? 'unknown'}°, ${meta.w}x${meta.h}, SKU ${meta.sku}.`,
    'Errors are against truth.csv after removing the constant offset over frames 60-119 (seated, frontal).',
    'Drift is the frame\'s nose-contact point against the bust\'s true nasion, in mm at the face; dy < 0 = riding up.',
    '',
    '## What was drawn (after filtering)',
    '',
    formatComparison(scores, 'shown'),
    '',
    '## Raw solve (before filtering)',
    '',
    formatComparison(scores, 'raw'),
    '',
    '## Seated bias removed',
    '',
    ...Object.entries(scores).map(([mode, s]) => `- ${mode}: raw yaw ${s.bias.raw.yaw.toFixed(2)}°, pitch ${s.bias.raw.pitch.toFixed(2)}°, roll ${s.bias.raw.roll.toFixed(2)}°; anchor (${s.bias.shown.du.toFixed(1)}, ${s.bias.shown.dv.toFixed(1)}) px`),
    '',
    '## Still-segment jitter (shown)',
    '',
    ...Object.entries(scores).map(([mode, s]) => `- ${mode}: anchor ${s.segments.still?.jitter.anchorMm?.toFixed(2)} mm SD, yaw ${s.segments.still?.jitter.yawDeg?.toFixed(2)}° SD, pitch ${s.segments.still?.jitter.pitchDeg?.toFixed(2)}° SD`),
    '',
  ]

  let failures = []
  if (existsSync(args.limits)) {
    const limits = JSON.parse(await readFile(args.limits, 'utf8'))
    // The limits describe one mode (what ships, by default); fall back to the
    // last mode run when that one was not part of this run.
    const checked = scores[limits.mode] ? limits.mode : args.modes[args.modes.length - 1]
    failures = checkThresholds(scores[checked], limits)
    report.push(`## Limits (${path.basename(args.limits)}, checked on ${checked})`, '')
    report.push(failures.length
      ? failures.map((f) => `- FAIL ${f.seg} ${f.key}: ${Number.isFinite(f.value) ? f.value.toFixed(2) : f.value} (${f.reason}${f.limit != null ? ` ${f.limit}` : ''})`).join('\n')
      : '- all within limits')
  }
  const text = report.join('\n')
  await writeFile(path.join(args.out, 'report.md'), `${text}\n`)
  await writeFile(path.join(args.out, 'scores.json'), JSON.stringify(scores, null, 2))
  console.log(text)
  if (args.check && failures.length) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

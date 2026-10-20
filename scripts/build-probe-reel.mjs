#!/usr/bin/env node
/**
 * Assembles a probe-reel frame directory (rendered by harness/probereel.html via
 * the harness's /probe page) into a .y4m for Chrome's fake camera, plus a small
 * .mp4 preview.
 *
 *   node scripts/build-probe-reel.mjs [dir] [--fps 30]
 *   node scripts/build-probe-reel.mjs --from-video <clip.mp4>   (real footage; see below)
 *
 * dir defaults to ../test-mock-head/probe-landscape. Writes <dir>.y4m and
 * <dir>.mp4 next to the directory. Then:
 *
 *   chrome --use-fake-ui-for-media-stream --use-fake-device-for-media-stream \
 *          --use-file-for-fake-video-capture=<dir>.y4m <try-on url>
 *
 * Chrome loops the file. Read results against <dir>/truth.csv: every frame's
 * yaw/pitch/roll/distance/light, also burned into the frame's bottom-left corner.
 *
 * Requires ffmpeg on PATH.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const fpsIdx = args.indexOf('--fps')
const fps = fpsIdx >= 0 ? Number(args[fpsIdx + 1]) : 30

function ffmpeg(argv) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...argv], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`ffmpeg failed (${r.status})`)
}

/*
 * --from-video <clip.mp4>: the same kind of reel from REAL footage (e.g. an AI
 * head-turn clip with no glasses on), for try-ons whose tracker will not lock on
 * the CG bust. No per-frame pose truth exists for footage, so instead it gets:
 *   1. the clip as-is                     (tracking through natural turns)
 *   2. the clip again, dimmed and warmed  (light estimation, same motion)
 *   3. its last frame frozen for 4 s      (jitter floor: any motion is noise)
 * with the frame number and segment burned into the corner. Written as
 * <clip>-portrait.y4m (source framing) and <clip>-landscape.y4m (1280x720, the
 * clip centred on a flat dark backdrop, sized so a 4:3 centre crop -- which is
 * what a 640x480 getUserMedia request gets from Chrome -- still holds the whole
 * head).
 *
 * --pad blur pads with a blurred copy of the clip instead (the old default). Do
 * not use it for tracking reels: when the face runs off the clip's edge,
 * MediaPipe puts landmarks out on the blurred skin, which no camera produces
 * (FINDINGS §9). A flat pad leaves the clip edge as a plain edge.
 */
const fromIdx = args.indexOf('--from-video')
if (fromIdx >= 0) {
  const src = path.resolve(args[fromIdx + 1])
  const base = src.replace(/\.[^.]+$/, '')
  const font = process.platform === 'win32' ? "fontfile='C\\:/Windows/Fonts/consola.ttf':" : ''
  const padIdx = args.indexOf('--pad')
  const pad = padIdx >= 0 ? args[padIdx + 1] : 'flat'
  if (pad !== 'flat' && pad !== 'blur') throw new Error(`--pad must be flat or blur, got ${pad}`)
  // Keeps the clip's timing; flat fills it with a dark backdrop like the clip's.
  const padFilter = pad === 'blur' ? 'boxblur=20:2,eq=brightness=-0.1' : 'drawbox=c=0x101010:t=fill'
  const label = (tag) => `drawtext=${font}text='#%{frame_num} ${tag}':x=8:y=h-th-8:fontsize=h/45:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`
  const graph = [
    `[0:v]fps=${fps},format=yuv420p,split=3[a][b][c]`,
    `[a]setpts=PTS-STARTPTS,${label('real')}[A]`,
    // Roughly a dim tungsten room: about -1 stop, warmer.
    `[b]setpts=PTS-STARTPTS,eq=brightness=-0.07:gamma=0.85:saturation=1.05,colorbalance=rs=0.08:gs=0.01:bs=-0.1:rm=0.05:bm=-0.06,${label('dim-warm')}[B]`,
    `[c]reverse,trim=end_frame=1,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=4,${label('still')}[C]`,
    '[A][B][C]concat=n=3:v=1:a=0[reel]',
    '[reel]split=2[p][l]',
    `[l]split=2[lbg][lfg]`,
    `[lbg]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,${padFilter}[bg]`,
    `[lfg]scale=-2:720[fg]`,
    '[bg][fg]overlay=(W-w)/2:0,format=yuv420p[land]',
  ].join(';')
  ffmpeg(['-i', src, '-filter_complex', graph, '-map', '[p]', '-pix_fmt', 'yuv420p', `${base}-portrait.y4m`, '-map', '[land]', '-pix_fmt', 'yuv420p', `${base}-landscape.y4m`])
  for (const kind of ['portrait', 'landscape']) {
    ffmpeg(['-i', `${base}-${kind}.y4m`, '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', `${base}-${kind}.mp4`])
    console.log(`${base}-${kind}.y4m  ${(fs.statSync(`${base}-${kind}.y4m`).size / 1e6).toFixed(0)} MB`)
  }
  process.exit(0)
}
const dir = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--fps')
  ?? path.join(ROOT, '..', 'test-mock-head', 'probe-landscape'))

if (!fs.existsSync(path.join(dir, 'frame-0.jpg'))) {
  console.error(`no frame-0.jpg in ${dir} -- render it first at /probe/?save=1&dir=${path.basename(dir)}`)
  process.exit(1)
}

const input = ['-framerate', String(fps), '-i', path.join(dir, 'frame-%d.jpg')]
// y4m is raw: ~1.4 MB per 1280x720 frame. Chrome's fake device needs it raw.
ffmpeg([...input, '-pix_fmt', 'yuv420p', `${dir}.y4m`])
ffmpeg([...input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', `${dir}.mp4`])

const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(0)
console.log(`${dir}.y4m  ${mb(`${dir}.y4m`)} MB`)
console.log(`${dir}.mp4  ${mb(`${dir}.mp4`)} MB`)
console.log(`truth: ${path.join(dir, 'truth.csv')}`)

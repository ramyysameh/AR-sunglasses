import { WebIO } from '@gltf-transform/core'
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions'
import { validateModel, normalizeModel, calibrate, MODELING_SPEC } from '@artryon/calibration'

const io = new WebIO().registerExtensions(KHRONOS_EXTENSIONS)
let current = null

const report = document.getElementById('report')
const anchorsEl = document.getElementById('anchors')

function bar(label, score) {
  const pct = Math.round(score * 100)
  return `<div class="row"><span style="width:120px">${label}</span>` +
    `<div class="bar" style="width:${pct}px"></div><span>${pct}%</span></div>`
}

function renderReport(validation, calibration) {
  const c = calibration.confidence
  report.innerHTML =
    `<h3>Validation: ${validation.status}</h3>` +
    validation.issues.map((i) => `<div>[${i.severity}] ${i.message}</div>`).join('') +
    `<h3>Source: ${calibration.source}${calibration.needsManual ? ' — NEEDS MANUAL' : ''}</h3>` +
    (c
      ? bar('overall', c.overall) + Object.entries(c.breakdown).map(([k, v]) => bar(k, v)).join('')
      : '<div>tagged — exact anchors</div>')
}

function renderAnchors(fit) {
  const keys = ['bridgeAnchor', 'leftHinge', 'rightHinge']
  anchorsEl.innerHTML = '<h3>Anchors (editable)</h3>' + keys.map((key) =>
    ['x', 'y', 'z'].map((axis) =>
      `<label>${key}.${axis} <input type="number" step="0.001" data-key="${key}" data-axis="${axis}" value="${fit[key][axis]}"/></label>`
    ).join(' ')
  ).join('<br/>')
  anchorsEl.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      current.fitMetadata[input.dataset.key][input.dataset.axis] = Number(input.value)
    })
  })
}

document.getElementById('file').addEventListener('change', async (event) => {
  const file = event.target.files[0]
  if (!file) return
  try {
    const doc = await io.readBinary(new Uint8Array(await file.arrayBuffer()))
    const validation = validateModel(doc, MODELING_SPEC)
    const { doc: normalized } = normalizeModel(doc, MODELING_SPEC)
    const calibration = calibrate(normalized, MODELING_SPEC)
    current = calibration
    renderReport(validation, calibration)
    renderAnchors(calibration.fitMetadata)
  } catch (err) {
    document.getElementById('report').textContent = `Could not read model: ${err.message}`
  }
})

document.getElementById('export').addEventListener('click', () => {
  if (!current) return
  const blob = new Blob([JSON.stringify(current.fitMetadata, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'fit-metadata.json'
  a.click()
})

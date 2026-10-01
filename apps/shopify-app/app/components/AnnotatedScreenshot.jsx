/* eslint-disable react/prop-types -- static tutorial data */
import { useId } from 'react'

const ACCENT = '#e5484d'
const STROKE = { strokeWidth: 3 }

// The overlay is a 100x100 box stretched over the image (preserveAspectRatio
// "none"), so one x unit is width/100 px and one y unit is height/100 px.
// `aspect` (= width / height) is how much taller a y unit is than it looks,
// and is used to draw the number badge as a round circle, not an ellipse.
function Badge({ x, y, n, aspect }) {
  return (
    <g transform={`translate(${x} ${y}) scale(1 ${aspect})`}>
      <circle r="2.2" fill={ACCENT} />
      <text y="0.9" textAnchor="middle" fontSize="2.6" fontWeight="700" fill="#fff">{n}</text>
    </g>
  )
}

function Mark({ mark, aspect, arrowId }) {
  if (mark.kind === 'circle') {
    return (
      <g>
        <ellipse cx={mark.x} cy={mark.y} rx={mark.w / 2} ry={mark.h / 2} fill="none" stroke={ACCENT} vectorEffect="non-scaling-stroke" style={STROKE} />
        <Badge x={mark.x + mark.w / 2 + 1.5} y={mark.y - mark.h / 2} n={mark.n} aspect={aspect} />
      </g>
    )
  }
  if (mark.kind === 'box') {
    return (
      <g>
        <rect x={mark.x} y={mark.y} width={mark.w} height={mark.h} rx="1" fill="none" stroke={ACCENT} vectorEffect="non-scaling-stroke" style={STROKE} />
        <Badge x={mark.x - 1.5} y={mark.y - 1.5} n={mark.n} aspect={aspect} />
      </g>
    )
  }
  return (
    <g>
      <line x1={mark.x} y1={mark.y} x2={mark.toX} y2={mark.toY} stroke={ACCENT} vectorEffect="non-scaling-stroke" style={STROKE} markerEnd={`url(#${arrowId})`} />
      <Badge x={mark.x} y={mark.y} n={mark.n} aspect={aspect} />
    </g>
  )
}

/**
 * A screenshot with numbered circles, boxes and arrows drawn over it. Marks
 * are in percentages of the image, so they stay put at any width; captions
 * under the image repeat each number for screen readers and skimmers.
 */
export default function AnnotatedScreenshot({ src, alt, width, height, marks }) {
  // One arrowhead marker per figure: several screenshots share a page and
  // duplicate ids would make them reference each other's marker.
  const arrowId = `tutorial-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const aspect = width / height
  return (
    <figure style={{ margin: 0 }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: `${width} / ${height}`, border: '1px solid #e3e3e3', borderRadius: '8px', overflow: 'hidden' }}>
        <img src={src} alt={alt} width={width} height={height} style={{ display: 'block', width: '100%', height: '100%' }} />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <defs>
            {/* userSpaceOnUse: with the default strokeWidth units the 3px
                non-scaling stroke would blow the head up to ~15% of the image. */}
            <marker id={arrowId} viewBox="0 0 10 10" refX="8" refY="5" markerUnits="userSpaceOnUse" markerWidth="3" markerHeight={3 * aspect} orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" fill={ACCENT} />
            </marker>
          </defs>
          {marks.map((mark) => <Mark key={mark.n} mark={mark} aspect={aspect} arrowId={arrowId} />)}
        </svg>
      </div>
      <figcaption>
        <ol style={{ margin: '12px 0 0', paddingLeft: '20px' }}>
          {marks.map((mark) => <li key={mark.n} value={mark.n}>{mark.caption}</li>)}
        </ol>
      </figcaption>
    </figure>
  )
}

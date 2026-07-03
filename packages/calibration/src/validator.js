import { mergedPositions, countTriangles } from './glbAccess.js'
import { measureFrontWidth } from './geometry.js'

export function validateModel(doc, spec) {
  const issues = []
  const positions = mergedPositions(doc)

  if (positions.length === 0) {
    issues.push({ code: 'NO_GEOMETRY', severity: 'fail', message: 'model has no mesh geometry' })
    return { status: 'fail', issues }
  }

  if (countTriangles(doc) > spec.maxTriangles) {
    issues.push({ code: 'OVER_POLY_BUDGET', severity: 'warn', message: `exceeds ${spec.maxTriangles} triangles` })
  }

  const width = measureFrontWidth(positions)
  const [minW, maxW] = spec.frameWidthRangeM
  if (width < minW || width > maxW) {
    issues.push({ code: 'WIDTH_OUT_OF_RANGE', severity: 'warn', message: `front width ${width.toFixed(3)}m outside ${minW}-${maxW}m` })
  }

  const status = issues.some((i) => i.severity === 'fail')
    ? 'fail'
    : issues.length
      ? 'warn'
      : 'pass'
  return { status, issues }
}

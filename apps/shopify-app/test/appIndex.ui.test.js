import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const routeUrl = new URL('../app/routes/app._index.jsx', import.meta.url)

describe('home Polaris contract', () => {
  it('uses valid subdued text and numeric ARIA values', async () => {
    const source = await readFile(routeUrl, 'utf8')
    expect(source).not.toContain('tone="subdued"')
    expect(source).not.toContain('aria-valuemin="0"')
    expect(source).toContain('color="subdued"')
    expect(source).toContain('aria-valuemin={0}')
  })
})

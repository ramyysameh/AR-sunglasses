import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// The app embed is the store's on/off switch: a block placed in a template must
// not show its button unless the embed is on. That contract lives in CSS split
// across two files, so check both halves stay in step.
const read = (path) => readFileSync(new URL(`../extensions/tryon-button/${path}`, import.meta.url), 'utf8')
const core = read('snippets/tryon_core.liquid')
const embed = read('blocks/tryon_embed.liquid')

const BLOCK_ROOT = '.ar-tryon[data-ar-tryon-placement="block"]:not([data-ar-tryon-design-mode])'
const EDITOR_BUTTON = '.ar-tryon[data-ar-tryon-placement="block"][data-ar-tryon-design-mode] .ar-tryon__open'

describe('app embed as the on/off switch', () => {
  it('hides a block-placed button by default', () => {
    expect(core).toMatch(new RegExp(`${escape(BLOCK_ROOT)}\\s*\\{\\s*display: none;`))
    expect(core).toMatch(new RegExp(`${escape(EDITOR_BUTTON)}\\s*\\{\\s*display: none;`))
  })

  it('reveals it from the embed with selectors that out-rank the hide rules', () => {
    expect(embed).toMatch(new RegExp(`html ${escape(BLOCK_ROOT)}\\s*\\{\\s*display: block;`))
    expect(embed).toMatch(new RegExp(`html ${escape(EDITOR_BUTTON)}\\s*\\{\\s*display: inline-flex;`))
    expect(embed).toMatch(/html \.ar-tryon__embed-off\s*\{\s*display: none;/)
  })

  it('outputs the reveal rule outside the product-page condition', () => {
    expect(embed.indexOf('<style>')).toBeLessThan(embed.indexOf("{% if request.page_type == 'product'"))
  })

  it('loads the embed on every template so blocks outside product pages still show', () => {
    const schema = JSON.parse(embed.slice(embed.indexOf('{% schema %}') + 12, embed.indexOf('{% endschema %}')))
    expect(schema.enabled_on).toBeUndefined()
  })

  it('tells the merchant in the theme editor why the button is hidden', () => {
    expect(core).toContain('class="ar-tryon__embed-off"')
  })
})

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

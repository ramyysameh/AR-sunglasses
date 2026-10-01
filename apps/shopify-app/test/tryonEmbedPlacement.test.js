import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const liquid = readFileSync(new URL('../extensions/tryon-button/blocks/tryon_embed.liquid', import.meta.url), 'utf8')
const scriptBody = liquid.slice(liquid.indexOf('<script>') + '<script>'.length, liquid.indexOf('</script>'))

function run({ root, submit }) {
  const document = {
    querySelector: (sel) => (sel.includes('data-ar-tryon-placement') ? root : sel.includes('/cart/add') ? submit : null),
  }
  new Function('document', scriptBody)(document)
}

describe('embed placement', () => {
  it('puts the button right after Add to cart', () => {
    const root = { classList: { add: () => { throw new Error('should not float') } } }
    const calls = []
    const submit = { insertAdjacentElement: (where, el) => calls.push([where, el]) }
    run({ root, submit })
    expect(calls).toEqual([['afterend', root]])
  })

  it('floats the button when the theme has no Add to cart form', () => {
    const added = []
    const root = { classList: { add: (c) => added.push(c) } }
    run({ root, submit: null })
    expect(added).toEqual(['ar-tryon--floating'])
  })

  it('does nothing when the block already won', () => {
    expect(() => run({ root: null, submit: null })).not.toThrow()
  })
})

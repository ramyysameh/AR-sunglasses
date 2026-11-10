#!/usr/bin/env node
// Adds the Meta Pixel to the Zendo Labs marketing site (zendo-labs.vercel.app).
//
// Run from the site folder (the one holding index.html and ar-try-on/):
//   node add-meta-pixel.mjs            # patches ./index.html and ./ar-try-on/index.html
//   node add-meta-pixel.mjs path/to/site
//
// Safe to run twice: files that already carry the pixel are left alone.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

export const PIXEL_ID = '1860638841647938'
const PAGES = ['index.html', 'ar-try-on/index.html']
const MARKER = '<!-- Meta Pixel -->'

// PageView on every page, plus a Lead each time someone clicks through to the
// Shopify App Store listing. The install itself happens on apps.shopify.com,
// where no third-party pixel can run, so the click is the closest signal.
const headSnippet = `  ${MARKER}
  <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '${PIXEL_ID}');
    fbq('track', 'PageView');
    (function () {
      function onInstallClick(e) {
        var a = e.target && e.target.closest && e.target.closest('a[href*="apps.shopify.com"]');
        if (a) fbq('track', 'Lead', { content_name: 'AR Try-on', content_category: 'shopify_install_click' });
      }
      document.addEventListener('click', onInstallClick, true);
      document.addEventListener('auxclick', onInstallClick, true);
    })();
  </script>
  <!-- End Meta Pixel -->
`
const bodySnippet = `
  <noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1" /></noscript>`

export function addPixel(html) {
  if (html.includes(MARKER) || html.includes('fbevents.js')) return null
  const eol = html.includes('\r\n') ? '\r\n' : '\n'
  const fix = (s) => s.replace(/\n/g, eol)
  if (!/<\/head>/i.test(html) || !/<body[^>]*>/i.test(html)) {
    throw new Error('no </head> or <body> tag found')
  }
  return html
    .replace(/^[ \t]*<\/head>/im, (m) => fix(headSnippet) + m)
    .replace(/<body[^>]*>/i, (m) => m + fix(bodySnippet))
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('add-meta-pixel.mjs')) {
  const root = resolve(process.argv[2] ?? '.')
  let failed = false
  for (const page of PAGES) {
    const file = join(root, page)
    if (!existsSync(file)) {
      console.error(`missing  ${page}  (run this from the site folder, or pass its path)`)
      failed = true
      continue
    }
    const out = addPixel(readFileSync(file, 'utf8'))
    if (out === null) console.log(`skipped  ${page}  (pixel already present)`)
    else {
      writeFileSync(file, out)
      console.log(`patched  ${page}`)
    }
  }
  process.exit(failed ? 1 : 0)
}

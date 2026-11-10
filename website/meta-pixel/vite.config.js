import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Meta Pixel, injected into every page at build time. Tracks PageView on load
// and a Lead on each click through to the Shopify App Store (the install itself
// happens on apps.shopify.com, where a third-party pixel cannot run).
const META_PIXEL_ID = '1860638841647938'

const metaPixel = () => ({
  name: 'meta-pixel',
  transformIndexHtml: () => [
    {
      tag: 'script',
      injectTo: 'head',
      children: `
!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');
(function () {
  function onInstallClick(e) {
    var a = e.target && e.target.closest && e.target.closest('a[href*="apps.shopify.com"]');
    if (a) fbq('track', 'Lead', { content_name: 'AR Try-on', content_category: 'shopify_install_click' });
  }
  document.addEventListener('click', onInstallClick, true);
  document.addEventListener('auxclick', onInstallClick, true);
})();
`,
    },
    {
      tag: 'noscript',
      injectTo: 'body-prepend',
      children: `<img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1" />`,
    },
  ],
})

export default defineConfig({
  plugins: [metaPixel()],
  input: {
    main: resolve(import.meta.dirname, 'index.html'),
    tryon: resolve(import.meta.dirname, 'ar-try-on/index.html'),
  },
  server: { port: 5190 },
})

import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// Meta Pixel and Google Analytics 4, injected into every page at build time.
// Both record a page view on load and an event on each click through to the
// Shopify App Store. Completed installs are reported by the App Store listing
// itself, which is linked to the same IDs in the Partner Dashboard.
const META_PIXEL_ID = '1860638841647938'
const GA4_MEASUREMENT_ID = 'G-F2ME2Z1XBG'

const analytics = () => ({
  name: 'analytics',
  transformIndexHtml: () => [
    {
      tag: 'script',
      injectTo: 'head',
      attrs: { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}` },
    },
    {
      tag: 'script',
      injectTo: 'head',
      children: `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA4_MEASUREMENT_ID}');
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
    if (!a) return;
    fbq('track', 'Lead', { content_name: 'AR Try-on', content_category: 'shopify_install_click' });
    gtag('event', 'install_click', { app_name: 'AR Try-on', link_url: a.href, link_text: (a.textContent || '').trim() });
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
  plugins: [analytics()],
  input: {
    main: resolve(import.meta.dirname, 'index.html'),
    tryon: resolve(import.meta.dirname, 'ar-try-on/index.html'),
  },
  server: { port: 5190 },
})

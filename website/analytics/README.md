# Analytics for the Zendo Labs site

The marketing site at https://zendo-labs.vercel.app (home page and
`/ar-try-on/`) runs:

- Meta Pixel `1860638841647938`
- Google Analytics 4 `G-F2ME2Z1XBG`

The site's source is not in this repository; it is deployed to Vercel from a
local folder. Both tags live in that site's `vite.config.js`, as a small plugin
that injects them into every page at build time. The copy in this folder is the
one currently deployed.

## Keeping it

Copy `vite.config.js` from here over the one in the local site folder before
the next `vercel --prod`. Deploying with the old config removes both tags.

## What gets tracked

| When | Meta Pixel | GA4 |
| --- | --- | --- |
| Every page load | `PageView` | `page_view` |
| A click on any link to `apps.shopify.com` (the Install buttons) | `Lead` | `install_click` |

## Shopify App Store listing

The listing is linked to the same IDs in the Partner Dashboard (Apps → AR Try-on
→ Distribution → Manage listing → Tracking information). With a GA4 Measurement
Protocol API secret entered there, Shopify sends `shopify_app_install` to GA4
when a merchant finishes installing. See
https://shopify.dev/docs/apps/launch/marketing/track-listing-traffic

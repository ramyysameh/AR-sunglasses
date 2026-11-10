# Meta Pixel for the Zendo Labs site

Meta Pixel `1860638841647938` runs on the marketing site at
https://zendo-labs.vercel.app (home page and `/ar-try-on/`).

The site's source is not in this repository; it is deployed to Vercel from a
local folder. The pixel lives in that site's `vite.config.js`, as a small
plugin that injects the snippet into every page at build time. The copy in this
folder is the one currently deployed.

## Keeping it

Copy `vite.config.js` from here over the one in the local site folder before
the next `vercel --prod`. Deploying with the old config removes the pixel.

## What gets tracked

| Event | When |
| --- | --- |
| `PageView` | Every load of either page |
| `Lead` | A click on any link to `apps.shopify.com` (the Install buttons) |

The install itself happens on the Shopify App Store, where a third-party pixel
cannot run, so `Lead` counts install clicks, not completed installs. Use `Lead`
as the conversion event for ads.

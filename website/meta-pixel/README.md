# Meta Pixel for the Zendo Labs site

Adds Meta Pixel `1860638841647938` to the marketing site at
https://zendo-labs.vercel.app (home page and `/ar-try-on/`).

The site's source is not in this repository; it is deployed to Vercel from a
local folder. `add-meta-pixel.mjs` patches that folder in place.

## Use

From the site folder (the one with `index.html`, `ar-try-on/` and `vite.config.js`):

```sh
node /path/to/AR-sunglasses/website/meta-pixel/add-meta-pixel.mjs
npx vercel --prod
```

It edits `index.html` and `ar-try-on/index.html`, and skips a file that already
has the pixel.

## What gets tracked

| Event | When |
| --- | --- |
| `PageView` | Every load of either page |
| `Lead` | A click on any link to `apps.shopify.com` (the Install buttons) |

The install itself happens on the Shopify App Store, where a third-party pixel
cannot run, so `Lead` counts install clicks, not completed installs. Use `Lead`
as the conversion event for ads.

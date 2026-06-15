# Shopify WebAR Try-On Embed (legacy manual section)

This folder contains a manual theme-section embed for the WebAR try-on. It is the
quickest way to drop the hosted try-on onto a single store, and is kept as a fallback.

> The production distribution path is a **Shopify App + Theme App Extension** (see the
> `shopify-app/` project), which installs the Try-On button automatically. Prefer that
> over this manual section for any real deployment.

## Manual section setup

1. Build and deploy the Vite app over HTTPS (e.g. Vercel).
2. In the theme editor, add the **AR Try-On** section and set `tryon_app_url` to the
   hosted app URL.
3. The section passes the product and variant IDs to the try-on app via query params.

The try-on runs entirely client-side using the custom MediaPipe + Three.js engine — no
API keys or external AR vendor is required.

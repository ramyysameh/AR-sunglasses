# Shopify WebAR Try-On Embed

This folder contains a theme-section integration for the production WebAR try-on.

1. Build and deploy the Vite app over HTTPS.
2. Configure the section setting `tryon_app_url` to the hosted app URL.
3. Set Snap Camera Kit values through the hosted app environment:
   - `VITE_SNAP_CAMERA_KIT_API_TOKEN`
   - `VITE_SNAP_LENS_ID`
   - `VITE_SNAP_LENS_GROUP_ID`
4. Map production product and variant IDs into `src/config/tryOnConfig.js` or provide `window.AR_TRYON_CONFIG` from the theme.

The storefront should use the Snap Camera Kit provider. The local MediaPipe provider is only a debug fallback.

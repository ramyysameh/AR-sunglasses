// Tutorial content. Mark coordinates are percentages of each screenshot
// (public/tutorial/*.png, 2560x1600 captures of a 1280x800 admin viewport).
export const TUTORIAL_STEPS = [
  {
    id: 'create',
    title: '1. Create 3D models',
    intro: 'On Workspace, choose up to 5 products. We build each 3D model from the product photos.',
    image: { src: '/tutorial/create.png', alt: 'Create with AI on the Workspace page', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'box', x: 27, y: 36, w: 14, h: 6, caption: 'Choose products: pick up to 5 from your store.' },
      { n: 2, kind: 'arrow', x: 75, y: 58, toX: 55, toY: 52, caption: 'Tick 3 or 4 clear photos per product. The first 4 are ticked for you.' },
      { n: 3, kind: 'circle', x: 33, y: 86, w: 16, h: 7, caption: 'Generate. Each model takes a few minutes; you can leave the page.' },
    ],
  },
  {
    id: 'save',
    title: '2. Review and save',
    intro: 'Check each model, zoom in on the details, then save it. Saving adds try-on to its product.',
    image: { src: '/tutorial/review.png', alt: 'A generated model ready to review', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'box', x: 30, y: 30, w: 50, h: 40, caption: 'Expand for a large view: drag to rotate, scroll or pinch to zoom.' },
      { n: 2, kind: 'circle', x: 33, y: 80, w: 12, h: 6, caption: 'Save model. Free models left are shown at the top of the Models page.' },
      { n: 3, kind: 'arrow', x: 70, y: 82, toX: 50, toY: 80, caption: 'Not right? Try again (3 free retries) or Discard.' },
    ],
  },
  {
    id: 'turn-on',
    title: '3. Turn on try-on in your store',
    intro: 'One switch adds the Try on button to every product with a model.',
    image: { src: '/tutorial/turn-on.png', alt: 'The theme editor with the AR Try-on app embed switched on', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'circle', x: 14, y: 40, w: 22, h: 8, caption: 'AR Try-on is already switched on under App embeds.' },
      { n: 2, kind: 'circle', x: 90, y: 8, w: 8, h: 6, caption: 'Click Save. That is the only step in the theme editor.' },
    ],
  },
  {
    id: 'check',
    title: '4. Check your store',
    intro: 'Open a product with a model. The Try on button sits under Add to cart.',
    image: { src: '/tutorial/storefront.png', alt: 'A product page with the Try on button under Add to cart', width: 2560, height: 1600 },
    marks: [
      { n: 1, kind: 'box', x: 58, y: 62, w: 34, h: 8, caption: 'The Try on button opens the camera try-on.' },
      { n: 2, kind: 'arrow', x: 40, y: 90, toX: 57, toY: 66, caption: 'Back in the app, Workspace shows the product as Live.' },
    ],
  },
]

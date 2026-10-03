// Tutorial content. Mark coordinates are percentages of each screenshot
// (public/tutorial/*.png, captured from the dev store with the generic demo
// products; measured against the element boxes in each capture).
export const TUTORIAL_STEPS = [
  {
    id: 'create',
    title: '1. Create 3D models',
    intro: 'On Workspace, choose up to 5 products. We build each 3D model from the product photos.',
    image: { src: '/tutorial/create.png', alt: 'Create with AI on the Workspace page with two products picked', width: 1280, height: 654 },
    marks: [
      { n: 1, kind: 'box', x: 13.05, y: 12.84, w: 10.63, h: 5.81, caption: 'Choose products: pick up to 5 from your store.' },
      { n: 2, kind: 'arrow', x: 50, y: 45.9, toX: 37.5, toY: 44.3, caption: 'Tick 3 or 4 clear photos per product. The first 4 are ticked for you.' },
      { n: 3, kind: 'circle', x: 19.8, y: 94.1, w: 15.6, h: 7.65, caption: 'Generate. Each model takes a few minutes; you can leave the page.' },
    ],
  },
  {
    id: 'save',
    title: '2. Review and save',
    intro: 'Check each model, then save it. Saving adds try-on to its product.',
    image: { src: '/tutorial/review.png', alt: 'A generated model ready to review', width: 1280, height: 544 },
    marks: [
      { n: 1, kind: 'circle', x: 55.16, y: 30.5, w: 10.94, h: 9.93, caption: 'Expand for a large view: drag to rotate, scroll or pinch to zoom.' },
      { n: 2, kind: 'box', x: 14.38, y: 86.76, w: 7.97, h: 7.35, caption: 'Save model. Free models left are shown at the top of the Models page.' },
      { n: 3, kind: 'arrow', x: 46.9, y: 79, toX: 35.2, toY: 89.7, caption: 'Not right? Try again (3 free retries) or Discard.' },
    ],
  },
  {
    id: 'turn-on',
    title: '3. Turn on try-on in your store',
    intro: 'One switch adds the Try on button to every product with a model.',
    image: { src: '/tutorial/turn-on.png', alt: 'The theme editor with the AR Try-on app embed switched on', width: 1536, height: 674 },
    marks: [
      { n: 1, kind: 'circle', x: 9.96, y: 29.08, w: 19.53, h: 8.31, caption: 'AR Try-on is already switched on under App embeds.' },
      { n: 2, kind: 'arrow', x: 85.94, y: 25.22, toX: 93.75, toY: 6.68, caption: 'Click Save. That is the only step in the theme editor.' },
    ],
  },
  {
    id: 'check',
    title: '4. Check your store',
    intro: 'Open a product with a model. The Try on button sits under Add to cart.',
    image: { src: '/tutorial/storefront.png', alt: 'A product page with the Try on button under Add to cart', width: 1536, height: 674 },
    marks: [
      { n: 1, kind: 'box', x: 65.43, y: 69.44, w: 30.79, h: 9.79, caption: 'The Try on button opens the camera try-on.' },
      { n: 2, kind: 'arrow', x: 57.29, y: 37.09, toX: 65.43, toY: 46, caption: 'It sits under Add to cart on every product with a model.' },
    ],
  },
]

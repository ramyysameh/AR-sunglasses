export default function HelpPage() {
  return (
    <s-page heading="Help">
      <s-section heading="The glasses look too small or too large">
        <s-paragraph>
          Open your theme editor, select the AR Try-On block on the product page,
          and adjust Glasses size. 1 is the natural fit; try around 1.6 if they
          look small. The change applies to every product using that block.
        </s-paragraph>
      </s-section>

      <s-section heading="The Try on button doesn't appear">
        <s-paragraph>
          Two things have to be true. The product needs try-on added on the{' '}
          <s-link href="/app/products">Products</s-link> page, and the AR Try-On
          block needs to be on your product template in the theme editor. A
          product with no model stays hidden on purpose.
        </s-paragraph>
      </s-section>

      <s-section heading="The camera doesn't start">
        <s-paragraph>
          The shopper&apos;s browser asks for camera permission the first time.
          If they dismissed it, they&apos;ll need to allow the camera for your
          store in their browser settings. The camera also needs a secure
          connection, which your storefront already uses.
        </s-paragraph>
        <s-paragraph>
          Face tracking runs entirely in the shopper&apos;s browser. No photo or
          video is uploaded or stored.
        </s-paragraph>
      </s-section>

      <s-section heading="Preparing a model">
        <s-paragraph>
          Models are .glb files up to 25 MB. The app measures frame width, hinge
          points and lens placement from the geometry when you upload, so no
          manual setup is needed. A model marked Check fit still works, but it&apos;s
          worth previewing before you rely on it.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Resources">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/privacy" target="_blank">Privacy policy</s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="mailto:ramy.sameh2@gmail.com">Contact support</s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  )
}

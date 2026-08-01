export default function HelpPage() {
  return (
    <s-page heading="Help">
      <s-section heading="Setting up try-on for a product">
        <s-ordered-list>
          <s-list-item>
            Upload a calibrated GLB model on the{" "}
            <s-link href="/app/models">Models</s-link> page.
          </s-list-item>
          <s-list-item>Map the model to the product it belongs to.</s-list-item>
          <s-list-item>
            In the theme editor, open the product page template and add the
            &quot;AR Try-On&quot; block. The try-on engine URL is pre-filled by
            default -- leave it as-is unless you&apos;re self-hosting.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="Model requirements">
        <s-paragraph>
          Models must be uploaded as .glb files. The app validates and
          calibrates each model automatically -- frame width, hinge points,
          and lens placement are measured from the geometry. A model with low
          calibration confidence can still be used, but fit accuracy may need
          manual review.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Resources">
        <s-unordered-list>
          <s-list-item>
            <s-link href="/privacy" target="_blank">
              Privacy policy
            </s-link>
          </s-list-item>
          <s-list-item>
            <s-link href="mailto:ramy.sameh2@gmail.com">
              Contact support
            </s-link>
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

/**
 * Public privacy policy. Deliberately outside the `app.` route prefix so it
 * bypasses embedded auth -- the App Store listing needs a URL reachable by
 * anyone, and Shopify's reviewers check that it resolves.
 */
export const meta = () => [{ title: "Privacy Policy — AR Try-on" }];

const UPDATED = "22 July 2026";
const CONTACT = "ramy.sameh2@gmail.com";

export default function Privacy() {
  return (
    <main style={{ maxWidth: "42rem", margin: "0 auto", padding: "2rem 1.5rem", lineHeight: 1.6, fontFamily: "system-ui, sans-serif" }}>
      <h1>Privacy Policy</h1>
      <p><em>Last updated: {UPDATED}</em></p>

      <h2>Camera and face data</h2>
      <p>
        AR Try-on renders eyewear on your face using your device camera. All face
        tracking runs entirely in your browser, on your device. The camera feed is
        never transmitted to our servers, never recorded, and never stored. No
        image, video frame, or biometric template of your face leaves your device
        at any point.
      </p>
      <p>
        When you close the try-on view, the camera stops and nothing about your
        face persists anywhere.
      </p>

      <h2>What we store</h2>
      <p>We store only data belonging to the merchant operating the store:</p>
      <ul>
        <li>The store&rsquo;s myshopify domain.</li>
        <li>
          Authentication credentials and the name and email of the staff member
          who installed the app, supplied by Shopify during installation.
        </li>
        <li>3D eyewear models uploaded by the merchant, and their fit measurements.</li>
        <li>Which model is shown on which product.</li>
      </ul>
      <p>
        We store no data about shoppers. We do not track visitors, log try-on
        sessions, or build profiles.
      </p>

      <h2>Retention and deletion</h2>
      <p>
        Uninstalling the app immediately revokes our access to the store.
        Shopify then sends us a data-erasure request approximately 48 hours
        later, at which point all remaining store data is permanently deleted.
        This includes uploaded models and their stored files.
      </p>

      <h2>Service providers</h2>
      <p>
        We use Vercel (application hosting), Neon (database), and Amazon Web
        Services S3 (storage of merchant-uploaded models). Merchant data as
        described above is processed by these providers on our behalf. No shopper
        or camera data is sent to any of them, because none is ever collected.
      </p>

      <h2>Your rights</h2>
      <p>
        Under the GDPR and similar laws you may request access to, correction of,
        deletion of, or a portable copy of your personal data. Contact us at{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will respond within 30
        days. Shoppers who submit a request through Shopify should note that we
        hold no shopper data to return or erase.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about this policy: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>
      </p>
    </main>
  );
}

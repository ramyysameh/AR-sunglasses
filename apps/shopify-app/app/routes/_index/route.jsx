import { redirect } from "react-router";
import styles from "./styles.module.css";

const APP_STORE_URL = "https://apps.shopify.com";
const SUPPORT_EMAIL = "zendolabs@gmail.com";

const FEATURES = [
  {
    title: "Live camera try-on",
    body: "Shoppers see your frames on their own face, tracked in real time, before they buy.",
  },
  {
    title: "Nothing is stored",
    body: "Face tracking runs entirely in the shopper's browser. No photos or video are uploaded or saved.",
  },
  {
    title: "Set up in minutes",
    body: "Upload a model, map it to a product, and add one block in the theme editor.",
  },
];

export const meta = () => [
  { title: "AR Try-on for Shopify" },
  {
    name: "description",
    content:
      "Let shoppers try on your sunglasses with their own camera, live on your product page. No photos stored, no app for shoppers to install.",
  },
];

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // A merchant arriving from the admin always carries ?shop -- send them into
  // the embedded app rather than showing them this marketing page.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function Index() {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <header className={styles.hero}>
          <p className={styles.eyebrow}>Shopify app</p>
          <h1 className={styles.heading}>Try sunglasses on, right on the product page</h1>
          <p className={styles.tagline}>
            AR Try-on lets your shoppers see your frames on their own face, live
            through their camera — no downloads, no uploads, no guesswork about fit.
          </p>
          <a className={styles.cta} href={APP_STORE_URL} target="_blank" rel="noreferrer">
            Get it on the Shopify App Store
          </a>
        </header>

        <ul className={styles.features}>
          {FEATURES.map((feature) => (
            <li key={feature.title} className={styles.feature}>
              <strong className={styles.featureTitle}>{feature.title}</strong>
              <p className={styles.featureBody}>{feature.body}</p>
            </li>
          ))}
        </ul>

        <footer className={styles.footer}>
          <a href="/privacy">Privacy policy</a>
          <span aria-hidden="true">·</span>
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
        </footer>
      </div>
    </div>
  );
}

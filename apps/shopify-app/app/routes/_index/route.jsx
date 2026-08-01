import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>AR Try-on</h1>
        <p className={styles.text}>
          Let shoppers try on sunglasses with their own camera, in real time,
          directly on your product page.
        </p>
        <p className={styles.text}>
          Install this app from the{" "}
          <a
            href="https://apps.shopify.com"
            target="_blank"
            rel="noreferrer"
          >
            Shopify App Store
          </a>{" "}
          to add it to your store.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Live camera try-on.</strong> Shoppers see the glasses on
            their own face, tracked in real time, before they buy.
          </li>
          <li>
            <strong>No photos stored.</strong> Face tracking runs entirely in
            the shopper&apos;s browser -- nothing is uploaded or saved.
          </li>
          <li>
            <strong>Simple setup.</strong> Upload a model, map it to a
            product, and add one block in the theme editor.
          </li>
        </ul>
      </div>
    </div>
  );
}

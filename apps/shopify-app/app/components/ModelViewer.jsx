// app/components/ModelViewer.jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useRef, useState } from "react";

export default function ModelViewer({ src, alt = "3D model preview" }) {
  const holderRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  // Mount only when scrolled near the viewport (long lists stay fast).
  useEffect(() => {
    const el = holderRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  // Client-only dynamic import — never runs during SSR.
  useEffect(() => {
    if (!visible || ready) return;
    let cancelled = false;
    import("@google/model-viewer").then(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [visible, ready]);

  return (
    <div ref={holderRef} style={{ width: "100%", height: "160px" }}>
      {ready ? (
        <model-viewer
          src={src}
          alt={alt}
          camera-controls
          disable-zoom
          style={{ width: "100%", height: "100%", backgroundColor: "transparent" }}
        ></model-viewer>
      ) : (
        <s-stack direction="block" alignItems="center" justifyContent="center">
          <s-spinner accessibilityLabel="Loading 3D preview"></s-spinner>
        </s-stack>
      )}
    </div>
  );
}

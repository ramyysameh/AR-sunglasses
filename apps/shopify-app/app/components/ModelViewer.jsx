// app/components/ModelViewer.jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useRef, useState } from "react";

/** model-viewer's zoom() takes "key presses": positive zooms in. */
export function zoomStep(direction) {
  return direction === "in" ? 1 : -1;
}

const controlStyle = {
  width: "32px",
  height: "32px",
  border: "1px solid #d4d4d4",
  borderRadius: "8px",
  background: "#fff",
  font: "inherit",
  fontSize: "16px",
  lineHeight: "1",
  cursor: "pointer",
};

export default function ModelViewer({ src, alt = "3D model preview", height = 160, controls = false }) {
  const holderRef = useRef(null);
  const viewerRef = useRef(null);
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

  function zoom(direction) {
    const viewer = viewerRef.current;
    if (viewer && typeof viewer.zoom === "function") viewer.zoom(zoomStep(direction));
  }

  function reset() {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.cameraOrbit = "auto auto auto";
    viewer.fieldOfView = "auto";
    if (typeof viewer.jumpCameraToGoal === "function") viewer.jumpCameraToGoal();
  }

  return (
    <div ref={holderRef} style={{ position: "relative", width: "100%", height: `${height}px` }}>
      {ready ? (
        <model-viewer
          ref={viewerRef}
          src={src}
          alt={alt}
          camera-controls
          style={{ width: "100%", height: "100%", backgroundColor: "transparent" }}
        ></model-viewer>
      ) : (
        <s-stack direction="block" alignItems="center" justifyContent="center">
          <s-spinner accessibilityLabel="Loading 3D preview"></s-spinner>
        </s-stack>
      )}
      {controls && (
        <div style={{ position: "absolute", right: "8px", bottom: "8px", display: "flex", gap: "6px" }}>
          <button type="button" aria-label="Zoom in" style={controlStyle} onClick={() => zoom("in")}>+</button>
          <button type="button" aria-label="Zoom out" style={controlStyle} onClick={() => zoom("out")}>−</button>
          <button type="button" aria-label="Reset view" style={controlStyle} onClick={reset}>↺</button>
        </div>
      )}
    </div>
  );
}

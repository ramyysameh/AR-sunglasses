// app/components/ModelViewer.jsx
/* eslint-disable react/prop-types -- plain JSX component, no PropTypes lib in use elsewhere */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** ExpandedViewer renders the large preview overlay content (testable with renderToStaticMarkup). */
export function ExpandedViewer({ src, alt, ready, canFullscreen, onClose, onFullscreen, closeButtonRef }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1000,
        backgroundColor: "white",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px", borderBottom: "1px solid #eee" }}>
        <strong>{alt}</strong>
        <div style={{ display: "flex", gap: "8px" }}>
          {canFullscreen && (
            <button
              type="button"
              aria-label="Full screen"
              onClick={onFullscreen}
              style={{ padding: "8px 12px", cursor: "pointer", border: "1px solid #d4d4d4", borderRadius: "4px", background: "#fff" }}
            >
              Full screen
            </button>
          )}
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close large preview"
            onClick={onClose}
            style={{ padding: "8px 12px", cursor: "pointer", border: "1px solid #d4d4d4", borderRadius: "4px", background: "#fff" }}
          >
            Close
          </button>
        </div>
      </div>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {ready ? (
          <model-viewer
            src={src}
            alt={alt}
            camera-controls
            style={{ width: "100%", height: "100%", backgroundColor: "transparent" }}
          ></model-viewer>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
            <s-spinner accessibilityLabel="Loading 3D preview"></s-spinner>
          </div>
        )}
      </div>
      {ready && (
        <div style={{ textAlign: "center", padding: "12px", fontSize: "14px", color: "#666" }}>
          Drag to rotate. Scroll or pinch to zoom.
        </div>
      )}
    </div>
  );
}

export default function ModelViewer({ src, alt = "3D model preview", height = 160, expandable = false }) {
  const holderRef = useRef(null);
  const expandButtonRef = useRef(null);
  const overlayRef = useRef(null);
  const closeButtonRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const prevOverflowRef = useRef(null);

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

  const close = () => {
    setExpanded(false);
    expandButtonRef.current?.focus();
    // Restore scroll lock
    if (typeof document !== "undefined" && prevOverflowRef.current !== null) {
      document.body.style.overflow = prevOverflowRef.current;
      prevOverflowRef.current = null;
    }
  };

  // Handle Esc key to close expanded view.
  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        close();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [expanded]);

  // Lock scroll when expanded, move focus to Close button.
  useEffect(() => {
    if (!expanded) return;
    if (typeof document !== "undefined") {
      prevOverflowRef.current = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      closeButtonRef.current?.focus();
    }
    return () => {
      if (typeof document !== "undefined" && prevOverflowRef.current !== null) {
        document.body.style.overflow = prevOverflowRef.current;
        prevOverflowRef.current = null;
      }
    };
  }, [expanded]);

  const canFullscreen = typeof document !== "undefined" && Boolean(document.fullscreenEnabled);

  const handleFullscreen = () => {
    if (overlayRef.current?.requestFullscreen) {
      overlayRef.current.requestFullscreen().catch(() => {});
    }
  };

  return (
    <>
      <div ref={holderRef} style={{ position: "relative", width: "100%", height: `${height}px` }}>
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
        {expandable && (
          <button
            ref={expandButtonRef}
            type="button"
            aria-label="Open large preview"
            onClick={() => setExpanded(true)}
            style={{
              position: "absolute",
              top: "8px",
              right: "8px",
              padding: "6px 12px",
              background: "#fff",
              border: "1px solid #d4d4d4",
              borderRadius: "4px",
              cursor: "pointer",
              fontSize: "16px",
            }}
          >
            ⤢ Expand
          </button>
        )}
      </div>
      {expanded && typeof document !== "undefined" &&
        createPortal(
          <div ref={overlayRef}>
            <ExpandedViewer
              src={src}
              alt={alt}
              ready={ready}
              canFullscreen={canFullscreen}
              onClose={close}
              onFullscreen={handleFullscreen}
              closeButtonRef={closeButtonRef}
            />
          </div>,
          document.body
        )}
    </>
  );
}

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { sandboxedPage } from "../shared/website";

// A generated page in a sandbox: scripts run, but with an opaque origin and
// no same-origin access, popups, forms or top-level navigation.
export function WebsiteFrame({ page, title, className = "website-frame", preview = false, style }: {
  page: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  // A thumbnail ignores the pointer, so the bubble stays draggable.
  preview?: boolean;
}) {
  const document = useMemo(() => sandboxedPage(page), [page]);
  return (
    <iframe
      className={className}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={document}
      loading="lazy"
      style={style}
      {...(preview ? { tabIndex: -1, "aria-hidden": true } : {})}
    />
  );
}

const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;

// A desktop-width page scaled down to fit a bubble.
export function WebsiteThumbnail({ page }: { page: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.35);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth) setScale(element.clientWidth / PAGE_WIDTH); };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  return (
    <figure className="website-thumbnail">
      <div ref={box} className="website-thumbnail-box" style={{ height: PAGE_HEIGHT * scale }}>
        <WebsiteFrame page={page} title="Website preview" className="website-thumbnail-frame" preview
          style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, transform: `scale(${scale})` }} />
      </div>
      <figcaption>Website preview · open the reader to use it</figcaption>
    </figure>
  );
}

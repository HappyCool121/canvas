import { useEffect } from "react";
import type { RefObject } from "react";
import { useReactFlow, type Viewport } from "@xyflow/react";

type Gesture = Event & { scale: number; clientX: number; clientY: number };
export function useCanvasGestures(container: RefObject<HTMLDivElement | null>, save: (viewport: Viewport) => void) {
  const flow = useReactFlow();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let native = false, start = flow.getViewport(), anchor = { x: 0, y: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelCamera = () => element.dispatchEvent(new Event("canvas-gesture-start", { bubbles: true }));
    const point = (x: number, y: number) => {
      const rect = element.getBoundingClientRect();
      return { x: Number.isFinite(x) ? x - rect.left : rect.width / 2, y: Number.isFinite(y) ? y - rect.top : rect.height / 2 };
    };
    const zoom = (from: Viewport, scale: number, p: { x: number; y: number }) => {
      const z = Math.max(.15, Math.min(1.6, from.zoom * scale));
      if (!Number.isFinite(z)) return;
      void flow.setViewport({ zoom: z, x: p.x - (p.x - from.x) * z / from.zoom, y: p.y - (p.y - from.y) * z / from.zoom });
    };
    const consume = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const begin = (event: Event) => {
      consume(event); native = true; cancelCamera();
      start = flow.getViewport(); const e = event as Gesture; anchor = point(e.clientX, e.clientY);
    };
    const change = (event: Event) => { consume(event); if (native) zoom(start, (event as Gesture).scale, anchor); };
    const end = (event: Event) => { consume(event); native = false; save(flow.getViewport()); };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      consume(event); cancelCamera();
      if (!native) { zoom(flow.getViewport(), Math.pow(2, -event.deltaY * (event.deltaMode === 1 ? .05 : .002)), point(event.clientX, event.clientY)); }
      clearTimeout(timer); timer = setTimeout(() => save(flow.getViewport()), 160);
    };
    const options = { capture: true, passive: false };
    element.addEventListener("gesturestart", begin, options);
    element.addEventListener("gesturechange", change, options);
    element.addEventListener("gestureend", end, options);
    element.addEventListener("wheel", wheel, options);
    return () => {
      clearTimeout(timer);
      element.removeEventListener("gesturestart", begin, true); element.removeEventListener("gesturechange", change, true);
      element.removeEventListener("gestureend", end, true); element.removeEventListener("wheel", wheel, true);
    };
  }, [container, flow, save]);
}

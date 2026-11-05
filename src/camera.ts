import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReactFlow, type Rect, type Viewport } from "@xyflow/react";

export type CameraRequest = { ids: string[]; first?: boolean; center?: boolean; followId?: string };

const MIN_ZOOM = 0.15;
const DURATION = 320;

function visibleAreas(graph: HTMLElement): Rect[] {
  const stage = graph.parentElement!;
  const toolbar = stage.querySelector<HTMLElement>(".topbar-layer")!;
  const panel = stage.querySelector<HTMLElement>('.reading-panel[data-open="true"]');
  const dock = stage.querySelector<HTMLElement>(".composer-dock");
  const top = toolbar.offsetTop + toolbar.offsetHeight + 52;
  const right = graph.clientWidth - 64;
  const bottom = graph.clientHeight - 16;
  const left = 16;
  const area = (x: number, y: number, endX: number, endY: number) =>
    ({ x, y, width: endX - x, height: endY - y });
  const areas: Rect[] = [];
  const panelLeft = panel ? panel.getBoundingClientRect().left - stage.getBoundingClientRect().left - 64 : right;
  areas.push(area(left, top, panelLeft, dock ? dock.getBoundingClientRect().top - stage.getBoundingClientRect().top - 12 : bottom));
  if (panel) {
    const panelBottom = panel.offsetTop + panel.offsetHeight + 52;
    areas.push(area(left, panelBottom, right, dock ? dock.getBoundingClientRect().top - stage.getBoundingClientRect().top - 12 : bottom));
  }
  return areas.filter(({ width, height }) => width > 0 && height > 0);
}

function frame(bounds: Rect, areas: Rect[], from: Viewport, center = false) {
  return areas.map((area) => {
    const zoom = Math.max(MIN_ZOOM, Math.min(from.zoom, area.width / bounds.width, area.height / bounds.height));
    const project = (position: number, size: number, start: number, space: number, translation: number) => {
      const min = start - position * zoom;
      const max = start + space - (position + size) * zoom;
      return min <= max ? Math.min(max, Math.max(min, translation)) : (min + max) / 2;
    };
    // Zoom around the visible region, then pan only far enough to fit.
    const ratio = zoom / from.zoom;
    const cx = area.x + area.width / 2;
    const cy = area.y + area.height / 2;
    const x = center ? cx - (bounds.x + bounds.width / 2) * zoom : project(bounds.x, bounds.width, area.x, area.width, cx + (from.x - cx) * ratio);
    const y = center ? cy - (bounds.y + bounds.height / 2) * zoom : project(bounds.y, bounds.height, area.y, area.height, cy + (from.y - cy) * ratio);
    return { area, viewport: { x, y, zoom }, distance: Math.hypot(x - from.x, y - from.y) };
  }).sort((a, b) => b.viewport.zoom - a.viewport.zoom || a.distance - b.distance)[0];
}

export function useCamera(
  graph: RefObject<HTMLDivElement | null>,
  request: CameraRequest | undefined,
  onViewport: (viewport: Viewport) => void,
) {
  const flow = useReactFlow();
  const active = useRef(false);
  const save = useRef(onViewport);
  save.current = onViewport;

  useLayoutEffect(() => {
    const element = graph.current;
    if (!element || !request) return;
    const stage = element.parentElement!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let raf = 0;
    let settleTimer = 0;
    let origin: Viewport | undefined;
    let start: Viewport | undefined;
    let startedAt = 0;
    let last: Viewport | undefined;
    let destination: Viewport | undefined;
    let lastFrameAt = 0;
    let settledFrames = 0;
    let observer: ResizeObserver | undefined;
    let cancelled = false;

    const stop = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settleTimer);
      active.current = false;
      delete element.dataset.camera;
    };
    const interrupt = (event: Event) => {
      if (!active.current || !(event.target instanceof Element) ||
          !event.target.closest(".flow-container, .topbar-tools, .topbar-path")) return;
      cancelled = true;
      observer?.disconnect();
      stop();
      if (last) save.current(last);
    };

    // A pending answer can grow after the transition. Keep its final measured
    // bounds in view with a minimal correction once the layout settles.
    const finishTurn = () => {
      if (element.querySelector('[data-status="pending"]') || element.dataset.layout === "running" || element.dataset.layoutReady !== "true") {
        settledFrames = 0;
        settleTimer = window.setTimeout(finishTurn, 80);
        return;
      }
      if (++settledFrames < 3) {
        raf = requestAnimationFrame(finishTurn);
        return;
      }
      const bounds = flow.getNodesBounds(request.ids);
      const fit = frame(bounds, visibleAreas(element), last!, request.center ?? request.first);
      // Prefer the completed answer while keeping the new pair clear of overlays.
      const preferred = fit && request.followId ? frame(flow.getNodesBounds([request.followId]), [fit.area], fit.viewport, true) : fit;
      const target = preferred && fit ? frame(bounds, [fit.area], preferred.viewport, false) : fit;
      if (target && (Math.hypot(target.viewport.x-last!.x,target.viewport.y-last!.y) > 0.1 || target.viewport.zoom !== last!.zoom)) {
        const from = last!, to = target.viewport;
        const began = performance.now();
        const correct = (now: number) => {
          if (cancelled) return;
          const progress = reduced.matches ? 1 : Math.min(1,(now-began)/180);
          const ease = 1-Math.pow(1-progress,3);
          last = { x:from.x+(to.x-from.x)*ease, y:from.y+(to.y-from.y)*ease, zoom:from.zoom+(to.zoom-from.zoom)*ease };
          const applied = flow.setViewport(last);
          if (progress < 1) raf=requestAnimationFrame(correct);
          else void applied.then(() => {
            if (cancelled) return;
            raf=requestAnimationFrame(() => { save.current(last!); settledFrames=0; raf=requestAnimationFrame(finishTurn); });
          });
        };
        element.dataset.camera="moving";
        raf=requestAnimationFrame(correct);
        return;
      }
      observer?.disconnect();
      stop();
    };

    const tick = (now: number) => {
      const measured = request.ids.every((id) => {
        const node = flow.getInternalNode(id);
        return node?.measured.width && node.measured.height;
      });
      const bounds = measured && flow.getNodesBounds(request.ids);
      origin ??= flow.viewportInitialized ? flow.getViewport() : undefined;
      const target = bounds && origin && frame(bounds, visibleAreas(element), origin, request.center ?? request.first);
      if (!target || !origin || !bounds) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const { viewport, area } = target;
      if (!start) {
        startedAt = now;
        start = request.first ? {
          x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * viewport.zoom,
          y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * viewport.zoom,
          zoom: viewport.zoom,
        } : origin;
      }
      // Filter live bounds on the same animation clock. Late measurements and
      // insertion ticks change the destination without restarting or jumping.
      const follow = reduced.matches ? 1 : 1-Math.exp(-Math.max(0,now-lastFrameAt)/60);
      destination = destination ? {
        x: destination.x+(viewport.x-destination.x)*follow,
        y: destination.y+(viewport.y-destination.y)*follow,
        zoom: destination.zoom+(viewport.zoom-destination.zoom)*follow,
      } : viewport;
      lastFrameAt = now;
      const tracking = Math.hypot(destination.x-viewport.x,destination.y-viewport.y) > 0.2 || Math.abs(destination.zoom-viewport.zoom) > 0.0001;
      const progress = reduced.matches ? 1 : Math.min(1, (now - startedAt) / DURATION);
      const ease = (1 - Math.cos(Math.PI * progress)) / 2;
      const mix = (from: number, to: number) => from + (to - from) * ease;
      last = progress === 1 ? destination : {
        x: mix(start.x, destination.x),
        y: mix(start.y, destination.y),
        zoom: mix(start.zoom, destination.zoom),
      };
      void flow.setViewport(last);
      element.dataset.camera = "moving";
      if (progress < 1 || tracking || element.dataset.layout === "running" || element.dataset.layoutReady !== "true" || [...stage.querySelectorAll(".reading-panel, .composer-dock")].some(node => node.getAnimations().length)) raf = requestAnimationFrame(tick);
      else {
        save.current(last);
        raf = requestAnimationFrame(finishTurn);
      }
    };

    active.current = true;
    if (request.first) element.dataset.camera = "measuring";
    stage.addEventListener("canvas-gesture-start", interrupt, true);
    stage.addEventListener("canvas-resize-start", interrupt, true);
    stage.addEventListener("pointerdown", interrupt, true);
    stage.addEventListener("wheel", interrupt, { capture: true, passive: true });
    stage.addEventListener("keydown", interrupt, true);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      observer?.disconnect();
      stop();
      stage.removeEventListener("canvas-gesture-start", interrupt, true);
      stage.removeEventListener("canvas-resize-start", interrupt, true);
      stage.removeEventListener("pointerdown", interrupt, true);
      stage.removeEventListener("wheel", interrupt, true);
      stage.removeEventListener("keydown", interrupt, true);
    };
  }, [flow, graph, request]);

  return active;
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Check,
  ChevronRight,
  CircleHelp,
  Focus,
  Home,
  Map as MapIcon,
  Minus,
  PanelLeftOpen,
  Pencil,
  Plus,
} from "lucide-react";
import type { Canvas, Message } from "../shared/types";
import { ancestorPath, rootIds, rootOf } from "../shared/graph";
import { messageTitle } from "../shared/titles";

function PathFlow({ canvas, onPick }: { canvas: Canvas; onPick: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [omitted, setOmitted] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  let path: Message[] = [];
  try { path = ancestorPath(canvas, canvas.selectedId); } catch { /* Invalid path has no navigation. */ }
  const signature = path.map((m) => `${m.id}:${messageTitle(m)}`).join("|");
  useEffect(() => { setExpanded(false); }, [canvas.selectedId]);
  useLayoutEffect(() => {
    const element = host.current, ruler = measure.current;
    if (!element || !ruler) return;
    const fit = () => {
      const widths = [...ruler.querySelectorAll<HTMLElement>(".path-step")].map((chip) => chip.offsetWidth);
      const header = element.closest<HTMLElement>(".topbar")!;
      const width = header.clientWidth;
      const title = header.querySelector<HTMLElement>(".topbar-title")!.offsetWidth;
      const tools = header.querySelector<HTMLElement>(".topbar-tools")!.offsetWidth;
      const available = Math.max(40, width <= 1100 ? width - 14 : width - 2 * Math.max(title, tools) - 38);
      element.parentElement!.style.maxWidth = `${available + 14}px`;
      let total = widths.reduce((sum, width) => sum + width, 0);
      let remove = 0;
      // Reserve the overflow control only when it is needed; always keep the selected title.
      if (total > available) {
        total += 38;
        while (remove < widths.length - 1 && total > available) total -= widths[remove++];
      }
      setOmitted(remove);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    observer.observe(ruler);
    const header = element.closest<HTMLElement>(".topbar")!;
    observer.observe(header);
    for (const group of header.querySelectorAll(".topbar-title, .topbar-tools")) observer.observe(group);
    fit();
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [signature]);
  useEffect(() => {
    if (!expanded) return;
    const close = (event: PointerEvent) => { if (!host.current?.contains(event.target as globalThis.Node)) setExpanded(false); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [expanded]);
  const chip = (item: Message, index: number) => <span className="path-step" key={item.id}>
    {index > 0 && <ChevronRight size={12} className="path-arrow" />}
    <button className={`path-chip ${item.role} ${item.id === canvas.selectedId ? "current" : ""}`} title={messageTitle(item)} aria-current={item.id === canvas.selectedId ? "step" : undefined} onClick={() => { onPick(item.id); setExpanded(false); }}>
      <span className="chip-dot" />{item.editOf && <Pencil size={10} />}<span>{messageTitle(item)}</span>
    </button>
  </span>;
  return <div className="path-container" ref={host} onKeyDown={(event) => {
    if (event.key === "Escape" && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
  }}>
    <div className="path-measure" ref={measure} aria-hidden="true" inert>{path.map(chip)}</div>
    <nav className="path-flow" aria-label="Selected path">
      {omitted > 0 && <button className="path-chip more" aria-label={`Show ${omitted} hidden steps`} aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>…</button>}
      {path.slice(omitted).map((item, index) => chip(item, index + (omitted ? 1 : 0)))}
    </nav>
    {expanded && <nav className="path-overflow" aria-label="Omitted ancestors">{path.slice(0, omitted).map((item) => <button key={item.id} onClick={() => { onPick(item.id); setExpanded(false); }}>{messageTitle(item)}</button>)}</nav>}
  </div>;
}

export function TopBar({
  canvas,
  empty,
  sidebarCollapsed,
  onShowSidebar,
  onSelect,
  minimap,
  onMinimap,
}: {
  canvas: Canvas;
  empty: boolean;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  onSelect: (id: string) => void;
  minimap: boolean;
  onMinimap: () => void;
}) {
  const flow = useReactFlow();
  const lastPath = useRef(canvas);
  if (canvas.selectedId) lastPath.current = canvas;
  const pathCanvas = canvas.selectedId ? canvas : lastPath.current;
  const [help, setHelp] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = layer.current;
    if (!element) return;
    const update = () => element.parentElement!.style.setProperty("--panel-top", `${element.offsetTop + element.offsetHeight + 12}px`);
    const observer = new ResizeObserver(update);
    observer.observe(element); update();
    return () => observer.disconnect();
  }, []);

  return (
    <div className="topbar-layer" ref={layer}>
      <header className="topbar">
        <div className="topbar-group topbar-title">
          {sidebarCollapsed && (
            <button
              className="icon-button"
              aria-label="Show sidebar"
              title="Show sidebar"
              onClick={onShowSidebar}
            >
              <PanelLeftOpen size={17} />
            </button>
          )}
          <strong title={canvas.title}>{canvas.title}</strong>
        </div>
        {!empty && (
          <div className="topbar-group topbar-path" data-visible={!!canvas.selectedId} inert={!canvas.selectedId} aria-hidden={!canvas.selectedId}>
            <PathFlow canvas={pathCanvas} onPick={onSelect} />
          </div>
        )}
        <div className="topbar-group topbar-tools">
          {!empty && (
            <>
              <button
                className="icon-button"
                aria-label="zoom out"
                title="Zoom out"
                onClick={() => void flow.zoomOut({ duration: 200 })}
              >
                <Minus size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="zoom in"
                title="Zoom in"
                onClick={() => void flow.zoomIn({ duration: 200 })}
              >
                <Plus size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Fit to view"
                title="Show the whole conversation"
                onClick={() =>
                  void flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 })
                }
              >
                <Focus size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Go to root"
                title="Go to the root of this branch"
                onClick={() => {
                  // The selected branch's own root, else the first root.
                  const root = (canvas.selectedId && rootOf(canvas, canvas.selectedId)) || rootIds(canvas)[0];
                  if (root) onSelect(root);
                }}
              >
                <Home size={16} />
              </button>
              <button
                className="icon-button"
                aria-label="Minimap"
                aria-pressed={minimap}
                title={minimap ? "Hide the minimap" : "Show the minimap"}
                onClick={onMinimap}
              >
                <MapIcon size={16} />
              </button>
              <span className="topbar-divider" />
            </>
          )}
          <button
            className="icon-button"
            aria-label="Canvas help"
            title="Help"
            onClick={() => setHelp((v) => !v)}
          >
            <CircleHelp size={16} />
          </button>
        </div>
      </header>
      {help && (
        <div className="help-popover">
          <strong>A little room to explore.</strong>
          <p>
            Click a bubble to read it and continue from there. The first
            follow-up uses nearby space; alternatives branch from the same parent.
            Click empty canvas or press Escape to clear selection.
          </p>
          <p>
            Shift + drag empty canvas to select intersecting bubbles. Shift + click
            toggles a bubble in the group. Drag any selected bubble to move the group.
            Group selection keeps your reader and reply target. Scroll to pan, pinch or use
            − / + to zoom. Edit a prompt from the reading panel to rewrite it.
          </p>
          <p>
            The scissors on a selected bubble branch off: continue here as a new root, or
            copy the branch to a new chat. The map button shows numbered roots. Expand the
            reading panel from its top-left corner to chat with the selected branch.
          </p>
          <button onClick={() => setHelp(false)}>
            Got it <Check size={13} />
          </button>
        </div>
      )}
    </div>
  );
}

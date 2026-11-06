import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  NodeToolbar,
  NodeResizeControl,
  useReactFlow,
  useUpdateNodeInternals,
  BackgroundVariant,
  Handle,
  Position,
  ReactFlow,
  useNodesState,
  applyNodeChanges,
  SelectionMode,
  type NodeChange,
  type Edge,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import { Palette, Minimize2, Maximize2, RotateCcw } from "lucide-react";
import { CHATGPT_PLAN, CHATGPT_USAGE_URL } from "../shared/models";
import type { Canvas, Message } from "../shared/types";
import { ancestorPath, automaticOffset, CARD_WIDTH, linkKind, visualParent } from "../shared/graph";
import { messageTitle, BUBBLE_COLORS } from "../shared/titles";
import { Markdown } from "./Markdown";
import { Thumbnail } from "./images";
import { useCanvasGestures } from "./gestures";
import { useCamera, type CameraRequest } from "./camera";
import { useForceLayout, type LayoutItem } from "./physics";

type Rectangle = { x: number; y: number; width: number; height: number };
type ResizePhase = "start" | "move" | "end";
type Point = { x: number; y: number };
type MessageData = {
  message: Message;
  onRetry: (id: string) => void;
  onPlanSettings: (profileId?: string, reconsent?: boolean) => void;
  onPlanReroute: (id: string) => void;
  generating: boolean;
  multiple: boolean;
  onResize: (id: string, rect: Rectangle, phase: ResizePhase) => void;
  onAppearance: (id: string, patch: Pick<Message, "color" | "displayMode">) => void;
};
type MessageNodeType = Node<MessageData, "message">;

const MessagePreview = memo(function MessagePreview({ content, prompt }: { content: string; prompt: boolean }) {
  const preview = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = preview.current;
    if (element) setClipped(element.scrollHeight > element.clientHeight + 1);
  }, [content]);
  return (
    <div
      ref={preview}
      className={`bubble-preview ${prompt ? "prompt-preview" : ""} ${clipped ? "clipped" : ""}`}
    >
      <Markdown content={content} />
    </div>
  );
});

// Hidden anchors so edges can leave and enter a bubble on any side.
function Anchors({
  type,
  sides,
}: {
  type: "source" | "target";
  sides: Position[];
}) {
  return sides.map((side) => (
    <Handle
      key={side}
      id={`${type === "source" ? "s" : "t"}-${side}`}
      type={type}
      position={side}
      isConnectable={false}
    />
  ));
}

// Today: "4:12 PM"; this year: "2 Nov, 4:12 PM"; otherwise with the year.
export function formatTime(timestamp: number, now = new Date()) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return time;
  const day = date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${day}, ${time}`;
}

const MessageNode = memo(function MessageNode({ data, selected }: NodeProps<MessageNodeType>) {
  const flow = useReactFlow<MessageNodeType>();
  const controls = selected && !data.multiple;
  const [shown, setShown] = useState(false);
  const [present, setPresent] = useState(false);
  useEffect(() => {
    if (!controls && !present) return;
    if (controls) setPresent(true);
    const frame = requestAnimationFrame(() => setShown(!!controls));
    const timer = controls ? undefined : window.setTimeout(() => setPresent(false), 540);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [controls]);
  const [swatches, setSwatches] = useState(false);
  const updateInternals = useUpdateNodeInternals();
  const { message: m } = data;
  const assistant = m.role === "assistant";
  const mode = m.displayMode || "preview";
  useLayoutEffect(() => { updateInternals(m.id); }, [m.id, mode, updateInternals]);
  useEffect(() => { if (!controls) setSwatches(false); }, [controls]);
  const size = m.sizes?.[mode];
  const time = m.completedAt ?? m.createdAt;
  return (
    <article
      onClick={event => { if ((event.target as Element).closest("a, button, input, textarea")) event.stopPropagation(); }}
      data-message-id={m.id}
      data-role={m.role}
      data-status={m.status}
      data-display-mode={mode}
      data-manual-size={!!size}
      style={{ ...(size ? { width: size.width, height: size.height } : {}), ...(!size && assistant && mode !== "compact" ? { width: CARD_WIDTH } : {}), ...(m.color ? { background: BUBBLE_COLORS[m.color] } : {}) }}
      className={`bubble ${assistant ? "answer" : "prompt"} ${m.images?.length ? "with-images" : ""} ${selected ? "selected" : ""}`}
    >
      <Anchors
        type="target"
        sides={[Position.Top, Position.Bottom, Position.Left, Position.Right]}
      />
      {controls && (["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((corner) => <NodeResizeControl
        key={corner} position={corner} minWidth={160} minHeight={72}
        className={`corner-resize ${corner}`} autoScale
        onResizeStart={(_event, rect) => data.onResize(m.id, rect, "start")}
        onResize={(_event, rect) => data.onResize(m.id, rect, "move")}
        onResizeEnd={(_event, rect) => data.onResize(m.id, rect, "end")}
      ><button className="resize-key nodrag nopan" aria-label={`Resize ${corner} corner. Arrow keys; Shift for larger steps`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const node = flow.getNode(m.id);
          if (!node) return;
          const currentSize = node.data.message.sizes?.[mode] || node.measured;
          if (!currentSize?.width || !currentSize.height) return;
          const step = event.shiftKey ? 32 : 8;
          const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
          const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
          const left = corner.includes("left"), top = corner.includes("top");
          const width = Math.max(160, currentSize.width + (left ? -dx : dx));
          const height = Math.max(72, currentSize.height + (top ? -dy : dy));
          const rect = { x: node.position.x + (left ? currentSize.width - width : 0), y: node.position.y + (top ? currentSize.height - height : 0), width, height };
          data.onResize(m.id, rect, "start"); data.onResize(m.id, rect, "end");
        }}><span aria-hidden="true" /></button></NodeResizeControl>)}
      <NodeToolbar isVisible={!data.multiple && (!!controls || present)} position={Position.Top} align="end" offset={0}>
        <div data-visible={!!controls && shown} inert={!controls} aria-hidden={!controls} className="bubble-controls nodrag nopan" role="toolbar" aria-label="Bubble appearance" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => {
          if (e.key === "Escape" && swatches) { e.preventDefault(); e.stopPropagation(); setSwatches(false); }
        }}>
          <button className="bubble-control color-control" aria-label="Bubble color" aria-expanded={swatches} onClick={() => setSwatches((v) => !v)}><Palette size={15} /></button>
          <button className="bubble-control compact-control" aria-label="Compact bubble" aria-pressed={mode === "compact"} onClick={() => data.onAppearance(m.id, { displayMode: mode === "compact" ? "preview" : "compact" })}><Minimize2 size={15} /></button>
          <button className="bubble-control expand-control" aria-label="Expand bubble" aria-pressed={mode === "expanded"} onClick={() => data.onAppearance(m.id, { displayMode: mode === "expanded" ? "preview" : "expanded" })}><Maximize2 size={15} /></button>
          {swatches && <div className="bubble-swatches" role="group" aria-label="Bubble colors">
            {Object.entries(BUBBLE_COLORS).map(([color, value]) => <button key={color} style={{ background: value }} aria-label={`${color.replace("-", " ")} bubble`} aria-pressed={m.color === color} onClick={() => { data.onAppearance(m.id, { color: color as Message["color"] }); setSwatches(false); }} />)}
            <button aria-label="Reset bubble color" onClick={() => { data.onAppearance(m.id, { color: undefined }); setSwatches(false); }}><RotateCcw size={13} /></button>
          </div>}
        </div>
      </NodeToolbar>
      <div className={`bubble-content ${size ? "nodrag nowheel" : ""}`}>
      {mode === "compact" ? <strong className="bubble-title">{messageTitle(m)}</strong> : <>
      {m.images?.length ? (
        <div className="bubble-images">
          {m.images.slice(0, 4).map((image) => (
            <Thumbnail key={image.id} image={image} />
          ))}
        </div>
      ) : null}
      {(m.images?.length ?? 0) > 4 && <span className="attachment-count">{m.images!.length} attachments · open reader to view all</span>}
      {m.status === "pending" ? (
        <div className="typing" role="status" aria-label="Writing an answer">
          <span />
          <span />
          <span />
        </div>
      ) : m.status === "error" || m.status === "interrupted" ? (
        <div className="bubble-error">
          <strong>
            {m.status === "interrupted"
              ? "Request interrupted"
              : "A small interruption"}
          </strong>
          <p>{m.error}</p>
          {m.provider === CHATGPT_PLAN && m.errorCode === "chatgpt_plan_limit" &&
            <a className="nodrag plan-error-action" href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a>}
          {m.provider === CHATGPT_PLAN && ["chatgpt_plan_consent", "chatgpt_plan_revoked"].includes(m.errorCode ?? "") &&
            <button type="button" className="nodrag plan-error-action" onClick={event => {
              event.stopPropagation();
              data.onPlanSettings(m.profileId, m.errorCode === "chatgpt_plan_consent");
            }}>{m.errorCode === "chatgpt_plan_consent" ? "Enable plan usage" : "Sign in again"}</button>}
          <button
            className="nodrag"
            disabled={data.generating}
            onClick={(e) => {
              e.stopPropagation();
              data.onRetry(m.id);
            }}
          >
            <RotateCcw size={13} /> Retry answer
          </button>
          {m.provider === CHATGPT_PLAN && <button type="button" className="nodrag plan-error-action" disabled={data.generating}
            onClick={event => {
              event.stopPropagation();
              data.onPlanReroute(m.id);
            }}>Change retry route</button>}
        </div>
      ) : m.content ? (
        mode === "expanded" ? <div className="bubble-full nodrag nowheel"><Markdown content={m.content} /></div> : <MessagePreview content={m.content} prompt={!assistant} />
      ) : null}
      {m.truncated && (
        <small className="bubble-note">Output limit reached</small>
      )}
      </>}
      </div>
      {mode !== "compact" && m.status !== "pending" && (
        <time
          className="bubble-time"
          dateTime={new Date(time).toISOString()}
          title={new Date(time).toLocaleString()}
        >
          {formatTime(time)}
        </time>
      )}
      <Anchors
        type="source"
        sides={[Position.Bottom, Position.Top, Position.Left, Position.Right]}
      />
    </article>
  );
});
const nodeTypes = { message: MessageNode };

type Props = {
  canvas: Canvas;
  camera?: CameraRequest;
  onGeometry: (rectangles: Record<string, import("../shared/graph").PlacementRect>) => void;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  onGroupSelection: (active: boolean) => void;
  onRetry: (id: string) => void;
  onPlanSettings: (profileId?: string, reconsent?: boolean) => void;
  onPlanReroute: (id: string) => void;
  onAppearance: MessageData["onAppearance"];
  onResize: (id: string, size: { width: number; height: number }, position: Point, offset?: Point) => void;
  onLayout: (positions: Map<string, Point>, rebase?: boolean) => void;
  onDrop: (positions: Map<string, Point>, offsets: Map<string, Point>) => void;
  onViewport: (viewport: Viewport) => void;
};

export function Graph({
  canvas,
  camera,
  onGeometry,
  onSelect,
  onDeselect,
  onGroupSelection,
  onRetry,
  onPlanSettings,
  onPlanReroute,
  onAppearance,
  onResize,
  onLayout,
  onDrop,
  onViewport,
}: Props) {
  const callbacks = useRef({ onResize, onRetry, onPlanSettings, onPlanReroute, onAppearance, onSelect, onDeselect, onDrop, onViewport, onGroupSelection });
  callbacks.current = { onResize, onRetry, onPlanSettings, onPlanReroute, onAppearance, onSelect, onDeselect, onDrop, onViewport, onGroupSelection };
  const retry = useCallback((id: string) => callbacks.current.onRetry(id), []);
  const planSettings = useCallback<MessageData["onPlanSettings"]>((...args) => callbacks.current.onPlanSettings(...args), []);
  const planReroute = useCallback((id: string) => callbacks.current.onPlanReroute(id), []);
  const appearance = useCallback<MessageData["onAppearance"]>((id, patch) => callbacks.current.onAppearance(id, patch), []);
  const container = useRef<HTMLDivElement>(null);
  const saveGesture = useCallback((v: Viewport) => callbacks.current.onViewport(v), []);
  useCanvasGestures(container, saveGesture);
  const framing = useCamera(container, camera, onViewport);
  const initial = useRef(true);
  const pointer = useRef<Point | null>(null);
  const [group, setGroup] = useState(() => new Set(canvas.selectedId ? [canvas.selectedId] : []));
  const membership = useRef(group);
  const [groupMode, setGroupMode] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const selectGroup = useCallback((ids: Set<string>) => {
    membership.current = ids;
    setGroup(ids);
  }, []);
  useLayoutEffect(() => {
    callbacks.current.onGroupSelection(groupMode);
    return () => callbacks.current.onGroupSelection(false);
  }, [groupMode]);
  // Saved messages/physics never own temporary membership. Only an actual
  // active-target change (including reload/canvas switch) resets the group.
  useLayoutEffect(() => {
    selectGroup(new Set(canvas.selectedId ? [canvas.selectedId] : []));
    setGroupMode(false);
  }, [canvas.selectedId, selectGroup]);
  useEffect(() => {
    const clear = () => { selectGroup(new Set()); setGroupMode(false); setSelecting(false); };
    const stage = container.current?.parentElement;
    stage?.addEventListener("canvas-clear-selection", clear);
    return () => stage?.removeEventListener("canvas-clear-selection", clear);
  }, [selectGroup]);
  // Measure bubbles in their final font, so a late font can't reflow the map.
  const [fontsReady, setFontsReady] = useState(
    () => !document.fonts || document.fonts.status === "loaded",
  );
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);
  const generating = canvas.messages.some((m) => m.status === "pending");
  const byId = useMemo(
    () => new Map(canvas.messages.map((m) => [m.id, m])),
    [canvas.messages],
  );
  const kinds = useMemo(
    () => new Map(canvas.messages.map((m) => [m.id, linkKind(canvas, m)])),
    // linkKind depends only on the messages.
    [canvas.messages],
  );
  // The selected path, plus any prompts an edited prompt visually hangs from.
  const onPath = useMemo(() => {
    const ids = new Set<string>();
    try {
      for (const message of ancestorPath(canvas, canvas.selectedId)) {
        ids.add(message.id);
        let original = message.editOf;
        while (original && !ids.has(original)) {
          ids.add(original);
          original = byId.get(original)?.editOf;
        }
      }
    } catch {
      return ids;
    }
    return ids;
  }, [byId, canvas.selectedId]);

  const resizeHandler = useRef<MessageData["onResize"]>(() => {});
  const resize = useCallback<MessageData["onResize"]>((...args) => resizeHandler.current(...args), []);
  const messageNodes = (): MessageNodeType[] =>
    canvas.messages.map((message) => ({
      id: message.id,
      type: "message",
      position: message.position,
      style: message.sizes?.[message.displayMode || "preview"],
      width: message.sizes?.[message.displayMode || "preview"]?.width,
      height: message.sizes?.[message.displayMode || "preview"]?.height,
      className: "nokey",
      data: { message, onResize: resize, onRetry: retry, onPlanSettings: planSettings, onPlanReroute: planReroute, onAppearance: appearance, generating, multiple: false },
    }));
  const [nodes, setNodes] =
    useNodesState<MessageNodeType>(messageNodes());
  useEffect(() => {
    // The layout owns existing bubbles' positions; saved ones seed new bubbles.
    setNodes((previous) => {
      const current = new Map(previous.map((node) => [node.id, node]));
      return messageNodes().map((node) => {
        const existing = current.get(node.id);
        if (!existing) return node;
        const old = existing.data;
        const a = old.message, b = node.data.message;
        const sameMessage = a === b || (Object.keys(b) as (keyof Message)[]).every((key) => key === "position" || a[key] === b[key]);
        const sameData = sameMessage && old.generating === generating;
        if (sameData) return existing;
        return { ...existing, style: node.style, width: node.width, height: node.height, data: sameData ? old : node.data };
      });
    });
  }, [
    canvas.messages,
    retry,
    appearance,
    generating,
    setNodes,
  ]);

  useLayoutEffect(() => {
    onGeometry(Object.fromEntries(nodes.map(n => [n.id, { ...n.position, width: n.measured?.width ?? CARD_WIDTH, height: n.measured?.height ?? 210 }])));
  }, [nodes, onGeometry]);
  const items: LayoutItem[] = nodes.flatMap((node) => {
    const message = byId.get(node.id);
    const width = node.measured?.width;
    const height = node.measured?.height;
    if (!message || !width || !height) return [];
    return [
      {
        id: node.id,
        position: node.position,
        width,
        height,
        parentId: visualParent(message),
        role: message.role,
        automatic: !!message.placementOffset,
        upward: !!message.placementOffset && message.placementOffset.y < 0,
        kind: kinds.get(node.id) ?? null,
        offset: message.placementOffset ? (() => {
          const parent = nodes.find(n => n.id === visualParent(message));
          const pw = parent?.measured?.width ?? CARD_WIDTH, ph = parent?.measured?.height ?? 210;
          return automaticOffset({ width: pw, height: ph }, { width, height }, message.placementOffset, message.role === "assistant");
        })() : message.layoutOffset,
      },
    ];
  });
  const layout = useForceLayout({
    items,
    ids: canvas.messages.map(message => message.id),
    ready: fontsReady && items.length === nodes.length,
    trustRestored: canvas.layout === "force-v2",
    rootId: canvas.rootId,
    selectedId: canvas.selectedId,
    pendingId: canvas.messages.find(m => m.status === "pending")?.id,
    paused: selecting || groupMode,
    onTick: (positions) =>
      setNodes((previous) =>
        previous.map((node) => {
          const next = positions.get(node.id);
          return next &&
            (Math.abs(next.x - node.position.x) > 0.01 ||
              Math.abs(next.y - node.position.y) > 0.01)
            ? { ...node, position: next }
            : node;
        }),
      ),
    onSettle: (positions, rebase) => {
      const rounded = new Map(
        [...positions].map(([id, p]) => [
          id,
          { x: Math.round(p.x), y: Math.round(p.y) },
        ]),
      );
      const moved = canvas.messages.some((m) => {
        const p = rounded.get(m.id);
        return p && (p.x !== m.position.x || p.y !== m.position.y);
      });
      if (moved || rebase) onLayout(rounded, rebase);
    },
  });

  resizeHandler.current = (id, rect, phase) => {
    if (phase === "start") {
      container.current?.dispatchEvent(new Event("canvas-resize-start", { bubbles: true }));
      layout.resizeStart(id);
    }
    layout.resize(id, rect);
    setNodes((previous) => previous.map((node) => {
      if (node.id !== id) return node;
      const message = node.data.message;
      return { ...node, position: { x: rect.x, y: rect.y }, width: rect.width, height: rect.height,
        style: { width: rect.width, height: rect.height },
        data: { ...node.data, message: { ...message, sizes: { ...message.sizes, [message.displayMode || "preview"]: { width: rect.width, height: rect.height } } } } };
    }));
    if (phase === "end") {
      const message = byId.get(id);
      callbacks.current.onResize(id, { width: rect.width, height: rect.height }, { x: rect.x, y: rect.y }, layout.resizeOffset(id, message ? visualParent(message) : null));
    }
  };

  const centres = new Map(
    nodes.map((n) => [n.id, n.position.x + (n.measured?.width ?? 0) / 2]),
  );
  const edges: Edge[] = canvas.messages.flatMap((m) => {
    const parentId = visualParent(m);
    if (!parentId) return [];
    const parentNode = nodes.find(n => n.id === parentId);
    const childNode = nodes.find(n => n.id === m.id);
    const dx = (centres.get(m.id) ?? 0) - (centres.get(parentId) ?? 0);
    const dy = childNode && parentNode ? childNode.position.y + (childNode.measured?.height ?? 0) / 2 - parentNode.position.y - (parentNode.measured?.height ?? 0) / 2 : 1;
    const side = Math.abs(dx) > Math.abs(dy) ? (dx >= 0 ? "right" : "left") : (dy >= 0 ? "bottom" : "top");
    const opposite = { right: "left", left: "right", bottom: "top", top: "bottom" };
    const active = onPath.has(m.id) && onPath.has(parentId);
    return [
      {
        id: `${parentId}-${m.id}`,
        source: parentId,
        target: m.id,
        sourceHandle: `s-${side}`,
        targetHandle: `t-${opposite[side]}`,
        type: "default",
        className: active ? "edge-active" : undefined,
        style: {
          stroke: active ? "var(--edge-active)" : "var(--edge)",
          strokeWidth: active ? 3.2 : 2.4,
          strokeDasharray: m.editOf ? "5 6" : undefined,
        },
        selectable: false,
        focusable: false,
      },
    ];
  });

  const selectionCache = useRef(new Map<string, { source: MessageNodeType; node: MessageNodeType }>());
  const controlledNodes = useMemo(() => {
    const next = new Map<string, { source: MessageNodeType; node: MessageNodeType }>();
    for (const source of nodes) {
      const cached = selectionCache.current.get(source.id);
      const selected = group.has(source.id), multiple = group.size > 1;
      let data = source.data;
      if (data.multiple !== multiple) {
        data = cached?.source.data === source.data && cached.node.data.multiple === multiple
          ? cached.node.data : { ...data, multiple };
      }
      const node = cached?.source === source && cached.node.selected === selected && cached.node.data === data
        ? cached.node : { ...source, selected, data };
      next.set(source.id, { source, node });
    }
    selectionCache.current = next;
    return [...next.values()].map(entry => entry.node);
  }, [nodes, group]);
  const onNodesChange = useCallback((changes: NodeChange<MessageNodeType>[]) => {
    const selections = changes.filter(change => change.type === "select");
    if (selections.length) {
      const next = new Set(membership.current);
      for (const change of selections) {
        if (change.selected) next.add(change.id); else next.delete(change.id);
      }
      selectGroup(next);
    }
    const geometry = changes.filter(change => change.type !== "select");
    if (geometry.length) setNodes(previous => applyNodeChanges(geometry, previous));
  }, [selectGroup, setNodes]);
  const clickNode = useCallback((event: React.MouseEvent, node: MessageNodeType) => {
    if ((event.target as Element).closest("button, a, input, textarea, .react-flow__resize-control")) return;
    if (event.shiftKey) { setGroupMode(true); return; } // React Flow already toggled membership.
    selectGroup(new Set(node.data.message.status === "complete" ? [node.id] : canvas.selectedId ? [canvas.selectedId] : []));
    setGroupMode(false);
    callbacks.current.onSelect(node.id);
  }, [selectGroup, canvas.selectedId]);
  const clickPane = useCallback((event: React.MouseEvent) => {
    const start = pointer.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
    selectGroup(new Set());
    setGroupMode(false);
    callbacks.current.onDeselect();
  }, [selectGroup]);
  const dragStart = useCallback((_event: MouseEvent | TouchEvent | React.MouseEvent, node: MessageNodeType, dragged: MessageNodeType[]) => {
    layout.dragStart();
    if (!membership.current.has(node.id)) selectGroup(new Set([node.id]));
    layout.drag(new Map(dragged.map(n => [n.id, n.position])));
  }, [layout.dragStart, layout.drag, selectGroup]);
  const drag = useCallback((_event: MouseEvent | TouchEvent | React.MouseEvent, _node: MessageNodeType, dragged: MessageNodeType[]) => {
    layout.drag(new Map(dragged.map(n => [n.id, n.position])));
  }, [layout.drag]);
  const parentIds = useRef(byId);
  parentIds.current = byId;
  const drop = useCallback((_event: MouseEvent | TouchEvent | React.MouseEvent, _node: MessageNodeType, dragged: MessageNodeType[]) => {
    const positions = new Map(dragged.map(n => [n.id, n.position]));
    const parents = new Map(dragged.map(n => [n.id, visualParent(parentIds.current.get(n.id)!)]));
    const offsets = layout.dragStop(positions, parents);
    callbacks.current.onDrop(positions, offsets);
  }, [layout.dragStop]);
  const moved = useCallback((_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    if (!initial.current && !framing.current) callbacks.current.onViewport(viewport);
  }, []);
  const initialized = useCallback(() => { initial.current = false; }, []);

  return (
    <div
      ref={container}
      className="flow-container"
      data-testid="graph"
      data-layout-ticks={layout.diagnostics.ticks}
      data-simulated-bodies={layout.diagnostics.simulated}
      data-layout={layout.running ? "running" : "settled"}
      data-layout-ready={fontsReady && items.length === nodes.length}
      onPointerCancelCapture={() => setSelecting(false)}
      onPointerDownCapture={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
      }}
    >
      <ReactFlow
        nodes={controlledNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        defaultViewport={canvas.viewport}
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        minZoom={0.15}
        maxZoom={1.6}
        nodeDragThreshold={4}
        nodeClickDistance={4}
        paneClickDistance={4}
        selectionKeyCode="Shift"
        multiSelectionKeyCode="Shift"
        selectionMode={SelectionMode.Partial}
        onSelectionStart={() => { setSelecting(true); setGroupMode(true); selectGroup(new Set()); }}
        onSelectionEnd={() => setSelecting(false)}
        onNodeClick={clickNode}
        onPaneClick={clickPane}
        onNodesChange={onNodesChange}
        onNodeDragStart={dragStart}
        onNodeDrag={drag}
        onNodeDragStop={drop}
        onMoveEnd={moved}
        onInit={initialized}
        nodesDraggable
        selectNodesOnDrag={false}
        onSelectionDragStart={(_event, dragged) => dragStart(_event, dragged[0], dragged)}
        onSelectionDrag={(_event, dragged) => drag(_event, dragged[0], dragged)}
        onSelectionDragStop={(_event, dragged) => drop(_event, dragged[0], dragged)}
        selectionOnDrag={false}
        panOnDrag
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background
          variant={BackgroundVariant.Lines}
          gap={40}
          lineWidth={1}
          color="var(--grid)"
        />
      </ReactFlow>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import { collisionPairs, SpatialIndex } from "./spatial";
import { adjacentPosition, responsePosition, type LinkKind } from "../shared/graph";

// Simulation coordinates are bubble centres; React Flow positions are top-left.
type Body = SimulationNodeDatum & {
  id: string;
  role?: "user" | "assistant";
  x: number;
  y: number;
  width: number;
  height: number;
};
export type LayoutItem = {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  role?: "user" | "assistant";
  automatic?: boolean;
  upward?: boolean;
  parentId: string | null;
  kind: LinkKind | null;
  offset?: { x: number; y: number };
};
type Point = { x: number; y: number };

const GAP_X = 72;
const GAP_Y = 52;
const PADDING = 28;
const ANCHOR = 0.16;
// How much a child pulls back on its parent: enough to feel connected.
const PARENT_SHARE = 0.18;
// Collisions scale with alpha like every other force, so where the layout comes
// to rest does not depend on when the simulation cooled. The cap keeps hot
// layouts from overshooting.
const COLLIDE = 3;
const COLLIDE_CAP = 0.5;
// A layout whose net force (per unit alpha) stays below this is left at rest.
const PROBE_ALPHA = 0.1;
const UNSETTLED_FORCE = 3;

const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function anchorTarget(
  parent: Body,
  child: Body,
  kind: LinkKind,
  offset?: Point,
): Point {
  if (offset) return { x: parent.x + offset.x, y: parent.y + offset.y };
  if (kind === "down")
    return {
      x: parent.x,
      y: parent.y + parent.height / 2 + GAP_Y + child.height / 2,
    };
  const side = child.x >= parent.x ? 1 : -1;
  return {
    x: parent.x + side * (parent.width / 2 + GAP_X + child.width / 2),
    y: parent.y,
  };
}

function anchorForce(links: () => [Body, Body, LinkKind, Point?][], active: () => string | null, inserting = () => false) {
  return (alpha: number) => {
    if (inserting()) alpha *= 2;
    for (const [parent, child, kind, offset] of links()) {
      const selected = active();
      if (selected && selected !== parent.id && selected !== child.id) continue;
      const target = anchorTarget(parent, child, kind, offset);
      const dx = (target.x - child.x) * ANCHOR * alpha;
      const dy = (target.y - child.y) * ANCHOR * alpha;
      if (!selected || selected === child.id) { child.vx! += dx; child.vy! += dy; }
      if (!selected || selected === parent.id) { parent.vx! -= dx * PARENT_SHARE; parent.vy! -= dy * PARENT_SHARE; }
    }
  };
}

// Rectangle collision: push overlapping bubbles apart along the shallower axis.
function rectangleCollision(all: () => Body[], active: () => string | null, stationary: () => SpatialIndex<Body> | null, inserting: () => boolean = () => false) {
  return (alpha: number) => {
    const stiffness = Math.min(COLLIDE * alpha, inserting() ? 0.48 : COLLIDE_CAP);
    const selected = active();
    const body = selected ? all().find((b) => b.id === selected) : undefined;
    const pairs: [Body, Body][] = body && stationary() ? [...stationary()!.nearby(body)].map((other) => [body, other]) : collisionPairs(all(), selected);
    for (const [a, b] of pairs) {
      const dx = b.x + b.vx! - (a.x + a.vx!);
      const dy = b.y + b.vy! - (a.y + a.vy!);
      const overlapX = (a.width + b.width) / 2 + PADDING - Math.abs(dx);
      const overlapY = (a.height + b.height) / 2 + PADDING - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;
      const aFixed = !!selected && selected !== a.id || a.fx != null;
      const bFixed = !!selected && selected !== b.id || b.fx != null;
      if (aFixed && bFixed) continue;
      const shareA = aFixed ? 0 : bFixed ? 1 : 0.5;
      const shareB = bFixed ? 0 : 1 - shareA;
      if (overlapX < overlapY) {
        const push = (dx >= 0 ? 1 : -1) * overlapX * stiffness;
        a.vx! -= push * shareA; b.vx! += push * shareB;
      } else {
        const push = (dy >= 0 ? 1 : -1) * overlapY * stiffness;
        a.vy! -= push * shareA; b.vy! += push * shareB;
      }
    }
  };
}

export function useForceLayout({
  items,
  ids,
  ready,
  trustRestored,
  rootIds,
  selectedId,
  pendingId,
  paused,
  onTick,
  onSettle,
}: {
  items: LayoutItem[];
  ids: string[];
  // False while some bubbles are still unmeasured.
  ready: boolean;
  // Saved positions came from this layout. Crowded maps can take longer to
  // settle than the cooling allows, so reopening one must not resume motion.
  trustRestored: boolean;
  // Bubbles that hang from nothing; they hold still while nothing is selected.
  rootIds: string[];
  selectedId: string | null;
  pendingId?: string;
  paused: boolean;
  onTick: (positions: Map<string, Point>) => void;
  onSettle: (positions: Map<string, Point>, rebase?: boolean) => void;
}) {
  const [running, setRunning] = useState(false);
  const [awaitingMeasurement, setAwaitingMeasurement] = useState(false);
  const bodies = useRef(new Map<string, Body>());
  const links = useRef<[Body, Body, LinkKind, Point?][]>([]);
  const dragging = useRef(false);
  const held = useRef(false);
  const pause = useRef(paused);
  pause.current = paused;
  const moving = useRef(running);
  moving.current = running;
  // Hold the chosen rectangle until deselection, including after release.
  const resizing = useRef<string | null>(null);
  const callbacks = useRef({ onTick, onSettle });
  callbacks.current = { onTick, onSettle };
  const simulation = useRef<Simulation<Body, undefined> | null>(null);
  const selected = useRef(selectedId);
  selected.current = selectedId;
  const insertion = useRef<{ ids: Set<string>; fresh: Set<string>; upward: Set<string>; launched: boolean; parentId?: string | null; rest: Map<string,Point>; offsets: Map<string,Point>; completed: boolean } | null>(null);
  const restedInsertion = useRef<typeof insertion.current>(null);
  const active = () => insertion.current ? null : selected.current;
  const list = () => [...bodies.current.values()];
  const published = useRef(new Map<string, Point>());
  const stationary = useRef<SpatialIndex<Body> | null>(null);
  const diagnostics = useRef({ ticks: 0, simulated: 0 });
  const initialised = useRef(false);
  const restoredIds = useRef(new Set(ids));
  // A trusted restored layout stays put through late measurement (fonts and
  // math finishing after load) until the person selects, moves or adds anything.
  const untouched = useRef(false);
  const inputs = useRef("");
  const rootKey = rootIds.join("|");
  const roots = new Set(rootIds);

  const positions = () => {
    const changes = new Map<string, Point>();
    for (const body of bodies.current.values()) {
      const p = { x: body.x - body.width / 2, y: body.y - body.height / 2 };
      const previous = published.current.get(body.id);
      if (!previous || Math.abs(p.x - previous.x) > 0.01 || Math.abs(p.y - previous.y) > 0.01) {
        changes.set(body.id, p); published.current.set(body.id, p);
      }
    }
    return changes;
  };
  const publish = () => {
    // Keep the chosen ordering as collisions separate neighbours. In particular,
    // a shorter sideways prompt has a negative centre delta, but is not upward.
    const local = insertion.current;
    if (local) for (const [parent, child] of links.current) {
      if (!local.fresh.has(child.id)) continue;
      const upward = local.upward.has(child.id);
      const boundary = upward
        ? parent.y-parent.height/2-GAP_Y-child.height/2
        : child.role === "assistant"
          ? parent.y+parent.height/2+GAP_Y+child.height/2
          : parent.y-parent.height/2+child.height/2;
      if (upward ? child.y > boundary : child.y < boundary) {
        child.y = boundary;
        child.vy = upward ? Math.min(0, child.vy ?? 0) : Math.max(0, child.vy ?? 0);
        if (child.fy != null) child.fy = boundary;
      }
    }
    callbacks.current.onTick(positions());
  };
  const settle = () => {
    publish();
    callbacks.current.onSettle(new Map([...published.current].filter(([id]) => insertion.current ? insertion.current.ids.has(id) : !active() || id === active())), !!insertion.current);
  };

  const finishInsertion = () => {
      if (insertion.current?.completed) {
        restedInsertion.current = insertion.current;
        insertion.current = null;
        // Saving the measured offsets must not start a second, ordinary cooling
        // cycle. Hold the finished insertion until the next active selection.
        held.current = true;
        simulation.current!.alphaDecay(0.04).velocityDecay(0.42);
        diagnostics.current.simulated = selected.current ? 1 : list().length;
        for (const b of list()) { const fixed = selected.current ? b.id !== selected.current : roots.has(b.id); b.fx = fixed ? b.x : null; b.fy = fixed ? b.y : null; }
        stationary.current = selected.current ? new SpatialIndex(list().filter(b=>b.id!==selected.current)) : null;
        simulation.current!.nodes(selected.current ? list().filter(b=>b.id===selected.current) : list());
      }
  };

  if (!simulation.current) {
    simulation.current = forceSimulation<Body>([])
      .alphaDecay(0.04)
      .velocityDecay(0.42)
      .force("anchor", anchorForce(() => insertion.current ? links.current.filter(([,child]) => insertion.current!.fresh.has(child.id)) : links.current, active, () => !!insertion.current))
      .force("insertion-rest", (alpha: number) => {
        const local = insertion.current;
        if (!local) return;
        for (const [id, origin] of local.rest) {
          const body = bodies.current.get(id);
          if (!body || body.fx != null) continue;
          body.vx! += (origin.x-body.x)*.08*alpha;
          body.vy! += (origin.y-body.y)*.08*alpha;
        }
      })
      .force("collide", rectangleCollision(list, active, () => stationary.current, () => !!insertion.current))
      .force("charge", (() => {
        const whole = forceManyBody<Body>().strength(-60).distanceMax(420);
        const force = (alpha: number) => {
          const id = active();
          if (!id) { whole(alpha); return; }
          const body = bodies.current.get(id);
          if (!body) return;
          for (const neighbour of (stationary.current || new SpatialIndex(list())).nearby(body, 420)) {
            const dx = body.x - neighbour.x, dy = body.y - neighbour.y;
            const distance = Math.max(1, dx * dx + dy * dy);
            if (distance > 420 * 420) continue;
            body.vx! += dx * 60 * alpha / distance;
            body.vy! += dy * 60 * alpha / distance;
          }
        };
        force.initialize = (nodes: Body[], random: () => number) => whole.initialize(nodes, random);
        return force;
      })())
      .stop();
    simulation.current.on("tick", () => { diagnostics.current.ticks++; publish(); });
    simulation.current.on("end", () => {
      setRunning(false);
      settle();
      finishInsertion();
    });
  }

  const overlapping = () => collisionPairs(list()).some(([a, b]) =>
    (a.width + b.width) / 2 > Math.abs(b.x - a.x) && (a.height + b.height) / 2 > Math.abs(b.y - a.y));
  // Measure the net force on the free bubbles without moving anything.
  const unsettled = () => {
    const sim = simulation.current!;
    const list = [...bodies.current.values()];
    const velocities = list.map((b) => [b.vx, b.vy]);
    for (const body of list) body.vx = body.vy = 0;
    for (const name of ["anchor", "collide", "charge"])
      sim.force(name)?.(PROBE_ALPHA);
    let strongest = 0;
    for (const body of list)
      if (body.fx == null)
        strongest = Math.max(strongest, Math.hypot(body.vx!, body.vy!));
    list.forEach((body, i) => ([body.vx, body.vy] = velocities[i]));
    return strongest / PROBE_ALPHA > UNSETTLED_FORCE;
  };

  const kick = useCallback((alpha: number) => {
    if (resizing.current || pause.current || dragging.current || held.current) return;
    const sim = simulation.current!;
    sim.alpha(Math.max(sim.alpha(), alpha));
    if (reducedMotion()) {
      sim.stop();
      while (sim.alpha() > sim.alphaMin()) { sim.tick(); diagnostics.current.ticks++; }
      publish();
      setRunning(false);
      settle();
      finishInsertion();
      return;
    }
    setRunning(true);
    sim.restart();
  }, []);

  // Save a simulation interrupted by a new selection before pinning its former
  // active body. Otherwise its last visible coordinates could be lost on reload.
  useLayoutEffect(() => {
    held.current = false;
    restedInsertion.current = null;
    if (!running) return;
    simulation.current!.stop();
    setRunning(false);
    callbacks.current.onSettle(new Map(list().map((b) => [b.id, { x: b.x - b.width / 2, y: b.y - b.height / 2 }])), !!insertion.current);
  }, [selectedId]);

  const pauseLayout = useCallback(() => {
    simulation.current!.stop();
    setRunning(false);
    if (moving.current || insertion.current) {
      callbacks.current.onSettle(new Map(list().map(b => [b.id, { x: b.x-b.width/2, y: b.y-b.height/2 }])), !!insertion.current);
    }
    moving.current = false;
    setAwaitingMeasurement(false);
    insertion.current = null;
    restedInsertion.current = null;
    simulation.current!.alphaDecay(0.04).velocityDecay(0.42);
    for (const b of list()) { b.vx = b.vy = 0; b.fx = b.x; b.fy = b.y; }
  }, []);
  useLayoutEffect(() => { if (paused) pauseLayout(); }, [paused, pauseLayout]);

  // Sync the bodies with the measured bubbles and their links. Only structure,
  // offsets and sizes trigger this, not the positions the layout saved itself.
  const sizes = items.map((i) => `${i.id}:${i.width}x${i.height}`).join("|");
  const structure = items
    .map(
      (i) =>
        `${i.id}<${i.parentId}:${i.kind}:${i.offset?.x ?? ""},${i.offset?.y ?? ""}`,
    )
    .join("|");
  useLayoutEffect(() => {
    if (!ready) return;
    const key = [structure, rootKey, selectedId, pendingId, paused].join("\n");
    if (inputs.current && inputs.current !== key) untouched.current = false;
    inputs.current = key;
    if (resizing.current !== selectedId) resizing.current = null;
    const sim = simulation.current!;
    const recent = restedInsertion.current;
    // A late content measurement reuses insertion physics, never ordinary
    // selection cooling. An offset-only save echo leaves the layout at rest.
    if (recent && items.some(item => {
      const body = bodies.current.get(item.id);
      return item.automatic && recent.fresh.has(item.id) && body && (body.width !== item.width || body.height !== item.height);
    })) {
      insertion.current = recent;
      recent.completed = false;
      restedInsertion.current = null;
      held.current = false;
      sim.alphaDecay(0.10).velocityDecay(0.55);
    }
    const next = new Map<string, Body>();
    let resized = false;
    const fresh = new Set<string>();
    for (const item of items) {
      let body = bodies.current.get(item.id);
      if (!body) {
        fresh.add(item.id);
        body = {
          id: item.id,
          role: item.role,
          x: item.position.x + item.width / 2,
          y: item.position.y + item.height / 2,
          width: item.width,
          height: item.height,
        };
      } else {
        resized ||= body.width !== item.width || body.height !== item.height;
        // Resizing owns the exact top-left, including left/top handles.
        if (resizing.current === item.id || paused || dragging.current) {
          body.x = item.position.x + item.width / 2;
          body.y = item.position.y + item.height / 2;
        } else {
          body.x += (item.width - body.width) / 2;
          const local = insertion.current;
          const upward = item.automatic && (local?.fresh.has(item.id) ? local.upward.has(item.id) : item.upward);
          body.y += (item.height - body.height) / 2 * (upward ? -1 : 1);
        }
        body.width = item.width;
        body.height = item.height;
      }
      next.set(item.id, body);
    }
    bodies.current = next;
    // A bubble can go (a summary left out); an insertion it belonged to ends.
    for (const kept of [insertion, restedInsertion])
      if (kept.current && [...kept.current.fresh].some((id) => !next.has(id))) kept.current = null;
    // Measurement can finish after the user has already created another turn.
    // Only IDs present on mount belong to the restored layout in that case.
    if (!initialised.current && trustRestored) {
      for (const id of fresh) if (restoredIds.current.has(id)) fresh.delete(id);
    }
    if (fresh.size && (initialised.current || pendingId || (!trustRestored && items.length === 2) || [...fresh].some(id => !restoredIds.current.has(id)))) {
      const prompt = items.find(i => fresh.has(i.id) && i.role === "user");
      const answer = items.find(i => fresh.has(i.id) && i.parentId === prompt?.id);
      const parent = prompt?.parentId ? next.get(prompt.parentId) : undefined;
      const offsets = new Map<string,Point>();
      const upwardIds = new Set<string>();
      if (prompt && answer) {
        const p = next.get(prompt.id)!, a = next.get(answer.id)!;
        const position = parent ? adjacentPosition({x:parent.x-parent.width/2,y:parent.y-parent.height/2,width:parent.width,height:parent.height},prompt,items.filter(i=>!fresh.has(i.id)&&i.id!==parent.id).map(i=>({...i.position,width:i.width,height:i.height})),prompt.kind==="down", answer) : prompt.position;
        p.x=position.x+p.width/2; p.y=position.y+p.height/2;
        const upward = !!parent && position.y < parent.y-parent.height/2;
        if (upward) { upwardIds.add(p.id); upwardIds.add(a.id); }
        const response = responsePosition({ ...position, width:p.width, height:p.height }, a, upward);
        a.x=response.x+a.width/2; a.y=response.y+a.height/2;
        if (parent) offsets.set(p.id,{x:p.x-parent.x,y:p.y-parent.y});
        offsets.set(a.id,{x:0,y:a.y-p.y});
      }
      const ids = new Set(fresh), rest = new Map<string,Point>();
      const index = new SpatialIndex([...next.values()]);
      for (const id of fresh) for (const b of index.nearby(next.get(id)!,160)) if (b.id !== prompt?.parentId) ids.add(b.id);
      for (const id of ids) if (!fresh.has(id)) { const b=next.get(id)!; rest.set(id,{x:b.x,y:b.y}); }
      // A fresh bubble that starts an existing branch, as a summary does, moves
      // away from that branch, which holds still.
      const started = prompt ? undefined : items.find(i => !fresh.has(i.id) && !!i.parentId && fresh.has(i.parentId));
      insertion.current={ids,fresh,upward:upwardIds,launched:false,parentId:prompt?.parentId ?? prompt?.id ?? started?.id,rest,offsets,completed:false};
      sim.alphaDecay(0.10).velocityDecay(0.55);
    }
    if (insertion.current && selectedId && !insertion.current.fresh.has(selectedId)) {
      insertion.current.completed = true;
      settle();
      finishInsertion();
    }
    const local = insertion.current;
    if (local) {
      const index = new SpatialIndex([...next.values()]);
      for (const id of local.fresh) for (const b of index.nearby(next.get(id)!,160)) {
        if (b.id === local.parentId || local.ids.has(b.id)) continue;
        local.ids.add(b.id); local.rest.set(b.id,{x:b.x,y:b.y});
      }
      // Signed offsets keep the pair pointing upward through measured growth.
      for (const item of items) if (local.fresh.has(item.id) && item.parentId) {
        const parent = next.get(item.parentId), child=next.get(item.id);
        const offset = local.offsets.get(item.id);
        if (!parent || !child || !offset) continue;
        if (item.role === "assistant" || local.upward.has(item.id)) {
          local.offsets.set(item.id,{x:item.role === "assistant" ? 0 : offset.x,y:(local.upward.has(item.id) ? -1 : 1)*(parent.height/2+GAP_Y+child.height/2)});
        }
      }
    }
    const chosen = active();
    for (const body of next.values()) {
      body.vx = body.vy = 0;
      const pinned = paused || dragging.current || held.current || (local ? !local.ids.has(body.id) || body.id === local.parentId : chosen ? body.id !== chosen : roots.has(body.id));
      body.fx = pinned ? body.x : null;
      body.fy = pinned ? body.y : null;
    }
    links.current = items.flatMap((item) => {
      const parent = item.parentId ? next.get(item.parentId) : undefined;
      return parent && item.kind
        ? [[parent, next.get(item.id)!, item.kind, local?.offsets.get(item.id) ?? item.offset] as const]
        : [];
    }) as [Body, Body, LinkKind, Point?][];
    sim.stop();
    setRunning(false);
    stationary.current = chosen ? new SpatialIndex([...next.values()].filter((b) => b.id !== chosen)) : null;
    diagnostics.current.simulated = local ? local.ids.size : chosen ? 1 : next.size;
    sim.nodes(local ? [...next.values()].filter(b=>local.ids.has(b.id) && b.id!==local.parentId) : chosen ? [...next.values()].filter((b) => b.id === chosen) : [...next.values()]);
    if (!next.size || resizing.current || paused || dragging.current || held.current) return;
    const restored = !initialised.current;
    initialised.current = true;
    if (restored && trustRestored && !local) { untouched.current = true; return; }
    if (local && !local.launched) {
      local.launched = true;
      // One outward launch; only insertion uses the hotter, faster-cooling mode.
      const anchor = local.parentId ? next.get(local.parentId) : undefined;
      for (const id of local.fresh) {
        const body = next.get(id)!;
        if (body.fx != null) continue;
        const dx = body.x-(anchor?.x ?? body.x), dy = body.y-(anchor?.y ?? body.y-1);
        const distance = Math.max(1,Math.hypot(dx,dy));
        body.vx = dx/distance*22; body.vy = dy/distance*22;
      }
      publish(); kick(0.85);
    }
    else if (local && resized) { publish(); kick(0.45); }
    else if (untouched.current && !local ? overlapping() : (restored && overlapping()) || unsettled())
      kick(restored ? 0.2 : 0.3);
    else if (local?.completed) { settle(); finishInsertion(); }
  }, [ready, structure, sizes, rootKey, selectedId, pendingId, paused, kick]);

  // Completion content is measured after the status update. Keep the local group
  // movable until those dimensions have stopped changing for a few frames.
  useEffect(() => {
    const local=insertion.current;
    if (!local || pendingId) { setAwaitingMeasurement(false); return; }
    local.completed=false;
    setAwaitingMeasurement(true);
    const timer=window.setTimeout(()=>{
      setAwaitingMeasurement(false);
      if (insertion.current !== local) return;
      local.completed=true;
      kick(.45);
    },200);
    return ()=>window.clearTimeout(timer);
  },[pendingId,sizes,kick]);

  useEffect(() => () => void simulation.current?.stop(), []);

  const dragStart = useCallback(() => {
    untouched.current = false;
    pauseLayout();
    dragging.current = true;
    held.current = true;
  }, [pauseLayout]);
  const drag = useCallback((positions: Map<string, Point>) => {
    for (const [id, position] of positions) {
      const body = bodies.current.get(id);
      if (!body) continue;
      body.x = body.fx = position.x + body.width/2;
      body.y = body.fy = position.y + body.height/2;
      body.vx = body.vy = 0;
      published.current.set(id, { ...position });
    }
  }, []);
  const dragStop = useCallback((positions: Map<string, Point>, parents: Map<string, string | null>) => {
    // Synchronize every body before computing any offset: a dragged parent may
    // appear later in the group than its child. Persist this drop in one update.
    drag(positions);
    dragging.current = false;
    const offsets = new Map<string, Point>();
    for (const [id, parentId] of parents) {
      const body = bodies.current.get(id), parent = parentId ? bodies.current.get(parentId) : undefined;
      if (body && parent) offsets.set(id, { x: body.x-parent.x, y: body.y-parent.y });
    }
    return offsets;
  }, [drag]);

  const resizeStart = useCallback((id: string) => {
    untouched.current = false;
    if (insertion.current) callbacks.current.onSettle(new Map(list().map(b => [b.id,{x:b.x-b.width/2,y:b.y-b.height/2}])), true);
    insertion.current = null;
    restedInsertion.current = null;
    simulation.current!.alphaDecay(0.04).velocityDecay(0.42);
    resizing.current = id;
    simulation.current!.stop();
    setRunning(false);
    for (const b of bodies.current.values()) { b.vx = b.vy = 0; b.fx = b.x; b.fy = b.y; }
  }, []);
  const resize = useCallback((id: string, rect: Point & { width: number; height: number }) => {
    const b = bodies.current.get(id);
    if (!b) return;
    b.width = rect.width; b.height = rect.height;
    b.x = b.fx = rect.x + rect.width / 2; b.y = b.fy = rect.y + rect.height / 2;
    b.vx = b.vy = 0;
    published.current.set(id, { x: rect.x, y: rect.y });
  }, []);
  const resizeOffset = useCallback((id: string, parentId: string | null) => {
    const b = bodies.current.get(id), parent = parentId ? bodies.current.get(parentId) : undefined;
    return b && parent ? { x: b.x - parent.x, y: b.y - parent.y } : undefined;
  }, []);
  return { resizeStart, resize, resizeOffset, running: running || awaitingMeasurement, dragStart, drag, dragStop, diagnostics: diagnostics.current };
}

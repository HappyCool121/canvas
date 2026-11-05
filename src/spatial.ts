// Rectangle-aware uniform grid. Large/expanded bubbles occupy every intersected
// cell, so a narrow neighbour never disappears behind a centre-only lookup.
export type SpatialBody = { id: string; x: number; y: number; width: number; height: number; vx?: number; vy?: number };
export class SpatialIndex<T extends SpatialBody> {
  private cells = new Map<string, T[]>();
  constructor(bodies: T[], private cellSize = 512) {
    for (const body of bodies) this.visit(body, 0, (key) => {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(body); else this.cells.set(key, [body]);
    });
  }
  private visit(body: SpatialBody, padding: number, visit: (key: string) => void) {
    const x = body.x + (body.vx || 0), y = body.y + (body.vy || 0);
    const left = Math.floor((x - body.width / 2 - padding) / this.cellSize);
    const right = Math.floor((x + body.width / 2 + padding) / this.cellSize);
    const top = Math.floor((y - body.height / 2 - padding) / this.cellSize);
    const bottom = Math.floor((y + body.height / 2 + padding) / this.cellSize);
    for (let cx = left; cx <= right; cx++) for (let cy = top; cy <= bottom; cy++) visit(`${cx},${cy}`);
  }
  nearby(body: SpatialBody, padding = 28) {
    const found = new Set<T>();
    this.visit(body, padding, (key) => { for (const other of this.cells.get(key) || []) if (other.id !== body.id) found.add(other); });
    return found;
  }
}
export function collisionPairs<T extends SpatialBody>(bodies: T[], activeId?: string | null) {
  const index = new SpatialIndex(bodies);
  const order = new Map(bodies.map((body, i) => [body.id, i]));
  const active = activeId ? bodies.filter((b) => b.id === activeId) : bodies;
  const pairs: [T, T][] = [];
  for (const a of active) for (const b of index.nearby(a)) {
    if (activeId || order.get(a.id)! < order.get(b.id)!) pairs.push([a, b]);
  }
  return pairs;
}

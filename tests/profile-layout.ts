import { performance } from "node:perf_hooks";
import { collisionPairs, SpatialIndex } from "../src/spatial";
import { mkdir, writeFile } from "node:fs/promises";

const results = [];
for (const size of [100, 500]) {
  const bodies = Array.from({ length: size }, (_, i) => ({ id: `${i}`, x: (i % 25) * 420, y: Math.floor(i / 25) * 260, width: 320, height: 180, vx: 0, vy: 0 }));
  const old = () => {
    let overlaps = 0;
    for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if ((a.width + b.width) / 2 + 28 > Math.abs(b.x - a.x) && (a.height + b.height) / 2 + 28 > Math.abs(b.y - a.y)) overlaps++;
    }
    return overlaps;
  };
  const indexed = () => {
    let overlaps = 0;
    for (const [a, b] of collisionPairs(bodies)) if ((a.width + b.width) / 2 + 28 > Math.abs(b.x - a.x) && (a.height + b.height) / 2 + 28 > Math.abs(b.y - a.y)) overlaps++;
    return overlaps;
  };
  const selected = bodies[Math.floor(size / 2)];
  const stationary = new SpatialIndex(bodies.filter((b) => b !== selected));
  const nearby = () => stationary.nearby(selected).size;
  function timing(run: () => number) {
    for (let i = 0; i < 100; i++) run();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) run();
    return Number(((performance.now() - start) / 1000).toFixed(4));
  }
  if (old() !== indexed()) throw new Error("Collision equivalence failed");
  results.push({ size, oldChecksPerTick: size * (size - 1) / 2, indexedChecksPerTick: collisionPairs(bodies).length, selectedChecksPerTick: nearby(), oldCollisionMs: timing(old), indexedCollisionMs: timing(indexed), selectedCollisionMs: timing(nearby) });
}
await mkdir("output", { recursive: true });
await writeFile("output/layout-profile.json", JSON.stringify({ fixture: "spaced grid, 320x180 rectangles, 1000 warm iterations; pure collision phase only", results }, null, 2));
console.log(JSON.stringify(results));

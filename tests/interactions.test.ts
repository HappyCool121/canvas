import { test } from "node:test";
import assert from "node:assert/strict";
import { messageTitle } from "../shared/titles";
import { SpatialIndex, collisionPairs } from "../src/spatial";
import { addTurn, newCanvas } from "../shared/graph";

test("message titles prefer Markdown headings, exclude fenced examples, normalize links and label empty messages", () => {
  const message = addTurn(newCanvas(), "Opening paragraph\n\n## **A heading** [here](https://example.com)\nLong response", null).canvas.messages[0];
  assert.equal(messageTitle(message), "A heading here");
  assert.equal(messageTitle({ ...message, content: "```md\n# example\n```\n\nReal title\n=====" }), "Real title");
  assert.ok(messageTitle({ ...message, content: "x".repeat(120) }).length <= 80);
  assert.equal(messageTitle({ ...message, content: "", status: "pending" }), "Writing an answer…");
  assert.equal(messageTitle({ ...message, content: "", images: [{ id: "p", width: 1, height: 1, mime: "image/png", pdf: { id: "pdf", page: 1, name: "source.pdf" } }] }), "PDF attachment");
});

test("spatial pairs include every overlap once, including large bubbles, negative positions and active-only queries", () => {
  const bodies = Array.from({ length: 500 }, (_, i) => ({ id: `${i}`, x: (i % 25) * 420 - 3000, y: Math.floor(i / 25) * 260 - 2000, width: 320, height: i === 10 ? 1800 : 180 }));
  const pairs = collisionPairs(bodies);
  const actual = new Set(pairs.map(([a, b]) => `${a.id}:${b.id}`));
  assert.equal(actual.size, pairs.length);
  for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
    const a = bodies[i], b = bodies[j];
    if (Math.abs(a.x - b.x) < (a.width + b.width) / 2 + 28 && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + 28) assert.ok(actual.has(`${a.id}:${b.id}`));
  }
  assert.ok(pairs.length < 500 * 499 / 20);
  assert.ok(collisionPairs(bodies, "10").every(([a]) => a.id === "10"));
  assert.ok(new SpatialIndex(bodies).nearby(bodies[10]).size < 30);
});

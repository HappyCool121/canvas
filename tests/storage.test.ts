import "fake-indexeddb/auto";
import { test } from "node:test";
import { openDB } from "idb";
import assert from "node:assert/strict";
import { createRepository } from "../src/storage";
import { addTurn, newCanvas, recoverCanvas } from "../shared/graph";

test("IndexedDB restores draft, selection, viewport, coordinates and interrupted request; last save wins", async () => {
  const name = `test-${crypto.randomUUID()}`;
  const repo = createRepository(name);
  const turn = addTurn(newCanvas(), "Persist this prompt", null);
  const canvas = {
    ...turn.canvas,
    draft: "Unsent follow-up",
    viewport: { x: -90, y: 71, zoom: 0.6 },
  };
  canvas.messages[0].position = { x: 900, y: 200 };
  await Promise.all([repo.save(turn.canvas), repo.save(canvas)]);
  await repo.setActive(canvas.id);
  await repo.close();
  const reopened = createRepository(name);
  const stored = await reopened.load();
  assert.equal(stored.activeId, canvas.id);
  assert.deepEqual(stored.canvases[0], canvas);
  assert.equal(
    recoverCanvas(stored.canvases[0]).messages.at(-1)?.status,
    "interrupted",
  );
  assert.ok(!JSON.stringify(stored).includes("apiKey"));
  await reopened.close();
});

test("image blobs round-trip outside canvas snapshots and a version 1 workspace upgrades intact", async () => {
  const name = `test-${crypto.randomUUID()}`;
  const legacy = await openDB(name, 1, {
    upgrade(db) {
      db.createObjectStore("canvases", { keyPath: "id" });
      db.createObjectStore("preferences");
    },
  });
  const canvas = addTurn(newCanvas(), "Saved before images existed", null).canvas;
  await legacy.put("canvases", canvas);
  legacy.close();
  const repo = createRepository(name);
  const stored = await repo.load();
  assert.deepEqual(stored.canvases, [canvas]);
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], {
    type: "image/png",
  });
  await repo.putImage("image-1", blob);
  const loaded = await repo.getImage("image-1");
  assert.equal(loaded?.type, "image/png");
  assert.deepEqual(
    new Uint8Array(await loaded!.arrayBuffer()),
    new Uint8Array([137, 80, 78, 71]),
  );
  await repo.deleteImage("image-1");
  assert.equal(await repo.getImage("image-1"), undefined);
  await repo.close();
  // Safari can't store Blobs in IndexedDB, so bytes are stored instead.
  const raw = await openDB(name, 2);
  await raw.put("images", blob, "legacy-blob");
  assert.ok(!((await raw.get("images", "legacy-blob")) instanceof ArrayBuffer));
  const reopened = createRepository(name);
  await reopened.putImage("image-2", blob);
  const record = await raw.get("images", "image-2");
  assert.equal(record.mime, "image/png");
  assert.ok(record.bytes instanceof ArrayBuffer);
  raw.close();
  // Blobs saved by earlier builds stay readable.
  assert.equal((await reopened.getImage("legacy-blob"))?.type, "image/png");
  await reopened.close();
});

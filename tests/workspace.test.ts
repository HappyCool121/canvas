import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Canvas } from "../shared/types";
import { createWorkspace, defaultDataDir } from "../server/workspace";
import { createApp } from "../server/app";
import { newCanvas, addTurn, recoverCanvas } from "../shared/graph";

async function temporary(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "canvas-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("the default data folder follows each platform's convention", () => {
  const home = path.join(path.sep, "home", "ada");
  assert.equal(defaultDataDir("darwin", {}, home), path.join(home, "Library", "Application Support", "Canvas"));
  assert.equal(defaultDataDir("win32", { APPDATA: path.join(home, "Roaming") }, home), path.join(home, "Roaming", "Canvas"));
  assert.equal(defaultDataDir("win32", {}, home), path.join(home, "AppData", "Roaming", "Canvas"));
  assert.equal(defaultDataDir("linux", { XDG_DATA_HOME: path.join(home, "data") }, home), path.join(home, "data", "canvas"));
  assert.equal(defaultDataDir("linux", {}, home), path.join(home, ".local", "share", "canvas"));
});
test("disk round-trip, serialized snapshots, restart recovery, preferences and original attachment integrity", async (t) => {
  const dir = await temporary(t);
  const store = createWorkspace(dir);
  const canvas = addTurn(newCanvas(), "Persist on this Mac", null).canvas;
  const png = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const original = new Uint8Array([80, 75, 3, 4, 42, 201]);
  await store.putAttachment("page", png, "image/png");
  await store.putAttachment("original", original, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  canvas.messages[0].images = [{ id: "page", mime: "image/png", width: 20, height: 30, docx: { id: "original", name: "source.docx", page: 1 } }];
  canvas.messages[0].sizes = { preview: { width: 420, height: 180 }, compact: { width: 180, height: 72 }, expanded: { width: 640, height: 420 } };
  canvas.messages[0].color = "coral"; canvas.messages[0].displayMode = "expanded";
  const latest = { ...canvas, draft: "Unsent draft", viewport: { x: 123, y: -32, zoom: 0.8 } };
  await Promise.all([store.save(canvas), store.save(latest)]);
  await store.setPreferences({ activeId: canvas.id, values: { "canvas.model": "deepseek-v4-pro" } });
  const reopened = createWorkspace(dir);
  const loaded = await reopened.load();
  assert.equal(loaded.canvases[0].messages[0].images![0].bytes, png.length);
  const expected = structuredClone(latest);
  expected.messages[0].images![0].bytes = png.length;
  assert.deepEqual(loaded.canvases, [expected]);
  assert.equal(loaded.activeId, canvas.id);
  assert.equal(loaded.preferences["canvas.model"], "deepseek-v4-pro");
  assert.equal(recoverCanvas(loaded.canvases[0]).messages[1].status, "interrupted");
  assert.deepEqual(new Uint8Array((await reopened.getAttachment("page"))!.bytes), png);
  assert.deepEqual(new Uint8Array((await reopened.getAttachment("original"))!.bytes), original);
  assert.equal((await readdir(path.join(dir, "canvases"))).length, 1);
  assert.ok(!(await readFile(path.join(dir, "canvases", `${canvas.id}.json`), "utf8")).includes("base64"));
});

test("imports are idempotent, retryable, and preserve conflicting histories and attachment IDs", async (t) => {
  const dir = await temporary(t);
  const store = createWorkspace(dir);
  const browser: Canvas = addTurn(newCanvas(), "Browser history", null).canvas;
  browser.draftImages = [{ id: "same-image", mime: "image/png", width: 1, height: 1 }];
  const disk = { ...browser, draftImages: [], draft: "Independent disk changes" };
  await store.save(disk);
  await store.putAttachment("same-image", new Uint8Array([1, 2]), "image/png");
  await assert.rejects(store.importCanvas(browser, {}), /attachment/);
  assert.equal((await store.load()).canvases.length, 1);
  const remapped = await store.putAttachment("same-image", new Uint8Array([3, 4]), "image/png", true);
  assert.notEqual(remapped, "same-image");
  const id = await store.importCanvas(browser, { "same-image": remapped });
  assert.notEqual(id, disk.id);
  // Simulate a crash after writing the conflict canvas but before its receipt.
  const preferenceFile = path.join(dir, "preferences.json");
  const incompleteReceipt = JSON.parse(await readFile(preferenceFile, "utf8"));
  delete incompleteReceipt.imports;
  await writeFile(preferenceFile, JSON.stringify(incompleteReceipt));
  const again = createWorkspace(dir);
  assert.equal(await again.importCanvas(browser, { "same-image": remapped }), id);
  assert.equal(await again.importCanvas(browser, { "same-image": remapped, "unrelated-image": "another-asset" }), id, "unrelated legacy attachments do not change a history receipt");
  let result = await again.load();
  assert.equal(result.canvases.length, 2);
  assert.deepEqual(result.canvases.find((c) => c.id === disk.id), disk);
  assert.equal(result.canvases.find((c) => c.id === id)?.draftImages?.[0].id, remapped);
  await again.save({ ...result.canvases.find((c) => c.id === id)!, draft: "Edited after import" });
  await again.importCanvas(browser, { "same-image": remapped });
  result = await again.load();
  assert.equal(result.canvases.find((c) => c.id === id)?.draft, "Edited after import");
  assert.deepEqual(new Uint8Array((await again.getAttachment("same-image"))!.bytes), new Uint8Array([1, 2]));
  // Legacy browser changes are preserved as another history instead of replacing either copy.
  await again.importCanvas({ ...browser, draft: "Changed legacy draft" }, { "same-image": remapped });
  assert.equal((await again.load()).canvases.length, 3);
});

test("failed writes reject, keep acknowledged snapshots and allow the queue to retry", async (t) => {
  const dir = await temporary(t);
  const invalid = path.join(dir, "not-a-directory");
  await writeFile(invalid, "occupied");
  const unavailable = createWorkspace(invalid);
  await assert.rejects(unavailable.save(newCanvas()));
  await rm(invalid);
  await unavailable.save(newCanvas());
  const canvas = (await unavailable.load()).canvases[0];
  const bad = { ...canvas, draftImages: [{ id: "missing", width: 1, height: 1, mime: "image/png" }] };
  await assert.rejects(unavailable.save(bad));
  assert.deepEqual((await unavailable.load()).canvases[0], canvas);
  await unavailable.save({ ...canvas, draft: "Retry succeeded" });
  assert.equal((await unavailable.load()).canvases[0].draft, "Retry succeeded");
});

test("workspace APIs retain Host/Origin guards, store binary bytes and reject traversal", async (t) => {
  const dir = await temporary(t);
  const server = createServer(createApp({ connections: [{ id: "deepseek", key: "synthetic", baseUrl: "https://api.deepseek.com" }], dataDir: dir }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { Origin: origin, "Content-Type": "application/json" };
  let response = await fetch(origin + "/api/workspace/preferences", { method: "PUT", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" });
  assert.equal(response.status, 403);
  const canvas = newCanvas();
  response = await fetch(origin + `/api/workspace/canvases/${canvas.id}`, { method: "PUT", headers, body: JSON.stringify(canvas) });
  assert.equal(response.status, 200);
  response = await fetch(origin + "/api/workspace/attachments/source-pdf", { method: "PUT", headers: { Origin: origin, "Content-Type": "application/pdf" }, body: new Uint8Array([37, 80, 68, 70, 0, 255]) });
  assert.equal(response.status, 200);
  response = await fetch(origin + "/api/workspace/attachments/source-pdf");
  assert.equal(response.headers.get("Content-Type"), "application/pdf");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [37, 80, 68, 70, 0, 255]);
  assert.equal((await fetch(origin + "/api/workspace/attachments/%2e%2e%2fsecret")).status, 400);
  assert.equal((await (await fetch(origin + "/api/workspace")).json()).canvases[0].id, canvas.id);
});

test("removing a canvas deletes its file and forgets it as the active canvas", async (t) => {
  const dir = await temporary(t);
  const store = createWorkspace(dir);
  const keep = addTurn(newCanvas(), "Keep", null).canvas;
  const drop = addTurn(newCanvas(), "Drop", null).canvas;
  await store.save(keep);
  await store.save(drop);
  await store.setPreferences({ activeId: drop.id });
  await store.remove(drop.id);
  const result = await store.load();
  assert.deepEqual(result.canvases.map((c) => c.id), [keep.id]);
  assert.equal(result.activeId, undefined);
  await store.remove(drop.id);
  await assert.rejects(store.remove("../escape"), /Invalid workspace identifier/);
});

test("text files are attachments: saves need their bytes, and imports remap them", async (t) => {
  const dir = await temporary(t);
  const store = createWorkspace(dir);
  const canvas = addTurn(newCanvas(), "Read this", null, { files: [{ id: "code-1", name: "a.ts", bytes: 3, lines: 1 }] }).canvas;
  await assert.rejects(store.save(canvas), /attachment is missing/);
  await store.putAttachment("code-1", new TextEncoder().encode("x=1"), "text/plain;charset=utf-8");
  await store.save(canvas);
  const moved = await store.putAttachment("code-1", new TextEncoder().encode("y=2"), "text/plain;charset=utf-8", true);
  assert.notEqual(moved, "code-1");
  const first = await store.importCanvas(canvas, { "code-1": moved }, true);
  const second = await store.importCanvas(canvas, { "code-1": moved }, true);
  assert.notEqual(first, canvas.id);
  assert.notEqual(first, second, "each chosen import is its own canvas");
  const imported = (await store.load()).canvases.find((c) => c.id === first)!;
  assert.equal(imported.messages[0].files?.[0].id, moved);
});

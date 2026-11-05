import { api } from "./api";
import { openDB, type DBSchema } from "idb";
import type { Canvas } from "../shared/types";

interface CanvasDatabase extends DBSchema {
  canvases: { key: string; value: Canvas };
  preferences: { key: string; value: string };
  // Attachment bytes live outside canvas snapshots so frequent saves stay small. Safari
  // cannot store Blobs in IndexedDB, so bytes are kept as an ArrayBuffer.
  // Early v0.2 builds stored Blobs directly; those remain readable.
  images: { key: string; value: StoredImage | Blob };
}
type StoredImage = { mime: string; bytes: ArrayBuffer };
export function createBrowserRepository(name = "canvas-workspace") {
  const database = openDB<CanvasDatabase>(name, 2, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("canvases", { keyPath: "id" });
        db.createObjectStore("preferences");
      }
      if (oldVersion < 2) db.createObjectStore("images");
    },
  });
  // Serialize snapshots so a slower draft/position save cannot overwrite a later answer.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async setPreference(key: string, value: string) { await (await database).put("preferences", value, key); },
    async attachments() {
      const db = await database;
      return { keys: await db.getAllKeys("images"), values: await db.getAll("images") };
    },
    async load() {
      const db = await database;
      const canvases = await db.getAll("canvases");
      if (canvases.some((c) => c.version !== 1 || !Array.isArray(c.messages)))
        throw new Error(
          "This browser contains a canvas version that cannot be read. Your saved data has not been changed.",
        );
      const preferences: Record<string, string> = {};
      for (const key of ["canvas.sidebar", "canvas.model"]) {
        const value = await db.get("preferences", key);
        if (value !== undefined) preferences[key] = value;
      }
      return {
        canvases,
        activeId: await db.get("preferences", "activeCanvas"),
        preferences,
      };
    },
    save(canvas: Canvas) {
      const snapshot = structuredClone(canvas);
      const result = queue
        .catch(() => {})
        .then(async () => {
          const db = await database;
          const tx = db.transaction("canvases", "readwrite");
          await Promise.all([tx.done, tx.store.put(snapshot)]);
        });
      queue = result;
      return result;
    },
    async putImage(id: string, blob: Blob) {
      const image = { mime: blob.type, bytes: await blob.arrayBuffer() };
      await (await database).put("images", image, id);
    },
    async putAttachments(entries: { id: string; blob: Blob }[]) {
      const assets = await Promise.all(entries.map(async ({ id, blob }) => ({
        id,
        value: { mime: blob.type, bytes: await blob.arrayBuffer() },
      })));
      const db = await database;
      const tx = db.transaction("images", "readwrite");
      const writes: Promise<unknown>[] = [tx.done];
      try {
        for (const { id, value } of assets) {
          writes.push(tx.store.put(value, id));
        }
      } catch (error) {
        tx.abort();
        await Promise.allSettled(writes);
        throw error;
      }
      await Promise.all(writes);
    },
    async getImage(id: string, _signal?: AbortSignal) {
      const stored = await (await database).get("images", id);
      if (!stored || stored instanceof Blob) return stored;
      return new Blob([stored.bytes], { type: stored.mime });
    },
    async deleteImage(id: string) {
      await (await database).delete("images", id);
    },
    async setActive(id: string) {
      const db = await database;
      await db.put("preferences", id, "activeCanvas");
    },
    async close() {
      await queue.catch(() => {});
      (await database).close();
    },
  };
}


type Workspace = { canvases: Canvas[]; activeId?: string; preferences: Record<string, string> };
export function createRepository(legacyName?: string) {
  // Explicit database names retain the browser adapter for existing callers/tests.
  if (legacyName) return createBrowserRepository(legacyName);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => {
    const result = queue.catch(() => {}).then(work);
    queue = result;
    return result;
  };
  async function put(id: string, blob: Blob, importing = false) {
    return api<{ id: string }>(`/api/workspace/attachments/${encodeURIComponent(id)}${importing ? "?import=true" : ""}`, {
      method: "PUT", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob,
    });
  }
  const repo = {
    async load(): Promise<Workspace> {
      // Open the legacy DB only during import; retain all browser originals.
      const browser = createBrowserRepository();
      try {
        const legacy = await browser.load();
        const all = await browser.attachments();
        const remapped: Record<string, string> = {};
        for (let i = 0; i < all.keys.length; i++) {
          const value = all.values[i];
          const blob = value instanceof Blob ? value : new Blob([value.bytes], { type: value.mime });
          remapped[all.keys[i]] = (await put(all.keys[i], blob, true)).id;
        }
        let activeId = legacy.activeId;
        for (const canvas of legacy.canvases) {
          const imported = await api<{ id: string }>("/api/workspace/import", {
            method: "POST", body: JSON.stringify({ canvas, assets: remapped }),
          });
          if (canvas.id === legacy.activeId) activeId = imported.id;
        }
        const values: Record<string, string> = {};
        for (const key of ["canvas.sidebar", "canvas.model"]) {
          try { const value = localStorage.getItem(key); if (value !== null) values[key] = value; } catch { /* Optional browser preferences. */ }
        }
        await api("/api/workspace/preferences", { method: "PUT", body: JSON.stringify({ activeId, values, importOnly: true }) });
      } finally { await browser.close(); }
      return api<Workspace>("/api/workspace");
    },
    save(canvas: Canvas) {
      const snapshot = JSON.stringify(canvas);
      return serial(async () => { await api(`/api/workspace/canvases/${canvas.id}`, { method: "PUT", body: snapshot }); });
    },
    putImage(id: string, blob: Blob) { return serial(async () => { await put(id, blob); }); },
    putAttachments(entries: { id: string; blob: Blob }[]) {
      return serial(async () => { for (const entry of entries) await put(entry.id, entry.blob); });
    },
    getImage(id: string, signal?: AbortSignal) {
      return serial(async () => {
        if (signal?.aborted) return undefined;
        const response = await fetch(`/api/workspace/attachments/${encodeURIComponent(id)}`, { signal });
        if (response.status === 404) return undefined;
        if (!response.ok) throw new Error("Could not read the local attachment. Please retry.");
        return response.blob();
      });
    },
    deleteImage(id: string) { return serial(async () => { await api(`/api/workspace/attachments/${encodeURIComponent(id)}`, { method: "DELETE" }); }); },
    setActive(id: string) { return api<void>("/api/workspace/preferences", { method: "PUT", body: JSON.stringify({ activeId: id }) }); },
    setPreference(key: string, value: string) { return serial(async () => { await api("/api/workspace/preferences", { method: "PUT", body: JSON.stringify({ values: { [key]: value } }) }); }); },
    async close() { await queue.catch(() => {}); },
  };
  return repo;
}

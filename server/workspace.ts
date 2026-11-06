import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import { homedir } from "node:os";
import path from "node:path";
import type { Canvas } from "../shared/types";

export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
// Sort object keys so legacy snapshots do not depend on property insertion order.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function validCanvas(c: Canvas) {
  return c && c.version === 1 && validId(c.id) && typeof c.title === "string" &&
    typeof c.draft === "string" && Number.isFinite(c.updatedAt) && Array.isArray(c.messages) &&
    c.messages.every((m) => m && validId(m.id) && ["user", "assistant"].includes(m.role) && typeof m.content === "string" && Number.isFinite(m.position?.x) && Number.isFinite(m.position?.y)) &&
    Number.isFinite(c.viewport?.x) && Number.isFinite(c.viewport?.y) && Number.isFinite(c.viewport?.zoom);
}
type Preferences = { activeId?: string; values?: Record<string, string>; imports?: Record<string, string>; browserPreferencesImported?: boolean };
type Asset = { hash: string; mime: string };
// The platform's per-user application-data folder.
export function defaultDataDir(platform = process.platform, env = process.env, home = homedir()) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Canvas");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Canvas");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "canvas");
}
export function createWorkspace(directory = process.env.CANVAS_DATA_DIR || defaultDataDir()) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = queue.catch(() => {}).then(work);
    queue = result;
    return result;
  };
  const file = (kind: string, id: string) => {
    if (!validId(id)) throw new Error("Invalid workspace identifier.");
    return path.join(directory, kind, `${id}.json`);
  };
  async function json<T>(filename: string, fallback?: T): Promise<T> {
    try { return JSON.parse(await readFile(filename, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
  }
  async function atomic(filename: string, bytes: string | Uint8Array) {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, filename);
      const parent = await open(path.dirname(filename), "r");
      try { await parent.sync(); } finally { await parent.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  const prefFile = path.join(directory, "preferences.json");
  const preferences = () => json<Preferences>(prefFile, {});
  async function asset(id: string) { return json<Asset | null>(file("attachments", id), null); }
  async function checkAssets(c: Canvas) {
    const images = [...(c.draftImages || []), ...c.messages.flatMap((m) => m.images || [])];
    for (const id of new Set(images.flatMap((i) => [i.id, ...[i.pdf?.id, i.docx?.id].filter((v): v is string => !!v)]))) {
      const record = await asset(id);
      if (!record) throw new Error("An attachment is missing. Import or attach it again before saving.");
      // Refuse to acknowledge snapshots with missing bytes, including interrupted imports.
      const object = await stat(path.join(directory, "objects", record.hash));
      if (!object.isFile()) throw new Error("Attachment bytes cannot be read.");
    }
  }
  async function save(c: Canvas) {
    if (!validCanvas(c)) throw new Error("The canvas format cannot be saved.");
    await checkAssets(c);
    await atomic(file("canvases", c.id), JSON.stringify(c));
  }
  return {
    directory,
    load: () => serial(async () => {
      await mkdir(path.join(directory, "canvases"), { recursive: true, mode: 0o700 });
      const names = (await readdir(path.join(directory, "canvases"))).filter((n) => n.endsWith(".json"));
      const canvases = await Promise.all(names.map(async (n) => {
        const c = await json<Canvas>(path.join(directory, "canvases", n));
        if (!validCanvas(c)) throw new Error("A saved canvas cannot be read. Your files have not been changed.");
        for (const image of [...(c.draftImages ?? []), ...c.messages.flatMap(m => m.images ?? [])]) {
          const record = await asset(image.id);
          if (record) { try { image.bytes = (await stat(path.join(directory, "objects", record.hash))).size; } catch { /* Missing assets remain recoverable through the UI. */ } }
        }
        return c;
      }));
      const prefs = await preferences();
      return { canvases, activeId: prefs.activeId, preferences: prefs.values || {} };
    }),
    save: (c: Canvas) => { const snapshot = structuredClone(c); return serial(() => save(snapshot)); },
    preferences: () => serial(async () => (await preferences()).values || {}),
    setPreferences: (patch: { activeId?: string; values?: Record<string, string> }, importOnly = false) => serial(async () => {
      if (patch.activeId !== undefined && !validId(patch.activeId)) throw new Error("Invalid active canvas.");
      const prefs = await preferences();
      if (importOnly && prefs.browserPreferencesImported) return;
      if (patch.activeId && (!importOnly || !prefs.activeId)) prefs.activeId = patch.activeId;
      prefs.values = importOnly ? { ...patch.values, ...prefs.values } : { ...prefs.values, ...patch.values };
      if (importOnly) prefs.browserPreferencesImported = true;
      await atomic(prefFile, JSON.stringify(prefs));
    }),
    putAttachment: (id: string, bytes: Uint8Array, mime: string, importing = false) => serial(async () => {
      if (!validId(id) || typeof mime !== "string" || mime.length > 150 || /[\r\n]/.test(mime)) throw new Error("Invalid attachment.");
      const hash = digest(bytes);
      const existing = await asset(id);
      if (existing && (existing.hash !== hash || existing.mime !== mime)) {
        if (!importing) throw new Error("This attachment identifier already belongs to another file.");
        id = `import-${digest(`${id}:${mime}:${hash}`)}`;
      }
      if (existing?.hash === hash && existing.mime === mime) {
        try { if (digest(await readFile(path.join(directory, "objects", hash))) === hash) return id; } catch { /* Repair an interrupted object write. */ }
      }
      await atomic(path.join(directory, "objects", hash), bytes);
      await atomic(file("attachments", id), JSON.stringify({ hash, mime }));
      return id;
    }),
    attachmentInfo: async (id: string) => {
      const record = await asset(id);
      if (!record) return undefined;
      return { ...record, size: (await stat(path.join(directory, "objects", record.hash))).size, path: path.join(directory, "objects", record.hash) };
    },
    putAttachmentStream: async (id: string, input: Readable, mime: string, importing = false) => {
      if (!validId(id) || mime.length > 150 || /[\r\n]/.test(mime)) throw new Error("Invalid attachment.");
      await mkdir(path.join(directory, "objects"), { recursive: true, mode: 0o700 });
      const temporary = path.join(directory, "objects", `${randomUUID()}.tmp`);
      const hashState = createHash("sha256");
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { for await (const chunk of input) { hashState.update(chunk); await handle.writeFile(chunk); } await handle.sync(); }
        finally { await handle.close(); }
        const hash = hashState.digest("hex");
        return await serial(async () => {
          const existing = await asset(id);
          if (existing && (existing.hash !== hash || existing.mime !== mime)) {
            if (!importing) throw new Error("This attachment identifier already belongs to another file.");
            id = `import-${digest(`${id}:${mime}:${hash}`)}`;
          }
          await rename(temporary, path.join(directory, "objects", hash));
          const parent = await open(path.join(directory, "objects"), "r");
          try { await parent.sync(); } finally { await parent.close(); }
          await atomic(file("attachments", id), JSON.stringify({ hash, mime }));
          return id;
        });
      } finally { await unlink(temporary).catch(() => {}); }
    },
    getAttachment: (id: string) => serial(async () => {
      const record = await asset(id);
      return record ? { bytes: await readFile(path.join(directory, "objects", record.hash)), mime: record.mime } : undefined;
    }),
    deleteAttachment: (id: string) => serial(async () => {
      // Bytes are retained for backups and retryable legacy imports. Removing a
      // draft must never break another snapshot or an in-flight save.
      if (!validId(id)) throw new Error("Invalid attachment identifier.");
    }),
    importCanvas: (canvas: Canvas, assets: Record<string, string>) => serial(async () => {
      if (!validCanvas(canvas) || !assets || Object.values(assets).some((id) => !validId(id))) throw new Error("Invalid browser import.");
      const refs = [...(canvas.draftImages || []), ...canvas.messages.flatMap((m) => m.images || [])];
      const relevantAssets: Record<string, string> = {};
      for (const image of refs) for (const id of [image.id, image.pdf?.id, image.docx?.id].filter((v): v is string => !!v)) {
        relevantAssets[id] = assets[id];
        if (!assets[id]) throw new Error("A browser attachment has not been imported yet.");
      }
      const fingerprint = digest(canonical({ canvas, assets: relevantAssets }));
      const prefs = await preferences();
      const importedId = prefs.imports?.[fingerprint];
      if (importedId) return importedId;
      const copy = structuredClone(canvas);
      const remap = (images: Canvas["draftImages"]) => images?.map((image) => ({
        ...image, id: assets[image.id] || image.id,
        ...(image.pdf ? { pdf: { ...image.pdf, id: assets[image.pdf.id] || image.pdf.id } } : {}),
        ...(image.docx ? { docx: { ...image.docx, id: assets[image.docx.id] || image.docx.id } } : {}),
      }));
      copy.draftImages = remap(copy.draftImages);
      copy.messages = copy.messages.map((m) => ({ ...m, ...(m.images ? { images: remap(m.images) } : {}) }));
      const existing = await json<Canvas | null>(file("canvases", copy.id), null);
      if (existing && canonical(existing) !== canonical(copy)) copy.id = `import-${fingerprint}`;
      // Deterministic conflict IDs recover a crash between canvas and import receipt.
      const priorCopy = await json<Canvas | null>(file("canvases", copy.id), null);
      if (!priorCopy) await save(copy);
      prefs.imports = { ...prefs.imports, [fingerprint]: copy.id };
      await atomic(prefFile, JSON.stringify(prefs));
      return copy.id;
    }),
  };
}

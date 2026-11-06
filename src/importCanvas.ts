import { canvasAssets } from "../shared/attachments";
import { validId } from "../shared/ids";
import type { Canvas } from "../shared/types";

// Exports above this size would not fit comfortably in browser memory.
const MAX_EXPORT_BYTES = 1024 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;
const invalid = () => new Error("This file isn’t a complete Canvas JSON export. Export it again from Canvas; nothing was imported.");

// Reads a file written by "Export canvas as JSON": the canvas and the bytes of
// every attachment it refers to. The server checks the conversation graph.
export async function readExport(file: File) {
  if (file.size > MAX_EXPORT_BYTES) throw new Error("This export is larger than 1 GiB. Split the canvas in the source app before importing.");
  let data: unknown;
  try { data = JSON.parse(await file.text()); } catch { throw invalid(); }
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!record(data) || data.format !== "canvas" || data.version !== 1 || !Array.isArray(data.attachments) ||
    Object.keys(data).some(key => !["format", "version", "canvas", "attachments"].includes(key))) throw new Error("Choose a version-1 Canvas JSON export.");
  const canvas = data.canvas as Canvas;
  if (!record(canvas) || canvas.version !== 1 || !validId(canvas.id) || !Array.isArray(canvas.messages)) throw invalid();
  const expected = new Set(canvasAssets(canvas).keys());
  const seen = new Set<string>();
  const entries: { id: string; blob: Blob }[] = [];
  for (const attachment of data.attachments as Record<string, unknown>[]) {
    const encoded = attachment?.base64;
    const padding = typeof encoded === "string" && encoded.endsWith("==") ? 2 : typeof encoded === "string" && encoded.endsWith("=") ? 1 : 0;
    // A flat character-class scan handles large objects without a repeated
    // regex group overflowing the browser's regular-expression stack.
    if (!record(attachment) || !validId(attachment.id) || seen.has(attachment.id) || !expected.has(attachment.id) ||
      typeof attachment.mime !== "string" || attachment.mime.length > 150 || /[\r\n]/.test(attachment.mime) ||
      typeof encoded !== "string" || encoded.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || encoded.length % 4 !== 0 ||
      /[^A-Za-z0-9+/]/.test(encoded.slice(0, encoded.length - padding)))
      throw new Error("The export contains an invalid, duplicate, unused or oversized attachment. Restore a complete Canvas export; nothing was imported.");
    seen.add(attachment.id);
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    entries.push({ id: attachment.id, blob: new Blob([bytes], { type: attachment.mime }) });
  }
  if (expected.size !== seen.size) throw new Error("The export is missing attachment bytes. Export again from the original app; nothing was imported.");
  return { canvas, entries };
}

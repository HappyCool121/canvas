import type { Canvas } from "../shared/types";
import { canvasAssets } from "../shared/attachments";
import { blobToDataUrl } from "./images";

export async function downloadCanvas(
  snapshot: Canvas,
  load: (id: string) => Promise<Blob | undefined>,
) {
  // Read one object at a time. Large document exports must not open hundreds
  // of simultaneous transfers or duplicate the entire base64 bundle in memory.
  const chunks: BlobPart[] = [`{"format":"canvas","version":1,"canvas":${JSON.stringify(snapshot)},"attachments":[`];
  let separator = "";
  for (const [id, label] of canvasAssets(snapshot)) {
    const blob = await load(id);
    if (!blob?.size)
      throw new Error(`Attachment bytes for ${label} are missing from local storage. Restore the attachment before exporting.`);
    const url = await blobToDataUrl(blob);
    chunks.push(separator, JSON.stringify({ id, mime: blob.type, base64: url.slice(url.indexOf(",") + 1) }));
    separator = ",";
  }
  chunks.push("]}");
  const file = new Blob(chunks, { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.title.replace(/[^\p{L}\p{N} -]/gu, "_") || "Canvas"}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

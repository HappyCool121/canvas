import type { Canvas } from "../shared/types";
import { blobToDataUrl, documentPage } from "./images";

export async function downloadCanvas(
  snapshot: Canvas,
  load: (id: string) => Promise<Blob | undefined>,
) {
  const refs = new Map<string, string>();
  for (const image of [
    ...(snapshot.draftImages ?? []),
    ...snapshot.messages.flatMap((message) => message.images ?? []),
  ]) {
    const source = documentPage(image);
    refs.set(image.id, source ? `${source.name}, page ${source.page}` : "an attached image");
    if (source) refs.set(source.id, source.name);
  }
  const attachments = await Promise.all([...refs].map(async ([id, label]) => {
    const blob = await load(id);
    if (!blob?.size)
      throw new Error(`Attachment bytes for ${label} are missing from local storage. Restore the attachment before exporting.`);
    const url = await blobToDataUrl(blob);
    return { id, mime: blob.type, base64: url.slice(url.indexOf(",") + 1) };
  }));
  const file = new Blob([JSON.stringify({
    format: "canvas",
    version: 1,
    canvas: snapshot,
    attachments,
  }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${snapshot.title.replace(/[^\p{L}\p{N} -]/gu, "_") || "Canvas"}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

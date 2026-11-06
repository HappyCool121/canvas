import type { Canvas, ImageRef, TextFileRef } from "./types";

export const MAX_IMAGES = 600;
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 48 * 1024 * 1024;

export class AttachmentLimitError extends Error {}
export function checkImageBudget(sizes: readonly number[]) {
  if (sizes.length > MAX_IMAGES) throw new AttachmentLimitError(`A conversation can send at most ${MAX_IMAGES} images or document pages, including its ancestors.`);
  if (sizes.some(size => !Number.isSafeInteger(size) || size < 0 || size > MAX_IMAGE_BYTES)) throw new AttachmentLimitError("Each prepared image must be 64 MiB or smaller.");
  if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_IMAGE_BYTES) throw new AttachmentLimitError("The selected conversation and attachments exceed the 200 MiB image budget. Select fewer pages or branch from an earlier message.");
}

// Code and text files travel inline as text, so their limits are about
// context size rather than request size.
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_TEXT_FILES = 20;
export const TEXT_MIME = "text/plain;charset=utf-8";

// Attachment objects a canvas refers to, with a label for error messages:
// images, the documents their pages came from, and text files.
export function canvasAssets(c: Canvas): Map<string, string> {
  const refs = new Map<string, string>();
  for (const image of [...(c.draftImages ?? []), ...c.messages.flatMap((m) => m.images ?? [])]) {
    const source = image.pdf ?? image.docx;
    refs.set(image.id, source ? `${source.name}, page ${source.page}` : "an attached image");
    if (source) refs.set(source.id, source.name);
  }
  for (const file of [...(c.draftFiles ?? []), ...c.messages.flatMap((m) => m.files ?? [])]) refs.set(file.id, file.name);
  return refs;
}

// Points a canvas at the identifiers its attachments were stored under.
export function remapAssets(c: Canvas, assets: Record<string, string>): Canvas {
  const id = (old: string) => assets[old] || old;
  const images = (list: ImageRef[] | undefined) => list?.map((image) => ({
    ...image, id: id(image.id),
    ...(image.pdf ? { pdf: { ...image.pdf, id: id(image.pdf.id) } } : {}),
    ...(image.docx ? { docx: { ...image.docx, id: id(image.docx.id) } } : {}),
  }));
  const files = (list: TextFileRef[] | undefined) => list?.map((file) => ({ ...file, id: id(file.id) }));
  return {
    ...c,
    ...(c.draftImages ? { draftImages: images(c.draftImages) } : {}),
    ...(c.draftFiles ? { draftFiles: files(c.draftFiles) } : {}),
    messages: c.messages.map((m) => ({ ...m, ...(m.images ? { images: images(m.images) } : {}), ...(m.files ? { files: files(m.files) } : {}) })),
  };
}

import { AttachmentLimitError } from "../shared/attachments";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;
const assets = import.meta.env.DEV ? "/node_modules/pdfjs-dist/" : "/pdfjs/";

export async function renderPdf(
  file: File,
  signal: AbortSignal,
  selectPages: (total: number) => Promise<number[]>,
  onPage?: (blob: Blob) => void,
) {
  const data = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const task = getDocument({
    data,
    cMapUrl: assets + "cmaps/",
    iccUrl: assets + "iccs/",
    standardFontDataUrl: assets + "standard_fonts/",
    wasmUrl: assets + "wasm/",
    stopAtErrors: true,
    enableXfa: false,
  });
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
  });
  signal.addEventListener("abort", abort, { once: true });
  try {
    const pdf = await Promise.race([task.promise, cancelled]);
    const pages = await selectPages(pdf.numPages);
    const results = [];
    for (const page of pages) {
      signal.throwIfAborted();
      const source = await Promise.race([pdf.getPage(page), cancelled]);
      const { width, height } = source.getViewport({ scale: 1 });
      const viewport = source.getViewport({ scale: 1600 / Math.max(width, height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      try {
        const render = source.render({ canvas, viewport, background: "#fff" });
        const cancelRender = () => render.cancel();
        signal.addEventListener("abort", cancelRender, { once: true });
        try {
          await render.promise;
        } finally {
          signal.removeEventListener("abort", cancelRender);
        }
        signal.throwIfAborted();
        const mime = "image/jpeg";
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error("JPEG encoding failed")), mime, 0.85);
        });
        onPage?.(blob);
        results.push({ page, blob, mime, width: canvas.width, height: canvas.height });
      } finally {
        source.cleanup();
        canvas.width = canvas.height = 0;
      }
    }
    return results;
  } catch (error) {
    if ((error as Error).name === "PasswordException")
      throw new Error("This PDF is password-protected. Unlock it and attach the unlocked copy.");
    if (signal.aborted || error instanceof AttachmentLimitError) throw error;
    throw new Error("This PDF couldn’t be read or rendered. Open it in a PDF viewer and try saving a fresh copy.");
  } finally {
    signal.removeEventListener("abort", abort);
    await task.destroy().catch(() => {});
  }
}

import { AttachmentLimitError } from "../shared/attachments";
import { renderAsync } from "docx-preview";
import html2canvas from "html2canvas";

type Capture = { section: HTMLElement; top: number; width: number; height: number };

function planCaptures(section: HTMLElement): Capture[] {
  const bounds = section.getBoundingClientRect();
  const width = Math.ceil(bounds.width);
  const sheet = Math.round(parseFloat(getComputedStyle(section).minHeight)) || 1056;
  const height = Math.max(sheet, Math.ceil(bounds.height), section.scrollHeight);
  // Prefer a paragraph or table-row boundary close to the end of the sheet.
  const boundaries = [...section.querySelectorAll("p, tr")].flatMap((element) => {
    // Paragraphs in cells are not page boundaries across the full table.
    if (element.tagName === "P" && element.closest("table")) return [];
    return [Math.ceil(element.getBoundingClientRect().bottom - bounds.top)];
  }).sort((a, b) => a - b);
  const captures: Capture[] = [];
  let top = 0;
  while (top < height) {
    const limit = top + sheet;
    if (limit >= height) {
      captures.push({ section, top, width, height: height - top });
      break;
    }
    const boundary = boundaries.findLast((value) => value <= limit && value >= top + sheet * 0.75);
    const end = boundary ?? limit;
    captures.push({ section, top, width, height: end - top });
    // Keep a short overlap if the cut goes through a tall paragraph or row.
    top = boundary ?? Math.max(top + 1, end - 24);
  }
  return captures;
}

export async function renderDocx(
  file: File,
  signal: AbortSignal,
  selectPages: (total: number) => Promise<number[]>,
  onPage?: (blob: Blob) => void,
) {
  signal.throwIfAborted();
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // CSP keeps scripts and remote resources out while allowing html2canvas
  // to write its temporary clone in WebKit.
  frame.style.cssText = "position:fixed;left:-2400px;top:0;width:1800px;height:1200px;pointer-events:none;border:0";
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; frame-src about:; base-uri 'none'; form-action 'none'">
    <style>html,body{margin:0;background:white;color:black}</style></head><body></body></html>`;
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
  });
  signal.addEventListener("abort", abort, { once: true });

  try {
    const loaded = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
    document.body.append(frame);
    await Promise.race([loaded, cancelled]);
    const doc = frame.contentDocument!;
    const styles = doc.createElement("div");
    const root = doc.createElement("div");
    doc.body.append(styles, root);
    const prepare = async () => {
      await renderAsync(file, root, styles, {
        className: "canvas-docx",
        inWrapper: false,
        ignoreLastRenderedPageBreak: false,
        renderAltChunks: false,
        useBase64URL: true,
      });
      await Promise.all([
        doc.fonts.ready,
        ...[...root.querySelectorAll("img")].map((image) => image.decode().catch(() => {})),
      ]);
    };
    await Promise.race([prepare(), cancelled]);
    const pages = [...root.querySelectorAll<HTMLElement>(":scope > section")].flatMap(planCaptures);
    if (!pages.length) throw new Error("No rendered pages");
    const selected = await selectPages(pages.length);
    const results = [];
    for (const page of selected) {
      signal.throwIfAborted();
      const { section, top, width, height } = pages[page - 1];
      const canvas = await Promise.race([
        html2canvas(section, {
          y: top,
          width,
          height,
          scale: Math.min(2, 1600 / Math.max(width, height)),
          backgroundColor: "#fff",
          imageTimeout: 3000,
          logging: false,
        }),
        cancelled,
      ]);
      const mime = "image/jpeg";
      try {
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((value) => value ? resolve(value) : reject(new Error("JPEG encoding failed")), mime, 0.85);
        });
        onPage?.(blob);
        results.push({ page, blob, mime, width: canvas.width, height: canvas.height });
      } finally {
        canvas.width = canvas.height = 0;
      }
    }
    return results;
  } catch (error) {
    if (signal.aborted || error instanceof AttachmentLimitError) throw error;
    throw new Error("This DOCX couldn’t be read or rendered. Open it in a word processor, then save a fresh, unprotected DOCX or export it as PDF.");
  } finally {
    signal.removeEventListener("abort", abort);
    frame.remove();
  }
}

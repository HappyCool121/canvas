import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ImageRef } from "../shared/types";

export { MAX_IMAGES } from "../shared/attachments";
// DeepSeek scales images to about 1300×1300 pixels; more only costs bandwidth.
const MAX_EDGE = 1600;
const KEEP_ORIGINAL_BYTES = 1.5 * 1024 * 1024;

// Anything the browser can decode is accepted and converted when needed.
export function isImageFile(file: File) {
  return (
    file.type.startsWith("image/") ||
    (!file.type && /\.(heic|heif|avif|jxl)$/i.test(file.name))
  );
}

// DeepSeek accepts PNG, JPEG, GIF and WebP, detected from the bytes themselves.
async function sniff(file: Blob) {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const text = (from: number, to: number) =>
    String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && text(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (text(0, 4) === "GIF8") return "image/gif";
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return "image/webp";
  return null;
}

function unreadable(file: File) {
  const format = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase();
  return new Error(
    `This browser can't read ${format ? `${format} images` : "that image"}. Try a PNG or JPEG.`,
  );
}

// createImageBitmap first; an <img> decodes more formats in some browsers,
// such as HEIC in Safari.
async function decode(file: File) {
  try {
    const bitmap = await createImageBitmap(file);
    return {
      source: bitmap as CanvasImageSource,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  } catch {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    const decoded = await image.decode().then(
      () => image.naturalWidth > 0 && image.naturalHeight > 0,
      () => false,
    );
    if (!decoded) {
      URL.revokeObjectURL(url);
      throw unreadable(file);
    }
    return {
      source: image as CanvasImageSource,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  }
}

export async function prepareImage(file: File) {
  const format = await sniff(file);
  const decoded = await decode(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
  const width = Math.max(1, Math.round(decoded.width * scale));
  const height = Math.max(1, Math.round(decoded.height * scale));
  if (format && scale === 1 && file.size <= KEEP_ORIGINAL_BYTES) {
    decoded.release();
    return { blob: file.slice(0, file.size, format), mime: format, width, height };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  // Small PNGs keep transparency; everything else becomes a JPEG on white.
  const mime =
    format === "image/png" && width * height <= 1024 * 1024
      ? "image/png"
      : "image/jpeg";
  if (mime === "image/jpeg") {
    context.fillStyle = "#fff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(decoded.source, 0, 0, width, height);
  decoded.release();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(unreadable(file))),
      mime,
      0.85,
    ),
  );
  return { blob, mime, width, height };
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

type ImageLoader = (id: string) => Promise<string | undefined>;
export const ImageLoaderContext = createContext<ImageLoader>(async () =>
  undefined,
);

export function useImageUrl(id: string) {
  const load = useContext(ImageLoaderContext);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    load(id)
      .then((value) => {
        if (live) setUrl(value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id, load]);
  return url;
}

export function Thumbnail({ image }: { image: ImageRef }) {
  const [visible, setVisible] = useState(false);
  const element = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => setVisible(entries.some(e => e.isIntersecting)), { rootMargin: "120px" });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, []);
  return <span ref={element} className="thumbnail" style={{ aspectRatio: `${image.width} / ${image.height}` }}>{visible && <ThumbnailImage image={image} />}</span>;
}
function ThumbnailImage({ image }: { image: ImageRef }) {
  const url = useImageUrl(image.id);
  const page = documentPage(image);
  return url ? <img src={url} alt={page ? `${page.name}, page ${page.page}` : "Attached image"} draggable={false} /> : null;
}


export const documentPage = (image: ImageRef) => image.docx ?? image.pdf;

export function groupAttachments(images: ImageRef[]) {
  const groups = new Map<string, { id: string; name?: string; kind?: "PDF" | "DOCX"; images: ImageRef[] }>();
  for (const image of images) {
    const source = documentPage(image);
    const id = source?.id ?? image.id;
    const group = groups.get(id);
    if (group) group.images.push(image);
    else groups.set(id, { id, name: source?.name, kind: image.docx ? "DOCX" : image.pdf ? "PDF" : undefined, images: [image] });
  }
  return [...groups.values()];
}

export function documentLabel(name: string, images: ImageRef[]) {
  return `${name} · ${images.length === 1 ? "page" : "pages"} ${images.map((image) => documentPage(image)!.page).join(", ")}`;
}

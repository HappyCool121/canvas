import type { Message } from "./types";

export function plainTitle(text: string) {
  return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "").replace(/[#*_`>|~[\]]/g, "")
    .replace(/\s+/g, " ").trim();
}
export function messageTitle(message: Message): string {
  // Headings inside fenced code are examples, not message titles.
  const lines = message.content.split(/\r?\n/);
  let fence: string | undefined;
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (marker[1][0] === fence) fence = undefined; continue; }
    if (fence) continue;
    const atx = lines[i].match(/^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (atx) { heading = atx[1]; break; }
    if (lines[i].trim() && /^\s{0,3}(=+|-+)\s*$/.test(lines[i + 1] || "")) { heading = lines[i]; break; }
  }
  const text = plainTitle(heading || message.content);
  if (text) return text.length > 80 ? `${text.slice(0, 79).trimEnd()}…` : text;
  if (message.files?.length) return message.files.length === 1 ? message.files[0].name : `${message.files.length} files`;
  if (message.images?.some((i) => i.pdf)) return "PDF attachment";
  if (message.images?.some((i) => i.docx)) return "Word attachment";
  if (message.images?.length) return message.images.length === 1 ? "Image attachment" : `${message.images.length} image attachments`;
  return message.status === "pending" ? "Writing an answer…" : message.status === "interrupted" ? "Request interrupted" : message.status === "error" ? "Answer needs a retry" : "Empty message";
}
export const BUBBLE_COLORS = { white: "#ffffff", "pale-blue": "#d9eaf7", mist: "#e6eeeb", lavender: "#e5ddf6", coral: "#f5d8cd" } as const;

import { validId } from "./ids";

// Folders live in the account's "canvas.folders" preference as a JSON string.
// placement maps a canvas to its folder; unplaced canvases sit in "Your space".
// collapsed lists folder IDs, plus SHARED_FOLDER for "Shared with you".
export type Folder = { id: string; name: string };
export type Folders = { folders: Folder[]; placement: Record<string, string>; collapsed: string[] };
export const FOLDERS_KEY = "canvas.folders";
export const COLORS_KEY = "canvas.colors";
export const SHARED_FOLDER = "shared";
export const EMPTY_FOLDERS: Folders = { folders: [], placement: {}, collapsed: [] };
const MAX_FOLDERS = 100;
const MAX_BYTES = 64 * 1024;
export const MAX_SAVED_COLORS = 12;

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export const validFolderName = (name: unknown): name is string =>
  typeof name === "string" && name === name.trim() && name.length >= 1 && name.length <= 60;

export function validFolders(value: unknown): value is Folders {
  if (!record(value) || Object.keys(value).some(k => !["folders", "placement", "collapsed"].includes(k))) return false;
  const { folders, placement, collapsed } = value;
  if (!Array.isArray(folders) || folders.length > MAX_FOLDERS) return false;
  const ids = new Set<string>();
  for (const folder of folders) {
    if (!record(folder) || Object.keys(folder).some(k => !["id", "name"].includes(k)) || !validId(folder.id) || ids.has(folder.id) || !validFolderName(folder.name)) return false;
    ids.add(folder.id);
  }
  if (!record(placement) || Object.entries(placement).some(([canvas, folder]) => !validId(canvas) || typeof folder !== "string" || !ids.has(folder))) return false;
  return Array.isArray(collapsed) && collapsed.length <= MAX_FOLDERS + 1 && collapsed.every(id => id === SHARED_FOLDER || ids.has(id as string));
}
// The stored preference string, as the server accepts it.
export function validFoldersPreference(value: unknown) {
  if (typeof value !== "string" || value.length > MAX_BYTES) return false;
  try { return validFolders(JSON.parse(value)); } catch { return false; }
}
export function parseFolders(value: string | undefined): Folders {
  if (!value) return EMPTY_FOLDERS;
  try { const parsed = JSON.parse(value); return validFolders(parsed) ? parsed : EMPTY_FOLDERS; } catch { return EMPTY_FOLDERS; }
}

// Saved custom bubble colors ("#rrggbb"), newest first.
export function validColorsPreference(value: unknown) {
  if (typeof value !== "string" || value.length > 1024) return false;
  try {
    const colors = JSON.parse(value);
    return Array.isArray(colors) && colors.length <= MAX_SAVED_COLORS && colors.every(c => typeof c === "string" && /^#[0-9a-f]{6}$/.test(c));
  } catch { return false; }
}
export function parseColors(value: string | undefined): string[] {
  try { return value && validColorsPreference(value) ? JSON.parse(value) : []; } catch { return []; }
}

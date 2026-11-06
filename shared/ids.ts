// Identifiers for canvases, messages, folders and attachments.
export const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
// Custom bubble colors are stored as lowercase-insensitive "#rrggbb".
export const validHex = (value: unknown): value is `#${string}` => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);

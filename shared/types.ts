import type { ModelInfo } from "./models";

export type Role = "user" | "assistant";
// Browser requests use local attachment IDs; legacy callers may still send data URLs.
// Provider file IDs are resolved on the server; storage keeps image bytes separately.
export type ChatMessage = { role: Role; content: string; images?: string[]; attachmentIds?: string[]; fileIds?: string[] };
export type DocumentPageRef = { id: string; name: string; page: number };
export type ImageRef = {
  id: string;
  mime: string;
  bytes?: number;
  width: number;
  height: number;
  pdf?: DocumentPageRef;
  docx?: DocumentPageRef;
};
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  // Billing detail DeepSeek reports; the context meter ignores it.
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
};
export type Message = {
  role: Role;
  content: string;
  id: string;
  parentId: string | null;
  position: { x: number; y: number };
  createdAt: number;
  status: "complete" | "pending" | "error" | "interrupted";
  error?: string;
  truncated?: boolean;
  // The model requested for an answer; retries reuse it.
  model?: string;
  completedAt?: number;
  images?: ImageRef[];
  // The prompt this one rewrites. Visual only: context still follows parentId.
  editOf?: string;
  usage?: Usage;
  color?: "white" | "pale-blue" | "mist" | "lavender" | "coral";
  displayMode?: "preview" | "compact" | "expanded";
  sizes?: Partial<Record<"preview" | "compact" | "expanded", { width: number; height: number }>>;
  // Automatic top-left offset; negative y preserves upward pair orientation.
  // Manual dragging/resizing takes ownership and clears it.
  placementOffset?: { x: number; y: number };
  // Preferred center offset from the visual parent, set when the user drops a bubble.
  layoutOffset?: { x: number; y: number };
};
export type Canvas = {
  version: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  rootId: string | null;
  selectedId: string | null;
  readingPanelOpen?: boolean;
  draft: string;
  draftParentId: string | null;
  draftImages?: ImageRef[];
  editingId?: string | null;
  // Force layout revision used to settle the stored positions.
  layout?: "force" | "force-v2";
  viewport: { x: number; y: number; zoom: number };
  messages: Message[];
};
export type Completion = {
  content: string;
  model: string;
  finishReason: "stop" | "length";
  usage?: Usage;
};
// Never includes the key itself.
export type ProviderStatus = {
  connected: boolean;
  // "env" for DEEPSEEK_API_KEY at startup, "session" for a key entered in the app.
  source: "env" | "session" | null;
};
export type ProviderAdapter = {
  id: string;
  models: ModelInfo[];
  // Checks a key without inference. `available` is false when the account has no balance.
  validateKey?(key: string, signal: AbortSignal): Promise<{ available: boolean }>;
  upload?(key: string, bytes: Uint8Array, mime: string, signal: AbortSignal): Promise<string>;
  // Throws an ApiError for errors DeepSeek reports.
  generate(
    key: string,
    model: string,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): Promise<Completion>;
};

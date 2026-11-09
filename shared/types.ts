import type { Preset } from "./providers";

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
// A code or text file attached to a prompt. Its bytes live with the other
// attachments; the text is sent inline, so no tools are involved.
export type TextFileRef = {
  id: string;
  name: string;
  bytes: number;
  lines: number;
};
export type BubblePreset = "white" | "pale-blue" | "mist" | "lavender" | "coral";
export type BubbleColor = BubblePreset | `#${string}`;
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  // Billing detail some providers report; the context meter ignores it.
  promptCacheHitTokens?: number;
  promptCacheMissTokens?: number;
  // Estimated USD: the provider's reported charge, or catalog list prices.
  cost?: number;
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
  errorCode?: string;
  truncated?: boolean;
  // The provider and model requested for an answer; retries reuse them.
  // Answers without a provider were written by DeepSeek.
  provider?: string;
  profileId?: string;
  model?: string;
  completedAt?: number;
  images?: ImageRef[];
  files?: TextFileRef[];
  // The thinking level requested for an answer; absent means the provider's default.
  reasoning?: string;
  // The prompt this one rewrites. Visual only: context still follows parentId.
  editOf?: string;
  // Marks an answer that summarizes earlier context: `of` is the last message
  // summarized, on `canvasId` when that is another canvas. A summary starts
  // its own branch, so the summarized messages are no longer sent below it.
  summary?: { of: string; canvasId?: string };
  usage?: Usage;
  color?: BubbleColor;
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
  // The reading panel covers the whole canvas as a chat of the selected branch.
  readerExpanded?: boolean;
  draft: string;
  draftParentId: string | null;
  draftImages?: ImageRef[];
  draftFiles?: TextFileRef[];
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
// Never includes a key.
export type ProviderConnection = {
  id: string;
  // "env" for a key from .env, "session" for one entered in the app,
  // "saved" for a keyless local server remembered between restarts.
  source: "env" | "session" | "saved" | "plan";
  baseUrl: string;
};
export type PlanIssue = { code: string; message: string };
export type PlanAccount = {
  id: string;
  label: string;
  status: "connected" | "consent" | "revoked" | "disconnected" | "disconnecting";
};
export type ChatGPTPlanState = {
  accounts: PlanAccount[];
  activeId?: string;
  signingIn: boolean;
  welcomeId?: string;
  issue?: PlanIssue;
};
export type ProvidersState = {
  chatGPTPlan?: ChatGPTPlanState;
  presets: Preset[];
  connected: ProviderConnection[];
  // Addresses entered earlier, to fill in the form again.
  savedBaseUrls: Record<string, string>;
};

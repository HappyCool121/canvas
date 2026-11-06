import type { Canvas, ImageRef, Message } from "./types";

// Seed sizes for placing new bubbles. The live layout uses measured sizes.
export const CARD_WIDTH = 520;
export const CARD_HEIGHT = 210;
export const ROW_GAP = 56;
export const COLUMN_GAP = 90;
export const IMAGE_TOKENS = 1024;
export const IMAGE_NOTE = "[Image not shown: this model can’t view images]";
const uid = () => crypto.randomUUID();

export type HistoryMessage = {
  role: Message["role"];
  content: string;
  images?: ImageRef[];
};
export type LinkKind = "down" | "side";

export function newCanvas(): Canvas {
  const now = Date.now();
  return {
    version: 1,
    id: uid(),
    title: "Untitled canvas",
    createdAt: now,
    updatedAt: now,
    rootId: null,
    selectedId: null,
    draft: "",
    draftParentId: null,
    draftImages: [],
    editingId: null,
    viewport: { x: 0, y: 0, zoom: 1 },
    messages: [],
  };
}

export function ancestorPath(
  canvas: Canvas,
  messageId: string | null,
): Message[] {
  const byId = new Map(canvas.messages.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const result: Message[] = [];
  let id = messageId;
  while (id) {
    if (seen.has(id))
      throw new Error("This conversation contains a circular connection.");
    seen.add(id);
    const message = byId.get(id);
    if (!message) throw new Error("A message in this conversation is missing.");
    if (message.status !== "complete")
      throw new Error("Choose a completed message to continue.");
    result.unshift(message);
    id = message.parentId;
  }
  return result;
}

export function requestHistory(
  canvas: Canvas,
  assistantId: string,
): HistoryMessage[] {
  const answer = canvas.messages.find((m) => m.id === assistantId);
  if (!answer || answer.role !== "assistant" || !answer.parentId)
    throw new Error("Answer not found.");
  return ancestorPath(canvas, answer.parentId).map(
    ({ role, content, images }) =>
      images?.length ? { role, content, images } : { role, content },
  );
}

// For models without vision: each image becomes a note in the text.
export function withoutImages(history: HistoryMessage[]): HistoryMessage[] {
  return history.map(({ role, content, images }) =>
    images?.length
      ? {
          role,
          content: [content, ...images.map(() => IMAGE_NOTE)]
            .filter(Boolean)
            .join("\n\n"),
        }
      : { role, content },
  );
}

// The bubble a message hangs from on the map. Edits hang from the prompt they
// rewrite even though their context continues from that prompt's parent.
export function visualParent(message: Message) {
  return message.editOf ?? message.parentId;
}

export function linkKind(canvas: Canvas, message: Message): LinkKind | null {
  const parentId = visualParent(message);
  if (!parentId) return null;
  if (message.editOf) return "side";
  if (message.role === "assistant") return "down";
  const parent = canvas.messages.find((m) => m.id === parentId);
  if (parent?.role !== "assistant") return "side";
  const first = canvas.messages
    .filter((m) => m.parentId === parentId && !m.editOf)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  return first?.id === message.id ? "down" : "side";
}

export function estimateTokens(message: {
  content: string;
  images?: unknown[];
}) {
  return (
    Math.ceil(message.content.length / 4) +
    (message.images?.length ?? 0) * IMAGE_TOKENS +
    4
  );
}

// Tokens on the path to a message: exact from the latest reported usage,
// estimated for anything after it.
export function contextTokens(canvas: Canvas, messageId: string | null) {
  let path: Message[];
  try {
    path = ancestorPath(canvas, messageId);
  } catch {
    return 0;
  }
  let total = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const usage = path[i].usage;
    if (usage) return total + usage.promptTokens + usage.completionTokens;
    total += estimateTokens(path[i]);
  }
  return total;
}

export type PlacementRect = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };
const PAIR_GAP = 52;

export function responsePosition(prompt: PlacementRect, response: Size, upward: boolean) {
  return {
    x: prompt.x + (prompt.width - response.width) / 2,
    y: upward ? prompt.y - response.height - PAIR_GAP : prompt.y + prompt.height + PAIR_GAP,
  };
}

// Persisted automatic offsets are signed top-left deltas. Negative y keeps
// growing upward pairs attached by their lower edge instead of flipping below.
export function automaticOffset(parent: Size, child: Size, offset: { x: number; y: number }, response = false) {
  return {
    x: response ? 0 : offset.x + (child.width - parent.width) / 2,
    y: response || offset.y < 0
      ? (offset.y < 0 ? -1 : 1) * (parent.height / 2 + PAIR_GAP + child.height / 2)
      : offset.y + (child.height - parent.height) / 2,
  };
}
// Direction is chosen locally; collisions are resolved by insertion physics.
export function adjacentPosition(parent: PlacementRect, prompt: { width: number; height: number }, occupied: PlacementRect[], continuation = true, response?: Size) {
  const directions = continuation ? [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  const intersection = (a: PlacementRect, b: PlacementRect) => Math.max(0, Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  const candidates = directions.map(([dx,dy], order) => {
    const x = dx > 0 ? parent.x+parent.width+72 : dx < 0 ? parent.x-prompt.width-72 : parent.x+(parent.width-prompt.width)/2;
    const y = dy > 0 ? parent.y+parent.height+52 : dy < 0 ? parent.y-prompt.height-52 : parent.y;
    const area = {x,y,...prompt};
    const pair = response ? [area, { ...responsePosition(area, response, dy < 0), ...response }] : [area];
    const overlap = pair.reduce((total, bubble) => total + occupied.reduce((sum,r)=>sum+intersection(bubble,r),0), 0);
    const crowding = pair.reduce((total, bubble) => total + occupied.reduce((sum,r)=>sum+intersection({x:bubble.x-120,y:bubble.y-120,width:bubble.width+240,height:bubble.height+240},r),0), 0);
    return {x,y,score:overlap*4+crowding,order};
  });
  candidates.sort((a,b)=>a.score-b.score || a.order-b.order);
  return {x:candidates[0].x,y:candidates[0].y};
}
function positionFor(canvas: Canvas, anchor: Message | undefined, continuation: boolean, geometry?: Record<string, PlacementRect>, promptHeight = CARD_HEIGHT) {
  if (!anchor) return {x:0,y:0};
  const rect = (m: Message): PlacementRect => geometry?.[m.id] ?? {...m.position,...(m.sizes?.[m.displayMode || "preview"] ?? {width:CARD_WIDTH,height:CARD_HEIGHT})};
  return adjacentPosition(rect(anchor), {width:CARD_WIDTH,height:promptHeight}, canvas.messages.filter(m=>m.id!==anchor.id).map(rect), continuation, {width:CARD_WIDTH,height:CARD_HEIGHT});
}

export function addTurn(
  canvas: Canvas,
  text: string,
  parentId: string | null,
  options: { images?: ImageRef[]; editOf?: string; model?: string; provider?: string; profileId?: string; geometry?: Record<string, PlacementRect> } = {},
) {
  const images = options.images?.length ? options.images : undefined;
  if (!text.trim() && !images) throw new Error("Write a prompt first.");
  if (canvas.messages.some((m) => m.status === "pending"))
    throw new Error("An answer is already being written on this canvas.");
  const original = options.editOf
    ? canvas.messages.find((m) => m.id === options.editOf)
    : undefined;
  if (options.editOf && original?.role !== "user")
    throw new Error("Choose a prompt to edit.");
  // An edit replaces the original prompt in context, so it shares its parent.
  const contextParentId = original ? original.parentId : parentId;
  if (canvas.rootId && !contextParentId && !original)
    throw new Error("Select a completed message to continue.");
  ancestorPath(canvas, contextParentId);
  if (original) ancestorPath(canvas, original.id);
  const parent = canvas.messages.find((m) => m.id === contextParentId);
  const continuation =
    !original &&
    parent?.role === "assistant" &&
    !canvas.messages.some((m) => m.parentId === parent.id && !m.editOf);
  const promptHeight = CARD_HEIGHT;
  const position = positionFor(canvas, original ?? parent, continuation, options.geometry, promptHeight);
  const prompt: Message = {
    id: uid(),
    parentId: contextParentId,
    role: "user",
    content: text.trim(),
    position,
    createdAt: Date.now(),
    status: "complete",
    ...(images ? { images } : {}),
    ...(original ? { editOf: original.id } : {}),
  };
  const anchor = original ?? parent;
  if (anchor) {
    const a = options.geometry?.[anchor.id] ?? { ...anchor.position, width: CARD_WIDTH, height: CARD_HEIGHT };
    prompt.placementOffset = { x: position.x - a.x, y: position.y - a.y };
    prompt.layoutOffset = { x: position.x + CARD_WIDTH/2 - a.x - a.width/2, y: position.y + CARD_HEIGHT/2 - a.y - a.height/2 };
  }
  const upward = !!anchor && position.y < (options.geometry?.[anchor.id]?.y ?? anchor.position.y);
  const answerPosition = responsePosition({ ...position, width: CARD_WIDTH, height: promptHeight }, { width: CARD_WIDTH, height: CARD_HEIGHT }, upward);
  const answer: Message = {
    id: uid(),
    parentId: prompt.id,
    role: "assistant",
    content: "",
    position: answerPosition,
    createdAt: Date.now() + 1,
    status: "pending",
    placementOffset: { x: answerPosition.x-position.x, y: answerPosition.y-position.y },
    layoutOffset: { x: 0, y: answerPosition.y-position.y },
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.profileId ? { profileId: options.profileId } : {}),
  };
  return {
    canvas: {
      ...canvas,
      rootId: canvas.rootId || prompt.id,
      selectedId: prompt.id,
      draftParentId: prompt.id,
      title: canvas.rootId
        ? canvas.title
        : prompt.content.replace(/\s+/g, " ").slice(0, 60) || "Image prompt",
      draft: "",
      draftImages: [],
      editingId: null,
      updatedAt: Date.now(),
      messages: [...canvas.messages, prompt, answer],
    },
    answerId: answer.id,
  };
}

export function patchMessage(
  canvas: Canvas,
  id: string,
  patch: Partial<Message>,
): Canvas {
  return {
    ...canvas,
    updatedAt: Date.now(),
    messages: canvas.messages.map((m) =>
      m.id === id ? { ...m, ...patch } : m,
    ),
  };
}

export function recoverCanvas(canvas: Canvas): Canvas {
  return {
    ...canvas,
    messages: canvas.messages.map((m) =>
      m.status === "pending"
        ? {
            ...m,
            status: "interrupted",
            error: "This request was interrupted. Retry when you’re ready.",
          }
        : m,
    ),
  };
}

import type { Canvas, ImageRef, Message, TextFileRef } from "./types";
import { messageTitle } from "./titles";

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
  files?: TextFileRef[];
};
// Sent before a branch that starts with an answer: some providers refuse a
// conversation whose first message is the assistant's.
export const CONTINUE_NOTE = "Continue from this earlier answer.";
// A summary is sent as the answer to this turn, in place of the messages it summarizes.
export const SUMMARY_NOTE = "Summarize our earlier conversation.";
// Asks for the summary that replaces earlier context when a branch is cut loose.
export const SUMMARY_PROMPT = [
  "Summarize our conversation so far. The summary will replace these messages, and the conversation will continue from it alone.",
  "Don't answer or continue the conversation, including its last message; summarize it instead.",
  "Keep what is needed to continue: the goal and background, facts, names, numbers and decisions, what attached images, pages and files contained where it still matters, code or exact wording that is still needed, open questions, and the latest unanswered request, if any.",
  "Leave out pleasantries and anything settled that no longer matters. Don't add anything new.",
  "Write in the language of the conversation, as compact Markdown, starting with a short heading that names the topic.",
].join(" ");
export type LinkKind = "down" | "side";
export const UNTITLED = "Untitled canvas";

export function newCanvas(): Canvas {
  const now = Date.now();
  return {
    version: 1,
    id: uid(),
    title: UNTITLED,
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

// `unwritten` lets the path start at a summary still being written or retried,
// for showing the branch it starts. Nothing can be sent from there until it is written.
export function ancestorPath(
  canvas: Canvas,
  messageId: string | null,
  unwritten = false,
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
    if (message.status !== "complete" && !(unwritten && message.summary))
      throw new Error(message.summary
        ? "This branch’s summary isn’t written yet. Wait for it, retry it, or choose Continue without summary."
        : "Choose a completed message to continue.");
    result.unshift(message);
    id = message.parentId;
  }
  return result;
}

// The messages sent for a path. A summary stands in for what it summarizes, as
// the answer to SUMMARY_NOTE. An answer that follows no prompt, as at the top of
// a branch cut loose, gets CONTINUE_NOTE before it.
export function contextMessages(path: Message[]): HistoryMessage[] {
  const history: HistoryMessage[] = [];
  for (const { role, content, images, files, summary } of path) {
    if (summary) {
      history.push({ role: "user", content: SUMMARY_NOTE }, { role: "assistant", content });
      continue;
    }
    if (role === "assistant" && history.at(-1)?.role !== "user")
      history.push({ role: "user", content: CONTINUE_NOTE });
    history.push({
      role,
      content,
      ...(images?.length ? { images } : {}),
      ...(files?.length ? { files } : {}),
    });
  }
  return history;
}

// The request for an answer. A summary is written from the path it summarizes,
// which is on `source` when that is another canvas.
export function requestHistory(
  canvas: Canvas,
  assistantId: string,
  source: Canvas = canvas,
): HistoryMessage[] {
  const answer = canvas.messages.find((m) => m.id === assistantId);
  if (answer?.role === "assistant" && answer.summary)
    return [
      ...contextMessages(ancestorPath(source, answer.summary.of)),
      { role: "user", content: SUMMARY_PROMPT },
    ];
  if (!answer || answer.role !== "assistant" || !answer.parentId)
    throw new Error("Answer not found.");
  return contextMessages(ancestorPath(canvas, answer.parentId));
}

// For models without vision: each image becomes a note in the text.
export function withoutImages(history: HistoryMessage[]): HistoryMessage[] {
  return history.map(({ images, ...message }) =>
    images?.length
      ? {
          ...message,
          content: [message.content, ...images.map(() => IMAGE_NOTE)]
            .filter(Boolean)
            .join("\n\n"),
        }
      : message,
  );
}

// The bubble a message hangs from on the map. Edits hang from the prompt they
// rewrite even though their context continues from that prompt's parent.
export function visualParent(message: Message) {
  return message.editOf ?? message.parentId;
}

// Bubbles that hang from nothing: the first prompt, and branches cut loose.
export function rootIds(canvas: Canvas): string[] {
  return canvas.messages
    .filter((m) => !visualParent(m))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => m.id);
}

// The root a bubble's branch grows from on the map.
export function rootOf(canvas: Canvas, id: string): string | undefined {
  const byId = new Map(canvas.messages.map((m) => [m.id, m]));
  const seen = new Set<string>();
  let message = byId.get(id);
  while (message && !seen.has(message.id)) {
    seen.add(message.id);
    const parent = visualParent(message);
    if (!parent || !byId.has(parent)) return message.id;
    message = byId.get(parent);
  }
  return message?.id;
}

// A bubble and everything that hangs from it on the map.
export function branchIds(canvas: Canvas, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const m of canvas.messages) {
    const parent = visualParent(m);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), m.id]);
  }
  const ids = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const next = stack.pop()!;
    if (ids.has(next)) continue;
    ids.add(next);
    stack.push(...(children.get(next) ?? []));
  }
  return ids;
}

// Cuts every link from inside a branch to messages outside it. Context then
// starts at the branch's top bubble; an edit of that bubble starts fresh too.
function loosen(message: Message, branch: Set<string>): Message {
  const parentOut = !!message.parentId && !branch.has(message.parentId);
  const editOut = !!message.editOf && !branch.has(message.editOf);
  if (!parentOut && !editOut) return message;
  const { editOf, placementOffset, layoutOffset, ...rest } = message;
  const next: Message = { ...rest, parentId: parentOut ? null : message.parentId };
  if (!editOut && editOf) next.editOf = editOf;
  // A bubble that still hangs from something keeps its placement.
  if (visualParent(next)) {
    if (placementOffset) next.placementOffset = placementOffset;
    if (layoutOffset) next.layoutOffset = layoutOffset;
  }
  return next;
}

function checkBranch(canvas: Canvas, id: string) {
  const top = canvas.messages.find((m) => m.id === id);
  if (!top || top.status !== "complete") throw new Error("Choose a completed message to branch off.");
  const branch = branchIds(canvas, id);
  if (canvas.messages.some((m) => branch.has(m.id) && m.status === "pending"))
    throw new Error("Wait for the answer in this branch to finish, then try again.");
  return { top, branch };
}

// "Continue here": the branch stays on this canvas as another root.
export function detachBranch(canvas: Canvas, id: string): Canvas {
  const { top, branch } = checkBranch(canvas, id);
  if (!visualParent(top)) return canvas;
  return {
    ...canvas,
    updatedAt: Date.now(),
    messages: canvas.messages.map((m) => (branch.has(m.id) ? loosen(m, branch) : m)),
  };
}

// "New chat": a copy of the branch becomes a new canvas, starting at its top bubble.
export function copyBranch(canvas: Canvas, id: string): Canvas {
  const { top, branch } = checkBranch(canvas, id);
  const ids = new Map([...branch].map((old) => [old, uid()]));
  const map = (old: string | null | undefined) => (old ? ids.get(old) ?? null : null);
  const messages = canvas.messages
    .filter((m) => branch.has(m.id))
    .map((m) => {
      const loose = loosen(m, branch);
      const copy: Message = {
        ...structuredClone(loose),
        id: ids.get(m.id)!,
        parentId: map(loose.parentId),
        position: { x: m.position.x - top.position.x, y: m.position.y - top.position.y },
      };
      if (loose.editOf) copy.editOf = ids.get(loose.editOf)!;
      return copy;
    });
  const rootId = ids.get(top.id)!;
  const fresh = newCanvas();
  return {
    ...fresh,
    title: messageTitle(top).slice(0, 120),
    rootId,
    selectedId: rootId,
    draftParentId: rootId,
    layout: canvas.layout,
    viewport: { ...fresh.viewport, zoom: canvas.viewport.zoom },
    messages,
  };
}

// The model that writes a summary.
export type SummaryRoute = { provider: string; model: string; profileId?: string };

// Branching off with a summary. "detach" cuts the branch loose as above, with a
// pending summary of the context above it beside the branch as its new top
// bubble. "copy" starts a new canvas holding only a pending summary of the
// conversation up to and including this bubble.
export function summarizeBranch(
  canvas: Canvas,
  id: string,
  mode: "detach" | "copy",
  route: SummaryRoute,
  geometry?: Record<string, PlacementRect>,
) {
  const selected = canvas.messages.find((m) => m.id === id);
  if (selected && !selected.parentId) throw new Error("This bubble has no earlier context to summarize.");
  const pending = (summary: Message["summary"], position: Message["position"]): Message => ({
    id: uid(),
    parentId: null,
    role: "assistant",
    content: "",
    position,
    createdAt: Date.now(),
    status: "pending",
    summary,
    provider: route.provider,
    model: route.model,
    ...(route.profileId ? { profileId: route.profileId } : {}),
  });
  if (mode === "copy") {
    ancestorPath(canvas, id);
    const summary = pending({ of: id, canvasId: canvas.id }, { x: 0, y: 0 });
    const fresh = newCanvas();
    return {
      canvas: {
        ...fresh,
        title: messageTitle(selected!).slice(0, 120),
        rootId: summary.id,
        selectedId: summary.id,
        draftParentId: summary.id,
        layout: canvas.layout,
        viewport: { ...fresh.viewport, zoom: canvas.viewport.zoom },
        messages: [summary],
      },
      summaryId: summary.id,
      topId: undefined,
    };
  }
  const { top } = checkBranch(canvas, id);
  const of = top.parentId!;
  if (canvas.messages.some((m) => m.status === "pending"))
    throw new Error("An answer is already being written on this canvas.");
  ancestorPath(canvas, of);
  const target = detachBranch(canvas, id);
  const branch = branchIds(canvas, id);
  // The summary sits beside the top bubble, on its left where there is room, so
  // the bubbles around the branch stay where they are.
  const box = (m: Message): PlacementRect =>
    geometry?.[m.id] ?? { ...m.position, ...(m.sizes?.[m.displayMode || "preview"] ?? { width: CARD_WIDTH, height: CARD_HEIGHT }) };
  const rect = box(target.messages.find((m) => m.id === id)!);
  const position = adjacentPosition(rect, { width: CARD_WIDTH, height: CARD_HEIGHT },
    target.messages.filter((m) => m.id !== id).map(box), false, undefined,
    [[-1, 0], [1, 0], [-1, -1], [1, -1], [0, -1], [-1, 1], [1, 1], [0, 1]]);
  const summary = pending({ of }, position);
  // Cutting loose left the top bubble and its edits without a parent.
  const messages = target.messages.map((m): Message => {
    if (!branch.has(m.id) || m.parentId) return m;
    if (m.id !== id) return { ...m, parentId: summary.id };
    return {
      ...m,
      parentId: summary.id,
      placementOffset: { x: rect.x - position.x, y: rect.y - position.y },
      layoutOffset: {
        x: rect.x + rect.width / 2 - position.x - CARD_WIDTH / 2,
        y: rect.y + rect.height / 2 - position.y - CARD_HEIGHT / 2,
      },
    };
  });
  return {
    canvas: {
      ...target,
      // The summary opens in the reader as it is written, as a new answer does.
      selectedId: summary.id,
      draftParentId: summary.id,
      updatedAt: Date.now(),
      messages: [...messages, summary],
    },
    summaryId: summary.id,
    topId: id,
  };
}

// Where a summary cut a branch loose on this canvas: from the last message it
// summarized to the bubble that hung from it. The map draws these dotted, as
// context no longer flows along them.
export function summaryCuts(canvas: Canvas): { from: string; to: string }[] {
  const ids = new Set(canvas.messages.map((m) => m.id));
  return canvas.messages.flatMap((s) => {
    if (!s.summary || s.summary.canvasId || !ids.has(s.summary.of)) return [];
    // The cut bubble predates its summary and comes first; replies to the summary come later.
    const cut = canvas.messages.find((m) => m.parentId === s.id && !m.editOf && m.createdAt <= s.createdAt);
    return cut ? [{ from: s.summary.of, to: cut.id }] : [];
  });
}

// "Continue without summary": a summary that couldn't be written goes, and its
// branch is left loose, as if the earlier context had been left out.
export function dropSummary(canvas: Canvas, id: string): Canvas {
  const summary = canvas.messages.find((m) => m.id === id);
  if (!summary?.summary || (summary.status !== "error" && summary.status !== "interrupted")) return canvas;
  const rest = new Set(canvas.messages.filter((m) => m.id !== id).map((m) => m.id));
  const messages = canvas.messages.filter((m) => m.id !== id).map((m) => loosen(m, rest));
  const next = { ...canvas, messages };
  return {
    ...next,
    updatedAt: Date.now(),
    rootId: canvas.rootId === id ? rootIds(next)[0] ?? null : canvas.rootId,
    selectedId: canvas.selectedId === id ? null : canvas.selectedId,
    draftParentId: canvas.draftParentId === id ? null : canvas.draftParentId,
  };
}

export function linkKind(canvas: Canvas, message: Message): LinkKind | null {
  const parentId = visualParent(message);
  if (!parentId) return null;
  if (message.editOf) return "side";
  const parent = canvas.messages.find((m) => m.id === parentId);
  // A summary sits beside the branch it starts.
  if (parent?.summary) return "side";
  if (message.role === "assistant") return "down";
  if (parent?.role !== "assistant") return "side";
  const first = canvas.messages
    .filter((m) => m.parentId === parentId && !m.editOf)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
  return first?.id === message.id ? "down" : "side";
}

export function estimateTokens(message: {
  content: string;
  images?: unknown[];
  files?: { bytes: number }[];
}) {
  return (
    Math.ceil(message.content.length / 4) +
    Math.ceil((message.files ?? []).reduce((sum, file) => sum + file.bytes, 0) / 4) +
    (message.images?.length ?? 0) * IMAGE_TOKENS +
    4
  );
}

// Tokens on the path to a message: exact from the latest reported usage,
// estimated for anything after it.
export function contextTokens(canvas: Canvas, messageId: string | null) {
  let path: Message[];
  try {
    path = ancestorPath(canvas, messageId, true);
  } catch {
    return 0;
  }
  // Usage reported before a summary, and the summary's own, counted the
  // context it replaced.
  const since = path[0]?.summary ? path[0].createdAt : -Infinity;
  let total = 0;
  for (let i = path.length - 1; i >= 0; i--) {
    const usage = path[i].createdAt > since ? path[i].usage : undefined;
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
export function adjacentPosition(parent: PlacementRect, prompt: { width: number; height: number }, occupied: PlacementRect[], continuation = true, response?: Size, order?: number[][]) {
  const directions = order ?? (continuation ? [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]] : [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]);
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
  options: { images?: ImageRef[]; files?: TextFileRef[]; editOf?: string; model?: string; provider?: string; profileId?: string; reasoning?: string; geometry?: Record<string, PlacementRect> } = {},
) {
  const images = options.images?.length ? options.images : undefined;
  const files = options.files?.length ? options.files : undefined;
  if (!text.trim() && !images && !files) throw new Error("Write a prompt first.");
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
    ...(files ? { files } : {}),
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
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  };
  return {
    canvas: {
      ...canvas,
      rootId: canvas.rootId || prompt.id,
      selectedId: prompt.id,
      draftParentId: prompt.id,
      // A canvas the person named keeps its name.
      title: canvas.rootId || canvas.title !== UNTITLED
        ? canvas.title
        : prompt.content.replace(/\s+/g, " ").slice(0, 60) || (files ? files[0].name.slice(0, 60) : "Image prompt"),
      draft: "",
      draftImages: [],
      draftFiles: [],
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

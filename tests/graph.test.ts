import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addTurn,
  adjacentPosition,
  automaticOffset,
  responsePosition,
  ancestorPath,
  CARD_HEIGHT,
  CARD_WIDTH,
  contextTokens,
  IMAGE_NOTE,
  IMAGE_TOKENS,
  linkKind,
  newCanvas,
  patchMessage,
  recoverCanvas,
  requestHistory,
  visualParent,
  withoutImages,
  branchIds,
  CONTINUE_NOTE,
  copyBranch,
  detachBranch,
  estimateTokens,
  rootIds,
  rootOf,
  dropSummary,
  leaveOutSummary,
  summarizeBranch,
  SUMMARY_NOTE,
  SUMMARY_PROMPT,
  summaryCuts,
} from "../shared/graph";
import type { Canvas } from "../shared/types";
import { canvasUsage } from "../shared/usage";

function complete(canvas: Canvas, text: string, parent: string | null) {
  const turn = addTurn(canvas, text, parent);
  return {
    ...turn,
    canvas: patchMessage(turn.canvas, turn.answerId, {
      status: "complete",
      content: `Answer to ${text}`,
    }),
  };
}

test("branches use only the selected ancestor path, even after dragging and later replies", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "Main continuation", root.answerId);
  const later = complete(main.canvas, "Later thought", main.answerId);
  const sibling = addTurn(later.canvas, "Alternative", root.answerId);
  assert.deepEqual(requestHistory(sibling.canvas, sibling.answerId), [
    { role: "user", content: "Root question" },
    { role: "assistant", content: "Answer to Root question" },
    { role: "user", content: "Alternative" },
  ]);
  const moved = {
    ...sibling.canvas,
    messages: sibling.canvas.messages.map((m) => ({
      ...m,
      position: { x: -500, y: 900 },
    })),
  };
  assert.deepEqual(
    requestHistory(moved, sibling.answerId),
    requestHistory(sibling.canvas, sibling.answerId),
  );
  assert.equal(
    sibling.canvas.messages.find((m) => m.id === main.answerId)?.content,
    "Answer to Main continuation",
  );
});

test("branching from a user message preserves consecutive user roles and excludes its answer", () => {
  const root = complete(newCanvas(), "Original question", null);
  const branch = addTurn(root.canvas, "Clarification", root.canvas.rootId);
  assert.deepEqual(requestHistory(branch.canvas, branch.answerId), [
    { role: "user", content: "Original question" },
    { role: "user", content: "Clarification" },
  ]);
  assert.ok(Math.abs(branch.canvas.messages.at(-2)!.position.x) <= CARD_WIDTH+90);
});

test("branches stay adjacent even when surrounding candidates are crowded", () => {
  const root = complete(newCanvas(), "Root", null);
  const main = complete(root.canvas, "Main", root.answerId);
  assert.ok(Number.isFinite(main.canvas.messages.at(-2)!.position.x));
  assert.ok(
    main.canvas.messages.at(-2)!.position.y >
      root.canvas.messages.at(-1)!.position.y,
  );
  let current = main.canvas;
  for (let i = 0; i < 8; i++)
    current = complete(current, `Branch ${i}`, root.answerId).canvas;
  const anchor = root.canvas.messages[1];
  for (const message of current.messages.filter(m => m.role === "user" && m.parentId === root.answerId)) {
    assert.ok(Math.abs(message.position.x-anchor.position.x) <= CARD_WIDTH+90);
    assert.ok(Math.abs(message.position.y-anchor.position.y) <= CARD_HEIGHT+56);
  }
});

test("pending requests block duplicate submission; recovery preserves IDs and completed ancestors", () => {
  const turn = addTurn(newCanvas(), "Do not lose this", null);
  assert.throws(
    () => addTurn(turn.canvas, "Duplicate", turn.canvas.rootId),
    /already/,
  );
  const recovered = recoverCanvas(turn.canvas);
  assert.equal(recovered.messages.at(-1)?.status, "interrupted");
  assert.equal(recovered.messages.at(-1)?.id, turn.answerId);
  assert.equal(recovered.messages[0].content, "Do not lose this");
  const retry = patchMessage(recovered, turn.answerId, {
    status: "pending",
    error: undefined,
  });
  assert.equal(retry.messages.length, 2);
  assert.deepEqual(requestHistory(retry, turn.answerId), [
    { role: "user", content: "Do not lose this" },
  ]);
});

test("missing parents, cycles, incomplete ancestors, empty prompts and second roots are rejected", () => {
  const turn = complete(newCanvas(), "Root", null);
  assert.throws(() => ancestorPath(turn.canvas, "missing"), /missing/);
  const cycle = patchMessage(turn.canvas, turn.canvas.rootId!, {
    parentId: turn.answerId,
  });
  assert.throws(() => ancestorPath(cycle, turn.answerId), /circular/);
  assert.throws(() => addTurn(turn.canvas, "", turn.answerId), /prompt/);
  assert.throws(() => addTurn(turn.canvas, "Second root", null), /Select/);
});

const image = { id: "image-1", mime: "image/png", width: 640, height: 480 };

test("an edited prompt hangs from the original but replaces it in context", () => {
  const root = complete(newCanvas(), "Root", null);
  const original = complete(root.canvas, "Tell me about cats", root.answerId);
  const promptId = original.canvas.messages.at(-2)!.id;
  const edit = addTurn(original.canvas, "Tell me about dogs", null, {
    editOf: promptId,
  });
  const rewritten = edit.canvas.messages.at(-2)!;
  assert.equal(rewritten.editOf, promptId);
  assert.equal(rewritten.parentId, root.answerId);
  assert.equal(visualParent(rewritten), promptId);
  assert.deepEqual(requestHistory(edit.canvas, edit.answerId), [
    { role: "user", content: "Root" },
    { role: "assistant", content: "Answer to Root" },
    { role: "user", content: "Tell me about dogs" },
  ]);
  assert.equal(linkKind(edit.canvas, rewritten), "side");
  assert.equal(linkKind(edit.canvas, edit.canvas.messages.at(-1)!), "down");
  // The original prompt keeps its place as the continuation of the root answer.
  const originalPrompt = edit.canvas.messages.find((m) => m.id === promptId)!;
  assert.equal(linkKind(edit.canvas, originalPrompt), "down");
  assert.notEqual(rewritten.position.x, originalPrompt.position.x);
  assert.equal(
    edit.canvas.messages.find((m) => m.id === original.answerId)?.content,
    "Answer to Tell me about cats",
  );
});

test("editing the root prompt starts a second tree without moving the root", () => {
  const root = complete(newCanvas(), "Original root", null);
  const edit = addTurn(root.canvas, "Better root", null, {
    editOf: root.canvas.rootId!,
  });
  assert.equal(edit.canvas.rootId, root.canvas.rootId);
  assert.equal(edit.canvas.messages.at(-2)!.parentId, null);
  assert.deepEqual(requestHistory(edit.canvas, edit.answerId), [
    { role: "user", content: "Better root" },
  ]);
  assert.throws(
    () => addTurn(root.canvas, "Edit", null, { editOf: root.answerId }),
    /prompt to edit/,
  );
});

test("image-only prompts are allowed and carry their images into history", () => {
  const turn = addTurn(newCanvas(), "  ", null, { images: [image] });
  assert.equal(turn.canvas.title, "Image prompt");
  assert.deepEqual(requestHistory(turn.canvas, turn.answerId), [
    { role: "user", content: "", images: [image] },
  ]);
  assert.equal(turn.canvas.draftImages?.length, 0);
  assert.throws(() => addTurn(newCanvas(), " ", null, { images: [] }), /prompt/);
});

test("continuations link downward; alternatives and user-prompt branches link sideways on alternating sides", () => {
  const root = complete(newCanvas(), "Root", null);
  const main = complete(root.canvas, "Main", root.answerId);
  const right = complete(main.canvas, "Right", root.answerId);
  const left = complete(right.canvas, "Left", root.answerId);
  const kind = (id: string) =>
    linkKind(left.canvas, left.canvas.messages.find((m) => m.id === id)!);
  const promptOf = (answerId: string) =>
    left.canvas.messages.find((m) => m.id === answerId)!.parentId!;
  assert.equal(kind(root.canvas.rootId!), null);
  assert.equal(kind(root.answerId), "down");
  assert.equal(kind(promptOf(main.answerId)), "down");
  assert.equal(kind(promptOf(right.answerId)), "side");
  assert.equal(kind(promptOf(left.answerId)), "side");
  const x = (answerId: string) =>
    left.canvas.messages.find((m) => m.id === promptOf(answerId))!.position.x;
  const anchor = left.canvas.messages.find((m) => m.id === root.answerId)!;
  assert.ok(x(right.answerId) > anchor.position.x);
  assert.notDeepEqual(left.canvas.messages.at(-2)!.position, right.canvas.messages.at(-2)!.position);
  const userBranch = addTurn(left.canvas, "Clarify", root.canvas.rootId);
  assert.equal(
    linkKind(userBranch.canvas, userBranch.canvas.messages.at(-2)!),
    "side",
  );
});

test("context tokens use the latest reported usage and estimate what follows", () => {
  const root = complete(newCanvas(), "Root", null);
  const estimated = contextTokens(root.canvas, root.answerId);
  assert.equal(
    estimated,
    Math.ceil("Root".length / 4) + 4 + Math.ceil("Answer to Root".length / 4) + 4,
  );
  const measured = patchMessage(root.canvas, root.answerId, {
    usage: { promptTokens: 900, completionTokens: 100 },
  });
  assert.equal(contextTokens(measured, root.answerId), 1000);
  const next = addTurn(measured, "x".repeat(40), root.answerId, {
    images: [image],
  });
  const promptId = next.canvas.messages.at(-2)!.id;
  assert.equal(contextTokens(next.canvas, promptId), 1000 + 10 + 4 + IMAGE_TOKENS);
  assert.equal(contextTokens(next.canvas, null), 0);
  assert.equal(contextTokens(next.canvas, next.answerId), 0);
});

test("models without vision get a note per image instead of the image", () => {
  const turn = addTurn(newCanvas(), "Compare these", null, {
    images: [image, { ...image, id: "image-2" }],
    model: "deepseek-v4-pro",
  });
  assert.equal(turn.canvas.messages.at(-1)!.model, "deepseek-v4-pro");
  const onlyImage = addTurn(newCanvas(), "", null, { images: [image] });
  assert.deepEqual(
    withoutImages(requestHistory(turn.canvas, turn.answerId)),
    [
      {
        role: "user",
        content: `Compare these\n\n${IMAGE_NOTE}\n\n${IMAGE_NOTE}`,
      },
    ],
  );
  assert.deepEqual(
    withoutImages(requestHistory(onlyImage.canvas, onlyImage.answerId)),
    [{ role: "user", content: IMAGE_NOTE }],
  );
});

test("canvas billing reports partial usage for older answers and uses current Flash rates for legacy IDs", () => {
  const initial = newCanvas();
  const first = complete(initial, "First", null);
  const second = complete(first.canvas, "Follow-up", first.answerId);
  const third = complete(second.canvas, "Another branch", first.answerId);
  const canvas = patchMessage(
    patchMessage(third.canvas, second.answerId, {
      model: "deepseek-v4-flash-vision-exp",
      usage: { promptTokens: 1000, completionTokens: 500 },
    }),
    third.answerId,
    {
      model: "deepseek-v4-pro",
      usage: {
        promptTokens: 1000,
        completionTokens: 500,
        promptCacheHitTokens: 800,
        promptCacheMissTokens: 200,
      },
    },
  );
  const usage = canvasUsage(canvas);
  assert.equal(usage.tokens, 3000);
  assert.equal(usage.missingUsage, true);
  assert.equal(usage.partial, true);
  assert.ok(Math.abs(usage.cost - 0.0015896) < 1e-12);
  // Stored costs win; another provider's answer without one is partial.
  const withCost = patchMessage(canvas, first.answerId, { provider: "openai", model: "gpt-x", usage: { promptTokens: 10, completionTokens: 5, cost: 0.25 } });
  assert.ok(Math.abs(canvasUsage(withCost).cost - 0.2515896) < 1e-12);
  assert.equal(canvasUsage(withCost).missingUsage, false);
  const unpriced = patchMessage(withCost, first.answerId, { provider: "ollama", model: "llama3", usage: { promptTokens: 10, completionTokens: 5 } });
  assert.equal(canvasUsage(unpriced).partial, true);
});

test("placement uses measured rectangles, avoids a crowded side, and leaves existing positions untouched", () => {
  const root = complete(newCanvas(), 'Root', null);
  const anchor = root.canvas.messages[1];
  const geometry = Object.fromEntries(root.canvas.messages.map(m => [m.id, {...m.position,width:520,height:210}]));
  geometry[root.canvas.rootId!] = {x:anchor.position.x+550,y:anchor.position.y-1000,width:3000,height:4000};
  const before = structuredClone(root.canvas.messages);
  const branch = addTurn(root.canvas,'Use available space',root.canvas.rootId,{geometry});
  const position = branch.canvas.messages.at(-2)!.position;
  assert.ok(position.x < geometry[root.canvas.rootId!].x || position.x > geometry[root.canvas.rootId!].x+3000);
  assert.deepEqual(branch.canvas.messages.slice(0,-2),before);
  assert.deepEqual(addTurn(root.canvas,'Same placement',root.canvas.rootId,{geometry}).canvas.messages.at(-2)!.position, position);
});


test("adjacent placement chooses open directions without escaping fully crowded surroundings", () => {
  const parent={x:0,y:0,width:400,height:120}, prompt={width:160,height:80};
  const right={x:450,y:-100,width:800,height:500};
  const p=adjacentPosition(parent,prompt,[right],false);
  assert.ok(p.x<0,"a crowded right side favours the left");
  const crowded=[{x:-10000,y:-10000,width:20000,height:20000}];
  const q=adjacentPosition(parent,prompt,crowded);
  assert.ok(Math.abs(q.x)<=472 && Math.abs(q.y)<=172,"crowding never causes an expanding search");
  assert.deepEqual(adjacentPosition(parent,prompt,crowded),q);
});


test("placement scores both bubbles and reverses upward pairs including diagonals", () => {
  const parent = { x:0, y:0, width:400, height:120 };
  const promptSize = { width:160, height:80 }, answerSize = { width:160, height:300 };
  const blocker = { x:472, y:250, width:160, height:300 };
  assert.ok(adjacentPosition(parent, promptSize, [blocker], false).x > 0, "the prompt alone fits on the right");
  assert.ok(adjacentPosition(parent, promptSize, [blocker], false, answerSize).x < 0, "the pair avoids the blocked response space");
  for (const diagonal of [false, true]) {
    const canvas = newCanvas();
    const rects = [parent, { x:-10000, y:0, width:20000, height:5000 },
      ...(diagonal ? [{ x:-60, y:-2000, width:520, height:1900 }] : [])];
    canvas.messages = rects.map((r,i) => ({ id:`n${i}`, parentId:i ? "n0" : null, role:i ? "assistant" : "user", status:"complete", content:`bubble ${i}`, position:{x:r.x,y:r.y}, createdAt:i }));
    canvas.rootId = "n0";
    const geometry = Object.fromEntries(rects.map((r,i) => [`n${i}`, r]));
    const turn = addTurn(canvas, "Upward", "n0", { geometry });
    const [prompt, answer] = turn.canvas.messages.slice(-2);
    assert.ok(prompt.position.y < parent.y);
    if (diagonal) assert.ok(prompt.position.x > parent.x+parent.width || prompt.position.x+CARD_WIDTH < parent.x);
    assert.ok(answer.position.y+CARD_HEIGHT < prompt.position.y);
    assert.ok(prompt.placementOffset!.y < 0 && answer.placementOffset!.y < 0);
    assert.deepEqual(turn.canvas.messages.slice(0,-2), canvas.messages);
    assert.deepEqual(answer.position, responsePosition({...prompt.position,width:CARD_WIDTH,height:CARD_HEIGHT}, {width:CARD_WIDTH,height:CARD_HEIGHT}, true));
  }
});

test("signed automatic offsets preserve upward ordering as unequal bubbles grow", () => {
  const parent = { width:330, height:110 };
  for (const height of [72, 240, 730]) {
    const child = { width:520, height };
    for (const response of [false, true]) {
      const offset = automaticOffset(parent,child,{x:0,y:-262},response);
      assert.equal(offset.y+child.height/2, -parent.height/2-52);
      if (response) assert.equal(offset.x,0);
    }
    const down = automaticOffset(parent,child,{x:0,y:262},true);
    assert.equal(down.y-child.height/2,parent.height/2+52);
  }
});

test("cutting a branch loose makes it a root whose context starts there", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "Main continuation", root.answerId);
  const deeper = complete(main.canvas, "Deeper", main.answerId);
  const promptId = deeper.canvas.messages.find((m) => m.content === "Main continuation")!.id;
  // An edit of the cut prompt hangs from it but shares its old context parent.
  const edited = addTurn(deeper.canvas, "Main, rewritten", null, { editOf: promptId });
  const withEdit = patchMessage(edited.canvas, edited.answerId, { status: "complete", content: "Edited answer" });
  assert.deepEqual(rootIds(withEdit), [withEdit.rootId]);
  assert.equal(branchIds(withEdit, promptId).size, 6, "the prompt, its answer, the follow-up pair and the edit pair");
  const cut = detachBranch(withEdit, promptId);
  const roots = rootIds(cut);
  assert.equal(roots.length, 2);
  assert.equal(roots[1], promptId);
  const prompt = cut.messages.find((m) => m.id === promptId)!;
  assert.equal(prompt.parentId, null);
  assert.equal(prompt.layoutOffset, undefined);
  const editPrompt = cut.messages.find((m) => m.content === "Main, rewritten")!;
  assert.equal(editPrompt.parentId, null, "the edit no longer reaches the old ancestors");
  assert.equal(editPrompt.editOf, promptId, "and still hangs from the prompt it rewrites");
  assert.deepEqual(requestHistory(cut, deeper.answerId).map((m) => m.content), ["Main continuation", "Answer to Main continuation", "Deeper"]);
  assert.equal(rootOf(cut, deeper.answerId), promptId);
  assert.equal(rootOf(cut, root.answerId), cut.rootId);
  assert.equal(detachBranch(cut, promptId), cut, "a root is already loose");
  assert.throws(() => detachBranch(addTurn(cut, "Pending", deeper.answerId).canvas, promptId), /Wait for the answer/);
});

test("a branch that starts with an answer sends a short user turn first", () => {
  const root = complete(newCanvas(), "Root question", null);
  const next = complete(root.canvas, "Follow-up", root.answerId);
  const cut = detachBranch(next.canvas, root.answerId);
  const history = requestHistory(cut, next.answerId);
  assert.deepEqual(history.map((m) => [m.role, m.content]), [
    ["user", CONTINUE_NOTE],
    ["assistant", "Answer to Root question"],
    ["user", "Follow-up"],
  ]);
});

test("a branch copied to a new canvas gets fresh ids, its own root and the same layout", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "Main continuation", root.answerId);
  const source = { ...main.canvas, layout: "force-v2" as const, viewport: { x: 5, y: 6, zoom: 0.7 } };
  const top = source.messages.find((m) => m.id === root.answerId)!;
  const copy = copyBranch(source, root.answerId);
  assert.notEqual(copy.id, source.id);
  assert.equal(copy.messages.length, 3);
  assert.ok(copy.messages.every((m) => !source.messages.some((s) => s.id === m.id)), "every message has a new id");
  assert.equal(copy.rootId, copy.selectedId);
  const newRoot = copy.messages.find((m) => m.id === copy.rootId)!;
  assert.equal(newRoot.content, top.content);
  assert.equal(newRoot.parentId, null);
  assert.deepEqual(newRoot.position, { x: 0, y: 0 });
  const follow = copy.messages.find((m) => m.content === "Main continuation")!;
  const original = source.messages.find((m) => m.content === "Main continuation")!;
  assert.equal(follow.parentId, copy.rootId);
  assert.deepEqual(follow.position, { x: original.position.x - top.position.x, y: original.position.y - top.position.y });
  assert.equal(copy.layout, "force-v2");
  assert.equal(copy.viewport.zoom, 0.7);
  assert.equal(copy.title, "Answer to Root question", "titled after its first bubble");
  assert.equal(source.messages.length, 4, "the source is untouched");
  assert.equal(source.messages.find((m) => m.id === root.answerId)!.parentId, top.parentId);
});

test("prompts carry files and the answer's thinking level; a named canvas keeps its name", () => {
  const files = [{ id: "file-1", name: "app.py", bytes: 400, lines: 12 }];
  const named = { ...newCanvas(), title: "My plan" };
  const turn = addTurn(named, "", null, { files, reasoning: "high" });
  const [prompt, answer] = turn.canvas.messages;
  assert.deepEqual(prompt.files, files);
  assert.equal(answer.reasoning, "high");
  assert.equal(turn.canvas.title, "My plan");
  assert.equal(addTurn(newCanvas(), "", null, { files }).canvas.title, "app.py");
  assert.equal(estimateTokens({ content: "", files }), 100 + 4);
  const done = patchMessage(turn.canvas, turn.answerId, { status: "complete", content: "Read it" });
  const next = addTurn(done, "And then?", turn.answerId);
  assert.deepEqual(requestHistory(next.canvas, next.answerId)[0].files, files);
});

const route = { provider: "openai", model: "gpt-test", profileId: undefined };
// Writes a pending summary, as a completed request does.
const written = (canvas: Canvas, id: string, content = "# Topic\n\nWhat was said") =>
  patchMessage(canvas, id, { status: "complete", content });

test("branching off with a summary cuts the branch loose under a pending summary of what came before", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "Main continuation", root.answerId);
  const deeper = complete(main.canvas, "Deeper", main.answerId);
  const promptId = deeper.canvas.messages.find((m) => m.content === "Main continuation")!.id;
  const edited = addTurn(deeper.canvas, "Main, rewritten", null, { editOf: promptId });
  const withEdit = patchMessage(edited.canvas, edited.answerId, { status: "complete", content: "Edited answer" });
  const { canvas, summaryId } = summarizeBranch(withEdit, promptId, "detach", route);
  const summary = canvas.messages.find((m) => m.id === summaryId)!;
  assert.deepEqual(summary.summary, { of: root.answerId });
  assert.equal(summary.parentId, null);
  assert.equal(summary.status, "pending");
  assert.equal(summary.role, "assistant");
  assert.equal(summary.model, "gpt-test");
  assert.equal(canvas.messages.length, withEdit.messages.length + 1);
  assert.deepEqual(rootIds(canvas), [canvas.rootId, summaryId]);
  const prompt = canvas.messages.find((m) => m.id === promptId)!;
  assert.equal(prompt.parentId, summaryId);
  assert.ok(summary.position.x + CARD_WIDTH < prompt.position.x, "the summary sits beside the branch, on its left");
  assert.equal(summary.position.y, prompt.position.y);
  assert.ok(prompt.placementOffset && prompt.layoutOffset);
  assert.equal(linkKind(canvas, prompt), "side");
  assert.equal(canvas.selectedId, summaryId, "the summary opens in the reader as it is written");
  const editPrompt = canvas.messages.find((m) => m.content === "Main, rewritten")!;
  assert.equal(editPrompt.parentId, summaryId, "an edit of the top bubble continues from the summary too");
  assert.equal(editPrompt.editOf, promptId);
  assert.equal(rootOf(canvas, deeper.answerId), summaryId);
  assert.deepEqual(summaryCuts(canvas), [{ from: root.answerId, to: promptId }], "the cut is drawn from the old parent");

  // The summary is written from the path above the cut; the branch can't continue until then.
  assert.deepEqual(requestHistory(canvas, summaryId).map((m) => [m.role, m.content]), [
    ["user", "Root question"],
    ["assistant", "Answer to Root question"],
    ["user", SUMMARY_PROMPT],
  ]);
  assert.throws(() => addTurn(canvas, "Too soon", deeper.answerId), /already being written/);
  assert.equal(ancestorPath(canvas, deeper.answerId, true)[0].id, summaryId);
  assert.throws(() => ancestorPath(canvas, deeper.answerId), /summary isn’t written yet/);

  // Once written, the summary stands in for everything above the cut.
  const done = written(canvas, summaryId);
  const next = addTurn(done, "Go on", deeper.answerId);
  assert.deepEqual(requestHistory(next.canvas, next.answerId).map((m) => [m.role, m.content]), [
    ["user", SUMMARY_NOTE],
    ["assistant", "# Topic\n\nWhat was said"],
    ["user", "Main continuation"],
    ["assistant", "Answer to Main continuation"],
    ["user", "Deeper"],
    ["assistant", "Answer to Deeper"],
    ["user", "Go on"],
  ]);
  const fromSummary = addTurn(done, "From the summary", summaryId);
  assert.deepEqual(summaryCuts(fromSummary.canvas), [{ from: root.answerId, to: promptId }], "a later reply to the summary is not the cut");
  assert.deepEqual(summaryCuts(detachBranch(done, promptId)), [], "cutting the bubble loose again removes it");
  const rewrite = addTurn(done, "Rewritten again", null, { editOf: promptId });
  assert.deepEqual(requestHistory(rewrite.canvas, rewrite.answerId).map((m) => m.content), [SUMMARY_NOTE, "# Topic\n\nWhat was said", "Rewritten again"]);
});

test("a summary above an answer is followed by the short user turn, and summaries can be summarized again", () => {
  const root = complete(newCanvas(), "Root question", null);
  const next = complete(root.canvas, "Follow-up", root.answerId);
  const promptId = next.canvas.messages.find((m) => m.content === "Follow-up")!.id;
  const { canvas, summaryId } = summarizeBranch(next.canvas, next.answerId, "detach", route);
  assert.equal(canvas.messages.find((m) => m.id === summaryId)!.summary!.of, promptId);
  assert.deepEqual(requestHistory(canvas, summaryId).map((m) => [m.role, m.content]), [
    ["user", "Root question"],
    ["assistant", "Answer to Root question"],
    ["user", "Follow-up"],
    ["user", SUMMARY_PROMPT],
  ], "the summary includes the prompt the cut answer replied to");
  const done = written(canvas, summaryId, "First summary");
  const later = complete(done, "Later", next.answerId);
  assert.deepEqual(requestHistory(later.canvas, later.answerId).map((m) => [m.role, m.content]), [
    ["user", SUMMARY_NOTE],
    ["assistant", "First summary"],
    ["user", CONTINUE_NOTE],
    ["assistant", "Answer to Follow-up"],
    ["user", "Later"],
  ]);
  const again = summarizeBranch(later.canvas, later.answerId, "detach", route);
  assert.deepEqual(requestHistory(again.canvas, again.summaryId).map((m) => m.content), [
    SUMMARY_NOTE, "First summary", CONTINUE_NOTE, "Answer to Follow-up", "Later", SUMMARY_PROMPT,
  ]);
});

test("a summary for a new chat is the new canvas's only bubble and covers the conversation up to here", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "Main continuation", root.answerId);
  const source = { ...main.canvas, layout: "force-v2" as const };
  const promptId = source.messages.find((m) => m.content === "Main continuation")!.id;
  const { canvas: copy, summaryId, topId } = summarizeBranch(source, promptId, "copy", route);
  assert.notEqual(copy.id, source.id);
  assert.equal(topId, undefined);
  assert.equal(copy.messages.length, 1, "no bubbles come over from the previous chat");
  const [summary] = copy.messages;
  assert.equal(summary.id, summaryId);
  assert.equal(copy.rootId, summaryId);
  assert.equal(copy.selectedId, summaryId);
  assert.equal(copy.draftParentId, summaryId);
  assert.deepEqual(summary.summary, { of: promptId, canvasId: source.id });
  assert.deepEqual(summary.position, { x: 0, y: 0 });
  assert.equal(copy.title, "Main continuation");
  assert.equal(copy.layout, "force-v2");
  assert.deepEqual(requestHistory(copy, summaryId, source).map((m) => m.content), ["Root question", "Answer to Root question", "Main continuation", SUMMARY_PROMPT]);
  assert.deepEqual(summaryCuts(copy), [], "a new chat has no cut to show");
  assert.equal(source.messages.length, 4, "the source is untouched");
  const done = written(copy, summaryId, "Summary");
  const next = addTurn(done, "Carry on", summaryId);
  assert.deepEqual(requestHistory(next.canvas, next.answerId).map((m) => m.content), [SUMMARY_NOTE, "Summary", "Carry on"]);
});

test("summaries need earlier context and a quiet canvas, and an unwritten one can be left out", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "Main continuation", root.answerId);
  assert.throws(() => summarizeBranch(main.canvas, main.canvas.rootId!, "copy", route), /no earlier context/);
  const busy = addTurn(main.canvas, "Elsewhere", root.answerId).canvas;
  const promptId = main.canvas.messages.find((m) => m.content === "Main continuation")!.id;
  assert.throws(() => summarizeBranch(busy, promptId, "detach", route), /already being written/);
  assert.equal(summarizeBranch(busy, promptId, "copy", route).canvas.messages.length, 1, "a new chat writes on its own canvas");

  const { canvas, summaryId } = summarizeBranch(main.canvas, promptId, "detach", route);
  assert.equal(dropSummary(canvas, summaryId), canvas, "a summary being written stays");
  const failed = patchMessage(canvas, summaryId, { status: "error", error: "Nope" });
  const dropped = dropSummary(failed, summaryId);
  assert.equal(dropped.messages.some((m) => m.id === summaryId), false);
  const prompt = dropped.messages.find((m) => m.id === promptId)!;
  assert.equal(prompt.parentId, null);
  assert.equal(prompt.placementOffset, undefined);
  assert.deepEqual(dropped.messages, detachBranch(main.canvas, promptId).messages, "the same as leaving the context out");
  assert.deepEqual(summaryCuts(dropped), []);
  assert.equal(leaveOutSummary(canvas, summaryId, main.canvas), canvas, "Leave it out waits for a summary being written");
  assert.deepEqual(leaveOutSummary(failed, summaryId).messages, dropped.messages, "Continue here: the branch is left loose");

  const copied = summarizeBranch(main.canvas, promptId, "copy", route);
  const interrupted = patchMessage(copied.canvas, copied.summaryId, { status: "interrupted" });
  const copyDropped = dropSummary(interrupted, copied.summaryId);
  assert.deepEqual(copyDropped.messages, [], "a new chat without its summary starts blank");
  assert.equal(copyDropped.rootId, null);
  assert.equal(copyDropped.selectedId, null);

  // New chat: leaving the summary out copies the branch, as choosing it up front does.
  const left = leaveOutSummary(interrupted, copied.summaryId, main.canvas);
  const shape = (c: Canvas) => c.messages.map((m) => ({
    role: m.role, content: m.content, position: m.position, parent: c.messages.findIndex((p) => p.id === m.parentId),
  }));
  assert.equal(left.id, copied.canvas.id, "the new chat keeps its canvas");
  assert.equal(left.messages.some((m) => m.summary), false);
  assert.deepEqual(shape(left), shape(copyBranch(main.canvas, promptId)));
  assert.equal(left.messages.some((m) => main.canvas.messages.some((s) => s.id === m.id)), false, "the copy has its own ids");
  const top = left.messages.find((m) => m.content === "Main continuation")!;
  assert.equal(top.parentId, null);
  assert.deepEqual([left.rootId, left.selectedId, left.draftParentId], [top.id, top.id, top.id]);
  const reply = addTurn(left, "Next", left.messages.find((m) => m.role === "assistant")!.id);
  assert.deepEqual(requestHistory(reply.canvas, reply.answerId).map((m) => m.content),
    ["Main continuation", "Answer to Main continuation", "Next"], "earlier context stays out");
  assert.deepEqual(leaveOutSummary(interrupted, copied.summaryId).messages, [], "with its source deleted, a new chat starts blank");
  const branch = branchIds(main.canvas, promptId);
  const pruned = { ...main.canvas, messages: main.canvas.messages.filter((m) => !branch.has(m.id)) };
  assert.deepEqual(leaveOutSummary(interrupted, copied.summaryId, pruned).messages, [], "so it does with the bubble gone");
  const answering = addTurn(main.canvas, "Still going", main.answerId).canvas;
  assert.throws(() => leaveOutSummary(interrupted, copied.summaryId, answering), /Wait for the answer/);
});

test("the context meter counts a summary instead of usage reported before it", () => {
  const root = complete(newCanvas(), "Root question", null);
  const main = complete(root.canvas, "x".repeat(400), root.answerId);
  const measured = patchMessage(main.canvas, main.answerId, { usage: { promptTokens: 5000, completionTokens: 100 } });
  const promptId = measured.messages.find((m) => m.content === "x".repeat(400))!.id;
  assert.equal(contextTokens(measured, main.answerId), 5100);
  const { canvas, summaryId } = summarizeBranch(measured, promptId, "detach", route);
  // Created later than everything already in the branch.
  const later = patchMessage(canvas, summaryId, { createdAt: Date.now() + 1000 });
  const done = patchMessage(written(later, summaryId, "y".repeat(40)), summaryId, { usage: { promptTokens: 4000, completionTokens: 300 } });
  const expected = (10 + 4) + (100 + 4) + (Math.ceil("Answer to ".length / 4 + 100) + 4);
  assert.equal(contextTokens(done, main.answerId), expected);
  assert.equal(contextTokens(later, main.answerId), expected - 10, "a summary being written counts as empty");
  const next = addTurn(done, "More", main.answerId);
  const answered = patchMessage(next.canvas, next.answerId, { status: "complete", content: "Sure", usage: { promptTokens: 300, completionTokens: 20 }, createdAt: Date.now() + 2000 });
  assert.equal(contextTokens(answered, next.answerId), 320, "usage reported after the summary counts again");
});

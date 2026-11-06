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

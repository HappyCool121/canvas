import { test } from "node:test";
import assert from "node:assert/strict";
import { checkImageBudget, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES } from "../shared/attachments";
import { openAICompatible } from "../server/provider";
import { presetById } from "../shared/providers";

test("attachment budgets include every occurrence across a request", () => {
  checkImageBudget(Array(600).fill(1));
  assert.throws(() => checkImageBudget(Array(601).fill(1)), /600/);
  checkImageBudget([MAX_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES, 8*1024*1024]);
  assert.throws(() => checkImageBudget([MAX_IMAGE_BYTES+1]), /64 MiB/);
  assert.throws(() => checkImageBudget([MAX_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES-3*MAX_IMAGE_BYTES+1]), /200 MiB/);
});

test("Files API uses expiring uploads, reuses matching bytes and keeps file references in provider requests", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const provider = openAICompatible(presetById("deepseek")!, { key: "synthetic-key", baseUrl: "https://api.deepseek.com" }, (async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith("/files")) return Response.json({ id: "file-api-test", expires_at: Math.floor(Date.now()/1000)+86400 });
    return Response.json({ choices: [{ message: { content: "OK" }, finish_reason: "stop" }] });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  const bytes = new Uint8Array([1,2,3]);
  const id = await provider.upload!(bytes, "image/png", signal);
  assert.equal(await provider.upload!(bytes, "image/png", signal), id);
  assert.equal(requests.length, 1);
  const form = requests[0].init!.body as FormData;
  assert.equal(form.get("expires_after[seconds]"), "86400");
  await provider.generate("deepseek-flash", [{ role: "user", content: "Read", fileIds: [id] }], signal);
  assert.deepEqual(JSON.parse(requests[1].init!.body as string).messages[1].content[1], { type: "file", file_id: id });
});

test("source documents stream past the old 64 MiB transport cap without buffering the request", async () => {
  const { mkdtemp, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { Readable } = await import('node:stream');
  const { createWorkspace } = await import('../server/workspace');
  const dir = await mkdtemp(`${tmpdir()}/canvas-stream-`);
  try {
    const workspace = createWorkspace(dir);
    const chunk = Buffer.alloc(1024*1024, 17);
    await workspace.putAttachmentStream('large-document', Readable.from((async function*(){for(let i=0;i<65;i++) yield chunk;})()), 'application/pdf');
    assert.equal((await workspace.attachmentInfo('large-document'))!.size,65*1024*1024);
    await assert.rejects(workspace.putAttachmentStream('interrupted', Readable.from((async function*(){yield chunk; throw new Error('disconnect');})()), 'application/pdf'), /disconnect/);
    assert.equal(await workspace.attachmentInfo('interrupted'),undefined);
    assert.ok((await readdir(`${dir}/objects`)).every(name=>!name.endsWith('.tmp')));
  } finally {await rm(dir,{recursive:true,force:true});}
});

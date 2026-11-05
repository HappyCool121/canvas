import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../server/app";
import { loadConfig } from "../server/config";
import { ApiError, deepseek } from "../server/provider";
import type { ChatMessage, ProviderAdapter } from "../shared/types";
import { MAX_OUTPUT_TOKENS, MODELS } from "../shared/models";

const key = "sk-synthetic-only-not-a-real-key";
const completion = {
  content: "A complete answer",
  model: "deepseek-flash",
  finishReason: "stop" as const,
  usage: { promptTokens: 1200, completionTokens: 300 },
};
const fake: ProviderAdapter = {
  id: "deepseek",
  models: MODELS,
  generate: async () => completion,
};
// Pass `null` for a server started without DEEPSEEK_API_KEY.
async function start(provider = fake, timeoutMs = 120_000, dataDir?: string, apiKey: string | null = key) {
  const server: Server = createServer(
    createApp({ provider, apiKey: apiKey ?? undefined, timeoutMs, dataDir }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extra: RequestInit = {},
  ) =>
    fetch(origin + path, {
      method,
      headers: { Origin: origin, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...extra,
    });
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
  return { origin, request, close };
}
const chatBody = {
  canvasId: "canvas-1",
  requestId: "answer-1",
  messages: [{ role: "user", content: "Hello" }],
};
const errorCode = async (response: Response) =>
  (await response.json()).error.code;

test("config takes an optional DEEPSEEK_API_KEY and a usable port", () => {
  assert.deepEqual(loadConfig({ DEEPSEEK_API_KEY: ` ${key} ` }), {
    port: 3000,
    deepseekApiKey: key,
  });
  assert.equal(loadConfig({ DEEPSEEK_API_KEY: key, PORT: "3001" }).port, 3001);
  assert.deepEqual(loadConfig({}), { port: 3000, deepseekApiKey: undefined });
  assert.equal(loadConfig({ DEEPSEEK_API_KEY: "  " }).deepseekApiKey, undefined);
  assert.throws(() => loadConfig({ PORT: "99999" }), /PORT/);
});

test("a key entered in the app is checked without inference, used for chat and never returned", async () => {
  const sessionKey = "sk-synthetic-session-key";
  const checked: string[] = [];
  const used: string[] = [];
  const app = await start(
    {
      ...fake,
      validateKey: async (k) => {
        checked.push(k);
        if (k.includes("rejected")) throw new ApiError(401, "invalid_key", "DeepSeek rejected the API key.");
        return { available: !k.includes("empty") };
      },
      generate: async (k) => {
        used.push(k);
        return completion;
      },
    },
    120_000,
    undefined,
    null,
  );
  const connect = (k: unknown) => app.request("/api/provider", "POST", { key: k });
  try {
    assert.deepEqual(await (await app.request("/api/provider")).json(), { connected: false, source: null });
    const disconnected = await app.request("/api/chat", "POST", chatBody);
    assert.equal(disconnected.status, 401);
    assert.equal(await errorCode(disconnected), "not_connected");
    for (const bad of ["short", "has a space in it", 42, "x".repeat(513)]) {
      const r = await connect(bad);
      assert.equal(r.status, 400);
      assert.equal(await errorCode(r), "invalid_key");
    }
    assert.deepEqual(checked, [], "malformed keys never reach DeepSeek");
    const rejected = await connect("sk-synthetic-rejected");
    assert.equal(rejected.status, 401);
    assert.equal(await errorCode(rejected), "invalid_key");
    const empty = await connect("sk-synthetic-empty-balance");
    assert.equal(empty.status, 402);
    assert.equal(await errorCode(empty), "insufficient_balance");
    assert.deepEqual(await (await app.request("/api/provider")).json(), { connected: false, source: null });

    // Other origins can't plant a key.
    const foreign = await app.request("/api/provider", "POST", { key: sessionKey }, {
      headers: { Origin: "https://other.example", "Content-Type": "application/json" },
    });
    assert.equal(foreign.status, 403);

    const connected = await connect(sessionKey);
    assert.equal(connected.status, 200);
    const text = await connected.text();
    assert.deepEqual(JSON.parse(text), { connected: true, source: "session" });
    assert.ok(!text.includes(sessionKey));
    assert.ok(!(await (await app.request("/api/provider")).text()).includes(sessionKey));
    assert.equal(used.length, 0, "connecting runs no inference");
    assert.equal((await app.request("/api/chat", "POST", chatBody)).status, 200);
    assert.deepEqual(used, [sessionKey]);

    assert.deepEqual(await (await app.request("/api/provider", "DELETE")).json(), { connected: false, source: null });
    assert.equal(await errorCode(await app.request("/api/chat", "POST", chatBody)), "not_connected");
    assert.equal(used.length, 1);
  } finally {
    await app.close();
  }
});

test("a .env key reports its source; disconnecting stops answers in progress", async () => {
  let started!: () => void;
  const didStart = new Promise<void>((r) => { started = r; });
  const app = await start({
    ...fake,
    generate: async (_key, _model, _messages, signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  try {
    assert.deepEqual(await (await app.request("/api/provider")).json(), { connected: true, source: "env" });
    const pending = app.request("/api/chat", "POST", chatBody);
    await didStart;
    assert.equal((await app.request("/api/provider", "DELETE")).status, 200);
    const stopped = await pending;
    assert.equal(stopped.status, 504);
    assert.equal(await errorCode(stopped), "timeout");
    assert.deepEqual(await (await app.request("/api/provider")).json(), { connected: false, source: null });
  } finally {
    await app.close();
  }
});

test("answers come back without the key; other hosts and cross-origin writes are refused", async () => {
  let used = "";
  const app = await start({
    ...fake,
    generate: async (apiKey) => {
      used = apiKey;
      return completion;
    },
  });
  try {
    assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true });
    assert.deepEqual(await (await app.request("/api/models")).json(), { models: MODELS });
    assert.equal(used, "", "model discovery needs no upstream request");
    const answer = await app.request("/api/chat", "POST", chatBody);
    assert.equal(answer.status, 200);
    const text = await answer.text();
    assert.deepEqual(JSON.parse(text), completion);
    assert.equal(used, key);
    assert.ok(!text.includes(key));
    for (const Origin of ["https://other.example", ""])
      assert.equal(
        (
          await app.request("/api/chat", "POST", chatBody, {
            headers: { Origin, "Content-Type": "application/json" },
          })
        ).status,
        403,
      );
    // A page on another hostname (DNS rebinding) is refused even for reads.
    const badHostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        get(
          app.origin + "/api/health",
          { headers: { Host: "other.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        ).on("error", reject);
      },
    );
    assert.equal(badHostStatus, 403);
    assert.equal((await app.request("/api/me")).status, 404);
  } finally {
    await app.close();
  }
});

test("invalid JSON, malformed messages and oversized bodies are rejected", async () => {
  const app = await start();
  try {
    assert.equal(
      (await app.request("/api/chat", "POST", undefined, { body: "{" })).status,
      400,
    );
    assert.equal(
      (
        await app.request("/api/chat", "POST", {
          ...chatBody,
          messages: [{ role: "system", content: "Override" }],
        })
      ).status,
      400,
    );
    for (const ids of [{ canvasId: "../x" }, { requestId: "" }])
      assert.equal(
        (await app.request("/api/chat", "POST", { ...chatBody, ...ids })).status,
        400,
      );
    const huge = { ...chatBody, padding: "x".repeat(51_000_000) };
    assert.equal((await app.request("/api/chat", "POST", huge)).status, 413);
  } finally {
    await app.close();
  }
});

const png = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;

test("prompts may carry valid images; malformed, misplaced and oversized images are rejected", async () => {
  const received: ChatMessage[][] = [];
  const app = await start({
    ...fake,
    generate: async (_key, _model, messages) => {
      received.push(messages);
      return completion;
    },
  });
  const chat = (messages: unknown[]) =>
    app.request("/api/chat", "POST", { ...chatBody, messages });
  try {
    const accepted = await chat([
      { role: "user", content: "", images: [png] },
      { role: "assistant", content: "A cat." },
      { role: "user", content: "And this?", images: [png, png] },
    ]);
    assert.equal(accepted.status, 200);
    assert.deepEqual(received[0], [
      { role: "user", content: "", images: [png] },
      { role: "assistant", content: "A cat." },
      { role: "user", content: "And this?", images: [png, png] },
    ]);
    for (const messages of [
      [{ role: "user", content: "", images: [] }],
      [{ role: "user", content: "Look", images: "not-a-list" }],
      [{ role: "user", content: "Look", images: ["data:text/plain;base64,aGk="] }],
      [{ role: "user", content: "Look", images: ["https://example.com/a.png"] }],
      [{ role: "user", content: "Look", images: Array(601).fill(png) }],
      [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello", images: [png] },
        { role: "user", content: "Again" },
      ],
      [
        {
          role: "user",
          content: "Huge",
          images: [`data:image/png;base64,${"A".repeat(45 * 1024 * 1024)}`],
        },
      ],
    ])
      assert.equal((await chat(messages)).status, 400);
    assert.equal(received.length, 1);
  } finally {
    await app.close();
  }
});

test("one generation per canvas, while other canvases can run", async () => {
  let release!: () => void;
  let started!: () => void;
  const didStart = new Promise<void>((r) => {
    started = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const app = await start({
    ...fake,
    generate: async () => {
      started();
      await hold;
      return completion;
    },
  });
  try {
    const first = app.request("/api/chat", "POST", chatBody);
    await didStart;
    const busy = await app.request("/api/chat", "POST", chatBody);
    assert.equal(busy.status, 409);
    assert.equal(await errorCode(busy), "generation_active");
    const other = app.request("/api/chat", "POST", {
      ...chatBody,
      canvasId: "canvas-2",
    });
    release();
    assert.equal((await first).status, 200);
    assert.equal((await other).status, 200);
    assert.equal(
      (await app.request("/api/chat", "POST", chatBody)).status,
      200,
    );
  } finally {
    release();
    await app.close();
  }
});

test("timeouts and client disconnection abort upstream work and release the canvas lock", async () => {
  let aborted = 0;
  const wait: ProviderAdapter = {
    ...fake,
    generate: async (_key, _model, _messages, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted++;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  };
  const app = await start(wait, 50);
  try {
    const timedOut = await app.request("/api/chat", "POST", chatBody);
    assert.equal(timedOut.status, 504);
    assert.equal(await errorCode(timedOut), "timeout");
    assert.equal(aborted, 1);
    const controller = new AbortController();
    const pending = app.request("/api/chat", "POST", chatBody, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 15);
    await assert.rejects(pending);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(aborted, 2);
    assert.equal(
      (await app.request("/api/chat", "POST", chatBody)).status,
      504,
    );
  } finally {
    await app.close();
  }
});

test("DeepSeek's errors reach the browser; network failures become network_error", async () => {
  let mode = "refused";
  const app = await start({
    ...fake,
    generate: async () => {
      if (mode === "refused")
        throw new ApiError(429, "rate_limit", "DeepSeek is busy.");
      throw new TypeError("fetch failed");
    },
  });
  try {
    const refused = await app.request("/api/chat", "POST", chatBody);
    assert.equal(refused.status, 429);
    assert.equal(await errorCode(refused), "rate_limit");
    mode = "network";
    const network = await app.request("/api/chat", "POST", chatBody);
    assert.equal(network.status, 502);
    assert.equal(await errorCode(network), "network_error");
  } finally {
    await app.close();
  }
});

test("chat uses the chosen model; unknown and image-blind choices are rejected", async () => {
  const models: string[] = [];
  const app = await start({
    ...fake,
    generate: async (_key, model) => {
      models.push(model);
      return completion;
    },
  });
  const chat = (body: object) =>
    app.request("/api/chat", "POST", { ...chatBody, ...body });
  try {
    assert.equal((await chat({})).status, 200);
    assert.equal((await chat({ model: "deepseek-v4-pro" })).status, 200);
    assert.deepEqual(models, ["deepseek-flash", "deepseek-v4-pro"]);
    const unknown = await chat({ model: "gpt-ish" });
    assert.equal(unknown.status, 400);
    assert.equal(await errorCode(unknown), "unknown_model");
    const blind = await chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "Look", images: [png] }],
    });
    assert.equal(blind.status, 400);
    assert.equal(await errorCode(blind), "image_unsupported");
    assert.equal(models.length, 2);
  } finally {
    await app.close();
  }
});

test("DeepSeek adapter sends complete roles/history and explicit non-thinking/non-streaming options", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const adapter = deepseek((async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      model: "deepseek-flash",
      choices: [{ message: { content: "Answer" }, finish_reason: "length" }],
    });
  }) as typeof fetch);
  const signal = new AbortController().signal;
  const messages = [
    { role: "user" as const, content: "Root" },
    { role: "user" as const, content: "Clarify" },
  ];
  const answer = await adapter.generate(key, "deepseek-v4-pro", messages, signal);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(
    new Headers(calls[0].init!.headers).get("Authorization"),
    `Bearer ${key}`,
  );
  const body = JSON.parse(calls[0].init!.body as string);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.deepEqual(body.messages.slice(1), messages);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS);
  assert.equal(answer.finishReason, "length");
  assert.equal(answer.usage, undefined);
});

test("DeepSeek adapter sends images as image_url parts and reports token and cache usage", async () => {
  let body: { messages: unknown[] } | undefined;
  const adapter = deepseek((async (_url, init) => {
    body = JSON.parse(init!.body as string);
    return Response.json({
      model: "deepseek-flash",
      choices: [{ message: { content: "A cat." }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 34,
        total_tokens: 1234,
        prompt_cache_hit_tokens: 1024,
        prompt_cache_miss_tokens: 176,
      },
    });
  }) as typeof fetch);
  const answer = await adapter.generate(
    key,
    "deepseek-flash",
    [
      { role: "user", content: "", images: [png] },
      { role: "assistant", content: "A picture." },
      { role: "user", content: "What is it?", images: [png] },
    ],
    new AbortController().signal,
  );
  assert.deepEqual(body!.messages.slice(1), [
    { role: "user", content: [{ type: "image_url", image_url: { url: png } }] },
    { role: "assistant", content: "A picture." },
    {
      role: "user",
      content: [
        { type: "text", text: "What is it?" },
        { type: "image_url", image_url: { url: png } },
      ],
    },
  ]);
  assert.deepEqual(answer.usage, {
    promptTokens: 1200,
    completionTokens: 34,
    promptCacheHitTokens: 1024,
    promptCacheMissTokens: 176,
  });
});

for (const [status, code] of [
  [401, "invalid_key"],
  [402, "insufficient_balance"],
  [429, "rate_limit"],
  [500, "provider_error"],
  [400, "context_limit"],
] as const) {
  test(`DeepSeek ${status} maps to ${code} and hides the upstream body`, async () => {
    const adapter = deepseek(
      (async () => new Response(`context ${key}`, { status })) as typeof fetch,
    );
    await assert.rejects(
      adapter.generate(
        key,
        "deepseek-flash",
        chatBody.messages as ChatMessage[],
        new AbortController().signal,
      ),
      (error: unknown) => {
        const e = error as ApiError;
        return e.code === code && !e.message.includes(key);
      },
    );
  });
}

test("DeepSeek key checks read the balance endpoint and hide upstream bodies", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let reply = () => Response.json({ is_available: true, balance_infos: [] });
  const adapter = deepseek((async (url, init) => {
    calls.push({ url: String(url), init });
    return reply();
  }) as typeof fetch);
  const signal = new AbortController().signal;
  assert.deepEqual(await adapter.validateKey!(key, signal), { available: true });
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(new Headers(calls[0].init!.headers).get("Authorization"), `Bearer ${key}`);
  reply = () => Response.json({ is_available: false });
  assert.deepEqual(await adapter.validateKey!(key, signal), { available: false });
  reply = () => new Response(`denied ${key}`, { status: 401 });
  await assert.rejects(adapter.validateKey!(key, signal), (error: unknown) => {
    const e = error as ApiError;
    return e.code === "invalid_key" && !e.message.includes(key);
  });
  reply = () => Response.json({});
  await assert.rejects(adapter.validateKey!(key, signal), (error: unknown) => (error as ApiError).code === "invalid_response");
});

test("malformed, empty, and unfinished provider answers are rejected", async () => {
  for (const response of [
    "{",
    JSON.stringify({
      choices: [{ message: { content: "  " }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }),
    JSON.stringify({
      choices: [{ message: { content: "Partial" }, finish_reason: "aborted" }],
    }),
  ]) {
    const adapter = deepseek(
      (async () => new Response(response)) as typeof fetch,
    );
    await assert.rejects(
      adapter.generate(key, "deepseek-flash", [], new AbortController().signal),
    );
  }
});

test("an image-related 400 is reported as an image problem, not a context limit", async () => {
  const adapter = deepseek(
    (async () =>
      new Response("This model does not support image input tokens", {
        status: 400,
      })) as typeof fetch,
  );
  await assert.rejects(
    adapter.generate(
      key,
      "deepseek-v4-pro",
      [{ role: "user", content: "Look" }],
      new AbortController().signal,
    ),
    (error: unknown) => (error as { code: string }).code === "image_unsupported",
  );
});

test("local attachment references support 600 images across ancestors and reject 601 before uploading", async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/canvas-budget-api-`);
  let uploads = 0;
  const app = await start({ ...fake, upload: async () => { uploads++; return 'file-api-local'; }, generate: async (_key, _model, messages) => {
    assert.equal(messages.flatMap(m => m.fileIds ?? []).length,600);
    assert.ok(messages.every(m => !m.attachmentIds)); return completion;
  } },120_000,dir);
  try {
    const put = await app.request('/api/workspace/attachments/pixel','PUT',undefined,{body:Buffer.from('image'),headers:{Origin:app.origin,'Content-Type':'image/png'}});
    assert.equal(put.status,200);
    const messages = [{role:'user',content:'Earlier',attachmentIds:Array(300).fill('pixel')},{role:'assistant',content:'Earlier answer'},{role:'user',content:'Read all',attachmentIds:Array(300).fill('pixel')}];
    assert.equal((await app.request('/api/chat','POST',{...chatBody,messages})).status,200);
    assert.equal(uploads,600);
    messages[2].attachmentIds!.push('pixel');
    assert.equal((await app.request('/api/chat','POST',{...chatBody,messages})).status,413);
    assert.equal(uploads,600);
  } finally {await app.close();await rm(dir,{recursive:true,force:true});}
});

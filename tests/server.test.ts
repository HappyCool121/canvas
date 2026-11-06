import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, get, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../server/app";
import { loadConfig, type EnvConnection } from "../server/config";
import { ApiError, openAICompatible, type ProviderAdapter } from "../server/provider";
import type { ChatMessage, ProvidersState } from "../shared/types";
import { MAX_OUTPUT_TOKENS, REASONING_OUTPUT_TOKENS, type ModelInfo } from "../shared/models";
import { PRESETS, presetById } from "../shared/providers";
import catalog from "../shared/catalog.json" with { type: "json" };

const key = "sk-synthetic-only-not-a-real-key";
const completion = {
  content: "A complete answer",
  model: "deepseek-flash",
  finishReason: "stop" as const,
  usage: { promptTokens: 1200, completionTokens: 300 },
};
const fake = (overrides: Partial<ProviderAdapter> = {}): ProviderAdapter => ({
  validate: async () => {},
  listModels: async () => [],
  generate: async () => completion,
  ...overrides,
});
const deepseekEnv: EnvConnection = { id: "deepseek", key, baseUrl: "https://api.deepseek.com" };
type Options = NonNullable<Parameters<typeof createApp>[0]>;

// Every server gets its own data folder, so tests never touch real preferences.
async function start({ adapter = () => fake(), connections = [deepseekEnv], timeoutMs = 120_000, dataDir }: Partial<Options> = {}) {
  const own = dataDir ? undefined : await mkdtemp(path.join(tmpdir(), "canvas-api-"));
  const server: Server = createServer(
    createApp({ adapter, connections, timeoutMs, dataDir: dataDir ?? own }),
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
  const close = async () => {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    if (own) await rm(own, { recursive: true, force: true });
  };
  return { origin, request, close };
}
const chatBody = {
  canvasId: "canvas-1",
  requestId: "answer-1",
  messages: [{ role: "user", content: "Hello" }],
};
const errorCode = async (response: Response) =>
  (await response.json()).error.code;
const providers = async (app: Awaited<ReturnType<typeof start>>) =>
  (await (await app.request("/api/providers")).json()) as ProvidersState;
const connectedIds = async (app: Awaited<ReturnType<typeof start>>) =>
  (await providers(app)).connected.map((c) => `${c.id}:${c.source}`);

test("config connects every provider with a key in the environment, and a usable port", () => {
  assert.deepEqual(loadConfig({ DEEPSEEK_API_KEY: ` ${key} ` }), {
    port: 3000,
    connections: [{ id: "deepseek", key, baseUrl: "https://api.deepseek.com" }],
  });
  assert.equal(loadConfig({ PORT: "3001" }).port, 3001);
  assert.deepEqual(loadConfig({}), { port: 3000, connections: [] });
  assert.deepEqual(loadConfig({ DEEPSEEK_API_KEY: "  " }).connections, []);
  assert.throws(() => loadConfig({ PORT: "99999" }), /PORT/);
  const { connections } = loadConfig({
    OPENAI_API_KEY: "sk-openai",
    ANTHROPIC_API_KEY: "sk-ant",
    // A regional variable picks its endpoint.
    MINIMAX_CN_API_KEY: "mm-cn",
    // Placeholders come from the environment; unfinished ones don't connect.
    CLOUDFLARE_API_KEY: "cf-key",
    CLOUDFLARE_ACCOUNT_ID: "acct",
    AZURE_OPENAI_API_KEY: "az-key",
    // Keyless servers connect when their address is set; a custom key needs one.
    OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1",
    OPENAI_COMPATIBLE_API_KEY: "custom-key",
  });
  assert.deepEqual(connections, [
    { id: "openai", key: "sk-openai", baseUrl: "https://api.openai.com/v1" },
    { id: "anthropic", key: "sk-ant", baseUrl: "https://api.anthropic.com/v1" },
    { id: "minimax", key: "mm-cn", baseUrl: "https://api.minimaxi.com/v1" },
    { id: "cloudflare-workers-ai", key: "cf-key", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acct/ai/v1" },
    { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  ]);
  assert.deepEqual(
    loadConfig({ AZURE_OPENAI_API_KEY: "az", AZURE_OPENAI_BASE_URL: "https://mine.openai.azure.com/openai/v1", OPENAI_COMPATIBLE_API_KEY: "c", OPENAI_COMPATIBLE_BASE_URL: "http://10.0.0.5:8000/v1" }).connections,
    [
      { id: "azure", key: "az", baseUrl: "https://mine.openai.azure.com/openai/v1" },
      { id: "custom", key: "c", baseUrl: "http://10.0.0.5:8000/v1" },
    ],
  );
});

test("presets have unique ids, https defaults outside local servers, and environment names", () => {
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  for (const p of PRESETS) {
    assert.match(p.id, /^[a-z0-9-]+$/);
    if (p.group !== "Local and custom") assert.match(p.baseUrl, /^https:\/\//, p.id);
    for (const url of p.baseUrlChoices ?? []) assert.match(url, /^https?:\/\//);
    for (const e of p.env ?? []) assert.match(e.key, /^[A-Z][A-Z0-9_]+$/);
    if (p.keyUrl) assert.match(p.keyUrl, /^https:\/\//);
  }
  assert.ok(PRESETS.length >= 28);
});

test("a key entered in the app is checked without inference, used for chat and never returned", async () => {
  const sessionKey = "sk-synthetic-session-key";
  const checked: string[] = [];
  const used: string[] = [];
  const app = await start({
    connections: [],
    adapter: (_preset, settings) => fake({
      validate: async () => {
        checked.push(settings.key!);
        if (settings.key!.includes("rejected")) throw new ApiError(401, "invalid_key", "DeepSeek rejected the API key.");
        if (settings.key!.includes("empty")) throw new ApiError(402, "insufficient_balance", "No balance.");
      },
      generate: async () => {
        used.push(settings.key!);
        return completion;
      },
    }),
  });
  const connect = (k: unknown) => app.request("/api/providers/deepseek", "POST", { key: k });
  try {
    assert.deepEqual((await providers(app)).connected, []);
    assert.equal((await providers(app)).presets.length, PRESETS.length);
    const disconnected = await app.request("/api/chat", "POST", chatBody);
    assert.equal(disconnected.status, 401);
    const body = (await disconnected.json()).error;
    assert.equal(body.code, "not_connected");
    assert.match(body.message, /Connect DeepSeek/);
    for (const bad of ["short", "has a space in it", 42, "x".repeat(513), undefined]) {
      const r = await connect(bad);
      assert.equal(r.status, 400);
      assert.equal(await errorCode(r), "invalid_key");
    }
    assert.deepEqual(checked, [], "malformed keys never reach the provider");
    assert.equal((await app.request("/api/providers/nope", "POST", { key: sessionKey })).status, 404);
    const rejected = await connect("sk-synthetic-rejected");
    assert.equal(rejected.status, 401);
    assert.equal(await errorCode(rejected), "invalid_key");
    const empty = await connect("sk-synthetic-empty-balance");
    assert.equal(empty.status, 402);
    assert.equal(await errorCode(empty), "insufficient_balance");
    assert.deepEqual((await providers(app)).connected, []);

    // Other origins can't plant a key.
    const foreign = await app.request("/api/providers/deepseek", "POST", { key: sessionKey }, {
      headers: { Origin: "https://other.example", "Content-Type": "application/json" },
    });
    assert.equal(foreign.status, 403);

    const connected = await connect(sessionKey);
    assert.equal(connected.status, 200);
    const text = await connected.text();
    assert.deepEqual(JSON.parse(text).connected, [{ id: "deepseek", source: "session", baseUrl: "https://api.deepseek.com" }]);
    assert.ok(!text.includes(sessionKey));
    assert.ok(!(await (await app.request("/api/providers")).text()).includes(sessionKey));
    assert.ok(!(await (await app.request("/api/models")).text()).includes(sessionKey));
    assert.equal(used.length, 0, "connecting runs no inference");
    assert.equal((await app.request("/api/chat", "POST", chatBody)).status, 200);
    assert.deepEqual(used, [sessionKey]);

    assert.deepEqual((await (await app.request("/api/providers/deepseek", "DELETE")).json()).connected, []);
    assert.equal(await errorCode(await app.request("/api/chat", "POST", chatBody)), "not_connected");
    assert.equal(used.length, 1);
  } finally {
    await app.close();
  }
});

test("several providers connect at once; disconnecting one stops only its answers", async () => {
  let started!: () => void;
  const didStart = new Promise<void>((r) => { started = r; });
  const used: string[] = [];
  const app = await start({
    connections: [deepseekEnv, { id: "openai", key: "sk-openai-env", baseUrl: "https://api.openai.com/v1" }],
    adapter: (preset, settings) => fake({
      generate: async (model, _messages, signal) => {
        used.push(`${preset.id}:${settings.key}:${model}`);
        if (preset.id === "openai") return completion;
        return new Promise((_resolve, reject) => {
          started();
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    }),
  });
  try {
    assert.deepEqual(await connectedIds(app), ["deepseek:env", "openai:env"]);
    const pending = app.request("/api/chat", "POST", chatBody);
    await didStart;
    const other = await app.request("/api/chat", "POST", { ...chatBody, canvasId: "canvas-2", provider: "openai", model: "gpt-x" });
    assert.equal(other.status, 200);
    assert.equal((await app.request("/api/providers/deepseek", "DELETE")).status, 200);
    const stopped = await pending;
    assert.equal(stopped.status, 504);
    assert.equal(await errorCode(stopped), "timeout");
    assert.deepEqual(await connectedIds(app), ["openai:env"]);
    assert.deepEqual(used, [`deepseek:${key}:deepseek-flash`, "openai:sk-openai-env:gpt-x"]);
  } finally {
    await app.close();
  }
});

test("base URLs need https except on this computer or the local network; local servers need no key", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "canvas-base-"));
  const seen: string[] = [];
  const adapter: Options["adapter"] = (preset, settings) => fake({ validate: async () => { seen.push(`${preset.id} ${settings.baseUrl} ${settings.key ?? "-"}`); } });
  let app = await start({ connections: [], adapter, dataDir });
  const connect = (id: string, body: object) => app.request(`/api/providers/${id}`, "POST", body);
  try {
    for (const baseUrl of ["http://api.example.com/v1", "ftp://127.0.0.1/v1", "not a url", "https://user:pw@example.com/v1", "https://example.com/v1?x=1"]) {
      const r = await connect("custom", { key, baseUrl });
      assert.equal(r.status, 400, baseUrl);
      assert.equal(await errorCode(r), "invalid_base_url");
    }
    // Azure has no usable default address; a template must be completed.
    assert.equal(await errorCode(await connect("azure", { key })), "invalid_base_url");
    assert.equal(await errorCode(await connect("custom", { key })), "invalid_base_url");
    assert.equal(await errorCode(await connect("openai", {})), "invalid_key", "hosted providers need a key");
    assert.deepEqual(seen, []);

    assert.equal((await connect("custom", { baseUrl: "http://192.168.1.20:8000/v1/" })).status, 200);
    assert.equal((await connect("lmstudio", { baseUrl: "http://localhost:1234/v1" })).status, 200);
    assert.equal((await connect("azure", { key, baseUrl: "https://mine.openai.azure.com/openai/v1" })).status, 200);
    const ollama = await connect("ollama", {});
    assert.equal(ollama.status, 200);
    const state = (await ollama.json()) as ProvidersState;
    assert.deepEqual(state.savedBaseUrls, {
      custom: "http://192.168.1.20:8000/v1",
      lmstudio: "http://localhost:1234/v1",
      azure: "https://mine.openai.azure.com/openai/v1",
      ollama: "http://127.0.0.1:11434/v1",
    });
    assert.deepEqual(seen, [
      "custom http://192.168.1.20:8000/v1 -",
      "lmstudio http://localhost:1234/v1 -",
      `azure https://mine.openai.azure.com/openai/v1 ${key}`,
      "ollama http://127.0.0.1:11434/v1 -",
    ]);
    assert.equal((await app.request("/api/providers/lmstudio", "DELETE")).status, 200);
    await app.close();

    // Keyless servers reconnect after a restart; keys and disconnected servers don't.
    app = await start({ connections: [], adapter, dataDir });
    const restarted = await providers(app);
    assert.deepEqual(restarted.connected.map((c) => `${c.id}:${c.source}`), ["custom:saved", "ollama:saved"]);
    assert.equal(restarted.savedBaseUrls.lmstudio, "http://localhost:1234/v1");
    assert.equal(restarted.savedBaseUrls.azure, "https://mine.openai.azure.com/openai/v1");
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("answers come back without the key; other hosts and cross-origin writes are refused", async () => {
  let used = "";
  const app = await start({
    adapter: (_preset, settings) => fake({
      generate: async () => {
        used = settings.key!;
        return completion;
      },
    }),
  });
  try {
    assert.deepEqual(await (await app.request("/api/health")).json(), { ok: true });
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
    for (const route of ["/api/health", "/api/providers", "/api/models"]) {
      const badHostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          get(
            app.origin + route,
            { headers: { Host: "other.example" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          ).on("error", reject);
        },
      );
      assert.equal(badHostStatus, 403);
    }
    assert.equal((await app.request("/api/me")).status, 404);
  } finally {
    await app.close();
  }
});

test("model lists keep the catalog's chat models, fall back to the catalog, and keep local servers' own", async () => {
  const live: Record<string, string[] | Error> = {
    deepseek: ["deepseek-flash", "deepseek-v4-pro", "deepseek-embedding-x"],
    openai: new Error("unreachable"),
    // A local server that happens to share an id with Ollama Cloud's catalog.
    ollama: ["llama3.2:3b", Object.keys(catalog.providers.ollama)[0], "qwen3:8b"],
  };
  const app = await start({
    connections: [deepseekEnv, { id: "openai", key, baseUrl: "https://api.openai.com/v1" }, { id: "ollama", baseUrl: "http://127.0.0.1:11434/v1" }],
    adapter: (preset) => fake({
      listModels: async () => {
        const list = live[preset.id];
        if (list instanceof Error) throw list;
        return list;
      },
    }),
  });
  try {
    const { models } = (await (await app.request("/api/models")).json()) as { models: ModelInfo[] };
    const of = (provider: string) => models.filter((m) => m.provider === provider);
    assert.deepEqual(of("deepseek").map((m) => [m.id, m.label, m.vision, m.contextWindow]), [
      ["deepseek-flash", "DeepSeek Flash", true, 1_048_576],
      ["deepseek-v4-pro", "DeepSeek V4 Pro", false, 1_048_576],
    ]);
    assert.equal(of("deepseek")[0].providerName, "DeepSeek");
    assert.deepEqual(of("openai").map((m) => m.id).sort(), Object.keys(catalog.providers.openai).sort());
    assert.deepEqual(of("ollama").map((m) => m.id).sort(), [...(live.ollama as string[])].sort());
    const local = of("ollama").find((m) => m.id === "llama3.2:3b")!;
    assert.deepEqual([local.vision, local.contextWindow], [true, undefined]);
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
    for (const ids of [{ canvasId: "../x" }, { requestId: "" }, { model: "has space" }, { model: "x".repeat(201) }, { model: 7 }])
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
    adapter: () => fake({
      generate: async (_model, messages) => {
        received.push(messages);
        return completion;
      },
    }),
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
    adapter: () => fake({
      generate: async () => {
        started();
        await hold;
        return completion;
      },
    }),
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
  const wait = fake({
    generate: async (_model, _messages, signal) =>
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
  });
  const app = await start({ adapter: () => wait, timeoutMs: 50 });
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

test("provider errors reach the browser; network failures become network_error", async () => {
  let mode = "refused";
  const app = await start({
    adapter: () => fake({
      generate: async () => {
        if (mode === "refused")
          throw new ApiError(429, "rate_limit", "DeepSeek is busy.");
        throw new TypeError("fetch failed");
      },
    }),
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

test("chat uses the chosen provider and model; unknown providers and image-blind models are rejected", async () => {
  const models: string[] = [];
  const app = await start({
    connections: [deepseekEnv, { id: "openrouter", key, baseUrl: "https://openrouter.ai/api/v1" }],
    adapter: (preset) => fake({
      generate: async (model) => {
        models.push(`${preset.id}/${model}`);
        return completion;
      },
    }),
  });
  const chat = (body: object) =>
    app.request("/api/chat", "POST", { ...chatBody, ...body });
  try {
    // Requests from before provider choice use DeepSeek Flash.
    assert.equal((await chat({})).status, 200);
    assert.equal((await chat({ model: "deepseek-v4-pro" })).status, 200);
    // Any well-formed id goes to the provider, which decides.
    assert.equal((await chat({ provider: "openrouter", model: "vendor/new-model:free" })).status, 200);
    assert.deepEqual(models, ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro", "openrouter/vendor/new-model:free"]);
    const unknown = await chat({ provider: "nope" });
    assert.equal(unknown.status, 400);
    assert.equal(await errorCode(unknown), "unknown_provider");
    const absent = await chat({ provider: "groq", model: "llama" });
    assert.equal(absent.status, 401);
    assert.match((await absent.json()).error.message, /Connect Groq/);
    const blind = await chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "Look", images: [png] }],
    });
    assert.equal(blind.status, 400);
    assert.equal(await errorCode(blind), "image_unsupported");
    assert.equal(models.length, 3);
  } finally {
    await app.close();
  }
});

// Adapter tests: requests and replies at the HTTP boundary.
type Call = { url: string; init: RequestInit };
function recorder(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply(String(url), init ?? {});
  }) as typeof fetch;
  return { calls, fetcher };
}
const adapterFor = (id: string, fetcher: typeof fetch, settings: { key?: string; baseUrl?: string } = { key }) =>
  openAICompatible(presetById(id)!, { key: settings.key, baseUrl: settings.baseUrl ?? presetById(id)!.baseUrl }, fetcher);
const answer = (content: unknown, finish_reason: unknown = "stop", extra: object = {}) =>
  Response.json({ choices: [{ message: { content }, finish_reason }], ...extra });
const signal = () => new AbortController().signal;
const headers = (call: Call) => new Headers(call.init.headers);

test("DeepSeek adapter sends complete roles/history and explicit non-thinking/non-streaming options", async () => {
  const { calls, fetcher } = recorder(() => Response.json({ model: "deepseek-flash", choices: [{ message: { content: "Answer" }, finish_reason: "length" }] }));
  const messages = [
    { role: "user" as const, content: "Root" },
    { role: "user" as const, content: "Clarify" },
  ];
  const result = await adapterFor("deepseek", fetcher).generate("deepseek-v4-pro", messages, signal());
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].init.redirect, "error", "a key never follows a redirect");
  assert.equal(headers(calls[0]).get("Authorization"), `Bearer ${key}`);
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.deepEqual(body.messages.slice(1), messages);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.stream, false);
  assert.equal(body.max_tokens, MAX_OUTPUT_TOKENS, "DeepSeek's thinking is off, so the normal cap applies");
  assert.equal(result.finishReason, "length");
  assert.equal(result.usage, undefined);
});

test("OpenAI uses max_completion_tokens with room for reasoning; trailing slashes are trimmed", async () => {
  const reasoning = Object.entries(catalog.providers.openai).find(([, e]) => e[4] === 1 && (e[2] as number) >= REASONING_OUTPUT_TOKENS)![0];
  const { calls, fetcher } = recorder(() => answer("Hi"));
  await adapterFor("openai", fetcher, { key, baseUrl: "https://api.openai.com/v1/" }).generate(reasoning, [{ role: "user", content: "Hi" }], signal());
  assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
  const body = JSON.parse(calls[0].init.body as string);
  assert.equal(body.max_completion_tokens, REASONING_OUTPUT_TOKENS);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.thinking, undefined);
  // Models the catalog doesn't know keep the normal cap.
  await adapterFor("groq", fetcher).generate("brand-new", [{ role: "user", content: "Hi" }], signal());
  assert.equal(JSON.parse(calls[1].init.body as string).max_tokens, MAX_OUTPUT_TOKENS);
});

test("each provider gets its own auth header; keyless servers get none", async () => {
  const { calls, fetcher } = recorder(() => answer("Hi"));
  const run = (id: string, settings?: { key?: string; baseUrl?: string }) =>
    adapterFor(id, fetcher, settings).generate("m", [{ role: "user", content: "Hi" }], signal());
  await run("azure", { key, baseUrl: "https://mine.openai.azure.com/openai/v1" });
  await run("cloudflare-ai-gateway", { key, baseUrl: "https://gateway.ai.cloudflare.com/v1/a/g/compat" });
  await run("anthropic");
  await run("ollama", { baseUrl: "http://127.0.0.1:11434/v1" });
  assert.equal(headers(calls[0]).get("api-key"), key);
  assert.equal(headers(calls[0]).get("Authorization"), null);
  assert.equal(JSON.parse(calls[0].init.body as string).max_completion_tokens, MAX_OUTPUT_TOKENS);
  assert.equal(headers(calls[1]).get("cf-aig-authorization"), `Bearer ${key}`);
  assert.equal(headers(calls[1]).get("Authorization"), null);
  assert.equal(calls[2].url, "https://api.anthropic.com/v1/chat/completions");
  assert.equal(headers(calls[2]).get("Authorization"), `Bearer ${key}`);
  assert.equal(calls[3].url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(headers(calls[3]).get("Authorization"), null);
  // Anthropic's model list takes x-api-key.
  await adapterFor("anthropic", fetcher).validate(signal());
  assert.equal(calls[4].url, "https://api.anthropic.com/v1/models");
  assert.equal(headers(calls[4]).get("x-api-key"), key);
  assert.equal(headers(calls[4]).get("anthropic-version"), "2023-06-01");
});

test("adapters send images as image_url parts and report token, cache and cost usage", async () => {
  let body: { messages: unknown[] } | undefined;
  let usage: object = {
    prompt_tokens: 1200,
    completion_tokens: 34,
    total_tokens: 1234,
    prompt_cache_hit_tokens: 1024,
    prompt_cache_miss_tokens: 176,
  };
  const { fetcher } = recorder((_url, init) => {
    body = JSON.parse(init.body as string);
    return Response.json({ model: "deepseek-flash", choices: [{ message: { content: "A cat." }, finish_reason: "stop" }], usage });
  });
  const result = await adapterFor("deepseek", fetcher).generate(
    "deepseek-flash",
    [
      { role: "user", content: "", images: [png] },
      { role: "assistant", content: "A picture." },
      { role: "user", content: "What is it?", images: [png] },
    ],
    signal(),
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
  const [, , , , , input, output, cacheRead] = catalog.providers.deepseek["deepseek-flash"] as number[];
  assert.deepEqual(result.usage, {
    promptTokens: 1200,
    completionTokens: 34,
    promptCacheHitTokens: 1024,
    promptCacheMissTokens: 176,
    cost: (176 * input + 1024 * cacheRead + 34 * output) / 1_000_000,
  });
  // OpenAI-style cached tokens; a reported cost wins over list prices.
  usage = { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 }, cost: 0.0042 };
  const routed = await adapterFor("openrouter", fetcher).generate("vendor/model", [{ role: "user", content: "Hi" }], signal());
  assert.deepEqual(routed.usage, { promptTokens: 100, completionTokens: 10, promptCacheHitTokens: 60, promptCacheMissTokens: 40, cost: 0.0042 });
  // Unknown models have no price.
  usage = { prompt_tokens: 100, completion_tokens: 10 };
  const local = await adapterFor("ollama", fetcher, { baseUrl: "http://127.0.0.1:11434/v1" }).generate("llama3", [{ role: "user", content: "Hi" }], signal());
  assert.deepEqual(local.usage, { promptTokens: 100, completionTokens: 10 });
});

for (const [status, code, body] of [
  [401, "invalid_key", "denied"],
  [403, "invalid_key", "forbidden"],
  [402, "insufficient_balance", "pay"],
  [429, "rate_limit", "slow down"],
  [413, "request_too_large", "too big"],
  [500, "provider_error", "oops"],
  [400, "context_limit", "context"],
  [404, "model_unavailable", "nothing here"],
  [400, "model_unavailable", "The model `x` does not exist"],
] as const) {
  test(`HTTP ${status} (${body}) maps to ${code}, names the provider and hides the upstream body`, async () => {
    const { fetcher } = recorder(() => new Response(`${body} ${key}`, { status }));
    await assert.rejects(
      adapterFor("groq", fetcher).generate("m", chatBody.messages as ChatMessage[], signal()),
      (error: unknown) => {
        const e = error as ApiError;
        return e.code === code && !e.message.includes(key) && (code === "context_limit" || e.message.includes("Groq"));
      },
    );
  });
}

test("key checks: DeepSeek's balance, OpenRouter's key endpoint, model lists elsewhere; upstream bodies stay hidden", async () => {
  let reply = () => Response.json({ is_available: true, balance_infos: [] });
  const { calls, fetcher } = recorder(() => reply());
  const deepseek = adapterFor("deepseek", fetcher);
  await deepseek.validate(signal());
  assert.equal(calls[0].url, "https://api.deepseek.com/user/balance");
  assert.equal(headers(calls[0]).get("Authorization"), `Bearer ${key}`);
  reply = () => Response.json({ is_available: false });
  await assert.rejects(deepseek.validate(signal()), (e: unknown) => (e as ApiError).code === "insufficient_balance");
  reply = () => new Response(`denied ${key}`, { status: 401 });
  await assert.rejects(deepseek.validate(signal()), (error: unknown) => {
    const e = error as ApiError;
    return e.code === "invalid_key" && !e.message.includes(key);
  });
  reply = () => Response.json({});
  await assert.rejects(deepseek.validate(signal()), (error: unknown) => (error as ApiError).code === "invalid_response");

  reply = () => Response.json({ data: {} });
  await adapterFor("openrouter", fetcher).validate(signal());
  assert.equal(calls.at(-1)!.url, "https://openrouter.ai/api/v1/key");
  await adapterFor("groq", fetcher).validate(signal());
  assert.equal(calls.at(-1)!.url, "https://api.groq.com/openai/v1/models");
  // A missing model list can't show the key is wrong.
  reply = () => new Response("missing", { status: 404 });
  await adapterFor("google", fetcher).validate(signal());
  // Providers whose lists are public aren't checked before the first answer.
  const before = calls.length;
  await adapterFor("huggingface", fetcher).validate(signal());
  assert.equal(calls.length, before);

  const down = adapterFor("ollama", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch, { baseUrl: "http://127.0.0.1:11434/v1" });
  await assert.rejects(down.validate(signal()), (error: unknown) => {
    const e = error as ApiError;
    return e.code === "unreachable" && /Ollama at http:\/\/127\.0\.0\.1:11434\/v1/.test(e.message) && /running/.test(e.message);
  });
});

test("model lists read the provider's ids and drop Google's models/ prefix", async () => {
  const { calls, fetcher } = recorder((url) =>
    url.includes("googleapis")
      ? Response.json({ data: [{ id: "models/gemini-x" }, { id: 42 }, { id: "bad id" }] })
      : new Response("no", { status: 401 }),
  );
  assert.deepEqual(await adapterFor("google", fetcher).listModels(signal()), ["gemini-x"]);
  assert.equal(calls[0].url, "https://generativelanguage.googleapis.com/v1beta/openai/models");
  assert.deepEqual(await adapterFor("groq", fetcher).listModels(signal()), []);
});

test("malformed, empty, filtered and unfinished provider answers are rejected; reasoning tags are removed", async () => {
  for (const response of [
    "{",
    JSON.stringify({
      choices: [{ message: { content: "  " }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    }),
    JSON.stringify({
      choices: [{ message: { content: "Partial" }, finish_reason: "aborted" }],
    }),
    JSON.stringify({ choices: [{ message: { content: "<think>only thoughts</think>" }, finish_reason: "stop" }] }),
  ]) {
    const { fetcher } = recorder(() => new Response(response));
    await assert.rejects(
      adapterFor("deepseek", fetcher).generate("deepseek-flash", [], signal()),
    );
  }
  const filtered = recorder(() => answer("Withheld", "content_filter"));
  await assert.rejects(adapterFor("openai", filtered.fetcher).generate("m", [], signal()), (e: unknown) => (e as ApiError).code === "content_filtered");
  const exhausted = recorder(() => answer("", "length"));
  await assert.rejects(adapterFor("openai", exhausted.fetcher).generate("m", [], signal()), (e: unknown) => /output budget/.test((e as Error).message));
  const parts = recorder(() => answer([{ type: "text", text: "<think>hmm</think>\n\nPart one, " }, { type: "text", text: "part two." }], null));
  const result = await adapterFor("together", parts.fetcher).generate("m", [], signal());
  assert.equal(result.content, "Part one, part two.");
  assert.equal(result.finishReason, "stop");
});

test("an image-related 400 is reported as an image problem, not a context limit", async () => {
  const { fetcher } = recorder(() => new Response("This model does not support image input tokens", { status: 400 }));
  await assert.rejects(
    adapterFor("deepseek", fetcher).generate("deepseek-v4-pro", [{ role: "user", content: "Look" }], signal()),
    (error: unknown) => (error as { code: string }).code === "image_unsupported",
  );
});

test("local attachment references support 600 images across ancestors and reject 601 before uploading", async () => {
  const dir = await mkdtemp(`${tmpdir()}/canvas-budget-api-`);
  let uploads = 0;
  const app = await start({
    dataDir: dir,
    adapter: () => fake({
      upload: async () => { uploads++; return 'file-api-local'; },
      generate: async (_model, messages) => {
        assert.equal(messages.flatMap(m => m.fileIds ?? []).length,600);
        assert.ok(messages.every(m => !m.attachmentIds && !m.images)); return completion;
      },
    }),
  });
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

test("providers without a Files API receive local attachments inline, within the request budget", async () => {
  const dir = await mkdtemp(`${tmpdir()}/canvas-inline-`);
  const received: ChatMessage[][] = [];
  const app = await start({
    dataDir: dir,
    connections: [{ id: "openai", key, baseUrl: "https://api.openai.com/v1" }],
    adapter: () => fake({ generate: async (_model, messages) => { received.push(messages); return completion; } }),
  });
  const chat = (attachmentIds: string[]) =>
    app.request("/api/chat", "POST", { ...chatBody, provider: "openai", model: "gpt-x", messages: [{ role: "user", content: "Look", attachmentIds }] });
  try {
    const bytes = Buffer.from("png-bytes");
    await app.request("/api/workspace/attachments/pixel", "PUT", undefined, { body: bytes, headers: { Origin: app.origin, "Content-Type": "image/png" } });
    assert.equal((await chat(["pixel", "pixel"])).status, 200);
    assert.deepEqual(received[0], [{ role: "user", content: "Look", images: [png, png] }]);
    // About 35 MiB of images fit inside the 48 MiB request.
    await app.request("/api/workspace/attachments/large", "PUT", undefined, { body: Buffer.alloc(20 * 1024 * 1024), headers: { Origin: app.origin, "Content-Type": "image/png" } });
    const tooMuch = await chat(["large", "large"]);
    assert.equal(tooMuch.status, 413);
    assert.match((await tooMuch.json()).error.message, /OpenAI receives images inside each request/);
    assert.equal(received.length, 1);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});

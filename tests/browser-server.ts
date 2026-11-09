// Test-only server. Production has no mock mode or test endpoints.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createApp } from "../server/app";
import { createChatGPTPlan } from "../server/chatgpt-plan";
import { completed, events, planFixture } from "./plan-fixture";
import type { EnvConnection } from "../server/config";
import catalog from "../shared/catalog.json" with { type: "json" };
import { SUMMARY_PROMPT } from "../shared/graph";

const markdown = [
  "# A little room to explore",
  "",
  "A **clear answer** with *a new direction* and `inline code`.",
  "",
  "> Follow your curiosity.",
  "",
  "- First idea",
  "  - A nested idea",
  "- Second idea",
  "",
  "| Thought | Direction |",
  "| --- | --- |",
  "| Branch | Explore |",
  "",
  "[A useful link](https://example.com)",
  "",
  "```js",
  'const thought = "a new path";',
  "```",
  "",
  "~~~python",
  'print("another thought")',
  "~~~",
  "",
  "```text",
  "a".repeat(200),
  "```",
  "",
  "<script>window.__markdownExecuted = true</script>",
  '<img src=x onerror="window.__markdownExecuted = true">',
];
const attempts = new Map<string, number>();
// The latest chat request a provider received, for assertions about what was sent.
let lastChat: unknown;
const website = [
  "Here is a small page.",
  "",
  "```html",
  "<!doctype html><html><head><title>Demo</title></head><body><h1 id=\"title\">Hello site</h1></body></html>",
  "```",
  "",
  "```css",
  "h1 { color: rgb(200, 0, 0); }",
  "```",
  "",
  "```js",
  "document.getElementById('title').dataset.ran = 'yes';",
  "```",
].join("\n");
// Model lists: DeepSeek's two models, and the first few of OpenAI's catalog.
const listed: Record<string, string[]> = {
  "api.deepseek.com": ["deepseek-flash", "deepseek-v4-pro"],
  "api.openai.com": Object.keys(catalog.providers.openai).slice(0, 3),
};
const fetcher: typeof fetch = async (_url, init) => {
  if (String(_url).endsWith("/user/balance")) return Response.json({ is_available: true, balance_infos: [] });
  if (String(_url).endsWith("/files")) return Response.json({ id: `file-api-${crypto.randomUUID()}`, expires_at: Math.floor(Date.now()/1000)+86400 });
  if (String(_url).endsWith("/models")) return Response.json({ data: (listed[new URL(String(_url)).host] ?? []).map((id) => ({ id })) });
  const body = JSON.parse(init?.body as string);
  lastChat = body;
  const content = body.messages.at(-1).content as
    | string
    | { type: string; text?: string }[];
  const images = Array.isArray(content)
    ? content.filter((part) => ["image_url", "file"].includes(part.type)).length
    : 0;
  const last = Array.isArray(content)
    ? content.map((part) => part.text ?? "").join(" ").trim() ||
      `image-only-${images}`
    : content;
  const count = (attempts.get(last) || 0) + 1;
  attempts.set(last, count);
  if (last.includes("retry-test") && count === 1)
    return new Response("{}", { status: 429 });
  const summary = last === SUMMARY_PROMPT;
  // Summaries of a conversation that mentions summary-fail-test always fail.
  if (summary && JSON.stringify(body.messages).includes("summary-fail-test"))
    return new Response("{}", { status: 429 });
  const delay = last.includes("slow-test") || (summary && JSON.stringify(body.messages).includes("slow-test")) ? 1800 : 80;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    init?.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
  const reply = last.includes("website-test") ? website :
    markdown.join("\n") +
    "\n\n" +
    last +
    (images ? `\n\nI can see ${images} image(s).` : "") +
    `\n\nAnswered by ${body.model}.`;
  return Response.json({
    model: body.model,
    choices: [
      {
        message: { content: reply },
        finish_reason: last.includes("truncate-test") ? "length" : "stop",
      },
    ],
    // Deterministic synthetic usage so the context meter can be checked.
    usage: {
      prompt_tokens: 100 * body.messages.length + 1024 * images,
      completion_tokens: 250,
      ...(last === "Branch with cached tokens" ? {
        prompt_cache_hit_tokens: 150,
        prompt_cache_miss_tokens: 150,
      } : {}),
    },
  });
};
const port = Number(process.env.PORT || 3317);
if (!process.env.CANVAS_DATA_DIR) throw new Error("Browser tests require isolated temporary storage.");
const app = express();
let run = 0;
// Fixtures start connected to DeepSeek, as with DEEPSEEK_API_KEY in .env,
// unless reset with ?key=none.
const freshApp = (connected = true, withPlan = false) => {
  run++;
  let retried = false;
  const chatGPTPlan = withPlan ? createChatGPTPlan({
    directory: path.join(process.env.CANVAS_DATA_DIR!, `plan-${run}`),
    fetcher: planFixture({
      generate(account, body) {
        const last = body.input.at(-1).content;
        if (last === "plan-retry-first" && !retried) {
          retried = true;
          return events({ type: "response.incomplete", response: { status: "incomplete" } });
        }
        if (last === "plan-limited" && account === "a") {
          return events({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } });
        }
        return events(completed(`Answer billed to ${account}`));
      },
    }).fetcher,
  }) : undefined;
  return createApp({
    fetcher, chatGPTPlan,
    connections: connected ? [{ id: "deepseek", key: "sk-synthetic-browser-test", baseUrl: "https://api.deepseek.com" } satisfies EnvConnection] : [],
    dataDir: path.join(process.env.CANVAS_DATA_DIR!, `run-${run}`),
  });
};
let testApp = freshApp();
const fixtures = new Map([[String(run), testApp]]);
app.post("/test/reset", (req, res) => {
  // Closing contexts may still send saves. Keep each context on its own
  // repository even when a late request arrives after the next fixture opens.
  testApp = freshApp(req.query.key !== "none", req.query.plan === "1");
  fixtures.set(String(run), testApp);
  res.json({ ok: true, run });
});
app.get("/test/last-chat", (_req, res) => res.json(lastChat ?? null));
app.use((req, res, next) => (fixtures.get(req.get("X-Canvas-Test-Run") || "") || testApp)(req, res, next));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
app.use(express.static(path.join(root, "dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.join(root, "dist", "index.html")),
);
const server = createServer(app);
server.listen(port, "127.0.0.1", () =>
  console.log("Test server ready"),
);

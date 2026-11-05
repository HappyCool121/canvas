// Test-only server. Production has no mock mode or test endpoints.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createApp } from "../server/app";
import { deepseek } from "../server/provider";

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
const fetcher: typeof fetch = async (_url, init) => {
  if (String(_url).endsWith("/user/balance")) return Response.json({ is_available: true, balance_infos: [] });
  if (String(_url).endsWith("/files")) return Response.json({ id: `file-api-${crypto.randomUUID()}`, expires_at: Math.floor(Date.now()/1000)+86400 });
  const body = JSON.parse(init?.body as string);
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
  const delay = last.includes("slow-test") ? 1800 : 80;
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
  const reply =
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
// Fixtures start connected, as with DEEPSEEK_API_KEY in .env, unless reset with ?key=none.
const freshApp = (connected = true) => createApp({
  provider: deepseek(fetcher),
  apiKey: connected ? "sk-synthetic-browser-test" : undefined,
  dataDir: path.join(process.env.CANVAS_DATA_DIR!, `run-${++run}`),
});
let testApp = freshApp();
const fixtures = new Map([[String(run), testApp]]);
app.post("/test/reset", (req, res) => {
  // Closing contexts may still send saves. Keep each context on its own
  // repository even when a late request arrives after the next fixture opens.
  testApp = freshApp(req.query.key !== "none");
  fixtures.set(String(run), testApp);
  res.json({ ok: true, run });
});
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

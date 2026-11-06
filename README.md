# Canvas

A little more room for your thoughts. Canvas is a visual conversation tree for AI chats: continue a conversation downward, explore alternatives sideways, and return to any earlier message.

## Hosted Canvas and this repository

Canvas comes in two forms.

**Hosted Canvas** ([canvas.adrouter.co](https://canvas.adrouter.co)) is the official cloud version, currently in beta with a waitlist:

- **Sign in with Google** and keep your canvases in the cloud, on any device.
- **Share a canvas** with the people you invite, as viewers or editors. No one else can open it.
- **Work together.** Editors prompt, branch, edit prompts, attach files and move bubbles on the same canvas, and changes appear for everyone within seconds. Each person keeps their own selection, draft, reading panel and view.
- **No API key needed.** Models are included through Canvas credits.

**This repository** is the open-source version of the same canvas, for personal use. It runs on your own machine with your own API keys from almost any provider: OpenAI, Anthropic, Google Gemini, DeepSeek, OpenRouter, a local Ollama server, or any OpenAI-compatible endpoint. Your canvases are saved as files on your computer. It has no accounts, cloud sync, sharing or collaboration, and no usage limits of its own: each provider bills you directly.

## Quick start

Requires Node.js 22.13+, npm, and an API key from one of the [supported providers](#providers), or a local model server such as Ollama or LM Studio. From this directory:

```sh
npm ci
npm run dev
```

1. Open **http://127.0.0.1:3000**. Keep the terminal running while you use Canvas.
2. Choose **Connect a provider to send** in the composer, or **Connect a provider** at the bottom of the sidebar.
3. Pick your provider, paste your key (local servers don't need one) and choose **Connect**. Then pick a model in the composer and write your first prompt.

You can connect several providers at once and switch models between prompts, so you can branch sideways from any message to ask a different model. If port 3000 is busy, run `PORT=3001 npm run dev` and open that address instead. For a built app, run `npm run build && npm start`.

## Providers

Canvas speaks the OpenAI Chat Completions API, which most providers offer. Anthropic and Google Gemini are reached through their official OpenAI-compatible endpoints. The list follows the providers supported by [pi](https://github.com/earendil-works/pi).

| Provider | `.env` variables | Notes |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | |
| Anthropic | `ANTHROPIC_API_KEY` | Through Anthropic's OpenAI SDK compatibility endpoint. |
| Google Gemini | `GEMINI_API_KEY` | Through Gemini's OpenAI-compatible endpoint. |
| DeepSeek | `DEEPSEEK_API_KEY` | Images go through DeepSeek's Files API, so a branch can carry up to 600 images. Thinking is turned off. |
| xAI | `XAI_API_KEY` | |
| Mistral | `MISTRAL_API_KEY` | |
| Moonshot AI | `MOONSHOT_API_KEY` | Global or China endpoint. |
| Kimi For Coding | `KIMI_API_KEY` | |
| MiniMax | `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY` | Global or China endpoint. |
| Z.AI | `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` | General or Coding Plan, global or China. |
| Qwen (Alibaba Model Studio) | `DASHSCOPE_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY` | Pay-as-you-go or Token Plan. |
| Xiaomi MiMo | `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_CN_API_KEY`, `XIAOMI_TOKEN_PLAN_AMS_API_KEY`, `XIAOMI_TOKEN_PLAN_SGP_API_KEY` | API billing or a regional Token Plan. |
| Ant Ling | `ANT_LING_API_KEY` | |
| Groq | `GROQ_API_KEY` | |
| Cerebras | `CEREBRAS_API_KEY` | |
| Together AI | `TOGETHER_API_KEY` | |
| Fireworks | `FIREWORKS_API_KEY` | |
| Baseten | `BASETEN_API_KEY` | |
| NVIDIA NIM | `NVIDIA_API_KEY` | The key is first checked by your first answer. |
| Hugging Face | `HF_TOKEN` | Inference Providers router. The key is first checked by your first answer. |
| OpenRouter | `OPENROUTER_API_KEY` | Reports each answer's actual cost. |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` | |
| OpenCode Zen / Go | `OPENCODE_API_KEY` | Models on OpenCode's OpenAI-compatible route. The key is first checked by your first answer. |
| Cloudflare Workers AI | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` | |
| Cloudflare AI Gateway | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID` | The gateway's `/compat` endpoint, with its stored provider keys or unified billing. The key is first checked by your first answer. |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` (or `AZURE_OPENAI_RESOURCE_NAME`) | Base URL like `https://<resource>.openai.azure.com/openai/v1`. Type your deployment name in the model menu if it isn't listed. |
| Ollama | `OLLAMA_BASE_URL`, or `OLLAMA_API_KEY` for Ollama Cloud | No key needed locally. |
| LM Studio | `LMSTUDIO_BASE_URL` | No key needed. |
| Custom (OpenAI-compatible) | `OPENAI_COMPATIBLE_BASE_URL` + optional `OPENAI_COMPATIBLE_API_KEY` | vLLM, llama.cpp, LiteLLM or any server with `/chat/completions`. |

Not supported: Amazon Bedrock and Google Vertex AI (they sign requests with cloud credentials rather than an API key), GitHub Copilot and OpenAI Codex (subscription sign-in rather than API keys), Meta's Model API (pi reaches it through the OpenAI Responses API, which Canvas doesn't speak), and pi's own Radius and TypeSafe services. A provider with an OpenAI-compatible endpoint that isn't listed works through **Custom**.

**Models.** After you connect, the model menu lists the provider's chat models, with context windows, image support and prices from a bundled snapshot of [models.dev](https://models.dev) (MIT). Search the menu, or type any model id the provider accepts, such as an Azure deployment or a model released after the snapshot. Local servers list their own models. Refresh the snapshot with `npm run catalog`; Canvas never fetches it while running.

## Your keys

- **Connecting:** Canvas checks a key without running inference: it reads DeepSeek's balance, OpenRouter's key details, Vercel's credits or the provider's model list. A DeepSeek key that works but has no balance is refused with its own message. Providers that publish their model list without a key (marked in the table) are checked by your first answer instead.
- **Where keys live:** only in the memory of the local Canvas server process. They are never returned by the API, stored in browser storage, written to disk, bundled into the app or logged. Reloading the page keeps the connections. Restarting Canvas clears keys entered in the app. **Disconnect** clears a key immediately and stops that provider's answers in progress.
- **What is saved:** base URLs you enter, never keys, are saved in `preferences.json` so the form is filled in next time. Local servers you connected without a key (Ollama, LM Studio, a custom endpoint) reconnect at startup.
- **`.env`:** to connect at startup, run `cp .env.example .env` and set the variables from the table. Variables already exported in your shell, such as `OPENAI_API_KEY`, connect too. You can still replace a key in the app for the current session; restarting reconnects the `.env` keys.
- **Addresses:** base URLs must use `https://`. Plain `http://` is allowed only for this computer (`localhost`, `127.0.0.1`) and private network addresses (`10.x`, `172.16–31.x`, `192.168.x`, `*.local`). Canvas never follows a redirect with your key.
- **Local only:** the server listens on `127.0.0.1` only. It refuses API requests addressed to any other hostname and writes from any other origin, so other websites can't use your keys. Canvas has no sign-in, so don't expose it on a network: anyone who could reach it could read your canvases and spend your balance.
- **Billing:** each provider bills your account directly for every answer. The sidebar shows tokens used and an estimated cost for the current canvas at catalog list prices; OpenRouter reports the actual charge. DeepSeek charges more at peak hours, and answers from models without a listed price make the estimate partial.
- **Settings:** non-streaming Chat Completions with Canvas's system prompt, a 4,096-token output cap (16,384 for reasoning models, so they have room to think before answering) and a 300-second timeout. DeepSeek runs with thinking disabled. There is no automatic retry or fallback provider.

## Follow a thought

- Submit a root prompt; its answer appears directly below.
- Click any completed bubble (white prompts, grey answers) to choose the context for your next prompt. It turns green, opens in the reading panel and brings up the composer. Clicking another bubble replaces the panel. Close the reading panel with X to keep the bubble selected and the composer bottom-centered. The panel stays hidden across selections and prompts; use the arrow on the right to reopen it. Click empty canvas or press Escape to deselect.
- The top bar shows the selected branch as a flowchart (prompt → answer → …). Click a step to jump to it.
- New prompt/answer pairs choose a spacious direction among adjacent positions. Answers stay below their prompts; nearby bubbles gently yield, while the branching parent and distant bubbles stay fixed. Settled positions are saved, including small adjustments to manually positioned neighbours.
- The AI sees only the root-to-selected-message path plus your new prompt. Later messages and sibling branches are excluded. Branching from a user message preserves consecutive user roles.
- **Edit prompt** in the reading panel rewrites a prompt: the rewrite branches sideways from the original (dashed connector) and gets a fresh answer. The rewrite replaces the original in context; the original branch is kept.
- Attach up to 600 images or rendered document pages across the selected conversation with the image button, by pasting, or by dropping them on the composer. Canvas bubbles show a bounded preview; the reader provides all attachments. Large images are downscaled in the browser; formats providers don’t take (HEIC in Safari, AVIF or BMP in Chrome) are converted to JPEG/PNG when the browser can read them.
- Choose the model from the composer’s model menu, grouped by provider. Search it, or type a model id the list doesn’t show. The choice is remembered in the local workspace; each answer records its provider and model, and retries use them. Models that can’t see images, such as DeepSeek V4 Pro, receive each image in the branch as a short “[Image not shown…]” note, and attaching is disabled until you choose a model that sees images.
- Every bubble shows when it was written in its bottom-left corner. Errors appear as a dismissible pop-up above the composer.
- The layout settles like a mind map, then stops. Outside new-branch insertion, selecting a bubble moves only that bubble against stationary neighbours and connected anchors. Shift + drag empty canvas to select intersecting bubbles; each rectangle replaces the previous group. Shift + click toggles group membership. Drag any selected bubble to move the group while preserving relative positions; unselected bubbles stay stationary. Ordinary clicking selects one bubble. Group gestures keep the last active reader/reply target and reader visibility, and hide individual appearance/resize controls. Groups reset to the active bubble on reload or canvas switch. Dropped positions stay relative to their final parent positions. Deselecting resumes whole-map settling only when needed. Scroll to pan, pinch or use −/+ to zoom. **Fit to view** shows the graph; **Go to root** returns to the initial prompt.
- The bar in the bottom-left corner shows the selected branch’s context against the chosen model’s context window: exact once the provider reports usage, estimated otherwise. For models without a known window it shows the token count only.
- The reading panel supports headings, nested lists, links, tables, blockquotes, inline code and fenced code blocks. External images in answers are represented as labels; raw HTML is disabled.
- Three circular controls surround the selected bubble’s top-right corner: **Color** (white, pale blue, mist, lavender, coral, or reset), **Compact** (the first Markdown heading or an 80-character excerpt), and **Expand** (the full answer on the canvas). Toggle Compact/Expand again to restore the preview. Colors and display modes are saved; existing messages keep their original appearance. The controls keep their size when zooming.
- The branch pill is centered on the workspace and prioritizes the selected title. Its ellipsis opens omitted ancestors; narrow windows place it on a second row. The first answer is centered in the area around the reading panel and composer. Panning or zooming immediately cancels camera framing.
- Hide the sidebar with the panel button next to the logo; bring it back from the top-left of the canvas.
- Enter sends; Shift+Enter inserts a newline. A canvas accepts one generation at a time. You can switch canvases while an answer is pending; it stays attached to its original prompt.

### Corner resizing and motion

Select a bubble to show four lavender corner brackets. Drag any corner in either axis, or focus its bracket and use arrow keys (8 canvas units; Shift uses 32). The opposite corner stays fixed and the minimum is 160 × 72. Preview, Compact and Expanded each remember their own dimensions. Existing bubbles keep automatic sizing until resized in that mode.

Manually sized content reflows at its existing font size and scrolls inside the bubble; its timestamp stays outside the scrolling content. Compact shows only the derived title. Physics and the camera pause for resizing, connectors follow the rectangle, and neighbours stay stationary. The chosen rectangle stays in place after release; deselection permits map settling.

The selected-path pill retains its last path through a 550ms exit. Appearance buttons use a 520ms transition and remain 32px at any zoom; exiting controls immediately become inert. Reduced motion removes movement and scaling.

Creating a branch launches the new bubbles outward with a short, controlled settling motion, usually about a second after dimensions stabilize. Placement considers both bubbles; branches above a parent put the response above the prompt, including upward diagonals, and keep that ordering as the answer grows. The camera frames the new pair quickly, then follows the completed answer continuously. Panning, pinching, dragging or resizing cancels that movement. The reading panel and composer animate together when opening or closing, and the composer stays editable throughout. Reduced-motion preferences remove those transitions.

### Large attachments and Safari gestures

The selected ancestor path and draft share a 600-image and 200 MiB image budget. The composer shows remaining capacity. Images are optimized as before; original standalone images can be up to 64 MiB. PDF/DOCX source files have no fixed byte cap: browser rendering, memory and disk space remain practical constraints. Documents attach all pages when they fit; otherwise choose a page range. Preparation is cancellable and reports page progress.

For DeepSeek, the local server uploads prepared images through DeepSeek’s Files API when sending a prompt, with 24-hour expiry. Matching uploads are reused for the server’s lifetime. Expired uploads are recreated from local bytes. Upload failures keep the existing retryable answer; restarting the server clears the upload cache. Provider account storage quotas still apply. Other providers receive images inside each request, which leaves room for about 35 MiB of prepared images; providers also set their own limits on image count and request size, and report them as errors.

Canvas text is not selectable; copy text from the reader. Composer editing is unchanged. Pinching over the graph or any bubble zooms around the pointer even while the composer is focused. The reader and composer keep their normal gestures. In Safari, [WebKit bug 233141](https://bugs.webkit.org/show_bug.cgi?id=233141) can let a trackpad pinch open tab overview despite canceled gestures.

## Your saved workspace

Canvases, complete messages, positions, selection, unsent drafts and viewport are saved as files in your user data folder:

| Platform | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/Canvas` |
| Windows | `%APPDATA%\Canvas` |
| Linux and others | `$XDG_DATA_HOME/canvas`, or `~/.local/share/canvas` |

Set `CANVAS_DATA_DIR` to an absolute directory to use another location. Each canvas is one JSON file in `canvases/`. `attachments/` stores ID-to-object metadata; `objects/` stores separate original image/PDF/DOCX bytes, keyed by SHA-256. `preferences.json` remembers the active canvas, sidebar/model choices and completed imports. Your API key is never written to this folder.

The server serializes writes, syncs temporary files and atomically replaces snapshots. **Saved locally** appears after a successful disk acknowledgment. A prompt and pending answer must be saved before inference starts. Failed saves retain the in-memory canvas and offer **Try saving again**; keep the tab open until it succeeds.

Earlier versions of Canvas stored canvases in the browser’s `canvas-workspace` IndexedDB. On first opening from each browser/origin, Canvas copies those canvases, drafts, images and original documents to disk. Browser originals remain intact. Interrupted imports retry on reload and completed snapshots are not imported twice. A conflicting history or attachment gets a separate identifier, preserving both versions.

Any browser or localhost port using this server and data folder sees the same canvases; clearing browser site data and restarting the server do not remove them. Use **one active editing tab**. There is no cloud sync or multi-tab conflict resolution. Selected ancestor history travels through the local server to the provider you chose for inference.

Back up the entire data folder while Canvas is closed. Keep `canvases/`, `attachments/`, `objects/` and `preferences.json` together. **Export canvas as JSON** includes referenced attachment bytes and bubble appearance. Unreferenced attachment objects are retained so draft cleanup and retries cannot damage older snapshots; the data folder can grow over time.

On page reload or browser closure, unfinished requests are interrupted. The pending answer becomes a retryable card next time you open the workspace. **Retry answer** uses the same prompt and placeholder rather than adding duplicate nodes.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Send is disabled, “Connect a provider to send” | Connect a provider in the app, or set its variable in `.env` and restart Canvas. |
| “Connect … first” on an answer | Canvas restarted or that provider was disconnected. Connect it again, then use the answer’s retry action. |
| Key rejected | Check that the key belongs to the provider you chose, then connect it again (or fix it in `.env` and restart). |
| Insufficient balance | Add funds to that provider’s account, then connect again or retry the answer. |
| “Couldn’t reach … at …” | Check the base URL. For a local server, make sure it is running and serving its OpenAI-compatible API (for example `http://127.0.0.1:11434/v1` for Ollama). |
| “… doesn’t offer this model” | Choose another model, or check the model id or Azure deployment name you typed. |
| “… spent its whole output budget thinking” | A reasoning model used all 16,384 output tokens before answering. Retry, or choose a model without reasoning. |
| Cannot reach the local server | Start Canvas with `npm run dev` and keep the terminal open. |
| Rate limit / network / timeout | Wait or check connectivity, then use the existing answer's retry action. |
| Output limit reached | The retained answer is marked truncated; select it and ask a follow-up. |
| Context limit | Branch from an earlier message or start a new canvas. History is never silently trimmed or summarized. |
| Not saved | Keep the tab open, free disk space or check folder permissions, and click **Try saving again**. No new inference is sent if its prompt cannot be saved. |
| Workspace missing | Check `CANVAS_DATA_DIR` and your data-folder backup. For older browser-only history, open its original browser profile, hostname and port once. |

## Development

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium webkit
npm run test:e2e
```

- **Unit and API tests** cover:
  - context isolation, placement, prompt edits, images and persistence
  - config, connecting and disconnecting keys, the local Host and Origin checks, request validation and per-canvas locks
  - several providers, base URL rules, provider requests and auth headers, model lists, usage and cost
  - timeouts, disconnects and provider error mapping
- **Browser tests** run the built app against a **test-only server** with mocked provider fetches. There is no production mock switch and no automated paid inference. Screenshots are saved under `output/playwright/`.

### Structure

- `shared/`: conversation types, ancestry, link kinds, placement, token estimates, recovery, the provider presets (`providers.ts`) and the bundled model catalog (`catalog.json`, refreshed by `scripts/update-catalog.ts`).
- `server/`: local HTTP API, config, in-memory keys, the OpenAI-compatible adapter (`provider.ts`) and catalog lookups. `server/workspace.ts` holds serialized filesystem storage and idempotent import receipts.
- `src/`: bubble graph and force layout (`physics.ts`), top bar, reading panel, composer, context meter, sidebar, provider dialog, image handling and the API repository (with a retained IndexedDB import adapter).
- `tests/`: domain, disk/browser storage, API and browser acceptance. `node --import tsx tests/profile-layout.ts` writes collision profiling evidence to `output/layout-profile.json`.

See `SPEC.md` for behavior. Streaming, cloud sync, tools, regeneration and branch merging are not implemented yet.

## License

[MIT](LICENSE)

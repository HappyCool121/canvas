# Canvas — MVP Spec

## Summary

**Canvas** is a web app for interacting with AI through a visual conversation tree. Users can follow a conversation downward, explore alternatives sideways, and return to earlier messages without losing their place.

**MVP success:** A user starts a conversation, creates multiple branches, and resumes any branch with the correct conversation context.

Canvas runs on the user's own machine, with no sign-in or credit limits. The user brings their own keys for any of about 30 OpenAI-compatible providers (OpenAI, Anthropic and Gemini through their compatibility endpoints, DeepSeek, OpenRouter, local servers such as Ollama, or a custom endpoint), connected in the app for the server session or set in `.env`. A hosted version with sign-in, sharing and collaboration lives outside this repository.

## Core Experience

1. **Start a canvas:** Show a prompt composer in the center of an empty workspace. Submitting creates the root user-message bubble.
2. **Receive an answer:** Show a loading placeholder directly below the prompt, then render the completed answer there.
3. **Continue a conversation:** Click an answer to select it and open a follow-up composer. The first follow-up continues downward in that conversation’s column.
4. **Create an alternative:** Submitting another follow-up from a message that already has a continuation creates a branch beside the existing path.
5. **Revisit any message:** Users can select any completed user or assistant bubble and create a follow-up. Branches from user bubbles appear sideways, preserving the original prompt-and-answer pair.
6. **Edit a prompt (v0.2):** Editing a prompt creates a rewritten prompt that branches sideways from the original bubble; its new answer hangs below it. The rewrite replaces the original in context, and the original and its replies stay unchanged.
7. **Attach images (v0.2):** Prompts can include up to six images (picker, paste or drop), shown whole in the prompt bubble. They are sent as PNG, JPEG, GIF or WebP; other formats the browser can decode are converted first. Models that see images receive them as image inputs; image-only prompts are allowed.
8. **Choose a model (v0.3):** Any model from any connected provider, grouped by provider in a searchable menu, or a typed model id. Each answer records its provider and model. Models that cannot see images receive a text note in place of each image in the branch, and attaching is disabled while one is selected.

Visible connectors show each message’s parent: continuations connect bottom to top, and side branches connect bubble sides. Selecting a bubble highlights its path back to the root and shows that path as a flowchart in the top bar. A “Go to root” control returns the viewport to the initial prompt.

**Selection (v0.2):** Selecting a bubble turns it green, opens it in the reading panel and shows the composer; selecting another replaces the panel. Clicking empty canvas or pressing Escape deselects, closing the panel and hiding the composer for an unobstructed map.

## MVP Requirements

**Workspace**

- Desktop-first, pannable and zoomable canvas with a subtle grid, draggable message bubbles, and floating top controls (zoom, fit to view, go to root, minimap, help). The collapsible minimap numbers root bubbles and highlights the selected path.
- A live force layout keeps bubbles apart and arranges them as a mind map. While selected, only that bubble simulates against stationary neighbours; direct dragging moves just the dragged bubble. Deselecting resumes whole-map settling only when needed; a dropped bubble keeps its place relative to its parent. Settled positions are saved, and reopening a canvas does not restart motion.
- Flat, borderless bubbles with no header or footer: white for prompts, larger grey bubbles for answers, green when selected. Each bubble shows a subtle timestamp in its bottom-left corner.
- Answer bubbles have bounded Markdown previews. The full content opens in a right-hand reading panel without moving the graph.
- A collapsible sidebar; the collapsed state is remembered in the local workspace.
- A context meter anchored bottom-left shows the selected branch’s tokens against the chosen model’s context window (from the bundled models.dev catalog; tokens only when unknown), using the provider’s reported usage where available and an estimate otherwise.
- Assistant responses support Markdown headings, nested lists, links, blockquotes, tables, inline code, and fenced code blocks. Raw HTML is disabled.
- The sidebar lists saved canvases, in folders or in “Your space”, and provides “New canvas” (blank or imported from a JSON export), “New folder”, and per-canvas rename, move and delete (with confirmation). Folders and saved custom colors are workspace preferences.
- The reading panel expands from its top-left corner into chat mode: the selected branch as a chat over the whole canvas, with the composer still available; the graph keeps rendering behind it.
- Answers containing an HTML page show a preview in the bubble and the live page in the reader, in a sandboxed frame with scripts allowed and every outside request blocked.

**Conversation behavior**

- Each follow-up sends the root-to-selected-message history plus the new prompt.
- A canvas may have several roots. “Branch off” cuts a branch loose in place (“Continue here”) or copies it to a new canvas (“New chat”); its context then starts at its top bubble. A branch starting with an answer is preceded by a short user turn.
- When the bubble has earlier context, Branch off then asks what happens to it: “Leave it out”, or “Summarize it”. The option names the composer’s model and about how many tokens it will read. It is unavailable without a connected model, when the context exceeds that model’s window, or (on this canvas) while an answer is being written. A summary is a pending answer, saved before it is requested, that opens in the reader. On this canvas it summarizes the path above the cut and becomes the branch’s new root, beside the top bubble; the old link to the cut bubble stays as a dotted line, as that context is no longer sent. A new chat holds only the summary, written from the source canvas’s path up to and including the chosen bubble; no bubbles are copied. Requests below a summary send “Summarize our earlier conversation.” and the summary in place of the earlier messages; nothing can be sent from below it until it is written. A summary that fails or is interrupted offers Retry and “Leave it out”, which removes it and gives what leaving the context out up front would have: on this canvas the branch’s top bubble becomes its own root, and a new chat gets a copy of the branch from the source canvas (or starts blank if that canvas or bubble is gone). The context meter ignores usage reported before a summary.
- Prompts may carry code and text files, sent inline as fenced blocks before the prompt. Models get no tools.
- Each answer records the thinking level it requested; “Default” sends none.
- Sibling branches and messages after the selected message are excluded.
- Existing messages remain unchanged when new branches are added.
- One generation runs per canvas at a time.
- Failed requests preserve the prompt and show an error with a retry action.
- Retry reuses the existing answer placeholder; interrupted requests become retryable after reload.
- Completed responses remain attached to their original canvas when the user switches canvases.
- Responses appear when complete; streaming is deferred.

**Local server**

- One local server, listening on `127.0.0.1` only, serves the interface and API; provider requests pass through it. API requests for other hostnames or from other origins are refused.
- **Provider keys (session):** the user connects any number of providers in the app's provider dialog. The server checks each key without inference (DeepSeek's balance, OpenRouter's key endpoint, Vercel's credits, or the model list) and keeps it in process memory until **Disconnect** or a restart. A DeepSeek key that works but has no balance is refused with a distinct message. Each provider's standard variable in `.env` (for example `OPENAI_API_KEY`) connects it at startup. Keys are never returned by the API, stored in the browser, written to disk or logged. Base URLs must be https, except for loopback and private-network servers; entered base URLs are saved, and keyless local servers reconnect at startup. Without a connected provider, prompts can be drafted but not sent; a chat request for a disconnected provider fails with `not_connected` and the answer stays retryable. Disconnect stops that provider's answers in progress.
- **Requests:** non-streaming Chat Completions with a 4,096-token output cap (16,384 for reasoning models, or when a thinking level is chosen) and a 300-second timeout. DeepSeek receives images through its Files API with thinking disabled; other providers receive them inline. Usage records an estimated cost from catalog list prices, or the provider's reported charge.

**Storage**

- Persist canvases, messages, positions, selection, unsent drafts, viewport and preferences in the platform's application-data folder (`~/Library/Application Support/Canvas` on macOS, `%APPDATA%\Canvas` on Windows, `$XDG_DATA_HOME/canvas` or `~/.local/share/canvas` elsewhere), or `CANVAS_DATA_DIR`. Keep one JSON per canvas and separate attachment bytes. Serialize disk writes, sync temporary files and atomically replace snapshots. Copy IndexedDB non-destructively with idempotent receipts and separate conflict histories; browser originals remain intact. One active editing tab is supported.
- Save optional message `color`, `displayMode`, and `sizes` fields (`preview`, `compact`, `expanded` → `{ width, height }`); missing fields retain the current appearance. Provide zoom-independent color, compact-title and expanded-content controls around the selected bubble. Resizing must leave unselected bubbles stationary and refresh edge connectors.
- Center the measured branch pill, omit oldest ancestors first and keep an ellipsis navigation menu. Derive titles from the first Markdown heading, otherwise an excerpt of up to 80 characters or an attachment/status label. Frame the first answer in the usable area and cancel camera control on user pan/zoom.
- Save a prompt and pending answer before requesting inference; visibly report storage failures.
- The server keeps no transcripts.

**Deferred:** Native (non-OpenAI-compatible) provider APIs, cloud sync, collaboration, binary non-image attachments, tools, search, branch merging, in-place message editing, response regeneration, showing a model's thinking, and mobile optimization.

## Acceptance Scenarios

- A root prompt produces an answer directly below it.
- A first follow-up continues downward; a second follow-up from the same answer creates a side branch.
- Follow-ups work from both user and assistant messages.
- Each branch receives only its ancestor history.
- Creating or retrying a branch leaves existing branches intact.
- Saved canvases and their layout survive a page reload.
- Key and network failures preserve the user’s work and allow retry.
- A key entered in the app enables sending, survives a page reload, never appears in browser storage, and is cleared by Disconnect.
- Pan, zoom, selection, and “Go to root” make earlier conversations accessible.
- Full Markdown answers can be read in the reading panel without changing node positions.
- Deselecting hides the panel and composer; selecting another bubble replaces the panel content.
- An edited prompt branches from the original and its request excludes the original prompt.
- An attached image reaches a model that sees images as an image input and survives a reload.
- Several providers can be connected at once; an answer uses the provider and model it was requested with, and disconnecting one provider leaves the others connected.
- The context meter and the top-bar path follow the selected bubble.
- Branching off with a summary sends only the summary and the branch, and a new chat starts from the summary alone; a failed summary can be retried or left out, with the same result as leaving it out up front.


## Motion and corner resizing

The selected path fades over 550ms with 12px downward entry/upward exit, retaining its contents throughout exit. The 32px color, compact, expand and branch-off controls animate for 520ms from the bubble’s top-right corner onto an arc concentric with its 24px corner (radius 60 screen pixels, at 112.5°, 67.5°, 22.5° and -22.5°): two above the bubble and two beside it. Exiting controls are inert immediately. Reduced motion disables movement/scaling.

Four selected-only lavender corner brackets use React Flow resize controls with touch targets and keyboard arrows (8 units, Shift 32), free axes, fixed opposite corners and a 160 × 72 minimum. Each display mode remembers its own optional rectangle. Live resizing suspends camera/physics, updates edges and leaves neighbours stationary. Release saves the exact size, position and parent offset; deselection permits whole-map settling. Manually sized content reflows and scrolls with timestamps outside the content. The reading panel remains unchanged. Old messages auto-size; canvas version and API routes are unchanged.

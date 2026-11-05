# Canvas — MVP Spec

## Summary

**Canvas** is a web app for interacting with AI through a visual conversation tree. Users can follow a conversation downward, explore alternatives sideways, and return to earlier messages without losing their place.

**MVP success:** A user starts a conversation, creates multiple branches, and resumes any branch with the correct conversation context.

Canvas runs with DeepSeek inference, behind an adapter so other providers can be added later. It runs on the user's own machine, with no sign-in or credit limits. The user connects their own DeepSeek key in the app for the server session, or sets it in `.env`.

## Core Experience

1. **Start a canvas:** Show a prompt composer in the center of an empty workspace. Submitting creates the root user-message bubble.
2. **Receive an answer:** Show a loading placeholder directly below the prompt, then render the completed answer there.
3. **Continue a conversation:** Click an answer to select it and open a follow-up composer. The first follow-up continues downward in that conversation’s column.
4. **Create an alternative:** Submitting another follow-up from a message that already has a continuation creates a branch beside the existing path.
5. **Revisit any message:** Users can select any completed user or assistant bubble and create a follow-up. Branches from user bubbles appear sideways, preserving the original prompt-and-answer pair.
6. **Edit a prompt (v0.2):** Editing a prompt creates a rewritten prompt that branches sideways from the original bubble; its new answer hangs below it. The rewrite replaces the original in context, and the original and its replies stay unchanged.
7. **Attach images (v0.2):** Prompts can include up to six images (picker, paste or drop), shown whole in the prompt bubble. They are sent as PNG, JPEG, GIF or WebP; other formats the browser can decode are converted first. DeepSeek Flash receives them as image inputs; image-only prompts are allowed.
8. **Choose a model (v0.3):** DeepSeek Flash or DeepSeek V4 Pro, with the same key. V4 Pro cannot see images: it receives a text note in place of each image in the branch, and attaching is disabled while it is selected.

Visible connectors show each message’s parent: continuations connect bottom to top, and side branches connect bubble sides. Selecting a bubble highlights its path back to the root and shows that path as a flowchart in the top bar. A “Go to root” control returns the viewport to the initial prompt.

**Selection (v0.2):** Selecting a bubble turns it green, opens it in the reading panel and shows the composer; selecting another replaces the panel. Clicking empty canvas or pressing Escape deselects, closing the panel and hiding the composer for an unobstructed map.

## MVP Requirements

**Workspace**

- Desktop-first, dark, pannable and zoomable canvas with a subtle grid, draggable message bubbles, and floating top controls (zoom, fit to view, go to root, help).
- A live force layout keeps bubbles apart and arranges them as a mind map. While selected, only that bubble simulates against stationary neighbours; direct dragging moves just the dragged bubble. Deselecting resumes whole-map settling only when needed; a dropped bubble keeps its place relative to its parent. Settled positions are saved, and reopening a canvas does not restart motion.
- Flat, borderless bubbles with no header or footer: white for prompts, larger grey bubbles for answers, green when selected. Each bubble shows a subtle timestamp in its bottom-left corner.
- Answer bubbles have bounded Markdown previews. The full content opens in a right-hand reading panel without moving the graph.
- A collapsible sidebar; the collapsed state is remembered in the local workspace.
- A context meter anchored bottom-left shows the selected branch’s tokens against the model’s 1M-token window, using DeepSeek’s reported usage where available and an estimate otherwise.
- Assistant responses support Markdown headings, nested lists, links, blockquotes, tables, inline code, and fenced code blocks. Raw HTML is disabled.
- The sidebar lists saved canvases and provides “New canvas”.

**Conversation behavior**

- Each follow-up sends the root-to-selected-message history plus the new prompt.
- Sibling branches and messages after the selected message are excluded.
- Existing messages remain unchanged when new branches are added.
- One generation runs per canvas at a time.
- Failed requests preserve the prompt and show an error with a retry action.
- Retry reuses the existing answer placeholder; interrupted requests become retryable after reload.
- Completed responses remain attached to their original canvas when the user switches canvases.
- Responses appear when complete; streaming is deferred.

**Local server**

- One local server, listening on `127.0.0.1` only, serves the interface and API; provider requests pass through it. API requests for other hostnames or from other origins are refused.
- **DeepSeek key (session):** the user enters a key in the app's DeepSeek settings. The server checks it against DeepSeek's balance endpoint without inference and keeps it in process memory until **Disconnect** or a restart. A key that works but has no balance is refused with a distinct message. An optional `DEEPSEEK_API_KEY` in `.env` connects at startup. The key is never returned by the API, stored in the browser, written to disk or logged. Without a key, prompts can be drafted but not sent; a disconnected chat request fails with `not_connected` and the answer stays retryable. Disconnect stops answers in progress.

**Storage**

- Persist canvases, messages, positions, selection, unsent drafts, viewport and preferences in the platform's application-data folder (`~/Library/Application Support/Canvas` on macOS, `%APPDATA%\Canvas` on Windows, `$XDG_DATA_HOME/canvas` or `~/.local/share/canvas` elsewhere), or `CANVAS_DATA_DIR`. Keep one JSON per canvas and separate attachment bytes. Serialize disk writes, sync temporary files and atomically replace snapshots. Copy IndexedDB non-destructively with idempotent receipts and separate conflict histories; browser originals remain intact. One active editing tab is supported.
- Save optional message `color`, `displayMode`, and `sizes` fields (`preview`, `compact`, `expanded` → `{ width, height }`); missing fields retain the current appearance. Provide zoom-independent color, compact-title and expanded-content controls around the selected bubble. Resizing must leave unselected bubbles stationary and refresh edge connectors.
- Center the measured branch pill, omit oldest ancestors first and keep an ellipsis navigation menu. Derive titles from the first Markdown heading, otherwise an excerpt of up to 80 characters or an attachment/status label. Frame the first answer in the usable area and cancel camera control on user pan/zoom.
- Save a prompt and pending answer before requesting inference; visibly report storage failures.
- The server keeps no transcripts.

**Deferred:** Additional providers, cloud sync, collaboration, non-image attachments, tools, search, branch merging, in-place message editing, response regeneration, and mobile optimization.

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
- An attached image reaches DeepSeek as an image input and survives a reload.
- The context meter and the top-bar path follow the selected bubble.


## Motion and corner resizing

The selected path fades over 550ms with 12px downward entry/upward exit, retaining its contents throughout exit. The 32px color, compact and expand controls animate for 520ms from the bubble’s top-right corner to centers (-28,-28), (+28,-28), (+28,+28) screen pixels. Exiting controls are inert immediately. Reduced motion disables movement/scaling.

Four selected-only lavender corner brackets use React Flow resize controls with touch targets and keyboard arrows (8 units, Shift 32), free axes, fixed opposite corners and a 160 × 72 minimum. Each display mode remembers its own optional rectangle. Live resizing suspends camera/physics, updates edges and leaves neighbours stationary. Release saves the exact size, position and parent offset; deselection permits whole-map settling. Manually sized content reflows and scrolls with timestamps outside the content. The reading panel remains unchanged. Old messages auto-size; canvas version and API routes are unchanged.

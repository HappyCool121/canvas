import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { chromium, webkit } from "playwright";

let server, browser, dataDirectory;
const origin = "http://127.0.0.1:3317";
before(async () => {
  dataDirectory = await mkdtemp(path.join(tmpdir(), "canvas-browser-"));
  server = spawn(
    process.execPath,
    ["--import", "tsx", "tests/browser-server.ts"],
    {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "3317", CANVAS_DATA_DIR: dataDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Test server did not start: " + output)),
      15_000,
    );
    server.stdout.on("data", (data) => {
      output += data;
      if (output.includes("Test server ready")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on("data", (data) => {
      output += data;
    });
    server.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Test server exited: " + output));
    });
  });
  browser = await chromium.launch({ channel: "chromium" });
  await mkdir("output/playwright", { recursive: true });
});
after(async () => {
  await browser?.close();
  server?.kill("SIGTERM");
  await rm(dataDirectory, { recursive: true, force: true });
});

const blockRemoteFonts = context => context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.abort());
async function newPage(targetBrowser = browser, reset = "/test/reset") {
  const { run } = await (await fetch(origin + reset, { method: "POST" })).json();
  const context = await targetBrowser.newContext({
    extraHTTPHeaders: { "X-Canvas-Test-Run": String(run) },
    viewport: { width: 1440, height: 1000 },
  });
  // Interaction/layout acceptance must not depend on Google Fonts availability.
  // The delayed-measurement regression below controls font readiness explicitly.
  await blockRemoteFonts(context);
  context.setDefaultTimeout(10_000);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => {
    // WebKit can report an observer notification deferred to the next frame
    // while React Flow measures resized nodes. Layout assertions still run.
    if (targetBrowser.browserType().name() === "webkit" &&
        error.message === "ResizeObserver loop completed with undelivered notifications.") return;
    errors.push(error.message);
  });
  return { context, page, errors };
}
async function open(targetBrowser = browser) {
  const opened = await newPage(targetBrowser);
  await opened.page.goto(origin);
  await opened.page.getByRole("textbox", { name: "Your prompt" }).waitFor();
  await opened.page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return opened;
}
async function send(page, prompt, answers) {
  await page.getByRole("textbox", { name: "Your prompt" }).fill(prompt);
  await page.getByRole("button", { name: "Send prompt" }).click();
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll(
        '[data-role="assistant"][data-status="complete"]',
      ).length === count,
    answers,
  );
}
async function settled(page) {
  await page.waitForTimeout(150);
  await page.locator('[data-layout="settled"][data-layout-ready="true"]').waitFor();
  // Positions are saved once the layout comes to rest.
  await savedCanvas(page);
}
async function selectMessage(page, id) {
  // Fit first so a selected ancestor outside the current view remains operable.
  await settled(page);
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page.waitForTimeout(400);
  await page.locator(`[data-message-id="${id}"]`).click();
  const reopen = page.getByRole("button", { name: "Open reading panel" });
  if (await reopen.count()) await reopen.click();
}
async function deselect(page) {
  const point = await page.locator(".react-flow__pane").evaluate((pane) => {
    const { x, y, width, height } = pane.getBoundingClientRect();
    for (const row of [0.4, 0.6, 0.25, 0.75]) {
      for (const column of [0.05, 0.2, 0.8, 0.95]) {
        const point = { x: x + width * column, y: y + height * row };
        if (document.elementFromPoint(point.x, point.y) === pane) return point;
      }
    }
    throw new Error("No bare graph pane found");
  });
  await page.mouse.click(point.x, point.y);
}
async function savedCanvas(page) {
  await page.locator(".save-status").filter({ hasText: "Saving" }).waitFor({ state: "hidden" });
  return page.evaluate(async () => (await (await fetch("/api/workspace")).json()).canvases.sort((a, b) => a.createdAt - b.createdAt));
}

test("keys entered in the app last for the server session, several providers connect at once, and keys never reach browser storage", { timeout: 60_000 }, async () => {
  const sessionKey = "sk-synthetic-session-browser-key";
  const openaiKey = "sk-synthetic-openai-browser-key";
  const { context, page, errors } = await newPage(browser, "/test/reset?key=none");
  try {
    await page.goto(origin);
    const prompt = page.getByRole("textbox", { name: "Your prompt" });
    await prompt.fill("Hello before connecting");
    assert.equal(await page.getByRole("button", { name: "Send prompt" }).isDisabled(), true);
    await page.screenshot({ path: "output/playwright/provider-disconnected.png" });
    await page.getByRole("button", { name: "Connect a provider to send" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect a provider." });
    await dialog.getByLabel("Provider", { exact: true }).selectOption("deepseek");
    await dialog.getByLabel("DeepSeek API key").fill("short");
    await dialog.getByRole("button", { name: "Connect DeepSeek" }).click();
    await dialog.getByRole("alert").filter({ hasText: "Enter a valid DeepSeek API key." }).waitFor();
    await dialog.getByLabel("DeepSeek API key").fill(sessionKey);
    await dialog.getByRole("button", { name: "Connect DeepSeek" }).click();
    const connectedList = dialog.getByRole("list", { name: "Connected providers" });
    await connectedList.getByText("this session").waitFor();
    await page.screenshot({ path: "output/playwright/provider-connected.png" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "DeepSeek connected" }).waitFor();
    await page.getByRole("button", { name: "Model: DeepSeek Flash" }).waitFor();
    await send(page, "Hello after connecting", 1);

    await page.reload();
    await page.getByRole("button", { name: "DeepSeek connected" }).waitFor();

    // A second provider joins the first; its models get their own group.
    await page.getByRole("button", { name: "DeepSeek connected" }).click();
    await dialog.getByLabel("Provider", { exact: true }).selectOption("openai");
    await dialog.getByLabel("OpenAI API key").fill(openaiKey);
    await dialog.getByRole("button", { name: "Connect OpenAI" }).click();
    await connectedList.getByText("OpenAI").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "2 providers connected" }).waitFor();
    await page.getByRole("button", { name: "Model: DeepSeek Flash" }).click();
    const menu = page.getByRole("menu", { name: "Choose a model" });
    await menu.getByRole("group", { name: "OpenAI" }).getByRole("menuitemradio").first().waitFor();
    assert.equal(await menu.getByRole("group", { name: "DeepSeek" }).getByRole("menuitemradio").count(), 2);
    // A model the list doesn't show can be typed.
    await menu.getByLabel("Search models").fill("custom-model-x");
    await menu.getByRole("menuitem", { name: /custom-model-x.*with OpenAI/ }).click();
    await page.getByRole("button", { name: "Model: custom-model-x" }).waitFor();
    await send(page, "Ask another provider", 2);
    await page.getByRole("complementary", { name: "Full message" }).getByText("Answered by custom-model-x.").waitFor();
    const answer = (await savedCanvas(page))[0].messages.find((m) => m.role === "assistant" && m.model === "custom-model-x");
    assert.equal(answer.provider, "openai");

    const stored = await page.evaluate(async () => {
      const values = [JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
      for (const { name } of await indexedDB.databases()) {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        for (const store of db.objectStoreNames) {
          values.push(JSON.stringify(await new Promise((resolve) => {
            const request = db.transaction(store).objectStore(store).getAll();
            request.onsuccess = () => resolve(request.result);
          })));
        }
        db.close();
      }
      return values.join("");
    });
    for (const k of [sessionKey, openaiKey]) {
      assert.ok(!stored.includes(k));
      assert.ok(!JSON.stringify(await savedCanvas(page)).includes(k));
      assert.ok(!(await page.evaluate(async () => JSON.stringify(await (await fetch("/api/workspace")).json()))).includes(k));
    }

    await page.getByRole("button", { name: "2 providers connected" }).click();
    for (const name of ["OpenAI", "DeepSeek"]) {
      await connectedList.getByRole("listitem").filter({ hasText: name }).getByRole("button", { name: "Disconnect" }).click();
      await connectedList.getByRole("listitem").filter({ hasText: name }).waitFor({ state: "detached" });
    }
    await page.getByRole("button", { name: "Close provider settings" }).click();
    await page.getByRole("button", { name: "Connect a provider", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test(
  "complete branching workspace: ancestor context, Markdown panel, drag, viewport and persistence",
  { timeout: 90_000 },
  async () => {
    const { context, page, errors } = await open();
    try {
      await page.screenshot({ path: "output/playwright/empty-workspace.png" });
      const requests = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/api/chat")) requests.push(r.postDataJSON());
      });
      await send(page, "Explain a branching idea", 1);
      const firstId = await page
        .locator('[data-role="assistant"]')
        .getAttribute("data-message-id");
      const userId = await page
        .locator('[data-role="user"]')
        .getAttribute("data-message-id");
      await send(page, "Go deeper", 2);
      assert.equal(requests[1].messages.length, 3);
      await selectMessage(page, firstId);
      await send(page, "Take another direction", 3);
      assert.equal(requests[2].messages.length, 3);
      assert.ok(!JSON.stringify(requests[2]).includes("Go deeper"));
      await selectMessage(page, userId);
      await send(page, "Clarify the original question", 4);
      assert.deepEqual(
        requests[3].messages.map((m) => m.role),
        ["user", "user"],
      );
      // Go to root selects the root prompt and opens it in the panel.
      await settled(page);
      await page.getByRole("button", { name: "Go to root" }).click();
      await page.waitForTimeout(450);
      const panel = page.getByRole("complementary", { name: "Full message" });
      await panel.getByText("Explain a branching idea", { exact: true }).waitFor();
      // Closing the reader preserves context and the composer.
      await page.getByRole("button", { name: "Close reading panel" }).click();
      assert.equal(await panel.count(), 0);
      assert.equal(
        await page.getByRole("textbox", { name: "Your prompt" }).count(),
        1,
      );
      await selectMessage(page, firstId);
      await panel.locator("table").waitFor();
      assert.equal(await panel.locator("table").count(), 1);
      assert.equal(await panel.locator("pre").count(), 3);
      assert.equal(await panel.locator("ul ul").count(), 1);
      assert.equal(
        await panel.locator('a[href="https://example.com"]').count(),
        1,
      );
      assert.equal(await panel.locator("script,img").count(), 0);
      assert.equal(
        await page.evaluate(() => window.__markdownExecuted),
        undefined,
      );
      await settled(page);
      let positionsBefore = (await savedCanvas(page))[0].messages.map(
        (m) => m.position,
      );
      await page.screenshot({
        path: "output/playwright/branching-reading-panel.png",
      });
      // Selecting another bubble replaces the panel without moving the map.
      await selectMessage(page, userId);
      await panel.getByText("Explain a branching idea", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Close reading panel" }).click();
      await settled(page);
      const positionsAfter = (await savedCanvas(page))[0].messages.map(
        (m) => m.position,
      );
      // Deselecting may resume whole-map settling; use its final positions for the drag check.
      positionsBefore = positionsAfter;
      await page.screenshot({ path: "output/playwright/mind-map.png" });
      // Drag the root bubble while all other bubbles remain stationary.
      await page.getByRole("button", { name: "Fit to view" }).click();
      await page.waitForTimeout(400);
      const root = page.locator(`[data-message-id="${userId}"]`);
      const box = await root.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 90, box.y + box.height / 2 + 50, {
        steps: 12,
      });
      await page.mouse.up();
      await settled(page);
      const dragged = (await savedCanvas(page))[0];
      const moved = (id) => {
        const index = dragged.messages.findIndex((m) => m.id === id);
        return (
          Math.hypot(
            dragged.messages[index].position.x - positionsBefore[index].x,
            dragged.messages[index].position.y - positionsBefore[index].y,
          ) > 20
        );
      };
      assert.ok(moved(userId), "the dragged root moved");
      assert.ok(!moved(firstId), "stationary neighbours do not follow a direct drag");
      assert.equal(await panel.count(), 0, "dragging does not select");
      await page.getByRole("button", { name: "zoom out" }).click();
      const beforePan = await page
        .locator(".react-flow__viewport")
        .getAttribute("style");
      await page.mouse.move(300, 350);
      await page.mouse.wheel(65, 90);
      await page.waitForTimeout(350);
      assert.notEqual(
        await page.locator(".react-flow__viewport").getAttribute("style"),
        beforePan,
      );
      await selectMessage(page, firstId);
      await page
        .getByRole("textbox", { name: "Your prompt" })
        .fill("An unsent draft\nwith another line");
      // Finish the viewport interaction before taking the persisted snapshot.
      const beforeZoom = (await savedCanvas(page))[0].viewport.zoom;
      await page.getByRole("button", { name: "zoom out" }).click();
      await page.waitForFunction(async (beforeZoom) => {
        const { canvases: [canvas] } = await (await fetch("/api/workspace")).json();
        const viewport = document.querySelector(".react-flow__viewport");
        const { a, e, f } = new DOMMatrix(getComputedStyle(viewport).transform);
        const { x, y, zoom } = canvas.viewport;
        return Math.abs(e - x) < 0.001 && Math.abs(f - y) < 0.001 && Math.abs(a - zoom) < 0.00001 && zoom < beforeZoom * 0.9 && canvas.draft.includes("An unsent draft");
      }, beforeZoom);
      const stored = (await savedCanvas(page))[0];
      assert.ok(!JSON.stringify(stored).includes("access_token"));
      await page.reload();
      await page
        .locator('[data-role="assistant"][data-status="complete"]')
        .first()
        .waitFor();
      assert.equal(await page.locator("[data-message-id]").count(), 8);
      assert.equal(
        await page.getByRole("textbox", { name: "Your prompt" }).inputValue(),
        "An unsent draft\nwith another line",
      );
      await settled(page);
      const restored = (await savedCanvas(page))[0];
      assert.deepEqual(restored.viewport, stored.viewport);
      assert.deepEqual(
        restored.messages.map((m) => m.position),
        stored.messages.map((m) => m.position),
      );
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  "failure retry reuses nodes, preserves drafts, and reload recovers pending requests",
  { timeout: 60_000 },
  async () => {
    const { context, page, errors } = await open();
    try {
      await page
        .getByRole("textbox", { name: "Your prompt" })
        .fill("retry-test");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.locator('[data-status="error"]').waitFor();
      assert.equal(await page.locator("[data-message-id]").count(), 2);
      await page.getByRole("button", { name: "Retry answer" }).click();
      await page
        .locator('[data-role="assistant"][data-status="complete"]')
        .waitFor();
      assert.equal(await page.locator("[data-message-id]").count(), 2);
      await page
        .getByRole("textbox", { name: "Your prompt" })
        .fill("slow-test-interrupt");
      const inflight = page.waitForRequest(
        (request) => request.url().endsWith("/api/chat") &&
          request.postDataJSON().messages.at(-1).content === "slow-test-interrupt",
      );
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.locator('[data-status="pending"]').waitFor();
      await inflight; // Inference begins only after the pending turn is durable.
      await page.reload();
      await page.getByRole("textbox", { name: "Your prompt" }).waitFor();
      await page.locator('[data-status="interrupted"]').waitFor();
      assert.equal(await page.locator("[data-message-id]").count(), 4);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  "background response stays on original canvas and duplicate submission is blocked",
  { timeout: 60_000 },
  async () => {
    const { context, page, errors } = await open();
    try {
      let calls = 0;
      page.on("request", (r) => {
        if (r.url().endsWith("/api/chat")) calls++;
      });
      await page
        .getByRole("textbox", { name: "Your prompt" })
        .fill("slow-test-background");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.locator('[data-status="pending"]').waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Send prompt" }).isDisabled(),
        true,
      );
      await page.getByRole("button", { name: "New canvas" }).click();
      await page.getByRole("heading", { name: "Canvas", exact: true }).waitFor();
      await page.waitForTimeout(2200);
      assert.equal(await page.locator("[data-message-id]").count(), 0);
      await page.getByRole("button", { name: /slow-test-background/ }).click();
      await page
        .locator('[data-role="assistant"][data-status="complete"]')
        .waitFor();
      assert.equal(calls, 1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  "disk storage failure is visible and prevents an unsaved prompt from reaching inference",
  { timeout: 60_000 },
  async () => {
    const { context, page } = await open();
    try {
      let calls = 0;
      page.on("request", (r) => {
        if (r.url().endsWith("/api/chat")) calls++;
      });
      await page.route("**/api/workspace/canvases/*", (route) => route.fulfill({ status: 500, json: { error: { message: "Disk is full" } } }));
      await page
        .getByRole("textbox", { name: "Your prompt" })
        .fill("Keep this safe");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "Changes could not be saved" })
        .waitFor();
      await page.locator('[data-status="error"]').waitFor();
      assert.equal(calls, 0);
      assert.equal(
        await page
          .locator('[data-role="user"]')
          .textContent()
          .then((s) => s.includes("Keep this safe")),
        true,
      );
    } finally {
      await context.close();
    }
  },
);

// A Retina-sized screenshot, drawn by the page's own browser.
async function screenshotPng(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2880;
    canvas.height = 1800;
    const context = canvas.getContext("2d");
    context.fillStyle = "#223";
    context.fillRect(0, 0, 2880, 1800);
    context.fillStyle = "#fff";
    context.font = "80px sans-serif";
    for (let i = 0; i < 18; i++)
      context.fillText(`Screenshot line ${i}`, 100, 120 + i * 90);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  });
  return Buffer.from(base64, "base64");
}

test(
  "WebKit renders Markdown and attaches, sends and restores a screenshot",
  { timeout: 60_000 },
  async () => {
    const safari = await webkit.launch();
    const { context, page, errors } = await open(safari);
    try {
      const requests = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/api/chat")) requests.push(r.postDataJSON());
      });
      await send(page, "WebKit compatibility", 1);
      // A finished answer becomes the selection and opens in the panel.
      const panel = page.getByRole("complementary", { name: "Full message" });
      await panel.locator("table").waitFor();
      // Safari cannot keep Blobs in IndexedDB; the screenshot must still attach.
      await page.locator('input[type="file"]').setInputFiles({
        name: "Screenshot 2026-11-02 at 17.02.11.png",
        mimeType: "image/png",
        buffer: await screenshotPng(page),
      });
      await page.locator(".composer-image img").waitFor();
      assert.equal(await page.getByRole("alert").count(), 0);
      await page.getByRole("textbox", { name: "Your prompt" }).fill("Read it");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-role="assistant"][data-status="complete"]',
          ).length === 2,
      );
      const sent = requests.at(-1).messages.at(-1).attachmentIds;
      assert.equal(sent.length, 1);
      assert.ok(!sent[0].startsWith("data:"));
      // The whole image fills the prompt bubble.
      const image = page.locator('[data-role="user"] .thumbnail img');
      await image.waitFor();
      const box = await image.boundingBox();
      const bubble = await page
        .locator('[data-role="user"].with-images')
        .boundingBox();
      assert.ok(box.width > bubble.width * 0.8, "image spans the bubble");
      assert.ok(Math.abs(box.width / box.height - 1.6) < 0.05, "uncropped");
      await page.reload();
      await page.locator('[data-role="user"] .thumbnail img').waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await safari.close();
    }
  },
);

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test(
  "selection, path chips, context meter, prompt edits, images and the collapsible sidebar",
  { timeout: 90_000 },
  async () => {
    const { context, page, errors } = await open();
    try {
      const requests = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/api/chat")) requests.push(r.postDataJSON());
      });
      const panel = page.getByRole("complementary", { name: "Full message" });
      const meter = page.getByRole("meter", { name: "Context used" });
      const composer = page.getByRole("textbox", { name: "Your prompt" });
      await send(page, "Root question", 1);
      // The answer is selected: panel, path and exact usage (2 × 100 + 250).
      await panel.getByText("Root question").first().waitFor();
      const path = page.getByRole("navigation", { name: "Selected path" });
      assert.equal(await path.getByRole("button").count(), 2);
      assert.equal(
        await path.getByRole("button").nth(1).getAttribute("aria-current"),
        "step",
      );
      assert.equal(await meter.textContent(), "450 / 1M");

      await settled(page);
      await deselect(page);
      await panel.waitFor({ state: "hidden" });
      assert.equal(await composer.count(), 0);
      assert.equal(await meter.textContent(), "—");
      assert.equal(await page.locator(".topbar-path").getAttribute("data-visible"), "false");

      // Edit the root prompt: a sibling hangs from it and replaces it in context.
      const rootId = await page
        .locator('[data-role="user"]')
        .getAttribute("data-message-id");
      await selectMessage(page, rootId);
      await panel.getByRole("button", { name: "Edit prompt" }).click();
      await page.getByText("Editing prompt").waitFor();
      assert.equal(await composer.inputValue(), "Root question");
      await composer.fill("Root question, rephrased");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-role="assistant"][data-status="complete"]',
          ).length === 2,
      );
      assert.deepEqual(requests.at(-1).messages, [
        { role: "user", content: "Root question, rephrased" },
      ]);
      const edited = (await savedCanvas(page))[0].messages.find(
        (m) => m.content === "Root question, rephrased",
      );
      assert.equal(edited.editOf, rootId);
      assert.equal(edited.parentId, null);
      assert.equal(await page.locator(".react-flow__edge").count(), 3);
      assert.equal(
        await path.getByRole("button").first().textContent(),
        "Root question, rephrased",
      );

      // Attach an image to a follow-up from the selected answer.
      await page.locator('input[type="file"]').setInputFiles({
        name: "pixel.png",
        mimeType: "image/png",
        buffer: pixel,
      });
      await page.locator(".composer-image img").waitFor();
      await composer.fill("Describe the picture");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-role="assistant"][data-status="complete"]',
          ).length === 3,
      );
      const last = requests.at(-1).messages.at(-1);
      assert.equal(last.content, "Describe the picture");
      assert.equal(last.attachmentIds.length, 1);
      assert.ok(!last.attachmentIds[0].startsWith("data:"));
      await panel.getByText("I can see 1 image(s).").waitFor();
      await page.locator('[data-role="user"] .thumbnail img').waitFor();
      assert.ok(
        !JSON.stringify(await savedCanvas(page)).includes("base64"),
        "images are stored outside canvas snapshots",
      );

      // Path chips navigate back along the branch.
      await path.getByRole("button").first().click();
      await panel.getByText("Root question, rephrased", { exact: true }).waitFor();

      // The sidebar collapses, stays collapsed after reload, and reopens.
      await page.getByRole("button", { name: "Hide sidebar" }).click();
      await settled(page);
      await page.screenshot({ path: "output/playwright/collapsed-sidebar.png" });
      await page.reload();
      await page.locator('[data-role="user"] .thumbnail img').waitFor();
      await page.getByRole("button", { name: "Show sidebar" }).click();
      await page.getByRole("button", { name: "Hide sidebar" }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

test(
  "model choice, Pro without images, timestamps, notices above the input and no sidebar tip",
  { timeout: 90_000 },
  async () => {
    const { context, page, errors } = await open();
    try {
      const requests = [];
      page.on("request", (r) => {
        if (r.url().endsWith("/api/chat")) requests.push(r.postDataJSON());
      });
      assert.equal(await page.getByText("A thought can go anywhere").count(), 0);
      const panel = page.getByRole("complementary", { name: "Full message" });
      const composer = page.getByRole("textbox", { name: "Your prompt" });

      // Errors pop up above the input and can be dismissed.
      await page.locator('input[type="file"]').setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hello"),
      });
      const notice = page.getByRole("alert").filter({
        hasText: "Only images, PDFs and DOCX files can be attached.",
      });
      await notice.waitFor();
      const noticeBox = await notice.boundingBox();
      const formBox = await page.locator("form.composer").boundingBox();
      assert.ok(noticeBox.y + noticeBox.height <= formBox.y, "above the input");
      await page.getByRole("button", { name: "Dismiss message" }).click();
      assert.equal(await notice.count(), 0);

      // Flash sees an image.
      await page.locator('input[type="file"]').setInputFiles({
        name: "pixel.png",
        mimeType: "image/png",
        buffer: pixel,
      });
      await page.locator(".composer-image img").waitFor();
      await composer.fill("What is this?");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page
        .locator('[data-role="assistant"][data-status="complete"]')
        .waitFor();
      assert.equal(requests.at(-1).model, "deepseek-flash");
      assert.equal(requests.at(-1).messages[0].attachmentIds.length, 1);
      await panel.getByText("Answered by deepseek-flash.", { exact: true }).waitFor();

      // Every finished bubble has a timestamp.
      assert.equal(await page.locator(".bubble-time").count(), 2);
      assert.match(
        await page.locator(".bubble-time").first().textContent(),
        /\d:\d\d/,
      );

      // Switch to V4 Pro: no attaching, a note about branch images, text only.
      await page.getByRole("button", { name: "Model: DeepSeek Flash" }).click();
      await page.getByRole("menuitemradio", { name: /DeepSeek V4 Pro/ }).click();
      assert.equal(
        await page.getByRole("button", { name: "Attach images, PDF or DOCX" }).isDisabled(),
        true,
      );
      await page
        .getByText("DeepSeek V4 Pro can’t see the image in this branch")
        .waitFor();
      await composer.fill("Continue with Pro");
      await page.getByRole("button", { name: "Send prompt" }).click();
      await page.waitForFunction(
        () =>
          document.querySelectorAll(
            '[data-role="assistant"][data-status="complete"]',
          ).length === 2,
      );
      const pro = requests.at(-1);
      assert.equal(pro.model, "deepseek-v4-pro");
      assert.ok(pro.messages.every((m) => !m.images));
      assert.match(pro.messages[0].content, /Image not shown/);
      await panel.getByText("Answered by deepseek-v4-pro.").waitFor();

      // Draft images can't be sent with Pro.
      await page.getByRole("button", { name: "Model: DeepSeek V4 Pro" }).click();
      await page.getByRole("menuitemradio", { name: /DeepSeek Flash/ }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "pixel.png",
        mimeType: "image/png",
        buffer: pixel,
      });
      await page.locator(".composer-image img").waitFor();
      await page.getByRole("button", { name: "Model: DeepSeek Flash" }).click();
      await page.getByRole("menuitemradio", { name: /DeepSeek V4 Pro/ }).click();
      await page.getByText("DeepSeek V4 Pro can’t see images. Choose a model that can.").waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Send prompt" }).isDisabled(),
        true,
      );

      // The choice is remembered.
      await page.reload();
      await page.getByRole("button", { name: "Model: DeepSeek V4 Pro" }).waitFor();
      await page.screenshot({
        path: "output/playwright/model-and-timestamps.png",
      });
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  },
);

async function scannedPdf(page, pageCount = 8) {
  const jpeg = Buffer.from(await page.evaluate(() => {
    const scan = document.createElement("canvas");
    scan.width = 400;
    scan.height = 560;
    const ctx = scan.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 400, 560);
    ctx.fillStyle = "black";
    ctx.font = "32px sans-serif";
    ctx.fillText("Scanned document", 42, 90);
    return scan.toDataURL("image/jpeg").split(",")[1];
  }), "base64");
  const pages = Array.from({ length: pageCount }, (_, i) => i + 5);
  const drawing = "q 400 0 0 560 0 0 cm /Scan Do Q";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pageCount} /Kids [${pages.map((i) => `${i} 0 R`).join(" ")}] >>`,
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 400 /Height 560 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg, Buffer.from("\nendstream"),
    ]),
    `<< /Length ${drawing.length} >>\nstream\n${drawing}\nendstream`,
    ...pages.map(() => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 560] /Resources << /XObject << /Scan 3 0 R >> >> /Contents 4 0 R >>"),
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(chunks.reduce((size, chunk) => size + chunk.length, 0));
    chunks.push(Buffer.from(`${i + 1} 0 obj\n`), Buffer.from(object), Buffer.from("\nendobj\n"));
  }
  const xref = chunks.reduce((size, chunk) => size + chunk.length, 0);
  chunks.push(Buffer.from([
    "xref", `0 ${objects.length + 1}`, "0000000000 65535 f ",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  ].join("\n")));
  return Buffer.concat(chunks);
}

async function dropFile(page, selector, file) {
  return page.evaluate(({ selector, name, mimeType, bytes }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], name, { type: mimeType }));
    const target = document.querySelector(selector);
    const dragover = new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true });
    const drop = new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true });
    return [target.dispatchEvent(dragover), target.dispatchEvent(drop)];
  }, { selector, name: file.name, mimeType: file.mimeType, bytes: [...file.buffer] });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine} welcome, PDF drops and reload, model gating, branched export and usage`, { timeout: 90_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    const { context, page, errors } = await open(safari);
    try {
      if (safari) await page.emulateMedia({ reducedMotion: "reduce" });
      const heading = page.getByRole("heading", { name: "Canvas", exact: true });
      const prompt = page.getByRole("textbox", { name: "Your prompt" });
      const submit = page.getByRole("button", { name: "Send prompt" });
      const form = page.locator("form.composer");
      const usage = page.getByLabel("Canvas usage");
      await heading.waitFor();
      const initial = await form.boundingBox();
      const initialField = await prompt.boundingBox();
      assert.equal(await heading.locator("svg").count(), 0);
      assert.equal(await heading.locator("span").evaluate((sign) => getComputedStyle(sign).fontStyle), "normal");
      assert.equal(await prompt.getAttribute("placeholder"), null);
      await prompt.fill("  ");
      await heading.waitFor();
      await prompt.fill("Unsent opening");
      await page.waitForFunction(() =>
        getComputedStyle(document.querySelector(".send-button")).backgroundColor === "rgb(255, 113, 113)");
      await heading.waitFor();
      assert.deepEqual(await form.boundingBox(), initial);
      await savedCanvas(page);
      await page.reload();
      assert.equal(await prompt.inputValue(), "Unsent opening");
      await heading.waitFor();
      await prompt.fill("");
      await heading.waitFor();

      const tallDraft = "A long draft that should stay intact. ".repeat(250);
      await page.keyboard.insertText(tallDraft);
      const grown = await prompt.evaluate((field) => ({
        height: field.clientHeight,
        content: field.scrollHeight,
        cap: innerHeight / 3,
      }));
      assert.ok(grown.height > initialField.height && Math.abs(grown.height - grown.cap) <= 1);
      assert.ok(grown.content > grown.height);
      await submit.waitFor({ state: "visible" });
      await savedCanvas(page);
      await page.reload();
      assert.equal(await prompt.inputValue(), tallDraft);
      assert.ok(Math.abs((await prompt.boundingBox()).height - grown.cap) <= 1);
      await page.setViewportSize({ width: 1000, height: 780 });
      const meter = page.getByRole("meter", { name: "Context used" });
      await page.waitForFunction(() =>
        Math.abs(document.querySelector(".composer textarea").clientHeight - innerHeight / 3) <= 1
      );
      const [meterBox, narrowForm] = await Promise.all([meter.boundingBox(), form.boundingBox()]);
      assert.ok(meterBox.x + meterBox.width <= narrowForm.x);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await prompt.fill("");
      await heading.waitFor();
      assert.equal((await prompt.boundingBox()).height, initialField.height);

      const image = { name: "pixel.png", mimeType: "image/png", buffer: pixel };
      assert.deepEqual(await dropFile(page, ".sidebar-head", image), [false, false]);
      await page.locator(".composer-image img").waitFor();
      assert.deepEqual(await dropFile(page, ".composer", image), [false, false]);
      await page.locator(".composer-image img").nth(1).waitFor();
      await heading.waitFor();
      assert.equal(await page.locator(".composer-image img").count(), 2);
      assert.equal(new URL(page.url()).origin, origin);

      const pdf = { name: "scan.pdf", mimeType: "application/pdf", buffer: await scannedPdf(page, 600) };
      await prompt.fill(`retry-test-pdf-${engine}`);
      const picker = page.getByRole("dialog", { name: "Choose PDF pages" });
      const fileInput = page.locator('input[type="file"]');
      assert.deepEqual(await dropFile(page, ".workspace-stage", pdf), [false, false]);
      await picker.getByText("598 image slots remaining.").waitFor();
      assert.equal(await submit.isDisabled(), true);
      await picker.getByRole("button", { name: "Cancel" }).click();
      await picker.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Attach images, PDF or DOCX" }).waitFor();
      await page.waitForFunction(() => !document.querySelector(".attach-button").disabled);
      await fileInput.setInputFiles(pdf);
      await picker.getByText("598 image slots remaining.").waitFor();
      const pages = picker.getByRole("textbox");
      const attach = picker.getByRole("button", { name: "Attach pages" });
      await pages.fill("2-600");
      await attach.click();
      await picker.getByRole("alert").getByText(/at most 598 pages/).waitFor();
      await pages.fill("0, 601");
      await attach.click();
      await picker.getByRole("alert").getByText(/Enter pages from 1 to 600/).waitFor();
      await pages.fill("8, 3-4, 3");
      await attach.click();
      await page.getByText("scan.pdf · pages 3, 4, 8", { exact: true }).waitFor();
      await page.locator(".pdf-group img").nth(2).waitFor();
      await savedCanvas(page);
      await page.reload();
      await page.locator(".pdf-group img").nth(2).waitFor();
      assert.equal(await page.locator(".pdf-group img").count(), 3);
      // Confirm the page contains actual scan pixels rather than a blank JPEG.
      const scanHasInk = await page.locator(".pdf-group img").first().evaluate((img) => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(100, 170, 900, 110).data.some((v, i) => i % 4 === 0 && v < 50);
      });
      assert.ok(scanHasInk);
      async function chooseModel(from, to) {
        await page.getByRole("button", { name: `Model: ${from}` }).click();
        await page.getByRole("menuitemradio", { name: new RegExp(to) }).click();
      }
      await chooseModel("DeepSeek Flash", "DeepSeek V4 Pro");
      await page.getByText("DeepSeek V4 Pro can’t see PDF pages. Choose a model that can.").waitFor();
      assert.equal(await submit.isDisabled(), true);
      await chooseModel("DeepSeek V4 Pro", "DeepSeek Flash");
      const request = page.waitForRequest((r) => r.url().endsWith("/api/chat"));
      await submit.click();
      const sent = (await request).postDataJSON().messages[0].attachmentIds;
      assert.equal(sent.length, 5);
      assert.ok(sent.slice(2).every((url) => typeof url === "string" && !url.startsWith("data:")));
      const slosh = page.locator(".meter-slosh");
      await slosh.waitFor({ state: "attached" });
      const firstSlosh = await slosh.elementHandle();
      const shell = meter.locator(".meter-shell");
      const transform = () => shell.evaluate((element) => getComputedStyle(element).transform);
      assert.ok(await shell.evaluate((element) => element.offsetHeight > element.offsetWidth));
      assert.equal(await slosh.evaluate((element) => getComputedStyle(element).animationName), safari ? "none" : "meter-slosh");
      assert.equal(await shell.evaluate((element) => element.style.transform), "rotate(180deg)");
      if (safari) assert.equal(await transform(), "none");
      else await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".meter-shell")).transform).a < -0.99);
      await page.locator('[data-status="error"]').waitFor();
      await settled(page);
      await page.getByRole("button", { name: "Close reading panel" }).click();
      await page.getByRole("button", { name: "Fit to view" }).click();
      const retryUsage = await meter.getAttribute("aria-valuenow");
      await page.getByRole("button", { name: "Retry answer" }).click();
      await page.waitForFunction((element) => !element.isConnected, firstSlosh);
      assert.equal(await meter.getAttribute("aria-valuenow"), retryUsage);
      assert.equal(await shell.evaluate((element) => element.style.transform), "rotate(360deg)");
      if (safari) assert.equal(await transform(), "none");
      else await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".meter-shell")).transform).a > 0.99);
      await page.locator('[data-role="assistant"][data-status="complete"]').waitFor();
      await usage.getByText("5,570", { exact: true }).waitFor();
      const root = await page.locator('[data-role="user"]').getAttribute("data-message-id");
      await selectMessage(page, root);
      const panel = page.getByRole("complementary", { name: "Full message" });
      await panel.getByText("scan.pdf · pages 3, 4, 8", { exact: true }).waitFor();
      await panel.getByRole("button", { name: "Edit prompt" }).click();
      await page.locator(".pdf-group img").nth(2).waitFor();
      await page.getByRole("button", { name: "Remove PDF scan.pdf" }).click();
      assert.equal(await page.locator(".pdf-group").count(), 0);
      assert.equal(await page.locator(".composer-image").count(), 2);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await chooseModel("DeepSeek Flash", "DeepSeek V4 Pro");
      await send(page, "Branch with cached tokens", 2);
      await usage.getByText("6,120", { exact: true }).waitFor();
      const answers = page.locator('.bubble[data-role="assistant"][data-status="complete"]');
      assert.deepEqual(await answers.evaluateAll((nodes) => nodes.map((node) => node.offsetWidth)), [520, 520]);
      assert.equal(await answers.first().locator(".bubble-preview").evaluate((preview) =>
        getComputedStyle(preview).maxHeight), "360px");
      // Both answers are priced from the catalog: 5,320 + 250 tokens on Flash,
      // then 150 uncached + 150 cached + 250 on V4 Pro.
      const prices = JSON.parse(await readFile("shared/catalog.json", "utf8")).providers.deepseek;
      const [, , , , , flashIn, flashOut] = prices["deepseek-flash"];
      const [, , , , , proIn, proOut, proCached] = prices["deepseek-v4-pro"];
      const cost = (5320 * flashIn + 250 * flashOut + 150 * proIn + 150 * proCached + 250 * proOut) / 1_000_000;
      await usage.getByText(`≈ $${cost.toFixed(6)}`, { exact: true }).waitFor();

      await selectMessage(page, root);
      await panel.getByRole("button", { name: "Edit prompt" }).click();
      await prompt.fill("Keep this draft");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Export canvas as JSON" }).click(),
      ]);
      const snapshot = JSON.parse(await readFile(await download.path(), "utf8"));
      assert.equal(snapshot.version, 1);
      assert.equal(snapshot.canvas.draft, "Keep this draft");
      assert.equal(snapshot.canvas.messages.length, 4);
      assert.deepEqual(snapshot.canvas.draftImages, snapshot.canvas.messages[0].images);
      assert.equal(snapshot.canvas.messages[2].parentId, root);
      assert.equal(snapshot.canvas.messages[3].usage.promptCacheHitTokens, 150);
      assert.ok(snapshot.canvas.selectedId && snapshot.canvas.viewport.zoom > 0);
      assert.ok(snapshot.canvas.messages.every((m) => Number.isFinite(m.position.x)));
      assert.equal(snapshot.attachments.length, 6);
      assert.equal(new Set(snapshot.attachments.map((asset) => asset.id)).size, 6);
      const original = snapshot.attachments.find((asset) => asset.mime === "application/pdf");
      assert.deepEqual(Buffer.from(original.base64, "base64"), pdf.buffer);
      assert.ok(snapshot.attachments.filter((asset) => asset.mime === "image/jpeg").every(
        (asset) => Buffer.from(asset.base64, "base64").subarray(0, 2).toString("hex") === "ffd8",
      ));
      assert.ok(!JSON.stringify(snapshot).includes("sk-synthetic-browser-test"));
      await page.getByRole("button", { name: "New canvas" }).click();
      await usage.getByText("0", { exact: true }).waitFor();
      await chooseModel("DeepSeek V4 Pro", "DeepSeek Flash");
      await fileInput.setInputFiles({ ...pdf, name: "small.pdf", buffer: await scannedPdf(page, 2) });
      await page.getByText("small.pdf · pages 1, 2", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Remove PDF small.pdf" }).click();
      assert.equal(await page.locator(".pdf-group").count(), 0);
      await page.getByRole("button", { name: new RegExp(`retry-test-pdf-${engine}`) }).click();
      await usage.getByText("6,120", { exact: true }).waitFor();
      assert.equal(await slosh.count(), 0, "switching back does not replay a flip");
      await page.route(`**/api/workspace/attachments/${original.id}`, (route) => route.fulfill({ status: 404 }));
      await page.getByRole("button", { name: "Export canvas as JSON" }).click();
      await page.getByRole("alert").getByText(/scan.pdf are missing/).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await safari?.close();
    }
  });
}

const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
async function wordFixture() {
  const zip = new JSZip();
  const w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const rel = "http://schemas.openxmlformats.org/package/2006/relationships";
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="png" ContentType="image/png"/>
    <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  </Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${rel}"><Relationship Id="rId1" Type="${r}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<Relationships xmlns="${rel}"><Relationship Id="image" Type="${r}/image" Target="media/pixel.png"/></Relationships>`);
  zip.file("word/media/pixel.png", pixel);
  const paragraph = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
  zip.file("word/document.xml", `<w:document xmlns:w="${w}" xmlns:r="${r}"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
    <w:body>${paragraph("Browser Word fixture")}
      <w:tbl><w:tr><w:tc>${paragraph("Table cell")}</w:tc></w:tr></w:tbl>
      <w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>
        <a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="image"/></pic:blipFill><pic:spPr><a:xfrm><a:ext cx="914400" cy="914400"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic>
      </wp:inline></w:drawing></w:r></w:p>
      ${Array.from({ length: 180 }, (_, i) => paragraph(`Overflow paragraph ${i + 1}`)).join("")}
      <w:p><w:r><w:br w:type="page"/></w:r></w:p>${paragraph("Explicit Word page")}
      <w:p><w:r><w:lastRenderedPageBreak/><w:t>Saved Word page</w:t></w:r></w:p>
      <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:bottom="720" w:left="720" w:right="720"/></w:sectPr>
    </w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine} complete PDF and DOCX attachments exceed the old six-page cap, survive reload and export`, { timeout: 90_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    const { page, context, errors } = await open(safari ?? browser);
    try {
      const pdf = { name: "scan.pdf", mimeType: "application/pdf", buffer: await scannedPdf(page, 8) };
      const docx = { name: "notes.docx", mimeType: docxMime, buffer: await wordFixture() };
      const input = page.locator('input[type="file"]');
      await input.setInputFiles(pdf);
      await page.waitForFunction(() => !document.querySelector('.attach-button').disabled);
      let canvas = (await savedCanvas(page))[0];
      assert.equal(canvas.draftImages.length, 8);
      await input.setInputFiles(docx);
      await page.waitForFunction(() => !document.querySelector('.attach-button').disabled);
      canvas = (await savedCanvas(page))[0];
      assert.ok(canvas.draftImages.filter(i => i.docx).length >= 5);
      const count = canvas.draftImages.length;
      await page.reload();
      await page.getByRole('textbox', {name:'Your prompt'}).waitFor();
      assert.equal((await savedCanvas(page))[0].draftImages.length, count);
      const request = page.waitForRequest(r => r.url().endsWith('/api/chat'));
      await send(page, 'Read all attached pages', 1);
      const messages = (await request).postDataJSON().messages;
      assert.equal(messages[0].attachmentIds.length, count);
      assert.ok(!messages[0].images);
      await page.getByRole('complementary', {name:'Full message'}).getByText(`I can see ${count} image(s).`).waitFor();
      assert.equal(await page.locator('.bubble-images img').count() <= 4, true);
      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name:'Export canvas as JSON'}).click()]);
      const snapshot = JSON.parse(await readFile(await download.path(), 'utf8'));
      assert.deepEqual(Buffer.from(snapshot.attachments.find(a => a.mime === 'application/pdf').base64, 'base64'), pdf.buffer);
      assert.deepEqual(Buffer.from(snapshot.attachments.find(a => a.mime === docxMime).base64, 'base64'), docx.buffer);
      assert.deepEqual(errors, []);
    } finally { await context.close(); await safari?.close(); }
  });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine} keeps sidebar status scoped to the latest snapshot for the active canvas`, { timeout: 60_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    const { context, page, errors } = await open(safari);
    try {
      const status = page.locator(".sidebar-save [role=status]");
      const canvasItems = page.getByRole("navigation", { name: "Saved canvases" }).getByRole("button");
      const prompt = page.getByRole("textbox", { name: "Your prompt" });
      const waitStatus = (label) => status.getByText(label, { exact: true }).waitFor();
      await waitStatus("Saved locally");
      await page.getByRole("button", { name: "New canvas" }).click();
      await waitStatus("Saved locally");
      await canvasItems.nth(1).click();

      await page.evaluate(() => {
        const realFetch = window.fetch;
        window.releaseWrite = {};
        window.fetch = async function (url, options) {
          if (String(url).endsWith("/api/workspace/preferences") && options?.method === "PUT") return Response.json({ error: { message: "Preference write failed" } }, { status: 500 });
          if (String(url).includes("/api/workspace/canvases/") && options?.method === "PUT") {
            const snapshot = JSON.parse(options.body);
            if (["older draft", "latest draft"].includes(snapshot.draft)) {
              await new Promise((resolve) => { window.releaseWrite[snapshot.draft] = resolve; });
              if (snapshot.draft === "older draft") return Response.json({ error: { message: "Disk is full" } }, { status: 500 });
            }
          }
          return realFetch(url, options);
        };
        window.restorePut = () => { window.fetch = realFetch; };
      });
      await prompt.fill("older draft");
      await page.waitForFunction(() => !!window.releaseWrite["older draft"]);
      await prompt.fill("latest draft");
      await waitStatus("Saving…");
      await canvasItems.nth(0).click();
      await waitStatus("Saved locally");
      await page.getByText("Could not remember which canvas to reopen.").waitFor();
      await page.evaluate(() => window.releaseWrite["older draft"]());
      await page.waitForFunction(() => !!window.releaseWrite["latest draft"]);
      await waitStatus("Saved locally");
      await canvasItems.nth(1).click();
      await waitStatus("Saving…");
      await page.evaluate(() => window.releaseWrite["latest draft"]());
      await waitStatus("Saved locally");
      assert.equal(await prompt.inputValue(), "latest draft");

      await page.evaluate(() => {
        const previous = window.fetch;
        window.fetch = (url, options) => String(url).includes("/api/workspace/canvases/") && options?.method === "PUT"
          ? Promise.resolve(Response.json({ error: { message: "Test disk is full" } }, { status: 500 })) : previous(url, options);
      });
      await prompt.fill("retry the current draft");
      await waitStatus("Not saved");
      await page.getByRole("alert").getByText(/Test disk is full/).waitFor();
      assert.equal(await page.locator(".topbar-layer").getByText("Not saved").count(), 0);
      await page.evaluate(() => window.restorePut());
      await page.getByRole("button", { name: "Try saving again" }).click();
      await waitStatus("Saved locally");
      assert.ok((await savedCanvas(page)).some((canvas) => canvas.draft === "retry the current draft"));
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
      await safari?.close();
    }
  });

  test(`${engine} frames turns and top-bar navigation around the reading overlay`, { timeout: 60_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    try {
      for (const width of [1440, 430]) {
        const { context, page, errors } = await newPage(safari);
        try {
          await page.setViewportSize({ width, height: width === 430 ? 820 : 1000 });
          const reducedMotion = engine === "WebKit";
          if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(origin);
          const graph = page.getByTestId("graph");
          const panel = page.locator(".reading-panel");
          const form = page.locator(".composer");
          const heading = page.getByRole("heading", { name: "Canvas", exact: true });
          await heading.waitFor();
          assert.equal(await heading.locator("span").evaluate((sign) => getComputedStyle(sign).backgroundColor), "rgb(159, 160, 255)");
          const viewport = () => page.locator(".react-flow__viewport").evaluate((element) => {
            const { a, e, f } = new DOMMatrix(getComputedStyle(element).transform);
            return { x: e, y: f, zoom: a };
          });
          const frameSettled = () => page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
          const visible = (count, root = false) => page.waitForFunction(({ count, root }) => {
            const rect = (selector) => document.querySelector(selector)?.getBoundingClientRect();
            const stage = rect(".workspace-stage");
            const tools = rect(".topbar");
            const overlays = [rect('.reading-panel[data-open="true"]'), rect(".composer-dock")].filter(Boolean);
            const messages = [...document.querySelectorAll("[data-message-id]")];
            const bubbles = root ? messages.slice(0, 1) : messages.slice(-count);
            return bubbles.length === count && bubbles.every((bubble) => {
              const b = bubble.getBoundingClientRect();
              return b.left >= stage.left && b.right <= stage.right && b.top >= tools.bottom && b.bottom <= stage.bottom &&
                overlays.every((o) => b.right <= o.left || b.left >= o.right || b.bottom <= o.top || b.top >= o.bottom);
            });
          }, { count, root }).catch(async (error) => {
            const bounds = await page.locator(".topbar, .workspace-stage, .reading-panel, .composer-dock, [data-message-id]").evaluateAll((elements) =>
              elements.map((element) => [element.className, element.getBoundingClientRect().toJSON()]));
            throw new Error(`Bubbles did not land in view at ${width}px: ${JSON.stringify(bounds)}`, { cause: error });
          });
          await send(page, `First turn ${width}`, 1);
          await heading.waitFor({ state: "hidden" });
          await frameSettled();
          await visible(1);
          await panel.evaluate((element) => element.getAnimations().length
            ? Promise.all(element.getAnimations().map((animation) => animation.finished))
            : undefined);
          const toolbar = await page.locator(".topbar").boundingBox();
          const pill = page.locator(".topbar-path");
          const pillBox = await pill.boundingBox();
          const path = pill.getByRole("navigation", { name: "Selected path" });
          const pathElement = await path.elementHandle();
          const animationName = "none";
          assert.equal(await path.evaluate((nav) => getComputedStyle(nav).animationName), animationName);
          assert.deepEqual(await page.locator(".meter-capsule").evaluate((capsule) =>
            [capsule.offsetWidth, capsule.offsetHeight]), [40, 120]);
          const meterBox = await page.getByRole("meter", { name: "Context used" }).boundingBox();
          const close = panel.getByRole("button", { name: "Close reading panel" });
          assert.equal(await panel.locator("header, footer").count(), 0);
          await close.waitFor();
          const graphBox = await graph.boundingBox();
          const panelBox = await panel.boundingBox();
          const composerBox = await form.boundingBox();
          assert.ok(panelBox.y > toolbar.y + toolbar.height);
          assert.ok(Math.abs(panelBox.width - (width === 430 ? width * 0.65 : width * 0.34)) < 1);
          assert.ok(meterBox.x + meterBox.width <= composerBox.x);
          assert.ok(width === 430 ? panelBox.y + panelBox.height <= composerBox.y : composerBox.x + composerBox.width <= panelBox.x);
          const originalPanel = await panel.elementHandle();

          await send(page, `Follow-up ${width}`, 2);
          await frameSettled();
          await visible(2);
          await page.getByRole("button", { name: "Go to root" }).click();
          await panel.getByText(`First turn ${width}`, { exact: true }).waitFor();
          assert.equal(await panel.locator("header, footer").count(), 0);
          assert.ok(await pathElement.evaluate((nav) => nav.isConnected));
          const currentPill = await pill.boundingBox();
          const stageBox = await page.locator(".workspace-stage").boundingBox();
          assert.ok(Math.abs(currentPill.x + currentPill.width / 2 - stageBox.x - stageBox.width / 2) < 2);
          assert.ok(await originalPanel.evaluate((element) => element.isConnected));
          assert.deepEqual(await page.locator(".topbar").boundingBox(), toolbar);
          assert.deepEqual(await graph.boundingBox(), graphBox);
          await frameSettled();
          await visible(1, true);
          await page.getByRole("button", { name: "Edit prompt" }).click();
          await send(page, `Rewritten turn ${width}`, 3);
          await frameSettled();
          await visible(2);

          if (!reducedMotion) {
            await page.getByRole("button", { name: "Go to root" }).click();
            await page.locator('[data-camera="moving"]').waitFor();
            const point = { x: graphBox.x + 30, y: graphBox.y + 145 };
            await page.mouse.move(point.x, point.y);
            await page.mouse.wheel(70, 80);
            await frameSettled();
            await page.waitForTimeout(200);
            const panned = await viewport();
            await page.waitForTimeout(450);
            assert.deepEqual(await viewport(), panned, "the camera stays where the user panned");
          }
          await page.getByRole("button", { name: "Close reading panel" }).click();
          assert.equal(await panel.getAttribute("inert"), "");
          await page.keyboard.press("Escape");
          assert.equal(await pill.getAttribute("data-visible"), "false");
          await page.waitForTimeout(600);
          assert.equal(await pill.evaluate((el) => getComputedStyle(el).opacity), "0");
          await page.getByRole("button", { name: "Go to root" }).click();
          await path.waitFor();
          assert.equal(await path.evaluate((nav) => getComputedStyle(nav).animationName), animationName);
          assert.equal(await pill.getAttribute("data-visible"), "true");
          await frameSettled();
          await page.getByRole("button", {name:"Open reading panel"}).click();
          await close.click();
          assert.equal(await panel.evaluate((element) => getComputedStyle(element).pointerEvents), "none");
          assert.deepEqual(await page.locator(".topbar").boundingBox(), toolbar);
          assert.deepEqual(await graph.boundingBox(), graphBox);
          await frameSettled();
          const beforeReload = await viewport();
          await page.waitForFunction(() => document.querySelector(".save-status")?.textContent === "Saved locally");
          await page.waitForLoadState('networkidle');
          await page.reload();
          await graph.waitFor();
          await page.waitForFunction(({ x, y, zoom }) => {
            const { a, e, f } = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")).transform);
            return Math.abs(x - e) < 0.01 && Math.abs(y - f) < 0.01 && Math.abs(zoom - a) < 0.00001;
          }, beforeReload);
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    } finally {
      await safari?.close();
    }
  });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine} renders math in both bubbles and keeps reading controls floating`, { timeout: 60_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    const lines = [
      "Start of the math message",
      "",
      String.raw`Concentration \(C(t)=\frac{30t}{200+t}\) and $t\to\infty$.`,
      "",
      String.raw`\[\begin{aligned} a&=b+c \\ d&=e+f \end{aligned}\]`,
      "",
      "$$",
      String.raw`\sqrt{2}`,
      "$$",
      "",
      String.raw`Literal price \$5 and \$10.`,
      "",
      'Inline code: \`$x^2$\`.',
      "",
      "```math",
      "$y^2$",
      "```",
      "",
      String.raw`Invalid: $\frac{1$.`,
      "",
      String.raw`Untrusted: $\href{javascript:alert(1)}{bad}$.`,
      "",
      String.raw`\[${Array.from({ length: 32 }, (_, index) => `x_{${index}}`).join("+")}\]`,
      "",
      ...Array.from({ length: 18 }, (_, index) => `Scrollable paragraph ${index + 1}.\n`),
      "End of the math message",
    ];
    const content = lines.join("\n");
    try {
      for (const width of [1440, 430]) {
        const { context, page, errors } = await newPage(safari);
        try {
          await page.setViewportSize({ width, height: width === 430 ? 820 : 1000 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.addInitScript(() => {
            Object.defineProperty(navigator.clipboard, "writeText", {
              value: async (value) => { window.copiedMarkdown = value; },
            });
          });
          await page.route("**/api/chat", (route) => route.fulfill({
            json: { content, model: "deepseek-flash", finishReason: "stop" },
          }));
          await page.goto(origin);
          await send(page, content, 1);
          const prompt = page.locator('[data-message-id][data-role="user"]');
          const answer = page.locator('[data-message-id][data-role="assistant"]');
          for (const bubble of [prompt, answer]) {
            await bubble.locator(".katex math mfrac").first().waitFor({ state: "attached" });
            assert.ok(await bubble.locator(".katex-display").count() >= 2);
            assert.equal(await bubble.evaluate((element) =>
              element.scrollWidth <= element.clientWidth + 1), true);
          }

          const panel = page.getByRole("complementary", { name: "Full message" });
          const close = panel.getByRole("button", { name: "Close reading panel" });
          const actions = panel.getByRole("group", { name: "Message actions" });
          const reading = panel.locator(".reading-content");
          await reading.getByText("End of the math message", { exact: true }).waitFor();
          await page.waitForFunction(() => {
            const graph = document.querySelector(".flow-container").getBoundingClientRect();
            const toolbar = document.querySelector(".topbar").getBoundingClientRect();
            const obstacles = [".reading-panel", ".composer-dock"].map((selector) =>
              document.querySelector(selector).getBoundingClientRect());
            return [...document.querySelectorAll('[data-message-id][data-role="assistant"]')].every((bubble) => {
              const b = bubble.getBoundingClientRect();
              return b.left >= graph.left && b.right <= graph.right &&
                b.top >= toolbar.bottom && b.bottom <= graph.bottom &&
                obstacles.every((o) => b.right <= o.left || b.left >= o.right ||
                  b.bottom <= o.top || b.top >= o.bottom);
            });
          });
          await reading.locator(".katex math mfrac").first().waitFor({ state: "attached" });
          assert.equal(await reading.locator(".katex math").count() >= 5, true);
          await reading.getByText("Literal price $5 and $10.", { exact: true }).waitFor();
          assert.equal(await reading.locator("p code").textContent(), "$x^2$");
          assert.equal((await reading.locator("pre code").textContent()).trim(), "$y^2$");
          assert.equal(await reading.locator(".katex-error").first().textContent(), String.raw`\frac{1`);
          assert.equal(await reading.locator('a[href^="javascript:"]').count(), 0);
          const wideEquation = reading.locator(".katex-display").last();
          assert.equal(await wideEquation.evaluate((equation) => {
            equation.scrollLeft = equation.scrollWidth;
            return equation.scrollLeft > 0;
          }), true);

          const closeBox = await close.boundingBox();
          const actionsBox = await actions.boundingBox();
          const firstLine = await reading.getByText("Start of the math message", { exact: true }).boundingBox();
          assert.ok(firstLine.y >= closeBox.y + closeBox.height);
          await reading.evaluate((element) => { element.scrollTop = element.scrollHeight; });
          const lastLine = await reading.getByText("End of the math message", { exact: true }).boundingBox();
          assert.ok(lastLine.y + lastLine.height <= actionsBox.y);
          assert.deepEqual(await close.boundingBox(), closeBox);
          assert.deepEqual(await actions.boundingBox(), actionsBox);
          await actions.getByRole("button", { name: "Copy" }).click();
          await actions.getByRole("button", { name: "Copied" }).waitFor();
          assert.equal(await page.evaluate(() => window.copiedMarkdown), content);

          await page.getByRole("button", { name: "Go to root" }).click();
          await actions.getByRole("button", { name: "Edit prompt" }).waitFor({ state: "visible" });
          await reading.locator(".katex math mfrac").first().waitFor({ state: "attached" });
          assert.equal(await actions.getByRole("button", { name: "Edit prompt" }).isEnabled(), true);
          await close.click();
          await panel.waitFor({ state: "hidden" });
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    } finally {
      await safari?.close();
    }
  });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine} bubble controls persist with centered breadcrumbs and stationary neighbours on desktop and mobile`, { timeout: 90_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    try {
      for (const width of [1440, 430]) {
        const { context, page, errors } = await newPage(safari);
        try {
          await page.setViewportSize({ width, height: width === 430 ? 820 : 1000 });
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(origin);
          await send(page, "# A title for this prompt\n\nA little more context", 1);
          await settled(page);
          const answer = page.locator('[data-role="assistant"]');
          const id = await answer.getAttribute("data-message-id");
          await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
          const centered = await page.evaluate(() => {
            const stage = document.querySelector(".workspace-stage");
            const graph = document.querySelector(".flow-container");
            const panel = document.querySelector(".reading-panel");
            const dock = document.querySelector(".composer-dock");
            const bar = document.querySelector(".topbar-layer");
            const bubble = document.querySelector('[data-role="assistant"]').getBoundingClientRect();
            const bounds = stage.getBoundingClientRect();
            const x = bubble.x + bubble.width / 2 - bounds.x, y = bubble.y + bubble.height / 2 - bounds.y;
            const bottom = dock.offsetTop - 12;
            const areas = [
              { x: (16 + panel.offsetLeft - 64) / 2, y: (bar.offsetTop + bar.offsetHeight + 52 + bottom) / 2, height: bottom - bar.offsetTop - bar.offsetHeight - 52 },
              { x: (16 + graph.clientWidth - 64) / 2, y: (panel.offsetTop + panel.offsetHeight + 52 + bottom) / 2, height: bottom - panel.offsetTop - panel.offsetHeight - 52 },
            ];
            return {ok:areas.some((area) => area.height > 0 && Math.hypot(area.x - x, area.y - y) < 3), x,y,areas};
          });
          assert.ok(centered.ok, "the first response is centered in usable space after measurements settle: "+JSON.stringify({width,centered}));
          const graph = page.getByTestId("graph");
          const neighbours = () => page.locator(`.react-flow__node:not([data-id="${id}"])`).evaluateAll((nodes) => nodes.map((node) => [node.dataset.id, node.style.transform]));
          const before = await neighbours();
          const toolbar = page.getByRole("toolbar", { name: "Bubble appearance" });
          const color = toolbar.getByRole("button", { name: "Bubble color", exact: true });
          const compact = toolbar.getByRole("button", { name: "Compact bubble", exact: true });
          const expand = toolbar.getByRole("button", { name: "Expand bubble", exact: true });
          const a = await color.boundingBox(), b = await compact.boundingBox(), c = await expand.boundingBox();
          assert.ok(Math.abs(a.y - b.y) < 1 && Math.abs(b.x - c.x) < 1, "outer right angle");
          const corner = await answer.boundingBox();
          for (const [button, dx, dy] of [[a,-28,-28],[b,28,-28],[c,28,28]]) {
            assert.equal(Math.round(button.width), 32); assert.equal(Math.round(button.height), 32);
            assert.ok(Math.abs(button.x + 16 - corner.x - corner.width - dx) < 1);
            assert.ok(Math.abs(button.y + 16 - corner.y - dy) < 1);
          }
          await color.click();
          await toolbar.getByRole("button", { name: "lavender bubble", exact: true }).click();
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-role="assistant"]')).backgroundColor === "rgb(229, 221, 246)");
          await compact.click();
          assert.equal(await answer.getAttribute("data-display-mode"), "compact");
          assert.equal(await answer.locator(".bubble-title").textContent(), "A little room to explore");
          const selectedChip = page.locator('.path-flow [aria-current="step"]');
          assert.equal(await selectedChip.getAttribute("title"), "A little room to explore");
          await expand.click();
          await answer.locator(".bubble-full pre").first().waitFor();
          await settled(page);
          assert.deepEqual(await neighbours(), before, "expanding the selected bubble leaves every other bubble still");
          assert.equal(await graph.getAttribute("data-simulated-bodies"), "1");
          await expand.click();
          await settled(page);
          const ticks = await graph.getAttribute("data-layout-ticks");
          await page.waitForTimeout(300);
          assert.equal(await graph.getAttribute("data-layout-ticks"), ticks, "idle simulations have no ticks");
          await compact.click();
          await settled(page);
          const saved = (await savedCanvas(page))[0];
          assert.equal(saved.messages.find((m) => m.id === id).displayMode, "compact");
          assert.equal(saved.messages.find((m) => m.id === id).color, "lavender");
          const box = await page.locator(".topbar-path").boundingBox();
          const stage = await page.locator(".workspace-stage").boundingBox();
          assert.ok(Math.abs(box.x + box.width / 2 - stage.x - stage.width / 2) < 2);
          await page.reload();
          await answer.locator(".bubble-title").waitFor();
          assert.equal(await answer.getAttribute("data-display-mode"), "compact");
          await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-role="assistant"]')).backgroundColor === "rgb(229, 221, 246)");
          assert.deepEqual(errors, []);
          await page.screenshot({ path: `output/playwright/bubble-controls-${engine}-${width}.png` });
        } finally { await context.close(); }
      }
    } finally { await safari?.close(); }
  });

  test(`${engine} imports browser history and original attachments once and restores from disk in a fresh browser context`, { timeout: 60_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    const { context, page } = await open(safari);
    let nextContext;
    try {
      const legacy = await page.evaluate(async () => {
        const { canvases: [blank] } = await (await fetch("/api/workspace")).json();
        const canvas = { ...blank, draft: "Legacy unsent draft", draftImages: [{ id: "legacy-image", mime: "image/png", width: 1, height: 1, pdf: { id: "legacy-pdf", name: "original.pdf", page: 1 } }] };
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open("canvas-workspace", 2); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const tx = db.transaction(["canvases", "images", "preferences"], "readwrite");
        tx.objectStore("canvases").put(canvas);
        tx.objectStore("images").put({ mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]).buffer }, "legacy-image");
        tx.objectStore("images").put({ mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70, 0, 255]).buffer }, "legacy-pdf");
        tx.objectStore("preferences").put(canvas.id, "activeCanvas");
        await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
        return canvas;
      });
      await page.reload();
      await page.getByRole("button", { name: "New canvas" }).waitFor();
      let all = await savedCanvas(page);
      const imported = all.find((c) => c.draft === "Legacy unsent draft");
      assert.ok(imported);
      assert.notEqual(imported.id, legacy.id, "a conflicting disk canvas is retained separately");
      await page.reload();
      await page.getByRole("button", { name: "New canvas" }).waitFor();
      assert.equal((await savedCanvas(page)).length, all.length);
      const count = await page.evaluate(async () => {
        const db = await new Promise((resolve) => { const r = indexedDB.open("canvas-workspace"); r.onsuccess = () => resolve(r.result); });
        const tx = db.transaction("canvases"); const count = await new Promise((resolve) => { const r = tx.objectStore("canvases").count(); r.onsuccess = () => resolve(r.result); }); db.close(); return count;
      });
      assert.equal(count, 1, "browser original is intact");
      nextContext = await (safari || browser).newContext();
      await blockRemoteFonts(nextContext);
      const fresh = await nextContext.newPage();
      await fresh.goto(origin);
      await fresh.getByRole("button", { name: "New canvas" }).waitFor();
      all = await savedCanvas(fresh);
      assert.ok(all.some((c) => c.id === imported.id && c.draft === "Legacy unsent draft"));
      const attachment = await fresh.evaluate(async () => [...new Uint8Array(await (await fetch("/api/workspace/attachments/legacy-pdf")).arrayBuffer())]);
      assert.deepEqual(attachment, [37, 80, 68, 70, 0, 255]);
    } finally { await nextContext?.close(); await context.close(); await safari?.close(); }
  });
}

for (const engine of ["Chromium", "WebKit"]) {
  test(`${engine} profiles 100/500 bubble maps, measures omitted ancestors, and stops idle ticks`, { timeout: 120_000 }, async () => {
    const safari = engine === "WebKit" ? await webkit.launch() : undefined;
    const results = [];
    try {
      for (const count of [100, 500]) {
        const { context, page, errors } = await open(safari);
        try {
          await page.emulateMedia({ reducedMotion: "reduce" });
          const id = await page.evaluate(async (count) => {
            const { canvases: [canvas] } = await (await fetch("/api/workspace")).json();
            const messages = Array.from({ length: count }, (_, i) => ({ id: `profile-${i}`, parentId: i ? `profile-${i - 1}` : null, role: i % 2 ? "assistant" : "user", content: `# Thought ${i}\n\nA short preview for profiling.`, status: "complete", position: { x: i % 25 * 500, y: Math.floor(i / 25) * 280 }, createdAt: Date.now() }));
            const last = messages.at(-1);
            const stage = document.querySelector(".workspace-stage");
            const snapshot = { ...canvas, title: `Profile ${count}`, messages, rootId: messages[0].id, selectedId: last.id, draftParentId: last.id, layout: "force-v2", viewport: { x: stage.clientWidth / 2 - last.position.x - 210, y: 420 - last.position.y, zoom: 1 } };
            const saved = await fetch(`/api/workspace/canvases/${canvas.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) });
            if (!saved.ok) throw new Error("Profile fixture could not be saved");
            return canvas.id;
          }, count);
          const start = Date.now();
          await page.reload();
          const graph = page.getByTestId("graph");
          await graph.waitFor();
          await page.locator(`[data-message-id="profile-${count - 1}"]`).waitFor({ state: "attached" });
          await settled(page);
          const loadMs = Date.now() - start;
          const idle = await graph.getAttribute("data-layout-ticks");
          await page.waitForTimeout(200);
          assert.equal(await graph.getAttribute("data-layout-ticks"), idle);
          const more = page.getByRole("button", { name: /Show \d+ hidden steps/ });
          await more.click();
          const omitted = page.getByRole("navigation", { name: "Omitted ancestors" });
          assert.ok(await omitted.getByRole("button").count() > 0);
          assert.equal(await page.locator('.path-flow [aria-current="step"]').getAttribute("title"), `Thought ${count - 1}`);
          await omitted.getByRole("button").nth(0).click();
          await settled(page);
          assert.equal(await graph.getAttribute("data-simulated-bodies"), "1");
          const stored = (await savedCanvas(page)).find((c) => c.id === id);
          assert.ok(stored.messages.slice(1).every((m, index) => m.position.x === (index + 1) % 25 * 500 && m.position.y === Math.floor((index + 1) / 25) * 280), "only selected root was simulated");
          const after = await graph.getAttribute("data-layout-ticks");
          await page.waitForTimeout(200);
          assert.equal(await graph.getAttribute("data-layout-ticks"), after);
          results.push({ count, loadMs, selectedBodies: 1, selectedSettleTicks: Number(after) - Number(idle), idleTicks: 0 });
          assert.deepEqual(errors, []);
        } finally { await context.close(); }
      }
      await import("node:fs/promises").then(({ writeFile }) => writeFile(`output/browser-profile-${engine}.json`, JSON.stringify(results, null, 2)));
    } finally { await safari?.close(); }
  });
}

for (const engine of ["Chromium", "WebKit"]) test(`${engine} four-corner pointer and keyboard resizing preserves opposite corner, neighbours, viewport, independent modes, disk and export`, {timeout:90_000}, async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {context,page,errors}=await open(safari);
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    await send(page,'Resize a thought',1); await settled(page);
    await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
    const answer=page.locator('[data-role="assistant"]');
    const id=await answer.getAttribute('data-message-id');
    const node=page.locator(`.react-flow__node[data-id="${id}"]`);
    const geometry=()=>node.evaluate(el=>{const m=new DOMMatrix(el.style.transform);return {x:m.e,y:m.f,width:el.offsetWidth,height:el.offsetHeight};});
    const viewport=()=>page.locator('.react-flow__viewport').getAttribute('style');
    const neighbours=()=>page.locator(`.react-flow__node:not([data-id="${id}"])`).evaluateAll(els=>els.map(el=>[el.dataset.id,el.style.transform]));
    const beforeNeighbours=await neighbours(), beforeViewport=await viewport();
    const reading=await page.locator('.reading-content').textContent().catch(()=>page.locator('.reading-panel').textContent());
    const zoom=await page.locator('.react-flow__viewport').evaluate(el=>new DOMMatrix(getComputedStyle(el).transform).a);
    for(const corner of ['top-left','top-right','bottom-left','bottom-right']) {
      const edgeBefore=await page.locator(".react-flow__edge-path").getAttribute("d");
      const before=await geometry(); const handle=node.locator(`.corner-resize.${corner}`);
      const box=await handle.boundingBox(); const dx=corner.includes('left')?-22:22, dy=corner.includes('top')?-16:16;
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down();
      await page.mouse.move(box.x+box.width/2+dx,box.y+box.height/2+dy,{steps:8});
      await page.waitForTimeout(80);
      const live=await geometry();
      assert.ok(Math.abs(live.width-before.width-22/zoom)<2);
      assert.ok(Math.abs(live.height-before.height-16/zoom)<2);
      assert.notEqual(await page.locator('.react-flow__edge-path').getAttribute('d'),edgeBefore,'connector follows the live rectangle');
      assert.deepEqual(await neighbours(),beforeNeighbours); assert.equal(await viewport(),beforeViewport);
      await page.mouse.up(); await savedCanvas(page); await page.waitForTimeout(150);
      const after=await geometry();
      assert.deepEqual(after,live,'no physics correction after release');
      assert.ok(Math.abs((corner.includes('left')?after.x+after.width:after.x)-(corner.includes('left')?before.x+before.width:before.x))<2);
      assert.ok(Math.abs((corner.includes('top')?after.y+after.height:after.y)-(corner.includes('top')?before.y+before.height:before.y))<2);
    }
    const preview=await geometry();
    const key=node.getByRole('button',{name:/Resize top-left corner/}); await key.focus();
    await page.keyboard.press('Shift+ArrowLeft'); await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(100);
    const keyboard=await geometry(); assert.equal(Math.round(keyboard.width-preview.width),32); assert.equal(Math.round(keyboard.height-preview.height),8);
    assert.ok(Math.abs(keyboard.x+keyboard.width-preview.x-preview.width)<1);
    assert.ok(Math.abs(keyboard.y+keyboard.height-preview.y-preview.height)<1);
    await page.getByRole('button',{name:'Compact bubble',exact:true}).click();
    assert.equal(await answer.getAttribute('data-manual-size'),'false');
    const compactHandle=node.getByRole('button',{name:/Resize bottom-right corner/}); await compactHandle.focus(); await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
    const compact=await geometry();
    await page.getByRole('button',{name:'Expand bubble',exact:true}).click();
    assert.equal(await answer.getAttribute('data-manual-size'),'false');
    await node.getByRole('button',{name:/Resize bottom-right corner/}).focus(); await page.keyboard.press('Shift+ArrowRight');
    const expanded=await geometry();
    await page.getByRole('button',{name:'Expand bubble',exact:true}).focus(); await page.keyboard.press('Enter');
    await page.waitForTimeout(100); assert.equal((await geometry()).width,keyboard.width);
    await page.getByRole('button',{name:'Compact bubble',exact:true}).click();
    await page.waitForTimeout(100); assert.equal((await geometry()).width,compact.width);
    await page.getByRole('button',{name:'Expand bubble',exact:true}).focus(); await page.keyboard.press('Enter');
    await page.waitForTimeout(100); assert.equal((await geometry()).width,expanded.width);
    const stored=(await savedCanvas(page))[0].messages.find(m=>m.id===id);
    assert.equal(stored.sizes.preview.width,keyboard.width); assert.equal(stored.sizes.compact.width,compact.width); assert.equal(stored.sizes.expanded.width,expanded.width);
    const downloadEvent=page.waitForEvent('download'); await page.getByRole('button',{name:'Export canvas as JSON',exact:true}).click();
    const download=await downloadEvent; const exported=JSON.parse(await readFile(await download.path(),'utf8'));
    assert.deepEqual(exported.canvas.messages.find(m=>m.id===id).sizes,stored.sizes);
    await page.reload(); await answer.waitFor(); await settled(page);
    assert.equal((await geometry()).width,expanded.width);
    assert.deepEqual((await savedCanvas(page))[0].messages.find(m=>m.id===id).sizes,stored.sizes);
    assert.equal(await answer.locator('.bubble-content').evaluate(el=>getComputedStyle(el).overflowY),'auto');
    assert.equal(await answer.locator('.bubble-time').evaluate(el=>el.parentElement.querySelector('.bubble-content').contains(el)),false);
    assert.ok(reading.length>0); assert.deepEqual(errors,[]);
    await page.screenshot({path:`output/playwright/resize-${engine}.png`});
  } finally {await context.close(); await safari?.close();}
});

for (const engine of ["Chromium", "WebKit"]) test(`${engine} mobile touch corners, minimum size, zoom-independent controls and inert retained exits`, {timeout:90_000}, async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {run}=await (await fetch(origin+'/test/reset',{method:'POST'})).json();
  const context=await (safari||browser).newContext({extraHTTPHeaders:{'X-Canvas-Test-Run':String(run)},viewport:{width:430,height:900},hasTouch:true,reducedMotion:'no-preference'});
  await blockRemoteFonts(context);
  const page=await context.newPage(); page.setDefaultTimeout(10_000);
  try {
    await page.goto(origin); await send(page,'Touch and motion',1); await settled(page);
    await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
    const answer=page.locator('[data-role="assistant"]'), id=await answer.getAttribute('data-message-id');
    const node=page.locator(`.react-flow__node[data-id="${id}"]`);
    const before=await node.evaluate(el=>el.offsetWidth);
    const viewport=()=>page.locator('.react-flow__viewport').getAttribute('style');
    const neighbours=()=>page.locator(`.react-flow__node:not([data-id="${id}"])`).evaluateAll(els=>els.map(el=>el.style.transform));
    for(const corner of ['top-left','top-right','bottom-left','bottom-right']) {
      const view=await viewport(), others=await neighbours();
      const old=await node.evaluate(el=>({x:new DOMMatrix(el.style.transform).e,y:new DOMMatrix(el.style.transform).f,w:el.offsetWidth,h:el.offsetHeight}));
      await node.locator(`.corner-resize.${corner} .resize-key`).evaluate((target,corner)=>{
        const box=target.getBoundingClientRect(), x=box.x+box.width/2,y=box.y+box.height/2;
        const touch=(cx,cy)=>({identifier:1,target,clientX:cx,clientY:cy,pageX:cx+scrollX,pageY:cy+scrollY,screenX:cx,screenY:cy});
        const event=(name,touches,changedTouches)=>{ const e=new Event(name,{bubbles:true,cancelable:true}); Object.defineProperties(e,{touches:{value:touches},targetTouches:{value:touches},changedTouches:{value:changedTouches}}); return target.dispatchEvent(e); };
        const start=touch(x,y); event('touchstart',[start],[start]);
        const end=touch(x+(corner.includes('left')?-10:10),y+(corner.includes('top')?-8:8)); event('touchmove',[end],[end]); event('touchend',[],[end]);
      },corner);
      await savedCanvas(page);
      const size=await node.evaluate(el=>({x:new DOMMatrix(el.style.transform).e,y:new DOMMatrix(el.style.transform).f,w:el.offsetWidth,h:el.offsetHeight}));
      assert.ok(size.w>old.w && size.h>old.h,'touch changes both axes');
      assert.ok(Math.abs((corner.includes('left')?size.x+size.w:size.x)-(corner.includes('left')?old.x+old.w:old.x))<2);
      assert.ok(Math.abs((corner.includes('top')?size.y+size.h:size.y)-(corner.includes('top')?old.y+old.h:old.y))<2);
      assert.deepEqual(await neighbours(),others); assert.equal(await viewport(),view);
    }
    assert.ok(await node.evaluate(el=>el.offsetWidth)>before);
    await page.emulateMedia({reducedMotion:'reduce'});
    for(const name of ['zoom in','zoom out','zoom out']) {
      await page.getByRole('button',{name,exact:true}).click(); await page.waitForTimeout(250);
      const corner=await answer.boundingBox();
      for(const [label,dx,dy] of [['Bubble color',-28,-28],['Compact bubble',28,-28],['Expand bubble',28,28]]) {
        const button=await page.getByRole('button',{name:label,exact:true}).boundingBox();
        assert.ok(Math.abs(button.width-32)<.01); assert.ok(Math.abs(button.height-32)<.01);
        assert.ok(Math.abs(button.x+16-corner.x-corner.width-dx)<1);
        assert.ok(Math.abs(button.y+16-corner.y-dy)<1);
      }
    }
    await node.getByRole('button',{name:/Resize bottom-right/}).focus();
    for(let i=0;i<28;i++) await page.keyboard.press('Shift+ArrowLeft');
    for(let i=0;i<28;i++) await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(100);
    assert.deepEqual(await node.evaluate(el=>[el.offsetWidth,el.offsetHeight]),[160,72]);
    await page.emulateMedia({reducedMotion:'no-preference'});
    const pill=page.locator('.topbar-path'), content=await pill.textContent(), pillWidth=(await pill.boundingBox()).width;
    await page.getByRole('button',{name:'Close reading panel',exact:true}).click();
    assert.equal(await pill.textContent(),content); assert.equal((await pill.boundingBox()).width,pillWidth);
    await page.keyboard.press('Escape');
    assert.equal(await pill.getAttribute('inert'),'');
    const exit=page.locator('.bubble-controls[inert]'); assert.equal(await exit.count(),1);
    assert.equal(await exit.getAttribute('aria-hidden'),'true');
    assert.equal(await exit.locator('button').first().evaluate(el=>el.closest('[inert]')!==null),true);
    await page.waitForTimeout(100); const opacity=await pill.evaluate(el=>Number(getComputedStyle(el).opacity)); assert.ok(opacity>0 && opacity<1);
    await page.getByRole('button',{name:'Go to root',exact:true}).click();
    await page.getByRole('button',{name:'Open reading panel',exact:true}).click();
    await page.getByRole('button',{name:'Close reading panel',exact:true}).click();
    await page.getByRole('button',{name:'Go to root',exact:true}).click();
    assert.equal(await page.getByRole('toolbar',{name:'Bubble appearance'}).count(),1);
    await page.waitForTimeout(600); assert.equal(await page.locator('.bubble-controls[inert]').count(),0);
    assert.equal(await pill.getAttribute('data-visible'),'true');
  } finally {await context.close();await safari?.close();}
});

for (const engine of ['Chromium', 'WebKit']) test(`${engine} hidden reader preserves selection, centered drafts and graph pinch gestures`, {timeout:60000}, async () => {
  const safari = engine === 'WebKit' ? await webkit.launch() : undefined;
  const {page, context, errors} = await open(safari ?? browser);
  try {
    await send(page, 'Reader and gestures', 1);
    await settled(page);
    const selected = (await savedCanvas(page))[0].selectedId;
    const input = page.getByRole('textbox', {name:'Your prompt'});
    await input.fill('Keep this draft');
    await page.getByRole('button', {name:'Close reading panel'}).click();
    assert.equal((await savedCanvas(page))[0].selectedId, selected);
    assert.equal(await input.inputValue(), 'Keep this draft');
    await page.waitForFunction(()=>{const stage=document.querySelector('.workspace-stage').getBoundingClientRect(),dock=document.querySelector('.composer-dock').getBoundingClientRect();return Math.abs(dock.x+dock.width/2-stage.x-stage.width/2)<2;});
    const stage = await page.locator('.workspace-stage').boundingBox();
    const dock = await page.locator('.composer-dock').boundingBox();
    assert.ok(Math.abs(dock.x+dock.width/2-stage.x-stage.width/2)<2);
    await send(page, 'Still hidden after sending', 2);
    await settled(page);
    await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
    await savedCanvas(page);
    assert.equal(await page.getByRole('complementary', {name:'Full message'}).count(),0);
    await page.reload();
    await input.waitFor();
    await page.getByRole('button',{name:'Open reading panel'}).click();
    await page.getByRole('complementary',{name:'Full message'}).waitFor();
    await settled(page);
    await input.focus();
    const graph = page.locator('.flow-container');
    const oldZoom=(await savedCanvas(page))[0].viewport.zoom;
    const consumed=await graph.evaluate(element=>{
      const rect=element.getBoundingClientRect();
      const dispatch=(type,scale)=>{
        const e=new Event(type,{bubbles:true,cancelable:true});
        Object.defineProperties(e,{scale:{value:scale},clientX:{value:rect.left+rect.width/2},clientY:{value:rect.top+rect.height/2}});
        element.dispatchEvent(e); return e.defaultPrevented;
      };
      return [dispatch('gesturestart',1),dispatch('gesturechange',.8),dispatch('gestureend',.8)];
    });
    assert.deepEqual(consumed,[true,true,true]);
    await page.waitForFunction(async old=>{
      const {canvases}=await(await fetch('/api/workspace')).json();return canvases[0].viewport.zoom<old;
    },oldZoom);
    assert.equal(await page.locator('.bubble-full, .bubble').first().evaluate(e=>getComputedStyle(e).webkitUserSelect),'none');
    assert.equal(await page.locator('.reading-content').evaluate(e=>getComputedStyle(e).webkitUserSelect),'text');
    await page.locator('.reading-content p').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const paragraph = await page.locator('.reading-content p').first().boundingBox();
    await page.mouse.move(paragraph.x+2,paragraph.y+8); await page.mouse.down();
    await page.mouse.move(paragraph.x+Math.min(180,paragraph.width-2),paragraph.y+8,{steps:8}); await page.mouse.up();
    assert.ok(await page.evaluate(()=>getSelection().toString().length>0),'reader text can be selected by dragging: '+JSON.stringify(await page.evaluate(p=>({hit:document.elementFromPoint(p.x+2,p.y+8)?.outerHTML,selection:getSelection().toString(),box:p}),paragraph)));
    await page.evaluate(()=>getSelection().removeAllRanges());
    await page.getByRole('button',{name:'Close reading panel',exact:true}).click();
    await page.getByRole('button',{name:'Fit to view',exact:true}).click();
    await page.waitForTimeout(400);
    await page.getByRole('button',{name:'Expand bubble',exact:true}).click();
    await settled(page);
    assert.equal(await page.locator('.bubble-full').evaluate(e=>getComputedStyle(e).webkitUserSelect),'none');
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for (const engine of ['Chromium','WebKit']) test(`${engine} reader and composer reverse coordinated transitions without losing the draft`, {timeout:60000}, async()=>{
 const safari=engine==='WebKit'?await webkit.launch():undefined;
 const {page,context,errors}=await open(safari ?? browser);
 try {
  await send(page,'Coordinated movement',1); await settled(page);
  await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
  const input=page.getByRole('textbox',{name:'Your prompt'});
  await input.fill('Draft stays editable');
  const dock=page.locator('.composer-dock'), panel=page.locator('.reading-panel');
  const before=await dock.boundingBox();
  await page.getByRole('button',{name:'Close reading panel'}).click();
  await page.waitForTimeout(100);
  const during=await dock.boundingBox();
  const stage=await page.locator('.workspace-stage').boundingBox();
  const center=stage.x+stage.width/2;
  assert.ok(during.x+during.width/2>before.x+before.width/2+1);
  assert.ok(during.x+during.width/2<center-1,'composer has an intermediate position');
  assert.equal(await panel.getAttribute('inert'),'');
  assert.ok(await panel.evaluate(el=>Number(getComputedStyle(el).opacity)>0 && Number(getComputedStyle(el).opacity)<1));
  await input.fill('Typing during movement');
  await page.getByRole('button',{name:'Open reading panel'}).click();
  await page.waitForTimeout(450);
  const after=await dock.boundingBox();
  assert.ok(Math.abs(after.x-before.x)<1);
  assert.equal(await input.inputValue(),'Typing during movement');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('button',{name:'Close reading panel'}).click();
  assert.equal(await dock.evaluate(el=>el.getAnimations().length),0);
  assert.deepEqual(errors,[]);
 } finally {await context.close();await safari?.close();}
});

for (const engine of ['Chromium','WebKit']) test(`${engine} nearby insertion yields local manual neighbours and preserves parent, distant nodes and saved layout`, {timeout:60000}, async()=>{
 const safari=engine==='WebKit'?await webkit.launch():undefined;
 const {page,context,errors}=await open(safari ?? browser);
 try {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(async()=>{
   const {canvases:[canvas]}=await(await fetch('/api/workspace')).json();
   const node=(id,x,y,width,height,parentId='root',role='assistant')=>({id,parentId,role,content:id,status:'complete',position:{x,y},createdAt:Date.now(),sizes:{preview:{width,height}}});
   const messages=[node('root',0,0,160,72,null,'user'),node('anchor',0,250,400,120),node('far',4000,4000,220,110)];
   for(const [i,[x,y]] of [[120,430],[460,250],[-220,250],[120,100],[460,430],[-220,430],[460,100],[-220,100]].entries()) {
    const m=node(`near-${i}`,x,y,220,110);m.layoutOffset={x:x+110-80,y:y+55-36};messages.push(m);
   }
   const snapshot={...canvas,messages,rootId:'root',selectedId:'anchor',draftParentId:'anchor',layout:'force-v2',readingPanelOpen:false,viewport:{x:450,y:100,zoom:.7}};
   const r=await fetch(`/api/workspace/canvases/${canvas.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)}); if(!r.ok)throw new Error('fixture save failed');
  });
  await page.reload(); await page.getByRole('textbox',{name:'Your prompt'}).waitFor(); await settled(page);
  const before=(await savedCanvas(page))[0];
  await send(page,'Compact local branch',11);
  await settled(page); await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
  const after=(await savedCanvas(page))[0];
  const find=(c,id)=>c.messages.find(m=>m.id===id);
  assert.deepEqual(find(after,'anchor').position,find(before,'anchor').position);
  assert.deepEqual(find(after,'far').position,find(before,'far').position);
  const prompt=after.messages.find(m=>m.content==='Compact local branch');
  assert.ok(Math.abs(prompt.position.x)<900 && Math.abs(prompt.position.y-250)<600,'branch stays adjacent');
  const moved=before.messages.filter(m=>m.id.startsWith('near-') && Math.hypot(find(after,m.id).position.x-m.position.x,find(after,m.id).position.y-m.position.y)>1);
  assert.ok(moved.length>0,'nearby manual bubbles yield');
  const overlaps=await page.locator('[data-message-id]').evaluateAll(elements=>{
   const rects=elements.map(e=>({id:e.dataset.messageId,...e.getBoundingClientRect().toJSON()}));
   const fresh=rects.filter(r=>!['root','anchor','far'].includes(r.id)&&!r.id.startsWith('near-'));
   return fresh.flatMap(a=>rects.filter(b=>a.id!==b.id && Math.min(a.right,b.right)-Math.max(a.left,b.left)>.5 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.5).map(b=>[a.id,b.id]));
  });
  assert.deepEqual(overlaps,[],'new bubbles settle without overlap');
  assert.ok(moved.every(m=>Math.hypot(find(after,m.id).position.x-m.position.x,find(after,m.id).position.y-m.position.y)<240),'nudges remain local');
  await page.reload(); await page.getByRole('textbox',{name:'Your prompt'}).waitFor(); await settled(page);
  assert.deepEqual((await savedCanvas(page))[0].messages.map(m=>m.position),after.messages.map(m=>m.position));
  assert.deepEqual(errors,[]);
 } finally {await context.close();await safari?.close();}
});

async function interactionFixture(page, zoom = .8) {
  await page.evaluate(async zoom => {
    const {canvases:[canvas]} = await (await fetch('/api/workspace')).json();
    const node = (id,x,y,parentId,role='assistant',width=240,height=120) => ({
      id,parentId,role,content:`# ${id}\n\nReadable content for ${id}.`,status:'complete',
      position:{x,y},createdAt:Date.now(),sizes:{preview:{width,height}},
    });
    // Child comes before parent to catch offsets computed from stale parent positions.
    const messages = [node('child',0,230,'root'),node('root',0,0,null,'user'),node('sibling',360,230,'root'),node('distant',1800,1800,'root')];
    const snapshot = {...canvas,messages,rootId:'root',selectedId:'sibling',draftParentId:'sibling',readingPanelOpen:false,layout:'force-v2',viewport:{x:160,y:170,zoom}};
    const saved = await fetch(`/api/workspace/canvases/${canvas.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
    if(!saved.ok) throw new Error('Could not save interaction fixture');
  },zoom);
  await page.reload();
  await page.getByTestId('graph').waitFor();
  await settled(page);
}
const bubble = (page,id) => page.locator(`[data-message-id="${id}"]`);
async function smallMovementClick(page,id,shift=false) {
  const rect=await bubble(page,id).boundingBox();
  // Outer padding stays draggable even when content is scrollable.
  const x=rect.x+rect.width/2,y=rect.y+3;
  if(shift) await page.keyboard.down('Shift');
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+2,y+1);await page.mouse.up();
  if(shift) await page.keyboard.up('Shift');
}
async function selectedBubbles(page) {
  return (await page.locator('.bubble.selected').evaluateAll(nodes=>nodes.map(n=>n.dataset.messageId))).sort();
}

for(const engine of ['Chromium','WebKit']) test(`${engine} screen-pixel clicks survive zoom, pan, fit and resize without stale selection`,{timeout:60000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    await interactionFixture(page);
    for(const action of ['zoom out','zoom in','pan','Fit to view','resize']) {
      if(action==='pan') {
        const pane=await page.locator('.react-flow__pane').boundingBox();
        await page.mouse.move(pane.x+40,pane.y+280);await page.mouse.down();await page.mouse.move(pane.x+65,pane.y+300,{steps:4});await page.mouse.up();
      } else if(action==='resize') {
        await page.setViewportSize({width:1280,height:920});
      } else {
        await page.getByRole('button',{name:action,exact:true}).click();
        // Start the gesture on the first frame after the built-in animation.
        await page.waitForTimeout(action==='Fit to view'?310:210);
      }
      for(const id of ['root','child']) {
        await smallMovementClick(page,id);
        await page.waitForFunction(id=>document.querySelector(`[data-message-id="${id}"]`)?.classList.contains('selected'),id);
        const [canvas]=await savedCanvas(page);
        assert.equal(canvas.selectedId,id,action);
        assert.equal(canvas.draftParentId,id,action);
        assert.deepEqual(await selectedBubbles(page),[id]);
        assert.equal(await page.locator('.path-flow .path-chip[aria-current="step"]').getAttribute('title'),id);
      }
    }
    await page.reload();await settled(page);
    assert.deepEqual(await selectedBubbles(page),['child']);
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for(const engine of ['Chromium','WebKit']) test(`${engine} marquee replaces groups, Shift toggles, rigid dragging persists once and preserves reader and reply target`,{timeout:90000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    for(const zoom of [.55,1.1]) {
      await interactionFixture(page,zoom);
      const [before]=await savedCanvas(page);
      await page.getByRole('button',{name:'Fit to view'}).focus();
      const child=await bubble(page,'child').boundingBox(), sibling=await bubble(page,'sibling').boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.move(child.x-12,child.y+20);await page.mouse.down();
      await page.mouse.move(sibling.x+sibling.width-15,sibling.y+sibling.height+12,{steps:10});
      await page.locator('.react-flow__selection').waitFor();
      const graph=page.getByTestId('graph');
      const ticks=await graph.getAttribute('data-layout-ticks');
      await page.waitForTimeout(100);
      assert.equal(await graph.getAttribute('data-layout-ticks'),ticks,'marquee pauses physics');
      await page.mouse.up();await page.keyboard.up('Shift');
      assert.deepEqual(await selectedBubbles(page),['child','sibling'],'partial intersections count');
      assert.equal(await page.getByRole('toolbar',{name:'Bubble appearance'}).count(),0);
      assert.equal(await page.locator('.corner-resize').count(),0);
      await page.screenshot({path:`output/playwright/group-${engine}-${zoom}.png`});
      assert.equal(await page.locator('.reading-panel').getAttribute('data-open'),'false');
      assert.equal(await page.getByRole('textbox',{name:'Your prompt'}).evaluate(e=>e===document.activeElement),false);
      await smallMovementClick(page,'root',true);
      assert.deepEqual(await selectedBubbles(page),['child','root','sibling']);
      await smallMovementClick(page,'root',true);
      assert.deepEqual(await selectedBubbles(page),['child','sibling']);
      const snapshots=[];
      const record=request=>{
        if(request.method()==='PUT'&&request.url().includes('/api/workspace/canvases/')) {
          const snapshot=request.postDataJSON();
          if(snapshot.messages.some(m=>m.id==='child'&&m.position.x!==before.messages[0].position.x)) snapshots.push(snapshot);
        }
      };
      page.on('request',record);
      const moving=await bubble(page,'child').boundingBox();
      await page.mouse.move(moving.x+moving.width/2,moving.y+3);await page.mouse.down();
      await page.mouse.move(moving.x+moving.width/2+55,moving.y+3+30,{steps:10});await page.mouse.up();
      await settled(page);page.off('request',record);
      const [after]=await savedCanvas(page);
      const get=(c,id)=>c.messages.find(m=>m.id===id);
      const dx=get(after,'child').position.x-get(before,'child').position.x;
      const dy=get(after,'child').position.y-get(before,'child').position.y;
      assert.ok(dx>0&&dy>0&&Math.abs(dx-55/zoom)<7/zoom&&Math.abs(dy-30/zoom)<7/zoom,`screen deltas scale with zoom: ${JSON.stringify({dx,dy,zoom,positions:after.messages.map(m=>[m.id,m.position]),selected:await selectedBubbles(page)})}`);
      assert.ok(Math.abs(get(after,'sibling').position.x-get(before,'sibling').position.x-dx)<.01);
      assert.ok(Math.abs(get(after,'sibling').position.y-get(before,'sibling').position.y-dy)<.01);
      for(const id of ['root','distant']) assert.deepEqual(get(after,id).position,get(before,id).position);
      assert.equal(snapshots.length,1,'entire drop persists once');
      assert.equal(after.selectedId,'sibling');assert.equal(after.draftParentId,'sibling');
      assert.equal(after.readingPanelOpen,false);
      assert.deepEqual(await selectedBubbles(page),['child','sibling']);
      // A second rectangle replaces rather than adds to the prior group.
      const root=await bubble(page,'root').boundingBox();
      await page.keyboard.down('Shift');await page.mouse.move(root.x-12,root.y-12);await page.mouse.down();
      await page.mouse.move(root.x+root.width/2,root.y+root.height+10,{steps:8});await page.mouse.up();await page.keyboard.up('Shift');
      assert.deepEqual(await selectedBubbles(page),['root']);
      await page.reload();await settled(page);
      assert.deepEqual(await selectedBubbles(page),['sibling']);
      assert.deepEqual((await savedCanvas(page))[0].messages.map(m=>m.position),after.messages.map(m=>m.position));
    }
    // An open reader stays open; parent/child offsets use both final positions.
    await interactionFixture(page);
    await smallMovementClick(page,'root');
    await page.getByRole('button',{name:'Open reading panel'}).click();
    await page.getByRole('textbox',{name:'Your prompt'}).fill('Keep this reply');
    await page.getByRole('button',{name:'Fit to view'}).focus();
    await smallMovementClick(page,'child',true);
    assert.deepEqual(await selectedBubbles(page),['child','root']);
    assert.equal(await page.locator('.reading-panel').getAttribute('data-open'),'true');
    assert.equal(await page.getByRole('textbox',{name:'Your prompt'}).evaluate(e=>e===document.activeElement),false);
    const [beforePair]=await savedCanvas(page);
    const root=await bubble(page,'root').boundingBox();
    await page.waitForTimeout(400);
    await page.mouse.move(root.x+root.width/2,root.y+3);await page.mouse.down();await page.mouse.move(root.x+root.width/2+40,root.y+33,{steps:8});await page.mouse.up();
    await settled(page);
    const [pair]=await savedCanvas(page),get=id=>pair.messages.find(m=>m.id===id);
    assert.equal(pair.selectedId,'root');assert.equal(pair.draftParentId,'root');assert.equal(pair.draft,'Keep this reply');
    assert.ok(Math.abs(get('child').layoutOffset.x-(get('child').position.x-get('root').position.x))<.01);
    assert.ok(Math.abs(get('child').layoutOffset.y-(get('child').position.y-get('root').position.y))<.01);
    assert.deepEqual(get('sibling').position,beforePair.messages.find(m=>m.id==='sibling').position);
    await page.getByRole('button',{name:'Edit prompt'}).click();
    await page.keyboard.press('Escape');
    assert.equal((await savedCanvas(page))[0].editingId,null);
    assert.deepEqual(await selectedBubbles(page),['child','root'],'first Escape cancels the edit');
    await page.keyboard.press('Escape');
    assert.deepEqual(await selectedBubbles(page),[]);
    assert.equal((await savedCanvas(page))[0].selectedId,null);
    await smallMovementClick(page,'root');
    await smallMovementClick(page,'child',true);
    await deselect(page);
    assert.deepEqual(await selectedBubbles(page),[]);
    assert.equal((await savedCanvas(page))[0].selectedId,null);
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for(const engine of ['Chromium','WebKit']) test(`${engine} upward pairs retain orientation through measured growth, snappy settling and reload`,{timeout:90000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    for(const diagonal of [false,true]) {
      await page.emulateMedia({reducedMotion:diagonal?'reduce':'no-preference'});
      await page.evaluate(async diagonal=>{
        const {canvases:[canvas]}=await(await fetch('/api/workspace')).json();
        const node=(id,x,y,width,height,parentId='root',role='assistant')=>({id,parentId,role,content:id,status:'complete',position:{x,y},createdAt:Date.now(),sizes:{preview:{width,height}}});
        const messages=[node('root',0,4000,180,80,null,'user'),node('anchor',0,0,330,120),node('below',-4000,140,8000,2800)];
        if(diagonal) messages.push(node('above',115,-1800,100,1640));
        else messages.push(node('left',-2200,-1800,2050,1800),node('right',500,-1800,2200,1800));
        const snapshot={...canvas,messages,rootId:'root',selectedId:'anchor',draftParentId:'anchor',readingPanelOpen:false,layout:'force-v2',viewport:{x:380,y:520,zoom:.7}};
        const response=await fetch(`/api/workspace/canvases/${canvas.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
        if(!response.ok) throw new Error('Could not save upward fixture');
      },diagonal);
      await page.reload();await settled(page);
      const [before]=await savedCanvas(page);
      const promptText=`slow-test Upward ${diagonal?'diagonal':'vertical'} placement`;
      await page.getByRole('textbox',{name:'Your prompt'}).fill(promptText);
      await page.getByRole('button',{name:'Send prompt'}).click();
      await page.locator('[data-status="pending"]').waitFor();
      const fresh=await page.locator('[data-message-id]').evaluateAll(nodes=>nodes.slice(-2).map(n=>n.dataset.messageId));
      const ordered=()=>page.waitForFunction(([promptId,answerId])=>{
        const p=document.querySelector(`[data-message-id="${promptId}"]`)?.getBoundingClientRect();
        const a=document.querySelector(`[data-message-id="${answerId}"]`)?.getBoundingClientRect();
        const parent=document.querySelector('[data-message-id="anchor"]').getBoundingClientRect();
        return p&&a&&p.bottom<parent.top&&a.bottom<p.top;
      },fresh).catch(async error => {
        await page.screenshot({path:`output/playwright/upward-failure-${engine}.png`});
        const details = await page.locator('[data-message-id]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.messageId,status:n.dataset.status,rect:n.getBoundingClientRect().toJSON()})));
        throw new Error(error.message + JSON.stringify({details,canvas:(await savedCanvas(page))[0]}));
      });
      await ordered();
      if(diagonal) await page.locator('.path-flow .path-chip[title="anchor"]').click();
      await page.locator(`[data-message-id="${fresh[1]}"][data-status="complete"]`).waitFor();
      await page.locator('[data-layout-ready="true"]').waitFor();
      const completedAt=Date.now();
      await settled(page);
      assert.ok(Date.now()-completedAt<1800,`layout settles roughly one second after completed dimensions stabilize: ${Date.now()-completedAt}ms; ticks=${await page.getByTestId('graph').getAttribute('data-layout-ticks')}`);
      await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
      await ordered();
      const [after]=await savedCanvas(page),get=(c,id)=>c.messages.find(m=>m.id===id);
      const prompt=get(after,fresh[0]),answer=get(after,fresh[1]);
      if(diagonal) assert.equal(after.selectedId,'anchor','growth preserves upward ordering after the user interrupts insertion');
      assert.ok(prompt.placementOffset.y<0 && answer.placementOffset.y<0);
      if(diagonal) assert.ok(prompt.position.x>330 || prompt.position.x<0,'the blocked upper corridor chooses a diagonal');
      assert.deepEqual(get(after,'anchor').position,get(before,'anchor').position);
      assert.deepEqual(get(after,'root').position,get(before,'root').position);
      const sizes=await page.locator('[data-message-id]').evaluateAll(nodes=>nodes.slice(-2).map(n=>({width:n.offsetWidth,height:n.offsetHeight})));
      assert.notEqual(sizes[0].height,sizes[1].height,'measured prompt and response sizes differ');
      assert.ok(answer.position.y+sizes[1].height<prompt.position.y);
      await page.screenshot({path:`output/playwright/upward-${engine}-${diagonal?'diagonal':'vertical'}.png`});
      await page.reload();await settled(page);
      await ordered();
      assert.deepEqual((await savedCanvas(page))[0].messages.map(m=>m.position),after.messages.map(m=>m.position));
    }
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for(const engine of ['Chromium','WebKit']) test(`${engine} reader reopen target matches the close button on desktop and mobile`,{timeout:60000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    await send(page,'Reader access',1);await settled(page);
    for(const width of [1440,430]) {
      await page.setViewportSize({width,height:width===430?820:1000});
      if(width===430) {
        const hide=page.getByRole('button',{name:'Hide sidebar'});
        if(await hide.isVisible()) await hide.click();
      }
      const close=page.getByRole('button',{name:'Close reading panel'});
      await close.waitFor();
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const closed=await close.boundingBox();
      await close.click();
      const reopen=page.getByRole('button',{name:'Open reading panel'});
      const opened=await reopen.boundingBox();
      await page.screenshot({path:`output/playwright/reader-reopen-${engine}-${width}.png`});
      assert.equal(opened.width,44);assert.equal(opened.height,44);
      assert.ok(Math.abs(opened.x+22-closed.x-closed.width/2)<=1);
      assert.ok(Math.abs(opened.y+22-closed.y-closed.height/2)<=1,JSON.stringify({opened,closed,width}));
      await page.keyboard.press('Tab');
      await reopen.focus();
      assert.equal(await reopen.evaluate(e=>e.matches(':focus-visible')),true);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.reading-panel').getAttribute('data-open'),'true');
    }
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for(const engine of ['Chromium','WebKit']) test(`${engine} group selection holds the reply target through response completion and resets on canvas switch`,{timeout:60000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    await interactionFixture(page);
    await page.getByRole('textbox',{name:'Your prompt'}).fill('slow-test Hold group reply');
    await page.getByRole('button',{name:'Send prompt'}).click();
    await page.locator('[data-status="pending"]').waitFor();
    const [sending]=await savedCanvas(page);
    const promptId=sending.selectedId;
    await page.getByRole('button',{name:'Fit to view'}).click();
    await page.waitForTimeout(310);
    await smallMovementClick(page,'root',true);
    assert.deepEqual(await selectedBubbles(page),[promptId,'root'].sort());
    await page.locator('[data-status="pending"]').waitFor({state:'hidden'});
    await settled(page);
    const [completed]=await savedCanvas(page);
    assert.equal(completed.selectedId,promptId);
    assert.equal(completed.draftParentId,promptId);
    assert.equal(completed.readingPanelOpen,false);
    assert.deepEqual(await selectedBubbles(page),[promptId,'root'].sort());
    assert.equal(await page.getByRole('textbox',{name:'Your prompt'}).evaluate(e=>e===document.activeElement),false);
    await page.getByRole('button',{name:'New canvas'}).click();
    await page.locator('.canvas-list .canvas-item').nth(1).click();
    await settled(page);
    assert.deepEqual(await selectedBubbles(page),[promptId]);
    assert.equal((await savedCanvas(page)).find(c=>c.id===sending.id).draftParentId,promptId);
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for(const engine of ['Chromium','WebKit']) test(`${engine} measured sideways pairs keep their response below a shorter prompt`,{timeout:60000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.evaluate(async()=>{
      const {canvases:[canvas]}=await(await fetch('/api/workspace')).json();
      const node=(id,x,y,width,height,parentId='root',role='assistant')=>({id,parentId,role,content:id,status:'complete',position:{x,y},createdAt:Date.now(),sizes:{preview:{width,height}}});
      const messages=[node('root',0,4000,180,80,null,'user'),node('anchor',0,0,330,180),node('left',-4000,-3000,3900,6000),node('above',-100,-3000,300,2948),node('below',-100,232,300,3000)];
      const snapshot={...canvas,messages,rootId:'root',selectedId:'anchor',draftParentId:'anchor',readingPanelOpen:false,layout:'force-v2',viewport:{x:300,y:220,zoom:.7}};
      const response=await fetch(`/api/workspace/canvases/${canvas.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)});
      if(!response.ok) throw new Error('Could not save sideways fixture');
    });
    await page.reload();await settled(page);
    await page.getByRole('textbox',{name:'Your prompt'}).fill('slow-test Sideways');
    await page.getByRole('button',{name:'Send prompt'}).click();
    await page.locator('[data-status="pending"]').waitFor();
    await page.waitForFunction(()=>{
      const prompt=[...document.querySelectorAll('[data-role="user"]')].at(-1)?.getBoundingClientRect();
      const parent=document.querySelector('[data-message-id="anchor"]')?.getBoundingClientRect();
      return prompt&&parent&&prompt.left>parent.right&&Math.abs(prompt.top-parent.top)<20;
    });
    await page.locator('[data-status="pending"]').waitFor({state:'hidden'});await settled(page);
    const [after]=await savedCanvas(page),prompt=after.messages.at(-2),answer=after.messages.at(-1);
    assert.ok(answer.position.y>prompt.position.y);
    assert.ok(answer.placementOffset.y>0);
    assert.deepEqual(after.messages.find(m=>m.id==='anchor').position,{x:0,y:0});
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

for(const engine of ['Chromium','WebKit']) test(`${engine} creation before restored measurements finish still launches only the new pair`,{timeout:60000},async()=>{
  const safari=engine==='WebKit'?await webkit.launch():undefined;
  const {page,context,errors}=await open(safari??browser);
  try {
    await page.emulateMedia({reducedMotion:'reduce'});
    await interactionFixture(page);
    const [before]=await savedCanvas(page);
    await page.addInitScript(()=>{
      let release;
      const ready=new Promise(resolve=>{release=resolve;});
      Object.defineProperty(Object.getPrototypeOf(document.fonts),'status',{configurable:true,get:()=> 'loading'});
      Object.defineProperty(Object.getPrototypeOf(document.fonts),'ready',{configurable:true,get:()=>ready});
      window.releaseTestFonts=()=>release(document.fonts);
    });
    await page.reload();await page.getByTestId('graph').waitFor();
    assert.equal(await page.getByTestId('graph').getAttribute('data-layout-ready'),'false');
    await send(page,'Early creation before measurements settle',4);
    assert.equal(await page.getByTestId('graph').getAttribute('data-layout-ticks'),'0');
    await page.waitForTimeout(800);
    assert.equal(await page.getByTestId('graph').getAttribute('data-camera'),'moving','camera keeps tracking until measured layout is ready');
    await page.evaluate(()=>window.releaseTestFonts());
    await settled(page);
    await page.locator('[data-testid="graph"]:not([data-camera])').waitFor();
    assert.ok(Number(await page.getByTestId('graph').getAttribute('data-layout-ticks'))>0,'the completed new pair gets insertion physics');
    const [after]=await savedCanvas(page);
    for(const id of ['sibling','distant']) assert.deepEqual(after.messages.find(m=>m.id===id).position,before.messages.find(m=>m.id===id).position);
    assert.deepEqual(errors,[]);
  } finally {await context.close();await safari?.close();}
});

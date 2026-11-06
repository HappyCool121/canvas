import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createApp } from "../server/app";
import { createChatGPTPlan } from "../server/chatgpt-plan";
import { canvasUsage } from "../shared/usage";
import { addTurn, newCanvas, patchMessage } from "../shared/graph";
import { access, code, completed, events, planFixture, refresh, type Grant } from "./plan-fixture";

const planPath = "/api/providers/chatgpt-plan";
const prompt = [{ role: "user", content: "branch prompt" }];
const image = "data:image/png;base64,aW1hZ2U=";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function local(t: TestContext, fixture = planFixture()) {
  const root = await mkdtemp(path.join(tmpdir(), "canvas-plan-"));
  const directory = path.join(root, "plan");
  const dataDir = path.join(root, "workspace");
  const plan = createChatGPTPlan({ directory, fetcher: fixture.fetcher });
  const app = createApp({ chatGPTPlan: plan, dataDir, fetcher: fixture.fetcher });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await plan.close();
    await rm(root, { recursive: true, force: true });
  });
  const api = (pathname: string, body?: object, method = body ? "POST" : "GET") => fetch(origin + pathname, {
    method, headers: { Origin: origin, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  async function begin(profileId?: string, reconsent = false) {
    const start = await api(planPath + "/sign-in", { profileId, reconsent });
    assert.equal(start.status, 200);
    const { launchUrl } = await start.json();
    const response = await fetch(launchUrl, { redirect: "manual" });
    assert.equal(response.status, 302);
    const auth = new URL(response.headers.get("Location")!);
    assert.equal(auth.origin, "https://auth.openai.com");
    assert.equal(auth.searchParams.get("resource"), "https://api.openai.com/v1");
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.ok(!auth.searchParams.has("id_token_hint"));
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.pathname, "/auth/callback");
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    return { auth, callback };
  }
  async function signIn(account: string, options?: { profileId?: string; reconsent?: boolean; grant?: Partial<Grant> }) {
    const { auth, callback } = await begin(options?.profileId, options?.reconsent);
    if (!options?.profileId) {
      assert.equal(auth.searchParams.get("client_id"), "dynamic_agent_client");
      assert.equal(auth.searchParams.get("agent_name_hint"), "Canvas");
      callback.searchParams.set("client_id", `oaiapp_${account}`);
    } else {
      assert.equal(auth.searchParams.get("client_id"), `oaiapp_${account}`);
      assert.ok(!auth.searchParams.has("agent_name_hint"));
    }
    callback.searchParams.set("code", code(auth, account, options?.grant));
    const result = await fetch(callback);
    assert.equal(result.status, 200, await result.text());
    const state = await (await api(planPath)).json();
    return state.accounts.at(-1).id as string;
  }
  return {
    directory, dataDir, plan, origin, api, begin, signIn,
    chat: (profileId?: string, canvasId = "canvas", model = "gpt-6.1-sol", messages: object[] = prompt) =>
      api("/api/chat", { canvasId, requestId: "answer", provider: "chatgpt-plan", model, profileId, messages }),
  };
}

test("guards plan routes and consumes denial before exchanging a code", async t => {
  const fixture = planFixture();
  const app = await local(t, fixture);
  const rejected = await fetch(app.origin + planPath + "/sign-in", { method: "POST", headers: { Origin: "https://other.test" } });
  assert.equal(rejected.status, 403);
  const { callback } = await app.begin();
  callback.searchParams.set("error", "access_denied");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(fixture.calls.length, 0);
  const status = await (await app.api(planPath)).json();
  assert.equal(status.issue.code, "chatgpt_plan_consent");
  assert.deepEqual(status.accounts, []);
  const next = await app.begin();
  assert.equal((await app.api(planPath + "/cancel", {})).status, 200);
  await assert.rejects(fetch(next.callback));
});

test("validates state and rejects callback replay during token exchange", async t => {
  const entered = latch();
  const release = latch();
  const fixture = planFixture({ exchange: async () => { entered.resolve(); await release.promise; } });
  const app = await local(t, fixture);
  const { auth, callback } = await app.begin();
  callback.searchParams.set("code", code(auth, "a"));
  callback.searchParams.set("client_id", "oaiapp_a");
  const invalid = new URL(callback);
  invalid.searchParams.set("state", "wrong");
  assert.equal((await fetch(invalid)).status, 400);
  assert.equal(fixture.calls.length, 0);
  const first = fetch(callback);
  try {
    await entered.promise;
    assert.equal((await fetch(callback)).status, 400);
    assert.equal(fixture.calls.length, 1);
  } finally { release.resolve(); }
  assert.equal((await first).status, 200);
  assert.equal(fixture.calls.filter(call => call.url.endsWith("/token")).length, 1);
});

test("checks the signed identity, preserves the active account, and handles missing plan consent", async t => {
  const app = await local(t);
  const first = await app.signIn("first");
  for (const invalid of ["nonce", "audience", "issuer", "expiry", "signature"] as const) {
    const { auth, callback } = await app.begin();
    callback.searchParams.set("client_id", "oaiapp_wrong");
    callback.searchParams.set("code", code(auth, "wrong", { invalid }));
    assert.equal((await fetch(callback)).status, 400);
    assert.equal((await (await app.api(planPath)).json()).activeId, first);
  }
  const { auth, callback } = await app.begin(first);
  callback.searchParams.set("code", code(auth, "first", { invalid: "subject" }));
  assert.equal((await fetch(callback)).status, 400);
  const disabled = await app.signIn("denied", { grant: { consent: false } });
  const state = await (await app.api(planPath)).json();
  assert.equal(state.activeId, first);
  assert.equal(state.accounts[1].status, "consent");
  assert.equal((await (await app.chat(disabled)).json()).error.code, "chatgpt_plan_consent");
  const returning = await app.begin(disabled);
  assert.equal(returning.auth.searchParams.get("prompt"), "consent");
  returning.callback.searchParams.set("code", code(returning.auth, "denied"));
  assert.equal((await fetch(returning.callback)).status, 200);
  assert.equal((await (await app.api(planPath)).json()).activeId, disabled);
});

test("serializes refreshes, isolates the credential store, and restores the last active account", async t => {
  const entered = latch();
  const release = latch();
  const fixture = planFixture({ renew: async form => {
    assert.equal(form.get("refresh_token"), refresh("a"));
    entered.resolve();
    await release.promise;
    return Response.json({ access_token: access("rotated"), refresh_token: refresh("rotated"), expires_in: 3600, token_type: "Bearer" });
  } });
  const app = await local(t, fixture);
  const profile = await app.signIn("a", { grant: { expiresIn: 10 } });
  const one = app.chat(profile, "one");
  const two = app.chat(profile, "two");
  try {
    await entered.promise;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { openPlanStore } from "./server/chatgpt-plan/store.ts";
      try { openPlanStore(process.argv[1]); process.exitCode = 1; }
      catch (error) { process.exitCode = error.code === "chatgpt_plan_store" ? 0 : 2; }
    `, app.directory], { stdio: "ignore" });
    const [exit] = await once(child, "exit");
    assert.equal(exit, 0);
  } finally { release.resolve(); }
  for (const response of await Promise.all([one, two])) {
    assert.equal(response.status, 200);
    assert.match((await response.json()).content, /rotated/);
  }
  assert.equal(fixture.calls.filter(({ init }) => (init?.body as URLSearchParams)?.get?.("grant_type") === "refresh_token").length, 1);
  const disk = path.join(app.directory, "accounts.json");
  const stored = JSON.parse(await readFile(disk, "utf8"));
  assert.equal(stored.profiles[0].tokens.refreshToken, refresh("rotated"));
  if (process.platform !== "win32") {
    assert.equal((await stat(disk)).mode & 0o777, 0o600);
    assert.equal((await stat(app.directory)).mode & 0o777, 0o700);
  }
  for (const url of ["/api/providers", "/api/models", "/api/workspace"]) {
    const text = await (await app.api(url)).text();
    assert.doesNotMatch(text, /mock-(access|refresh|subject)|oaiapp_|urn:uuid/);
  }
  await app.plan.close();
  const restarted = createChatGPTPlan({ directory: app.directory, fetcher: fixture.fetcher });
  try {
    assert.equal(restarted.state().activeId, profile);
    assert.ok((await restarted.models(AbortSignal.timeout(1_000))).some(model => model.id === "unknown-rotated"));
  } finally { await restarted.close(); }
});

test("uses each answer’s exact account across switches and aborts only that account on disconnect", async t => {
  const started = latch();
  const revocations: string[] = [];
  const fixture = planFixture({
    generate: async (account, body, signal) => {
      if (body.input.at(-1).content !== "slow") return events(completed(`Account ${account}`));
      started.resolve();
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("Unreachable");
    },
    revoke: form => {
      revocations.push(form.get("token")!);
      return new Response();
    },
  });
  const app = await local(t, fixture);
  const a = await app.signIn("a");
  const b = await app.signIn("b");
  assert.notEqual(a, b);
  const state = await (await app.api(planPath)).json();
  assert.equal(state.activeId, b);
  assert.notEqual(state.accounts[0].label, state.accounts[1].label);
  const models = await (await app.api("/api/models")).json();
  assert.deepEqual(models.models.map((m: { id: string }) => m.id), ["gpt-6.1-sol", "unknown-b"]);
  assert.equal(models.models[0].vision, true);
  assert.equal(models.models[1].vision, false);
  assert.equal((await (await app.chat(a)).json()).content, "Account a");
  assert.equal((await app.chat(undefined)).status, 401);
  const slow = app.chat(a, "slow", "gpt-6.1-sol", [{ role: "user", content: "slow" }]);
  await started.promise;
  assert.equal((await app.api(planPath, { profileId: a }, "DELETE")).status, 200);
  assert.deepEqual(revocations, [refresh("a")]);
  assert.equal((await (await slow).json()).error.code, "chatgpt_plan_revoked");
  assert.equal((await (await app.chat(a)).json()).error.code, "chatgpt_plan_revoked");
  assert.equal((await (await app.chat(b)).json()).content, "Account b");
  assert.equal(JSON.parse(await readFile(path.join(app.directory, "accounts.json"), "utf8")).profiles[0].tokens, undefined);
});

test("requires a completed stream, classifies plan failures, and sends branched inline images", async t => {
  const secret = "mock-access-credential-do-not-expose";
  const warn = t.mock.method(console, "warn", () => {});
  const fixture = planFixture({ generate: (_account, body) => {
    switch (body.input.at(-1).content) {
      case "interrupted": return new Response(events({ type: "response.output_text.delta", delta: "Partial text" }).body);
      case "incomplete": return events({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
      case "rejected": return Response.json({ error: { code: "invalid_value", param: "input[0].content", message: secret } },
        { status: 400, headers: { "x-oai-request-id": "req-test" } });
      case "limit": return events({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: secret } } });
      case "temporary": return events({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_unavailable", message: secret } } });
      default:
        assert.deepEqual(body.input.slice(0, 2), [{ role: "user", content: "Parent" }, { role: "assistant", content: "Prior answer" }]);
        assert.equal(body.input.at(-1).content[1].image_url, image);
        // The live plan endpoint returned SSE without a Content-Type header.
        return new Response(events(completed("Image received ✓")).body);
    }
  } });
  const app = await local(t, fixture);
  const a = await app.signIn("a");
  for (const [content, expected] of [["interrupted", "stream"], ["incomplete", "incomplete"], ["rejected", "request"], ["limit", "limit"], ["temporary", "temporary"]]) {
    const response = await app.chat(a, "canvas", "gpt-6.1-sol", [{ role: "user", content }]);
    const result = await response.json();
    assert.equal(result.error.code, `chatgpt_plan_${expected}`);
    assert.doesNotMatch(JSON.stringify(result), /Partial text|mock-access/);
  }
  const diagnostics = warn.mock.calls.map(call => call.arguments[1]);
  assert.equal(diagnostics.length, 5);
  assert.deepEqual(diagnostics.map(({ stage, event, code }) => [stage, event, code]), [
    ["stream", undefined, undefined],
    ["event", "response.incomplete", undefined],
    ["http", undefined, "invalid_value"],
    ["event", "response.failed", "subscription_sharing_usage_limit_exceeded"],
    ["event", "response.failed", "subscription_sharing_usage_unavailable"],
  ]);
  assert.equal(diagnostics[1].reason, "max_output_tokens");
  assert.equal(diagnostics[2].status, 400);
  assert.equal(diagnostics[2].requestId, "req-test");
  assert.equal(diagnostics[2].param, "input[0].content");
  assert.doesNotMatch(JSON.stringify(diagnostics), /Partial text|mock-access/);
  const branch = [{ role: "user", content: "Parent" }, { role: "assistant", content: "Prior answer" }, { role: "user", content: "Child", images: [image] }];
  assert.equal((await (await app.chat(a, "canvas", "unknown-a", branch)).json()).error.code, "image_unsupported");
  const result = await (await app.chat(a, "canvas", "gpt-6.1-sol", branch)).json();
  assert.deepEqual(result, { content: "Image received ✓", model: "gpt-6.1-sol", finishReason: "stop", usage: { promptTokens: 20, completionTokens: 5 } });
  const turn = addTurn(newCanvas(), "Child", null, { provider: "chatgpt-plan", model: result.model, profileId: a });
  const canvas = patchMessage(turn.canvas, turn.answerId, { status: "complete", usage: { ...result.usage, cost: 100 } });
  const usage = canvasUsage(canvas);
  assert.equal(usage.tokens, 25);
  assert.equal(usage.planTokens, 25);
  assert.equal(usage.cost, 0);
  assert.equal(usage.partial, false);
});

test("cancels a request waiting on refresh and revokes the replacement token", async t => {
  const entered = latch();
  const release = latch();
  const revocations: string[] = [];
  const fixture = planFixture({
    renew: async () => {
      entered.resolve();
      await release.promise;
      return Response.json({
        access_token: access("rotated"), refresh_token: refresh("rotated"), expires_in: 3600, token_type: "Bearer",
      });
    },
    revoke: form => {
      revocations.push(form.get("token")!);
      return new Response();
    },
  });
  const app = await local(t, fixture);
  const a = await app.signIn("a", { grant: { expiresIn: 10 } });
  const chat = app.chat(a);
  await entered.promise;
  const disconnected = app.api(planPath, { profileId: a }, "DELETE");
  const deadline = AbortSignal.timeout(2_000);
  try {
    const result = await Promise.race([
      chat.then(response => response.json()),
      new Promise((_resolve, reject) => deadline.addEventListener("abort", () => reject(deadline.reason), { once: true })),
    ]);
    assert.equal(result.error.code, "chatgpt_plan_revoked");
    assert.deepEqual(revocations, []);
  } finally { release.resolve(); }
  assert.equal((await disconnected).status, 200);
  assert.deepEqual(revocations, [refresh("rotated")]);
});

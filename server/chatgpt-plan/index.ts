import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { ChatGPTPlanState, ChatMessage, PlanAccount, PlanIssue } from "../../shared/types";
import type { ModelInfo } from "../../shared/models";
import { ApiError } from "../provider";
import { authorizationUrl, consent, createPlanProtocol, DYNAMIC_CLIENT, hasPlanScope, modelUnavailable, revoked, temporary } from "./protocol";
import { openPlanStore, type PlanProfile, type PlanTokens } from "./store";

const SIGN_IN_MS = 5 * 60_000;
const random = () => randomBytes(32).toString("base64url");

function waitForToken(work: Promise<PlanTokens>, signal: AbortSignal) {
  return new Promise<PlanTokens>((resolve, reject) => {
    // Cancelling a request must leave the shared token rotation running.
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
const callbackPath = "/auth/callback";
const signInError = () => new ApiError(400, "chatgpt_plan_sign_in", "ChatGPT sign-in could not finish. Start a new sign-in and try again.");
export const planIssue = (error: unknown): PlanIssue => {
  const safe = error instanceof ApiError ? error : temporary();
  return { code: safe.code, message: safe.message };
};
function matches(value: string | null, expected: string) {
  return value !== null && Buffer.byteLength(value) === expected.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
function callbackPage(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "close",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Canvas · ChatGPT sign-in</title><h1>${text}</h1><p>Return to the Canvas tab. You can close this tab.</p></html>`);
}

export function createChatGPTPlan({ directory, fetcher = fetch }: { directory?: string; fetcher?: typeof fetch } = {}) {
  type Attempt = {
    controller: AbortController;
    server: ReturnType<typeof createServer>;
    timer: ReturnType<typeof setTimeout>;
    profileId?: string;
  };
  const protocol = createPlanProtocol(fetcher);
  const refreshes = new Map<string, Promise<PlanTokens>>();
  // Retain a rotated token if an atomic write fails before the rename so a
  // later write can recover without using the already-rotated refresh token.
  const uncommittedTokens = new Map<string, PlanTokens>();
  const requests = new Map<string, Set<AbortController>>();
  const disconnecting = new Map<string, Promise<boolean>>();
  const catalogs = new Map<string, { until: number; models: ModelInfo[] }>();
  let store: ReturnType<typeof openPlanStore> | undefined;
  let pending: Attempt | undefined;
  let issue: PlanIssue | undefined;
  let retryClientId: string | undefined;
  let closed = false;
  function storage() {
    if (closed) throw temporary();
    return store ??= openPlanStore(directory);
  }
  function profile(id: string) {
    return storage().value.profiles.find(p => p.id === id);
  }
  function saveProfile(updated: PlanProfile, activate = false) {
    const db = storage();
    const { value } = db;
    const profiles = value.profiles.some(p => p.id === updated.id)
      ? value.profiles.map(p => p.id === updated.id ? updated : p)
      : [...value.profiles, updated];
    db.save({ ...value, profiles, ...(activate ? { activeId: updated.id } : {}) });
  }
  function accountStatus(p: PlanProfile): PlanAccount["status"] {
    if (disconnecting.has(p.id)) return "disconnecting";
    if (p.revoked) return "revoked";
    if (!p.tokens) return "disconnected";
    return hasPlanScope(p.tokens) ? "connected" : "consent";
  }
  function state(): ChatGPTPlanState {
    try {
      const { activeId, profiles } = storage().value;
      const active = profiles.find(p => p.id === activeId);
      return {
        accounts: profiles.map(p => ({ id: p.id, label: p.label, status: accountStatus(p) })),
        activeId,
        signingIn: Boolean(pending),
        welcomeId: active && accountStatus(active) === "connected" && !active.welcomed ? active.id : undefined,
        issue,
      };
    } catch (error) {
      return { accounts: [], signingIn: false, issue: planIssue(error) };
    }
  }
  function end(attempt: Attempt, nextIssue?: PlanIssue) {
    if (pending !== attempt) return;
    pending = undefined;
    issue = nextIssue;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    attempt.server.close();
  }
  async function start(profileId?: string, reconsent = false) {
    const { hostId } = storage().value;
    if (pending) throw new ApiError(409, "chatgpt_plan_pending", "Finish or cancel the current ChatGPT sign-in first.");
    const saved = profileId ? profile(profileId) : undefined;
    if (profileId && (!saved || disconnecting.has(profileId))) throw revoked();
    const clientId = saved?.clientId ?? retryClientId ?? DYNAMIC_CLIENT;
    retryClientId = undefined;
    const state = random();
    const nonce = random();
    const verifier = random();
    const startPath = `/auth/start/${random()}`;
    let launched = false;
    let consumed = false;
    let callback = "";
    const controller = new AbortController();
    const server = createServer(async (req, res) => {
      // Compare the raw request target to a fixed local origin and never echo callback data.
      if (!callback || req.headers.host !== new URL(callback).host || req.method !== "GET" ||
        !req.url?.startsWith("/") || req.url.startsWith("//")) {
        return callbackPage(res, 404, "This Canvas sign-in link is unavailable.");
      }
      let url: URL;
      try { url = new URL(req.url, callback); }
      catch { return callbackPage(res, 400, "This Canvas sign-in link is invalid."); }
      if (url.origin !== new URL(callback).origin || pending !== attempt) {
        return callbackPage(res, 410, "This Canvas sign-in has ended.");
      }
      if (url.pathname === startPath && !launched) {
        launched = true;
        res.writeHead(302, {
          "Cache-Control": "no-store",
          "Connection": "close",
          "Referrer-Policy": "no-referrer",
          Location: authorizationUrl({
            clientId, hostId, redirectUri: callback, state, nonce, verifier,
            reconsent: clientId !== DYNAMIC_CLIENT && (reconsent || Boolean(saved && accountStatus(saved) === "consent")),
          }),
        });
        res.end();
        return;
      }
      if (!launched || consumed || url.pathname !== callbackPath || url.searchParams.getAll("state").length !== 1 ||
        !matches(url.searchParams.get("state"), state))
        return callbackPage(res, 400, "This Canvas sign-in link is invalid or has already been used.");

      consumed = true;
      let issued: string | undefined;
      try {
        if (url.searchParams.get("error") === "access_denied") throw consent();
        if (url.searchParams.has("error")) throw signInError();
        const returned = url.searchParams.get("client_id");
        const code = url.searchParams.get("code");
        if (clientId === DYNAMIC_CLIENT) {
          if (!returned || !/^oaiapp_[\w-]{1,200}$/.test(returned)) throw signInError();
          issued = returned;
        } else {
          if (returned !== null && returned !== clientId) throw signInError();
          issued = clientId;
        }
        if (!code || code.length > 4096) throw signInError();
        const identity = await protocol.exchange(issued, code, verifier, callback, nonce,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]));
        if (pending !== attempt || controller.signal.aborted) {
          return callbackPage(res, 410, "This Canvas sign-in has ended.");
        }
        const all = storage().value.profiles;
        const existing = all.find(p => p.clientId === issued);
        if (existing && (existing.subject !== identity.subject || disconnecting.has(existing.id))) throw signInError();
        const id = existing?.id ?? randomUUID();
        const enabled = hasPlanScope(identity.tokens);
        saveProfile({
          id, clientId: issued, subject: identity.subject,
          label: existing?.label ?? `${identity.label} · ${id.slice(0, 6)}`,
          welcomed: existing?.welcomed, tokens: identity.tokens,
        }, enabled);
        uncommittedTokens.delete(id);
        catalogs.delete(id);
        end(attempt, enabled ? undefined : planIssue(consent()));
        return callbackPage(res, 200, enabled ? "ChatGPT plan connected." : "ChatGPT plan permission is needed.");
      } catch (error) {
        if (pending === attempt && !saved && error instanceof ApiError && error.code === "chatgpt_plan_code")
          retryClientId = issued;
        end(attempt, planIssue(error));
        return callbackPage(res, 400, "Canvas could not complete ChatGPT plan sign-in.");
      }
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    const attempt = {
      controller, server, profileId,
      timer: setTimeout(() => end(attempt, planIssue(signInError())), SIGN_IN_MS),
    };
    pending = attempt;
    issue = undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      if (pending !== attempt) {
        server.close();
        throw signInError();
      }
      const address = server.address();
      if (!address || typeof address === "string") throw signInError();
      const origin = `http://127.0.0.1:${address.port}`;
      callback = origin + callbackPath;
      return origin + startPath;
    } catch (error) {
      end(attempt, planIssue(signInError()));
      throw error instanceof ApiError ? error : signInError();
    }
  }
  function available(id: string) {
    const selected = profile(id);
    if (!selected || disconnecting.has(id) || !selected.tokens || selected.revoked) throw revoked();
    if (!hasPlanScope(selected.tokens)) throw consent();
    return { ...selected, tokens: selected.tokens };
  }
  function persistRotation(current: PlanProfile, tokens: PlanTokens) {
    uncommittedTokens.set(current.id, tokens);
    saveProfile({ ...current, tokens });
    uncommittedTokens.delete(current.id);
  }
  function access(id: string) {
    const selected = available(id);
    const uncommitted = uncommittedTokens.get(id);
    if (uncommitted) {
      persistRotation(selected, uncommitted);
      return Promise.resolve(uncommitted);
    }
    if (selected.tokens.expiresAt > Date.now() + 60_000) return Promise.resolve(selected.tokens);
    const existing = refreshes.get(id);
    if (existing) return existing;
    const work = protocol.refresh(selected.clientId, selected.tokens).then(tokens => {
      const current = profile(id);
      if (!current || current.tokens !== selected.tokens) throw revoked();
      persistRotation(current, tokens);
      return tokens;
    }).catch(error => {
      const current = profile(id);
      if (current?.tokens === selected.tokens && error instanceof ApiError && error.code === "chatgpt_plan_revoked") {
        saveProfile({ ...current, tokens: undefined, revoked: true });
        catalogs.delete(id);
      }
      throw error;
    }).finally(() => { refreshes.delete(id); });
    refreshes.set(id, work);
    return work;
  }
  async function withAccount<T>(id: string, signal: AbortSignal, work: (token: string, signal: AbortSignal) => Promise<T>) {
    available(id);
    const controller = new AbortController();
    const active = requests.get(id) ?? new Set<AbortController>();
    requests.set(id, active.add(controller));
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      combined.throwIfAborted();
      const tokens = await waitForToken(access(id), combined);
      combined.throwIfAborted();
      if (available(id).tokens !== tokens) throw revoked();
      const result = await work(tokens.accessToken, combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw revoked();
      throw error;
    } finally {
      active.delete(controller);
      if (!active.size) requests.delete(id);
    }
  }
  async function catalog(id: string, signal: AbortSignal, fresh = false) {
    const current = available(id);
    const cached = catalogs.get(id);
    if (!fresh && cached && cached.until > Date.now()) return cached.models;
    const models = await withAccount(id, signal, (token, signal) => protocol.models(token, id, signal));
    // A response from a prior connection can finish after a reauthorization.
    if (profile(id)?.tokens === current.tokens && !disconnecting.has(id))
      catalogs.set(id, { models, until: Date.now() + 60_000 });
    return models;
  }

  return {
    state,
    start,
    cancel() {
      if (pending) end(pending);
      retryClientId = undefined;
    },
    async select(id: string) {
      await catalog(id, AbortSignal.timeout(15_000), true);
      saveProfile(available(id), true);
      issue = undefined;
    },
    welcome(id: string) {
      const selected = available(id);
      saveProfile({ ...selected, welcomed: true });
    },
    disconnect(id: string) {
      const previous = disconnecting.get(id);
      if (previous) return previous;
      if (!profile(id)) throw revoked();
      if (pending?.profileId === id) end(pending);
      const work = (async () => {
        // Let any refresh settle so revocation uses the latest rotating token.
        await refreshes.get(id)?.catch(() => {});
        const current = profile(id)!;
        const latest = uncommittedTokens.get(id) ?? current.tokens;
        const confirmed = await protocol.revoke(current.clientId, latest?.refreshToken ?? "");
        const db = storage();
        const { value } = db;
        db.save({
          ...value, activeId: value.activeId === id ? undefined : value.activeId,
          profiles: value.profiles.map(p => p.id === id ? { ...p, tokens: undefined, revoked: undefined } : p),
        });
        uncommittedTokens.delete(id);
        issue = confirmed ? undefined : {
          code: "chatgpt_plan_revocation_unconfirmed",
          message: "Canvas disconnected this account locally. Open ChatGPT settings to check its remote connection.",
        };
        return confirmed;
      })().finally(() => { disconnecting.delete(id); });
      disconnecting.set(id, work);
      catalogs.delete(id);
      for (const controller of requests.get(id) ?? []) controller.abort();
      return work;
    },
    async models(signal: AbortSignal) {
      const id = storage().value.activeId;
      if (!id || accountStatus(profile(id)!) !== "connected") return [];
      const models = await catalog(id, signal, true);
      return storage().value.activeId === id && !disconnecting.has(id) ? models : [];
    },
    async model(id: string, model: string, signal: AbortSignal) {
      const info = (await catalog(id, signal)).find(m => m.id === model);
      if (!info) throw modelUnavailable();
      return info;
    },
    generate(id: string, model: string, messages: ChatMessage[], signal: AbortSignal) {
      return withAccount(id, signal, (token, signal) => protocol.generate(token, model, messages, signal));
    },
    async close() {
      if (pending) end(pending);
      for (const set of requests.values()) for (const controller of set) controller.abort();
      await Promise.allSettled([...refreshes.values(), ...disconnecting.values()]);
      closed = true;
      store?.close();
      store = undefined;
    },
  };
}

export type ChatGPTPlan = ReturnType<typeof createChatGPTPlan>;

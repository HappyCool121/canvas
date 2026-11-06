import { createHash } from "node:crypto";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { MAX_REQUEST_BYTES } from "../../shared/attachments";
import { MODEL_ID, SYSTEM_PROMPT, type ModelInfo } from "../../shared/models";
import type { ChatMessage, Completion } from "../../shared/types";
import { planModelInfo } from "../catalog";
import { ApiError } from "../provider";
import type { PlanTokens } from "./store";

const AUTH = "https://auth.openai.com";
export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT = "dynamic_agent_client";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const hasPlanScope = (tokens?: PlanTokens) =>
  Boolean(tokens?.scopes.includes(PLAN_SCOPE) && tokens.scopes.includes("resource.invoke"));
export const temporary = () => new ApiError(503, "chatgpt_plan_temporary", "ChatGPT plan usage is temporarily unavailable. Wait a moment, then retry.");
export const revoked = () => new ApiError(401, "chatgpt_plan_revoked", "Sign in again with the original ChatGPT account to retry this answer.");
export const consent = () => new ApiError(403, "chatgpt_plan_consent", "Enable ChatGPT plan usage for this account in provider settings.");
export const modelUnavailable = () => new ApiError(404, "chatgpt_plan_model", "This ChatGPT account no longer lists that model. Choose an available model before changing this answer’s route.");
const badSignIn = () => new ApiError(502, "chatgpt_plan_sign_in", "Canvas could not verify the ChatGPT sign-in. Start a new sign-in and try again.");
const invalidStream = () => new ApiError(502, "chatgpt_plan_stream", "ChatGPT did not finish this answer. Your prompt is saved. Retry when you’re ready.");
const refreshErrors = new Set(["invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired", "refresh_token_invalidated", "refresh_token_reused"]);

export function authorizationUrl(params: {
  clientId: string; hostId: string; redirectUri: string; state: string; nonce: string;
  verifier: string; reconsent: boolean;
}) {
  const url = new URL("/api/accounts/authorize", AUTH);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    ext_agent_host_id: params.hostId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: SCOPES,
    resource: RESOURCE,
    state: params.state,
    nonce: params.nonce,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(params.verifier).digest("base64url"),
    ...(params.clientId === DYNAMIC_CLIENT ? { agent_name_hint: "Canvas" } : {}),
    ...(params.reconsent ? { prompt: "consent" } : {}),
  }).toString();
  return url.href;
}

function planError(status: number, code: unknown) {
  switch (code) {
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return consent();
    case "subscription_sharing_invalid_user":
      return revoked();
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return temporary();
    case "subscription_sharing_usage_limit_exceeded":
      return new ApiError(429, "chatgpt_plan_limit", "ChatGPT plan usage limit reached. Review the limit in ChatGPT settings before retrying.");
    case "subscription_sharing_user_not_eligible":
      return new ApiError(403, "chatgpt_plan_ineligible", "This ChatGPT account or workspace cannot use its plan in Canvas.");
    case "subscription_sharing_unsupported_capability":
      return new ApiError(400, "chatgpt_plan_capability", "This ChatGPT plan or model could not use an input in this branch.");
    case "subscription_sharing_route_not_supported":
      return new ApiError(403, "chatgpt_plan_ineligible", "ChatGPT plan access is unavailable for this request.");
  }
  if (status === 401) return revoked();
  if (status === 403) return new ApiError(403, "chatgpt_plan_ineligible", "ChatGPT plan access is restricted for this request.");
  if (status === 404 || code === "model_not_found") return modelUnavailable();
  if (status === 429) return new ApiError(429, "chatgpt_plan_limit", "ChatGPT plan usage is limited. Review usage in ChatGPT settings before retrying.");
  if (status >= 500) return temporary();
  return invalidStream();
}

function parseTokens(data: Record<string, unknown>, previous?: PlanTokens): PlanTokens {
  const { access_token, refresh_token, expires_in, scope, token_type } = data;
  const scopes = typeof scope === "string" ? scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
  const refreshToken = refresh_token === undefined ? previous?.refreshToken : refresh_token;
  if (typeof access_token !== "string" || !/^[\x21-\x7e]+$/.test(access_token) ||
    typeof token_type !== "string" || token_type.toLowerCase() !== "bearer" ||
    typeof expires_in !== "number" || !Number.isFinite(expires_in) || expires_in <= 0 ||
    (refreshToken !== undefined && (typeof refreshToken !== "string" || !refreshToken)) ||
    (scopes.includes(PLAN_SCOPE) && !refreshToken)) throw previous ? temporary() : badSignIn();
  return { accessToken: access_token, refreshToken: refreshToken ?? "", expiresAt: Date.now() + expires_in * 1000, scopes };
}

function inputMessage({ role, content, images }: ChatMessage) {
  return images?.length ? {
    role,
    content: [
      ...(content.trim() ? [{ type: "input_text", text: content }] : []),
      ...images.map(image_url => ({ type: "input_image", image_url, detail: "auto" })),
    ],
  } : { role, content };
}

type ResponseEvent = {
  type?: string;
  code?: string;
  delta?: string;
  response?: {
    status?: string;
    error?: { code?: string };
    output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
};

async function streamCompletion(response: Response, model: string): Promise<Completion> {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw invalidStream();
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let data: string[] = [];
  const deltas: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw invalidStream();
      buffer += value;
      // SSE accepts LF, CRLF, and CR. A CR at the end of a chunk may be part of CRLF.
      let offset = 0;
      const endings = /\r\n|\n|\r(?!$)/g;
      for (const end of buffer.matchAll(endings)) {
        const line = buffer.slice(offset, end.index);
        offset = end.index + end[0].length;
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        if (line || !data.length) continue;
        let event: ResponseEvent;
        try { event = JSON.parse(data.join("\n")); } catch { throw invalidStream(); }
        data = [];
        if (event?.type === "response.failed" || event?.type === "error") {
          throw planError(0, event.response?.error?.code ?? event.code);
        }
        if (event?.type === "response.incomplete") throw invalidStream();
        if ((event?.type === "response.output_text.delta" || event?.type === "response.refusal.delta") &&
          typeof event.delta === "string") deltas.push(event.delta);
        if (event?.type !== "response.completed") continue;
        const result = event.response;
        if (!result || result.status !== "completed") throw invalidStream();
        const content = result.output?.filter(item => item.type === "message")
          .flatMap(item => item.content ?? [])
          .map(part => part.type === "output_text" ? part.text : part.type === "refusal" ? part.refusal : "")
          .join("") || deltas.join("");
        if (!content.trim()) throw invalidStream();
        const { input_tokens: input, output_tokens: output } = result.usage ?? {};
        const usage = typeof input === "number" && Number.isSafeInteger(input) && input >= 0 &&
          typeof output === "number" && Number.isSafeInteger(output) && output >= 0
          ? { promptTokens: input, completionTokens: output } : undefined;
        return { content, model, finishReason: "stop", usage };
      }
      buffer = buffer.slice(offset);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalidStream();
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export function createPlanProtocol(fetcher: typeof fetch) {
  const jwks = createRemoteJWKSet(new URL("/.well-known/jwks.json", AUTH), {
    [customFetch]: (url, init) => fetcher(url, init),
  });
  async function call(url: string, init: RequestInit) {
    try { return await fetcher(url, { ...init, redirect: "error" }); }
    catch { throw temporary(); }
  }
  const form = (url: string, body: Record<string, string>, signal: AbortSignal) =>
    call(url, { method: "POST", body: new URLSearchParams(body), signal });
  async function token(body: Record<string, string>, signal: AbortSignal, refresh = false) {
    const response = await form(`${AUTH}/api/accounts/oauth/token`, { ...body, resource: RESOURCE }, signal);
    const data = await response.json().catch(() => null);
    if (response.ok && data && typeof data === "object") return data;
    if (refresh && refreshErrors.has(data?.error)) throw revoked();
    if (response.status >= 500 || response.status === 429 || refresh && data?.error !== "invalid_client") throw temporary();
    if (!refresh && data?.error === "invalid_grant")
      throw new ApiError(400, "chatgpt_plan_code", "ChatGPT could not exchange this sign-in code. Continue with ChatGPT to start again.");
    throw badSignIn();
  }
  async function resource(path: string, accessToken: string, signal: AbortSignal, body?: string) {
    const response = await call(RESOURCE + path, {
      signal, method: body ? "POST" : "GET", body,
      headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      throw planError(response.status, data?.error?.code);
    }
    return response;
  }
  return {
    async exchange(clientId: string, code: string, verifier: string, redirectUri: string, nonce: string, signal: AbortSignal) {
      const data = await token({
        grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri,
      }, signal);
      try {
        const { payload } = await jwtVerify(data.id_token, jwks, {
          issuer: AUTH, audience: clientId, algorithms: ["RS256"],
          requiredClaims: ["exp", "iat", "sub", "nonce"],
        });
        if (typeof payload.sub !== "string" || !payload.sub || payload.nonce !== nonce ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 || payload.azp !== undefined) && payload.azp !== clientId)
          throw badSignIn();
        const tokens = parseTokens(data);
        if (payload.at_hash !== undefined &&
          payload.at_hash !== createHash("sha256").update(tokens.accessToken).digest().subarray(0, 16).toString("base64url"))
          throw badSignIn();
        const label = [payload.email, payload.name].find(value => typeof value === "string" && value.trim()) as string | undefined;
        return { subject: payload.sub, label: label?.trim().slice(0, 120) ?? "ChatGPT account", tokens };
      } catch { throw badSignIn(); }
    },
    async refresh(clientId: string, previous: PlanTokens) {
      const data = await token({
        grant_type: "refresh_token", client_id: clientId, refresh_token: previous.refreshToken,
      }, AbortSignal.timeout(12_000), true);
      return parseTokens(data, previous);
    },
    async revoke(clientId: string, refreshToken: string) {
      if (!refreshToken) return true;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
        try {
          const signal = AbortSignal.timeout(5_000);
          const discovery = await call(`${AUTH}/.well-known/openid-configuration`, { signal });
          if (discovery.status >= 500) continue;
          if (!discovery.ok) return false;
          const { revocation_endpoint } = await discovery.json();
          const url = new URL(revocation_endpoint);
          if (url.origin !== AUTH || url.username || url.password || url.hash) return false;
          const response = await form(url.href, { client_id: clientId, token: refreshToken, token_type_hint: "refresh_token" }, signal);
          await response.body?.cancel();
          if (response.status < 500) return response.status === 200;
        } catch { /* Retry transport errors before clearing the local session. */ }
      }
      return false;
    },
    async models(accessToken: string, profileId: string, signal: AbortSignal) {
      const response = await resource("/models", accessToken, signal);
      const data = await response.json().catch(() => null);
      if (!Array.isArray(data?.models)) throw temporary();
      const models = new Map<string, ModelInfo>();
      for (const model of data.models) {
        if (model?.visibility === "list" && typeof model.slug === "string" && MODEL_ID.test(model.slug) &&
          typeof model.display_name === "string" && model.display_name.trim() && !models.has(model.slug))
          models.set(model.slug, planModelInfo(model.slug, model.display_name.trim(), profileId));
      }
      return [...models.values()];
    },
    async generate(accessToken: string, model: string, messages: ChatMessage[], signal: AbortSignal) {
      const body = JSON.stringify({ model, instructions: SYSTEM_PROMPT, input: messages.map(inputMessage), store: false, stream: true });
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
        throw new ApiError(413, "request_too_large", "This conversation exceeds Canvas’s request limit. Branch from an earlier message or attach fewer images.");
      return streamCompletion(await resource("/responses", accessToken, signal, body), model);
    },
  };
}

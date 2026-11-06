import { createHash } from "node:crypto";
import { MAX_REQUEST_BYTES } from "../shared/attachments";
import { MODEL_ID, SYSTEM_PROMPT } from "../shared/models";
import type { Preset } from "../shared/providers";
import type { ChatMessage, Completion, Usage } from "../shared/types";
import { estimateCost, outputCap } from "./catalog";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

// One connected provider. The key and base URL are fixed when it connects.
export type ProviderAdapter = {
  // Checks the key without inference. Throws an ApiError when the provider refuses it.
  validate(signal: AbortSignal): Promise<void>;
  // Model ids the provider lists for this key; empty when it doesn't list them.
  listModels(signal: AbortSignal): Promise<string[]>;
  upload?(bytes: Uint8Array, mime: string, signal: AbortSignal): Promise<string>;
  generate(model: string, messages: ChatMessage[], signal: AbortSignal): Promise<Completion>;
};
export type ConnectionSettings = { key?: string; baseUrl: string };

async function upstreamError(response: Response, name: string): Promise<never> {
  // Only inspect the upstream error to classify it. Never return or log its raw body.
  const body = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403)
    throw new ApiError(401, "invalid_key", `${name} rejected the API key. Check it and connect again (or fix it in .env).`);
  if (response.status === 402)
    throw new ApiError(402, "insufficient_balance", `Your ${name} account needs more balance. Add funds, then retry.`);
  if (response.status === 429)
    throw new ApiError(429, "rate_limit", `${name} is receiving too many requests, or your plan's limit was reached. Wait a moment, then retry.`);
  if (response.status === 413)
    throw new ApiError(413, "request_too_large", `${name} refused a request this large. Branch from an earlier message or attach fewer images.`);
  if (response.status === 400 && /image|vision/i.test(body))
    throw new ApiError(400, "image_unsupported", `${name} couldn’t use an image in this conversation. Choose a model that sees images, or branch from a message without that image.`);
  if ((response.status === 404 || response.status === 400) && /model/i.test(body) && /not.?found|not exist|unknown|invalid|unsupported/i.test(body))
    throw new ApiError(404, "model_unavailable", `${name} doesn’t offer this model for your key. Choose another model.`);
  if (response.status === 400 && /context|token|length/i.test(body))
    throw new ApiError(400, "context_limit", "This conversation exceeds the model’s context limit. Branch from an earlier message or start a new canvas.");
  if (response.status === 404)
    throw new ApiError(404, "model_unavailable", `${name} doesn’t offer this model at this address. Check the base URL, or choose another model.`);
  throw new ApiError(502, "provider_error", `${name} could not complete this request. Your prompt is saved; you can retry.`);
}

function readUsage(usage: Record<string, unknown> | undefined): Usage | undefined {
  const count = (value: unknown) =>
    Number.isInteger(value) && (value as number) >= 0
      ? (value as number)
      : undefined;
  const promptTokens = count(usage?.prompt_tokens);
  const completionTokens = count(usage?.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return;
  // DeepSeek reports hits and misses; OpenAI-style providers report cached tokens.
  let hit = count(usage?.prompt_cache_hit_tokens);
  let miss = count(usage?.prompt_cache_miss_tokens);
  const cached = count((usage?.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens);
  if ((hit === undefined || miss === undefined) && cached !== undefined && cached <= promptTokens) {
    hit = cached;
    miss = promptTokens - cached;
  }
  return {
    promptTokens,
    completionTokens,
    ...(hit !== undefined && miss !== undefined
      ? { promptCacheHitTokens: hit, promptCacheMissTokens: miss }
      : {}),
  };
}

// Images are only accepted in user messages, as OpenAI-style content parts.
function toProviderMessage({ role, content, images, fileIds }: ChatMessage) {
  if (!images?.length && !fileIds?.length) return { role, content };
  return {
    role,
    content: [
      ...(content.trim() ? [{ type: "text", text: content }] : []),
      ...(fileIds ?? []).map(file_id => ({ type: "file", file_id })),
      ...(images ?? []).map((url) => ({ type: "image_url", image_url: { url } })),
    ],
  };
}

function authHeaders(preset: Preset, key: string | undefined, purpose: "check" | "chat"): Record<string, string> {
  if (!key) return {};
  if (preset.auth === "api-key") return { "api-key": key };
  if (preset.auth === "cf-aig") return { "cf-aig-authorization": `Bearer ${key}` };
  // Anthropic's OpenAI-compatible endpoint takes a bearer key; its model list takes x-api-key.
  if (preset.auth === "anthropic" && purpose === "check") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { Authorization: `Bearer ${key}` };
}

export function openAICompatible(preset: Preset, { key, baseUrl }: ConnectionSettings, fetcher: typeof fetch = fetch): ProviderAdapter {
  const name = preset.name;
  const base = baseUrl.replace(/\/+$/, "");
  // A key never follows a redirect to another address.
  const call = (path: string, init: RequestInit) => fetcher(`${base}${path}`, { ...init, redirect: "error" });
  const files = new Map<string, { id: string; until: number }>();
  return {
    async validate(signal) {
      if (preset.validatePath === null) return;
      let response: Response;
      try {
        response = await call(preset.validatePath ?? "/models", { headers: authHeaders(preset, key, "check"), signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ApiError(502, "unreachable", `Couldn’t reach ${name} at ${base}. Check the address${preset.keyless ? " and that the server is running" : ""}.`);
      }
      if ([401, 402, 403].includes(response.status) || (preset.balanceCheck && !response.ok)) await upstreamError(response, name);
      if (preset.balanceCheck) {
        const data = await response.json();
        if (typeof data.is_available !== "boolean") throw new ApiError(502, "invalid_response", `${name} returned an unreadable balance response.`);
        if (!data.is_available) throw new ApiError(402, "insufficient_balance", `This ${name} key works, but its account needs more balance. Add funds, then connect again.`);
      }
      // Other answers (404, 5xx) can't show the key is wrong; the first answer will.
    },
    async listModels(signal) {
      const response = await call("/models", { headers: authHeaders(preset, key, "check"), signal });
      if (!response.ok) return [];
      const data = await response.json().catch(() => null);
      if (!Array.isArray(data?.data)) return [];
      return data.data
        .map((m: { id?: unknown }) => (typeof m?.id === "string" ? m.id.replace(/^models\//, "") : ""))
        .filter((id: string) => MODEL_ID.test(id));
    },
    ...(preset.files ? {
      async upload(bytes: Uint8Array, mime: string, signal: AbortSignal) {
        const hash = createHash("sha256").update(key ?? "").update(bytes).digest("hex");
        const cached = files.get(hash);
        if (cached && cached.until > Date.now() + 60_000) return cached.id;
        const form = new FormData();
        form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), "image");
        form.set("purpose", "user_data");
        form.set("expires_after[anchor]", "created_at");
        form.set("expires_after[seconds]", "86400");
        const response = await call("/files", { method: "POST", headers: authHeaders(preset, key, "chat"), body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]) });
        if (!response.ok) await upstreamError(response, name);
        const data = await response.json();
        if (typeof data.id !== "string") throw new ApiError(502, "invalid_response", `${name} did not return an uploaded file identifier.`);
        files.set(hash, { id: data.id, until: typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 86400_000 });
        return data.id;
      },
    } : {}),
    async generate(model, messages, signal) {
      const payload = JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages.map(toProviderMessage)],
        stream: false,
        [preset.maxTokensField ?? "max_tokens"]: outputCap(preset, model),
        ...preset.extraBody,
      });
      if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new ApiError(413, "request_too_large", "The conversation exceeds Canvas’s 48 MiB request limit. Branch from an earlier message or attach fewer images.");
      const response = await call("/chat/completions", {
        method: "POST",
        signal,
        headers: { ...authHeaders(preset, key, "chat"), "Content-Type": "application/json" },
        body: payload,
      });
      if (!response.ok) { if ([400, 404].includes(response.status)) files.clear(); await upstreamError(response, name); }
      const data = await response.json();
      const choice = data.choices?.[0];
      const raw = choice?.message?.content;
      const text = typeof raw === "string" ? raw
        : Array.isArray(raw) ? raw.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
      // Some open models put their reasoning inline before the answer.
      const content = text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, "");
      const finish = choice?.finish_reason ?? "stop";
      if (finish === "content_filter")
        throw new ApiError(502, "content_filtered", `${name} withheld this answer under its content policy. Your prompt is saved; rephrase it or choose another model.`);
      const finishReason = ["length", "max_tokens"].includes(finish) ? "length"
        : ["stop", "end_turn", "eos", "STOP"].includes(finish) ? "stop" : undefined;
      if (!content.trim() && finishReason === "length")
        throw new ApiError(502, "invalid_response", `The model spent its whole output budget thinking before it answered. Your prompt is saved; retry, or choose a model without reasoning.`);
      if (!content.trim() || !finishReason)
        throw new ApiError(
          502,
          "invalid_response",
          `${name} returned an incomplete or empty answer. Your prompt is saved; you can retry.`,
        );
      const usage = readUsage(data.usage);
      const reported = data.usage?.cost;
      const cost = typeof reported === "number" && reported >= 0 ? reported : usage && estimateCost(preset.id, model, usage);
      return {
        content,
        model: typeof data.model === "string" ? data.model : model,
        finishReason,
        ...(usage ? { usage: { ...usage, ...(cost !== undefined ? { cost } : {}) } } : {}),
      };
    },
  };
}

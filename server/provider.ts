import { createHash } from "node:crypto";
import { MAX_REQUEST_BYTES } from "../shared/attachments";
import type { ChatMessage, ProviderAdapter, Usage } from "../shared/types";
import { MAX_OUTPUT_TOKENS, MODELS, SYSTEM_PROMPT } from "../shared/models";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function upstreamError(response: Response): Promise<never> {
  // Only inspect the upstream error to classify it. Never return or log its raw body.
  const body = await response.text().catch(() => "");
  if (response.status === 401 || response.status === 403)
    throw new ApiError(
      401,
      "invalid_key",
      "DeepSeek rejected the API key. Enter a valid key in DeepSeek settings (or fix DEEPSEEK_API_KEY in .env).",
    );
  if (response.status === 402)
    throw new ApiError(
      402,
      "insufficient_balance",
      "Your DeepSeek account needs more balance. Add funds, then retry.",
    );
  if (response.status === 429)
    throw new ApiError(
      429,
      "rate_limit",
      "DeepSeek is receiving too many requests. Wait a moment, then retry.",
    );
  if (response.status === 400 && /image|vision/i.test(body))
    throw new ApiError(
      400,
      "image_unsupported",
      "DeepSeek couldn’t use an image in this conversation. Use DeepSeek Flash, or branch from a message without that image.",
    );
  if (response.status === 400 && /context|token|length/i.test(body))
    throw new ApiError(
      400,
      "context_limit",
      "This conversation exceeds DeepSeek’s context limit. Branch from an earlier message or start a new canvas.",
    );
  throw new ApiError(
    502,
    "provider_error",
    "DeepSeek could not complete this request. Your prompt is saved; you can retry.",
  );
}

function readUsage(usage: Record<string, unknown> | undefined): Usage | undefined {
  const count = (value: unknown) =>
    Number.isInteger(value) && (value as number) >= 0
      ? (value as number)
      : undefined;
  const promptTokens = count(usage?.prompt_tokens);
  const completionTokens = count(usage?.completion_tokens);
  if (promptTokens === undefined || completionTokens === undefined) return;
  const hit = count(usage?.prompt_cache_hit_tokens);
  const miss = count(usage?.prompt_cache_miss_tokens);
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

export function deepseek(fetcher: typeof fetch = fetch): ProviderAdapter {
  const base = "https://api.deepseek.com";
  const files = new Map<string, { id: string; until: number }>();
  return {
    id: "deepseek",
    models: MODELS,
    async validateKey(key, signal) {
      const response = await fetcher(`${base}/user/balance`, { headers: { Authorization: `Bearer ${key}` }, signal });
      if (!response.ok) await upstreamError(response);
      const data = await response.json();
      if (typeof data.is_available !== "boolean") throw new ApiError(502, "invalid_response", "DeepSeek returned an unreadable balance response.");
      return { available: data.is_available };
    },
    async upload(key, bytes, mime, signal) {
      const hash = createHash("sha256").update(key).update(bytes).digest("hex");
      const cached = files.get(hash);
      if (cached && cached.until > Date.now() + 60_000) return cached.id;
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), "image");
      form.set("purpose", "user_data");
      form.set("expires_after[anchor]", "created_at");
      form.set("expires_after[seconds]", "86400");
      const response = await fetcher(`${base}/files`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]) });
      if (!response.ok) await upstreamError(response);
      const data = await response.json();
      if (typeof data.id !== "string") throw new ApiError(502, "invalid_response", "DeepSeek did not return an uploaded file identifier.");
      files.set(hash, { id: data.id, until: typeof data.expires_at === "number" ? data.expires_at * 1000 : Date.now() + 86400_000 });
      return data.id;
    },
    async generate(key, model, messages, signal) {
      const payload = JSON.stringify({ model, messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages.map(toProviderMessage)], stream: false, thinking: { type: "disabled" }, max_tokens: MAX_OUTPUT_TOKENS });
      if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) throw new ApiError(413, "request_too_large", "The conversation exceeds DeepSeek’s 48 MiB request limit.");
      const response = await fetcher(`${base}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: payload,
      });
      if (!response.ok) { if ([400, 404].includes(response.status)) files.clear(); await upstreamError(response); }
      const data = await response.json();
      const choice = data.choices?.[0];
      const usage = readUsage(data.usage);
      if (
        typeof choice?.message?.content !== "string" ||
        !choice.message.content.trim() ||
        !["stop", "length"].includes(choice.finish_reason)
      )
        throw new ApiError(
          502,
          "invalid_response",
          "DeepSeek returned an incomplete or empty answer. Your prompt is saved; you can retry.",
        );
      return {
        content: choice.message.content,
        model: typeof data.model === "string" ? data.model : model,
        finishReason: choice.finish_reason,
        ...(usage ? { usage } : {}),
      };
    },
  };
}

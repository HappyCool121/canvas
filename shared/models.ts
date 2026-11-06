export const SYSTEM_PROMPT =
  "You are a helpful assistant. Respond clearly and use Markdown when useful. Delimit inline LaTeX math with single dollar signs and display math with double dollar signs on separate lines.";
export const MAX_OUTPUT_TOKENS = 4096;
// Reasoning models spend part of their output on thinking before they answer.
export const REASONING_OUTPUT_TOKENS = 16_384;

export type ModelInfo = {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  description: string;
  // Unknown models are assumed to see images; the provider's own error explains a refusal.
  vision: boolean;
  reasoning?: boolean;
  contextWindow?: number;
  // Local account that supplied this ChatGPT plan model.
  profileId?: string;
  // Thinking levels this model accepts, weakest first; absent when it has none to choose.
  efforts?: string[];
  // The level the provider uses when Canvas sends none, when it is known.
  defaultEffort?: string;
};

// Every thinking level Canvas can request. "off"/"on" are for providers that
// only switch thinking on or off.
export const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "off", "on"] as const;
export const validReasoning = (value: unknown): value is string =>
  typeof value === "string" && (REASONING_LEVELS as readonly string[]).includes(value);
export const EFFORT_LEVELS = ["low", "medium", "high"];
// DeepSeek maps every effort to low, high or max; Canvas keeps its thinking off by default.
export const DEEPSEEK_LEVELS = ["low", "high", "max"];
// Thinking budgets for Anthropic, which ignores reasoning_effort on its OpenAI-compatible endpoint.
export const THINKING_BUDGETS: Record<string, number> = { low: 2048, medium: 6144, high: 12288 };
// Levels that keep thinking off.
export const thinkingOff = (level: string | undefined) => level === "off" || level === "none";
// The last level chosen for each "provider/model", saved as a JSON preference.
export const REASONING_KEY = "canvas.reasoning";
export function validReasoningPreference(value: unknown) {
  if (typeof value !== "string" || value.length > 16 * 1024) return false;
  try {
    const parsed = JSON.parse(value);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.entries(parsed).every(([key, level]) => key.length <= 300 && validReasoning(level));
  } catch { return false; }
}
export const parseReasoning = (value: string | undefined): Record<string, string> =>
  value && validReasoningPreference(value) ? JSON.parse(value) : {};
// A label for a level: "High", "Off", "Extra high".
export const effortLabel = (level: string) => level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1);

export const CHATGPT_PLAN = "chatgpt-plan";
export const CHATGPT_PLAN_NAME = "ChatGPT plan";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

// Answers from before providers could be chosen were written by DeepSeek.
export const LEGACY_PROVIDER = "deepseek";
export const LEGACY_MODEL = "deepseek-flash";

// DeepSeek keeps the names Canvas has always shown for it.
export const MODEL_OVERRIDES: Record<string, Partial<ModelInfo>> = {
  "deepseek/deepseek-flash": { label: "DeepSeek Flash", description: "Fast · sees images" },
  "deepseek/deepseek-v4-pro": { label: "DeepSeek V4 Pro", description: "More capable · text only · higher cost" },
};

// Model ids as providers write them: "gpt-x", "vendor/model:free", "llama3.2:3b".
export const MODEL_ID = /^[\w.:/@+-]{1,200}$/;

// Model choices are stored as "provider/model"; model ids may contain slashes.
export const modelKey = (provider: string, id: string) => `${provider}/${id}`;
export function parseModelKey(key: string | null | undefined) {
  if (!key) return undefined;
  const slash = key.indexOf("/");
  return slash < 0
    ? { provider: LEGACY_PROVIDER, id: key }
    : { provider: key.slice(0, slash), id: key.slice(slash + 1) };
}

// Describes a model the catalog doesn't know, such as an Azure deployment or a local model.
export function unknownModel(provider: string, providerName: string, id: string): ModelInfo {
  return { provider, providerName, id, label: id, description: providerName, vision: provider !== CHATGPT_PLAN };
}

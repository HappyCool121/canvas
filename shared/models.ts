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
};

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
  return { provider, providerName, id, label: id, description: providerName, vision: true };
}

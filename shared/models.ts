export const SYSTEM_PROMPT =
  "You are a helpful assistant. Respond clearly and use Markdown when useful. Delimit inline LaTeX math with single dollar signs and display math with double dollar signs on separate lines.";
export const MAX_OUTPUT_TOKENS = 4096;

export type ModelInfo = {
  id: string;
  label: string;
  description: string;
  vision: boolean;
  contextWindow: number;
};

// DeepSeek models offered with the same key. Only Flash accepts images.
export const MODELS: ModelInfo[] = [
  {
    id: "deepseek-flash",
    label: "DeepSeek Flash",
    description: "Fast · sees images",
    vision: true,
    contextWindow: 1_000_000,
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "More capable · text only · higher cost",
    vision: false,
    contextWindow: 1_000_000,
  },
];
export const DEFAULT_MODEL = MODELS[0].id;

export function modelInfo(id: string | undefined): ModelInfo {
  return (
    MODELS.find((m) => m.id === id) ?? {
      ...MODELS[0],
      id: id ?? DEFAULT_MODEL,
      label: id ?? MODELS[0].label,
    }
  );
}

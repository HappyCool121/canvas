import catalog from "../shared/catalog.json" with { type: "json" };
import { MAX_OUTPUT_TOKENS, MODEL_OVERRIDES, REASONING_OUTPUT_TOKENS, modelKey, unknownModel, type ModelInfo } from "../shared/models";
import type { Preset } from "../shared/providers";
import type { Usage } from "../shared/types";

// [name, context, maxOutput, vision, reasoning, input, output, cacheRead]; see scripts/update-catalog.ts.
type Entry = [string, number, number, number, number, number, number, number];
const providers = catalog.providers as unknown as Record<string, Record<string, Entry>>;
const entry = (provider: string, id: string): Entry | undefined => providers[provider]?.[id];

export const catalogIds = (provider: string) => Object.keys(providers[provider] ?? {});

const tokens = (count: number) =>
  count >= 1_000_000 ? `${Math.round(count / 100_000) / 10}M` : `${Math.round(count / 1000)}K`;

export function modelInfo(preset: Preset, id: string): ModelInfo {
  const known = entry(preset.id, id);
  const override = MODEL_OVERRIDES[modelKey(preset.id, id)];
  if (!known) return { ...unknownModel(preset.id, preset.name, id), ...override };
  const [name, context, , vision, reasoning] = known;
  return {
    provider: preset.id,
    providerName: preset.name,
    id,
    label: name,
    description: [vision ? "Sees images" : "Text only", context ? `${tokens(context)} context` : ""].filter(Boolean).join(" · "),
    vision: Boolean(vision),
    reasoning: Boolean(reasoning),
    ...(context ? { contextWindow: context } : {}),
    ...override,
  };
}

export function outputCap(preset: Preset, id: string) {
  const known = entry(preset.id, id);
  const cap = known?.[4] && !preset.reasoningOff ? REASONING_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;
  return known?.[2] ? Math.min(cap, known[2]) : cap;
}

// Estimated USD at the catalog's list prices; undefined when a price is unknown.
export function estimateCost(provider: string, id: string, usage: Usage) {
  const known = entry(provider, id);
  if (!known || known[5] < 0 || known[6] < 0) return undefined;
  const [, , , , , input, output, cacheRead] = known;
  const cached = usage.promptCacheHitTokens ?? 0;
  return ((usage.promptTokens - cached) * input + cached * (cacheRead >= 0 ? cacheRead : input) +
    usage.completionTokens * output) / 1_000_000;
}

import catalog from "../shared/catalog.json" with { type: "json" };
import { CHATGPT_PLAN, CHATGPT_PLAN_NAME, DEEPSEEK_LEVELS, EFFORT_LEVELS, MAX_OUTPUT_TOKENS, MODEL_OVERRIDES, REASONING_OUTPUT_TOKENS, modelKey, thinkingOff, unknownModel, validReasoning, type ModelInfo } from "../shared/models";
import type { Preset } from "../shared/providers";
import type { Usage } from "../shared/types";

// [name, context, maxOutput, vision, reasoning, input, output, cacheRead]; see scripts/update-catalog.ts.
type Entry = [string, number, number, number, number, number, number, number];
const providers = catalog.providers as unknown as Record<string, Record<string, Entry>>;
const entry = (provider: string, id: string): Entry | undefined => providers[provider]?.[id];

export const catalogIds = (provider: string) => Object.keys(providers[provider] ?? {});

const tokens = (count: number) =>
  count >= 1_000_000 ? `${Math.round(count / 100_000) / 10}M` : `${Math.round(count / 1000)}K`;

// Thinking levels to offer. Models the catalog doesn't know may think, so they
// get the choice too; "Default" always sends nothing.
function thinking(preset: Preset, reasoning: boolean | undefined): Pick<ModelInfo, "efforts" | "defaultEffort"> {
  if (preset.reasoning === "deepseek") return { efforts: DEEPSEEK_LEVELS, defaultEffort: "off" };
  return reasoning === false ? {} : { efforts: EFFORT_LEVELS };
}

export function modelInfo(preset: Preset, id: string): ModelInfo {
  const known = entry(preset.id, id);
  const override = MODEL_OVERRIDES[modelKey(preset.id, id)];
  if (!known) return { ...unknownModel(preset.id, preset.name, id), ...thinking(preset, undefined), ...override };
  const [name, context, , vision, reasoning] = known;
  return {
    ...thinking(preset, Boolean(reasoning)),
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

// The plan's model list may name the levels a model accepts and its default;
// otherwise the bundled catalog decides whether to offer the usual three.
export function planModelInfo(id: string, label: string, profileId: string, levels?: unknown, fallback?: unknown): ModelInfo {
  const known = entry("openai", id);
  const contextWindow = known?.[1] || undefined;
  const vision = Boolean(known?.[3]);
  const listed = Array.isArray(levels)
    ? [...new Set(levels.map((level) => (typeof level === "string" ? level : (level as { effort?: unknown })?.effort)).filter(validReasoning))]
    : [];
  const efforts = listed.length ? listed : known && !known[4] ? undefined : EFFORT_LEVELS;
  return {
    provider: CHATGPT_PLAN, providerName: CHATGPT_PLAN_NAME, id, label, profileId, vision, contextWindow,
    description: [vision ? "Sees images" : "Text only", contextWindow ? `${tokens(contextWindow)} context` : ""].filter(Boolean).join(" · "),
    ...(efforts ? { efforts } : {}),
    ...(efforts && validReasoning(fallback) ? { defaultEffort: fallback } : {}),
  };
}

// A chosen thinking level gets the larger budget; reasoning models get it by default.
export function outputCap(preset: Preset, id: string, reasoning?: string) {
  const known = entry(preset.id, id);
  const thinks = reasoning ? !thinkingOff(reasoning) : Boolean(known?.[4]) && !preset.reasoningOff;
  const cap = thinks ? REASONING_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;
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

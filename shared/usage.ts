import { DEFAULT_MODEL } from "./models";
import type { Canvas } from "./types";

// USD per million tokens at off-peak rates. Peak is twice off-peak.
// https://api-docs.deepseek.com/quick_start/pricing/
const rates = new Map([
  [DEFAULT_MODEL, { cached: 0.003, uncached: 0.15, output: 0.6 }],
  ["deepseek-v4-pro", { cached: 0.022, uncached: 0.66, output: 1.98 }],
]);
const flashAliases = new Set(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

export function canvasUsage(canvas: Canvas) {
  let tokens = 0;
  let offPeak = 0;
  let missingUsage = false;
  let missingRate = false;
  for (const answer of canvas.messages) {
    if (answer.role !== "assistant" || answer.status !== "complete") continue;
    const { usage, model } = answer;
    if (!usage) {
      missingUsage = true;
      continue;
    }
    tokens += usage.promptTokens + usage.completionTokens;
    const rate = rates.get(!model || flashAliases.has(model) ? DEFAULT_MODEL : model);
    if (!rate) {
      missingRate = true;
      continue;
    }
    const { promptCacheHitTokens: hit, promptCacheMissTokens: miss } = usage;
    const cached = hit !== undefined && miss !== undefined &&
      hit >= 0 && miss >= 0 && hit + miss === usage.promptTokens ? hit : 0;
    offPeak += (cached * rate.cached + (usage.promptTokens - cached) * rate.uncached +
      usage.completionTokens * rate.output) / 1_000_000;
  }
  return { tokens, offPeak, peak: offPeak * 2, missingUsage, partial: missingUsage || missingRate };
}

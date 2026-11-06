import { CHATGPT_PLAN } from "./models";
import type { Canvas } from "./types";

// Older DeepSeek answers predate stored costs: USD per million tokens at off-peak rates.
// https://api-docs.deepseek.com/quick_start/pricing/
const legacyRates = new Map([
  ["deepseek-flash", { cached: 0.003, uncached: 0.15, output: 0.6 }],
  ["deepseek-v4-pro", { cached: 0.022, uncached: 0.66, output: 1.98 }],
]);
const flashAliases = new Set(["deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);

export function canvasUsage(canvas: Canvas) {
  let tokens = 0;
  let planTokens = 0;
  let planAnswers = false;
  let missingPlanUsage = false;
  let cost = 0;
  let missingUsage = false;
  let missingRate = false;
  for (const answer of canvas.messages) {
    if (answer.role !== "assistant" || answer.status !== "complete") continue;
    const { usage, model } = answer;
    if (answer.provider === CHATGPT_PLAN) {
      planAnswers = true;
      if (usage) planTokens += usage.promptTokens + usage.completionTokens;
      else missingPlanUsage = true;
      continue;
    }
    if (!usage) {
      missingUsage = true;
      continue;
    }
    tokens += usage.promptTokens + usage.completionTokens;
    if (usage.cost !== undefined) {
      cost += usage.cost;
      continue;
    }
    const rate = (!answer.provider || answer.provider === "deepseek") &&
      legacyRates.get(!model || flashAliases.has(model) ? "deepseek-flash" : model);
    if (!rate) {
      missingRate = true;
      continue;
    }
    const { promptCacheHitTokens: hit, promptCacheMissTokens: miss } = usage;
    const cached = hit !== undefined && miss !== undefined &&
      hit >= 0 && miss >= 0 && hit + miss === usage.promptTokens ? hit : 0;
    cost += (cached * rate.cached + (usage.promptTokens - cached) * rate.uncached +
      usage.completionTokens * rate.output) / 1_000_000;
  }
  return { tokens: tokens + planTokens, planTokens, planAnswers, missingPlanUsage, cost, missingUsage: missingUsage || missingPlanUsage, partial: missingUsage || missingRate };
}

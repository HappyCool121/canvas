// Refreshes shared/catalog.json from models.dev (MIT, https://github.com/sst/models.dev):
// context windows, image input, reasoning and list prices for each preset's models.
// Run with `npm run catalog`. Canvas never fetches the catalog at runtime.
import { writeFile } from "node:fs/promises";
import { PRESETS } from "../shared/providers";

type Source = {
  api?: string;
  models: Record<string, {
    id: string;
    type?: string;
    name?: string;
    status?: string;
    reasoning?: boolean;
    modalities?: { input?: string[]; output?: string[] };
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number; cache_read?: number };
    provider?: { api?: string };
  }>;
};

const response = await fetch("https://models.dev/api.json");
if (!response.ok) throw new Error(`models.dev answered ${response.status}`);
const sources = (await response.json()) as Record<string, Source>;
const providers: Record<string, Record<string, (string | number)[]>> = {};
for (const preset of PRESETS) {
  const models: Record<string, (string | number)[]> = {};
  for (const sourceId of preset.catalog ?? []) {
    const source = sources[sourceId];
    if (!source) throw new Error(`models.dev has no provider "${sourceId}" for ${preset.id}`);
    for (const m of Object.values(source.models)) {
      const output = m.modalities?.output ?? [];
      // Chat models only; gateways may route some models through other APIs.
      if (models[m.id] || m.status === "deprecated" || (m.type && m.type !== "chat") || output.length !== 1 || output[0] !== "text") continue;
      if (!m.modalities?.input?.includes("text") || (m.provider?.api && m.provider.api !== source.api)) continue;
      models[m.id] = [
        m.name || m.id,
        m.limit?.context ?? 0,
        m.limit?.output ?? 0,
        m.modalities.input.includes("image") ? 1 : 0,
        m.reasoning ? 1 : 0,
        m.cost?.input ?? -1,
        m.cost?.output ?? -1,
        m.cost?.cache_read ?? -1,
      ];
    }
  }
  if (Object.keys(models).length) providers[preset.id] = models;
}
const catalog = {
  source: "https://models.dev (MIT)",
  updated: new Date().toISOString().slice(0, 10),
  // 0 means unknown; -1 means no listed price.
  fields: ["name", "context", "maxOutput", "vision", "reasoning", "inputUSDPerM", "outputUSDPerM", "cacheReadUSDPerM"],
  providers,
};
await writeFile(new URL("../shared/catalog.json", import.meta.url), JSON.stringify(catalog) + "\n");
const count = Object.values(providers).reduce((sum, models) => sum + Object.keys(models).length, 0);
console.log(`Wrote ${count} models for ${Object.keys(providers).length} providers to shared/catalog.json.`);

import { PRESETS, unfinishedBaseUrl } from "../shared/providers";

// A provider connected from the environment (.env or the shell). Keys are never
// sent to the browser.
export type EnvConnection = { id: string; key?: string; baseUrl: string };
export type Config = {
  port: number;
  connections: EnvConnection[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const value = (name: string) => env[name]?.trim() || undefined;
  const connections: EnvConnection[] = [];
  for (const preset of PRESETS) {
    const entry = preset.env?.find((e) => value(e.key));
    const explicitBase = preset.envBaseUrl && value(preset.envBaseUrl);
    // Keyless servers connect when their address is set.
    if (!entry && !(preset.keyless && explicitBase)) continue;
    // {CLOUDFLARE_ACCOUNT_ID}-style placeholders are filled from the environment.
    const baseUrl = (explicitBase || entry?.baseUrl || preset.baseUrl)
      .replace(/\{(\w+)\}/g, (match, name: string) => value(name) ?? match);
    if (!baseUrl || unfinishedBaseUrl(baseUrl)) continue;
    connections.push({ id: preset.id, ...(entry ? { key: value(entry.key) } : {}), baseUrl });
  }
  const config = {
    port: Number(env.PORT || 3000),
    connections,
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("PORT must be a valid port number.");
  return config;
}

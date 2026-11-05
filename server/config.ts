export type Config = {
  port: number;
  // Optional DeepSeek key from .env. Without it, connect a key in the app.
  // Never sent to the browser.
  deepseekApiKey?: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const config = {
    port: Number(env.PORT || 3000),
    deepseekApiKey: env.DEEPSEEK_API_KEY?.trim() || undefined,
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw new Error("PORT must be a valid port number.");
  return config;
}

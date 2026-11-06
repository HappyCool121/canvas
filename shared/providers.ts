// Providers Canvas can connect with your own key. All speak OpenAI-style
// Chat Completions; Anthropic and Google through their compatibility endpoints.
export type Preset = {
  id: string;
  name: string;
  group: "Model makers" | "Fast hosts" | "Gateways" | "Local and custom";
  // Default endpoint, including the version path (requests append /chat/completions).
  baseUrl: string;
  // Regional or plan endpoints offered as suggestions.
  baseUrlChoices?: string[];
  // Any base URL may be entered (local servers, Azure, Cloudflare, custom).
  editableBaseUrl?: boolean;
  keyUrl?: string;
  // The key is optional (local servers).
  keyless?: boolean;
  // Environment variables that connect at startup; a variable may imply its endpoint.
  env?: { key: string; baseUrl?: string }[];
  envBaseUrl?: string;
  auth?: "bearer" | "api-key" | "cf-aig" | "anthropic";
  // Checked without inference when connecting; null when nothing can check the key.
  validatePath?: string | null;
  // DeepSeek's balance endpoint also reports whether the account can pay.
  balanceCheck?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  extraBody?: Record<string, unknown>;
  // Reasoning is turned off by extraBody, so the normal output cap applies.
  reasoningOff?: boolean;
  // Images go through the provider's Files API instead of inline data URLs.
  files?: boolean;
  // models.dev providers that describe this preset's models, merged in order.
  catalog?: string[];
};

export const PRESETS: Preset[] = [
  { id: "openai", name: "OpenAI", group: "Model makers", baseUrl: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", env: [{ key: "OPENAI_API_KEY" }], maxTokensField: "max_completion_tokens", catalog: ["openai"] },
  { id: "anthropic", name: "Anthropic", group: "Model makers", baseUrl: "https://api.anthropic.com/v1", keyUrl: "https://console.anthropic.com/settings/keys", env: [{ key: "ANTHROPIC_API_KEY" }], auth: "anthropic", catalog: ["anthropic"] },
  { id: "google", name: "Google Gemini", group: "Model makers", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", env: [{ key: "GEMINI_API_KEY" }], catalog: ["google"] },
  { id: "deepseek", name: "DeepSeek", group: "Model makers", baseUrl: "https://api.deepseek.com", keyUrl: "https://platform.deepseek.com/api_keys", env: [{ key: "DEEPSEEK_API_KEY" }], validatePath: "/user/balance", balanceCheck: true, extraBody: { thinking: { type: "disabled" } }, reasoningOff: true, files: true, catalog: ["deepseek"] },
  { id: "xai", name: "xAI", group: "Model makers", baseUrl: "https://api.x.ai/v1", keyUrl: "https://console.x.ai", env: [{ key: "XAI_API_KEY" }], catalog: ["xai"] },
  { id: "mistral", name: "Mistral", group: "Model makers", baseUrl: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys", env: [{ key: "MISTRAL_API_KEY" }], catalog: ["mistral"] },
  { id: "moonshot", name: "Moonshot AI", group: "Model makers", baseUrl: "https://api.moonshot.ai/v1", baseUrlChoices: ["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1"], keyUrl: "https://platform.moonshot.ai/console/api-keys", env: [{ key: "MOONSHOT_API_KEY" }], catalog: ["moonshotai", "moonshotai-cn"] },
  { id: "kimi-coding", name: "Kimi For Coding", group: "Model makers", baseUrl: "https://api.kimi.com/coding/v1", baseUrlChoices: ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1"], keyUrl: "https://www.kimi.com/code", env: [{ key: "KIMI_API_KEY" }], catalog: ["kimi-code-plan-global"] },
  { id: "minimax", name: "MiniMax", group: "Model makers", baseUrl: "https://api.minimax.io/v1", baseUrlChoices: ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1"], keyUrl: "https://platform.minimax.io", env: [{ key: "MINIMAX_API_KEY" }, { key: "MINIMAX_CN_API_KEY", baseUrl: "https://api.minimaxi.com/v1" }], catalog: ["minimax", "minimax-cn"] },
  { id: "zai", name: "Z.AI", group: "Model makers", baseUrl: "https://api.z.ai/api/paas/v4", baseUrlChoices: ["https://api.z.ai/api/paas/v4", "https://api.z.ai/api/coding/paas/v4", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/coding/paas/v4"], keyUrl: "https://z.ai/manage-apikey/apikey-list", env: [{ key: "ZAI_API_KEY" }, { key: "ZAI_CODING_CN_API_KEY", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }], catalog: ["zai", "zai-coding-plan", "zhipuai", "zhipuai-coding-plan"] },
  { id: "qwen", name: "Qwen (Alibaba Model Studio)", group: "Model makers", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", baseUrlChoices: ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"], keyUrl: "https://modelstudio.console.alibabacloud.com", env: [{ key: "DASHSCOPE_API_KEY" }, { key: "QWEN_TOKEN_PLAN_API_KEY", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" }, { key: "QWEN_TOKEN_PLAN_CN_API_KEY", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" }], catalog: ["alibaba", "alibaba-cn", "alibaba-token-plan", "alibaba-token-plan-cn"] },
  { id: "xiaomi", name: "Xiaomi MiMo", group: "Model makers", baseUrl: "https://api.xiaomimimo.com/v1", baseUrlChoices: ["https://api.xiaomimimo.com/v1", "https://token-plan-cn.xiaomimimo.com/v1", "https://token-plan-ams.xiaomimimo.com/v1", "https://token-plan-sgp.xiaomimimo.com/v1"], keyUrl: "https://platform.xiaomimimo.com", env: [{ key: "XIAOMI_API_KEY" }, { key: "XIAOMI_TOKEN_PLAN_CN_API_KEY", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1" }, { key: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", baseUrl: "https://token-plan-ams.xiaomimimo.com/v1" }, { key: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1" }], catalog: ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] },
  { id: "ant-ling", name: "Ant Ling", group: "Model makers", baseUrl: "https://api.ant-ling.com/v1", env: [{ key: "ANT_LING_API_KEY" }] },

  { id: "groq", name: "Groq", group: "Fast hosts", baseUrl: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", env: [{ key: "GROQ_API_KEY" }], catalog: ["groq"] },
  { id: "cerebras", name: "Cerebras", group: "Fast hosts", baseUrl: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai", env: [{ key: "CEREBRAS_API_KEY" }], catalog: ["cerebras"] },
  { id: "together", name: "Together AI", group: "Fast hosts", baseUrl: "https://api.together.ai/v1", keyUrl: "https://api.together.ai/settings/api-keys", env: [{ key: "TOGETHER_API_KEY" }], catalog: ["togetherai"] },
  { id: "fireworks", name: "Fireworks", group: "Fast hosts", baseUrl: "https://api.fireworks.ai/inference/v1", keyUrl: "https://fireworks.ai/account/api-keys", env: [{ key: "FIREWORKS_API_KEY" }], catalog: ["fireworks-ai"] },
  { id: "baseten", name: "Baseten", group: "Fast hosts", baseUrl: "https://inference.baseten.co/v1", keyUrl: "https://app.baseten.co/settings/api_keys", env: [{ key: "BASETEN_API_KEY" }], catalog: ["baseten"] },
  { id: "nvidia", name: "NVIDIA NIM", group: "Fast hosts", baseUrl: "https://integrate.api.nvidia.com/v1", keyUrl: "https://build.nvidia.com", env: [{ key: "NVIDIA_API_KEY" }], validatePath: null, catalog: ["nvidia"] },
  { id: "huggingface", name: "Hugging Face", group: "Fast hosts", baseUrl: "https://router.huggingface.co/v1", keyUrl: "https://huggingface.co/settings/tokens", env: [{ key: "HF_TOKEN" }], validatePath: null, catalog: ["huggingface"] },

  { id: "openrouter", name: "OpenRouter", group: "Gateways", baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/settings/keys", env: [{ key: "OPENROUTER_API_KEY" }], validatePath: "/key", catalog: ["openrouter"] },
  { id: "vercel", name: "Vercel AI Gateway", group: "Gateways", baseUrl: "https://ai-gateway.vercel.sh/v1", keyUrl: "https://vercel.com/dashboard/ai-gateway", env: [{ key: "AI_GATEWAY_API_KEY" }], validatePath: "/credits", catalog: ["vercel"] },
  { id: "opencode", name: "OpenCode Zen", group: "Gateways", baseUrl: "https://opencode.ai/inference/openai/v1", baseUrlChoices: ["https://opencode.ai/inference/openai/v1", "https://opencode.ai/inference/go/openai/v1"], keyUrl: "https://opencode.ai/auth", env: [{ key: "OPENCODE_API_KEY" }], validatePath: null, catalog: ["opencode", "opencode-go"] },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", group: "Gateways", baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1", editableBaseUrl: true, keyUrl: "https://dash.cloudflare.com/profile/api-tokens", env: [{ key: "CLOUDFLARE_API_KEY" }], catalog: ["cloudflare-workers-ai"] },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", group: "Gateways", baseUrl: "https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/compat", editableBaseUrl: true, keyUrl: "https://dash.cloudflare.com/profile/api-tokens", env: [{ key: "CLOUDFLARE_API_KEY" }], auth: "cf-aig", validatePath: null, catalog: ["cloudflare-ai-gateway"] },
  { id: "azure", name: "Azure OpenAI", group: "Gateways", baseUrl: "https://{AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1", editableBaseUrl: true, keyUrl: "https://portal.azure.com", env: [{ key: "AZURE_OPENAI_API_KEY" }], envBaseUrl: "AZURE_OPENAI_BASE_URL", auth: "api-key", maxTokensField: "max_completion_tokens", catalog: ["azure"] },

  { id: "ollama", name: "Ollama", group: "Local and custom", baseUrl: "http://127.0.0.1:11434/v1", baseUrlChoices: ["http://127.0.0.1:11434/v1", "https://ollama.com/v1"], editableBaseUrl: true, keyless: true, keyUrl: "https://ollama.com/settings/keys", env: [{ key: "OLLAMA_API_KEY", baseUrl: "https://ollama.com/v1" }], envBaseUrl: "OLLAMA_BASE_URL", catalog: ["ollama-cloud"] },
  { id: "lmstudio", name: "LM Studio", group: "Local and custom", baseUrl: "http://127.0.0.1:1234/v1", editableBaseUrl: true, keyless: true, envBaseUrl: "LMSTUDIO_BASE_URL" },
  { id: "custom", name: "Custom (OpenAI-compatible)", group: "Local and custom", baseUrl: "", editableBaseUrl: true, keyless: true, env: [{ key: "OPENAI_COMPATIBLE_API_KEY" }], envBaseUrl: "OPENAI_COMPATIBLE_BASE_URL" },
];

export const presetById = (id: unknown) => PRESETS.find((p) => p.id === id);
// Placeholders name environment variables ({CLOUDFLARE_ACCOUNT_ID}); a base URL
// that still has one must be completed before connecting.
export const unfinishedBaseUrl = (url: string) => /\{[^}]*\}/.test(url);

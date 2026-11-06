import { createReadStream } from "node:fs";
import { checkImageBudget, MAX_IMAGES, MAX_REQUEST_BYTES } from "../shared/attachments";
import express from "express";
import { createWorkspace, validId, validCanvas } from "./workspace";
import type { ChatMessage, ProviderConnection, ProvidersState } from "../shared/types";
import { ApiError, openAICompatible, type ConnectionSettings, type ProviderAdapter } from "./provider";
import { catalogIds, modelInfo } from "./catalog";
import type { EnvConnection } from "./config";
import { CHATGPT_PLAN, LEGACY_MODEL, LEGACY_PROVIDER, MODEL_ID } from "../shared/models";
import { planIssue, type ChatGPTPlan } from "./chatgpt-plan";
import { RESOURCE, revoked } from "./chatgpt-plan/protocol";
import { PRESETS, presetById, unfinishedBaseUrl, type Preset } from "../shared/providers";

const MAX_IMAGES_PER_MESSAGE = MAX_IMAGES;
const MAX_IMAGE_URL_LENGTH = Math.ceil(32 * 1024 * 1024 / 3) * 4 + 64;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/;

function validMessage(m: ChatMessage) {
  if (!m || !["user", "assistant"].includes(m.role)) return false;
  if (typeof m.content !== "string") return false;
  if (m.fileIds !== undefined) return false;
  if (m.attachmentIds !== undefined) return m.role === "user" && m.images === undefined && Array.isArray(m.attachmentIds) && m.attachmentIds.length > 0 && m.attachmentIds.length <= MAX_IMAGES && m.attachmentIds.every(validId);
  if (m.images === undefined) return Boolean(m.content.trim());
  return (
    m.role === "user" &&
    Array.isArray(m.images) &&
    m.images.length > 0 &&
    m.images.length <= MAX_IMAGES_PER_MESSAGE &&
    m.images.every(
      (url) =>
        typeof url === "string" &&
        url.length <= MAX_IMAGE_URL_LENGTH &&
        IMAGE_DATA_URL.test(url) &&
        Buffer.byteLength(url.slice(url.indexOf(",") + 1), "base64") <= 32 * 1024 * 1024,
    )
  );
}

// Plain http is fine for this computer and the local network; anything else needs https.
function privateAddress(hostname: string) {
  return /^(localhost|.+\.localhost|.+\.local|\[::1\]|127(\.\d+){3}|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$/i.test(hostname);
}
function checkBaseUrl(preset: Preset, raw: unknown) {
  const url = typeof raw === "string" && raw.trim() ? raw.trim().replace(/\/+$/, "") : preset.baseUrl;
  const invalid = (message: string) => new ApiError(400, "invalid_base_url", message);
  if (!url || unfinishedBaseUrl(url)) throw invalid(`Enter the full base URL for ${preset.name}.`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw invalid("Enter a base URL such as https://api.example.com/v1."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || url.length > 500)
    throw invalid("Enter the base URL without a user name, query or fragment.");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && privateAddress(parsed.hostname)))
    throw invalid("Use an https:// address. Plain http:// works only for this computer or your local network.");
  return url;
}

type Connection = {
  preset: Preset;
  settings: ConnectionSettings;
  source: ProviderConnection["source"];
  adapter: ProviderAdapter;
  models?: Promise<string[]>;
};
// Saved per provider in preferences.json: never a key, only the address, and
// whether a keyless local server should reconnect at startup.
type Saved = Record<string, { baseUrl?: string; keyless?: boolean }>;
const SAVED_KEY = "canvas.providers";

type Options = {
  fetcher?: typeof fetch;
  // Builds the adapter for a connection; tests replace it.
  adapter?: (preset: Preset, settings: ConnectionSettings) => ProviderAdapter;
  // Providers connected from .env. Keys are never sent to the browser.
  connections?: EnvConnection[];
  timeoutMs?: number;
  dataDir?: string;
  chatGPTPlan?: ChatGPTPlan;
};
export function createApp({
  fetcher = fetch,
  adapter = (preset, settings) => openAICompatible(preset, settings, fetcher),
  connections: initial = [],
  timeoutMs = 300_000,
  dataDir,
  chatGPTPlan,
}: Options = {}) {
  const app = express();
  app.disable("x-powered-by");
  const workspace = createWorkspace(dataDir);
  const active = new Map<string, { controller: AbortController; provider: string; profileId?: string }>();
  // Keys live only in this process's memory: a key entered in the app lasts
  // until Disconnect or a restart. They are never returned, stored or logged.
  const connections = new Map<string, Connection>();
  const connect = (preset: Preset, settings: ConnectionSettings, source: Connection["source"]) =>
    connections.set(preset.id, { preset, settings, source, adapter: adapter(preset, settings) });
  for (const c of initial) {
    const preset = presetById(c.id);
    if (preset) connect(preset, { key: c.key, baseUrl: c.baseUrl }, "env");
  }
  let saved: Saved = {};
  const restored = workspace.preferences().then((values) => {
    try { saved = JSON.parse(values[SAVED_KEY] || "{}"); } catch { saved = {}; }
    for (const [id, entry] of Object.entries(saved)) {
      const preset = presetById(id);
      if (preset?.keyless && entry.keyless && entry.baseUrl && !connections.has(id))
        connect(preset, { baseUrl: entry.baseUrl }, "saved");
    }
  }).catch(() => {});
  const remember = (id: string, entry: Saved[string] | undefined) => {
    saved = { ...saved };
    if (entry) saved[id] = entry; else delete saved[id];
    return workspace.setPreferences({ values: { [SAVED_KEY]: JSON.stringify(saved) } }).catch(() => {});
  };
  const versions = new Map<string, number>();
  const checks = new Map<string, Set<AbortController>>();
  const state = (): ProvidersState => {
    const plan = chatGPTPlan?.state();
    const connected: ProviderConnection[] = [...connections.values()].map(({ preset, settings, source }) => ({ id: preset.id, source, baseUrl: settings.baseUrl }));
    if (plan?.accounts.some(account => account.id === plan.activeId && account.status === "connected"))
      connected.push({ id: CHATGPT_PLAN, source: "plan", baseUrl: RESOURCE });
    return {
      presets: PRESETS,
      connected,
      savedBaseUrls: Object.fromEntries(Object.entries(saved).flatMap(([id, entry]) => (entry.baseUrl ? [[id, entry.baseUrl]] : []))),
      ...(plan ? { chatGPTPlan: plan } : {}),
    };
  };
  // Live model lists filtered to the catalog's chat models, or the catalog when
  // the provider doesn't list them. Local servers always show their own.
  const modelIds = (connection: Connection) => {
    connection.models ??= (async () => {
      const live = await connection.adapter.listModels(AbortSignal.timeout(10_000)).catch(() => []);
      if (!live.length) connection.models = undefined;
      if (privateAddress(new URL(connection.settings.baseUrl).hostname)) return live;
      const known = new Set(catalogIds(connection.preset.id));
      const listed = live.filter((id) => known.has(id));
      return listed.length ? listed : live.length ? live : [...known];
    })();
    return connection.models;
  };

  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // Only this machine's own pages may use the keys: the Host check stops DNS
    // rebinding, and writes must come from the same local origin.
    const host = req.headers.host || "";
    const localHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host);
    if (
      !localHost ||
      (!["GET", "HEAD"].includes(req.method) &&
        req.headers.origin !== `http://${host}`)
    ) {
      next(
        new ApiError(
          403,
          "origin_rejected",
          "Open Canvas from its local address to make this request.",
        ),
      );
      return;
    }
    next();
  });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  // Requests up to 48 MiB; images make up most of it.
  app.use("/api", (req, res, next) => req.path.startsWith("/workspace/attachments/") ? next() : express.json({ limit: MAX_REQUEST_BYTES })(req, res, next));
  app.use(["/api/providers", "/api/models", "/api/chat"], (_req, _res, next) => void restored.then(() => next()));

  app.get("/api/providers", (_req, res) => res.json(state()));
  app.get("/api/models", async (_req, res) => {
    const [lists, plan] = await Promise.all([
      Promise.all([...connections.values()].map(async connection =>
        (await modelIds(connection)).map(id => modelInfo(connection.preset, id)).sort((a, b) => a.label.localeCompare(b.label)),
      )),
      chatGPTPlan?.models(AbortSignal.timeout(15_000))
        .then(models => ({ models, planIssue: undefined }), error => ({ models: [], planIssue: planIssue(error) })),
    ]);
    res.json({ models: [...lists.flat(), ...(plan?.models ?? [])], planIssue: plan?.planIssue });
  });
  if (chatGPTPlan) {
    const planPath = `/api/providers/${CHATGPT_PLAN}`;
    const id = (value: unknown) => {
      if (!validId(value)) throw new ApiError(400, "invalid_profile", "Choose a saved ChatGPT account.");
      return value;
    };
    app.get(planPath, (_req, res) => res.json(chatGPTPlan.state()));
    app.post(`${planPath}/sign-in`, async (req, res) => {
      const profileId = req.body?.profileId === undefined ? undefined : id(req.body.profileId);
      const launchUrl = await chatGPTPlan.start(profileId, Boolean(profileId && req.body?.reconsent === true));
      res.json({ launchUrl });
    });
    app.post(`${planPath}/cancel`, (_req, res) => {
      chatGPTPlan.cancel();
      res.json(state());
    });
    app.post(`${planPath}/select`, async (req, res) => {
      await chatGPTPlan.select(id(req.body?.profileId));
      res.json(state());
    });
    app.post(`${planPath}/welcome`, (req, res) => {
      chatGPTPlan.welcome(id(req.body?.profileId));
      res.json(state());
    });
    app.delete(planPath, async (req, res) => {
      const profileId = id(req.body?.profileId);
      const disconnect = chatGPTPlan.disconnect(profileId);
      for (const request of active.values()) {
        if (request.provider === CHATGPT_PLAN && request.profileId === profileId) request.controller.abort(revoked());
      }
      await disconnect;
      res.json(state());
    });
  }
  app.post("/api/providers/:id", async (req, res, next) => {
    const preset = presetById(req.params.id);
    if (!preset) return next(new ApiError(404, "unknown_provider", "Choose a supported provider."));
    const key = typeof req.body?.key === "string" && req.body.key.trim() ? req.body.key.trim() : undefined;
    if (key ? !/^[\x21-\x7e]{8,512}$/.test(key) : !preset.keyless || req.body?.key !== undefined && typeof req.body.key !== "string")
      return next(new ApiError(400, "invalid_key", `Enter a valid ${preset.name} API key.`));
    let baseUrl: string;
    try { baseUrl = checkBaseUrl(preset, req.body?.baseUrl); } catch (error) { return next(error); }
    const version = (versions.get(preset.id) ?? 0) + 1;
    versions.set(preset.id, version);
    const controller = new AbortController();
    const pending = checks.get(preset.id) ?? new Set();
    checks.set(preset.id, pending.add(controller));
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 15_000));
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", disconnected);
    try {
      const settings = { key, baseUrl };
      await adapter(preset, settings).validate(controller.signal);
      if (versions.get(preset.id) !== version || controller.signal.aborted) throw new Error("aborted");
      connect(preset, settings, "session");
      const keyless = !key && preset.keyless;
      await remember(preset.id, baseUrl !== preset.baseUrl || keyless ? { baseUrl, ...(keyless ? { keyless } : {}) } : undefined);
      res.json(state());
    } catch (error) {
      next(
        versions.get(preset.id) !== version
          ? new ApiError(409, "connection_changed", "The connection changed. Enter your key again if needed.")
          : controller.signal.aborted
            ? new ApiError(504, "timeout", "The key check timed out. Try again.")
            : error,
      );
    } finally {
      clearTimeout(timer);
      pending.delete(controller);
      res.off("close", disconnected);
    }
  });
  app.delete("/api/providers/:id", async (req, res, next) => {
    const preset = presetById(req.params.id);
    if (!preset) return next(new ApiError(404, "unknown_provider", "Choose a supported provider."));
    versions.set(preset.id, (versions.get(preset.id) ?? 0) + 1);
    connections.delete(preset.id);
    for (const controller of checks.get(preset.id) ?? []) controller.abort();
    for (const { controller, provider } of active.values()) if (provider === preset.id) controller.abort();
    // A disconnected local server no longer reconnects at startup; its address stays for next time.
    if (saved[preset.id]?.keyless) await remember(preset.id, { baseUrl: saved[preset.id].baseUrl });
    res.json(state());
  });

  // All workspace operations share the localhost Host/Origin guard above.
  const storage = (work: () => Promise<unknown>, res: express.Response, next: express.NextFunction) => {
    void work().then((value) => res.json(value ?? { ok: true })).catch(() => next(new ApiError(500, "storage_error", "Could not read or save local Canvas files. Check available disk space and folder permissions, then retry.")));
  };
  app.get("/api/workspace", (_req, res, next) => storage(() => workspace.load(), res, next));
  app.put("/api/workspace/canvases/:id", (req, res, next) => {
    if (!validCanvas(req.body) || req.params.id !== req.body.id) return next(new ApiError(400, "invalid_canvas", "Invalid canvas snapshot."));
    storage(() => workspace.save(req.body), res, next);
  });
  app.put("/api/workspace/preferences", (req, res, next) => {
    const { activeId, values, importOnly } = req.body || {};
    if ((activeId !== undefined && !validId(activeId)) || (values !== undefined && (!values || typeof values !== "object" || Object.entries(values).some(([k, v]) => !["canvas.sidebar", "canvas.model"].includes(k) || typeof v !== "string" || v.length > 300)))) return next(new ApiError(400, "invalid_preferences", "Invalid workspace preferences."));
    storage(() => workspace.setPreferences({ activeId, values }, importOnly === true), res, next);
  });
  app.post("/api/workspace/import", (req, res, next) => {
    if (!validCanvas(req.body?.canvas)) return next(new ApiError(400, "invalid_import", "Invalid browser canvas."));
    storage(async () => ({ id: await workspace.importCanvas(req.body.canvas, req.body.assets) }), res, next);
  });
  app.put("/api/workspace/attachments/:id", (req, res, next) => {
    if (!validId(req.params.id)) return next(new ApiError(400, "invalid_attachment", "Invalid attachment bytes."));
    storage(async () => ({ id: await workspace.putAttachmentStream(req.params.id as string, req, req.get("Content-Type") || "application/octet-stream", req.query.import === "true") }), res, next);
  });
  app.get("/api/workspace/attachments/:id", (req, res, next) => {
    if (!validId(req.params.id)) return next(new ApiError(400, "invalid_attachment", "Invalid attachment identifier."));
    void workspace.attachmentInfo(req.params.id as string).then((asset) => {
      if (!asset) { res.sendStatus(404); return; }
      res.setHeader("Content-Type", asset.mime);
      res.setHeader("Content-Length", asset.size);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "attachment");
      if (req.method === "HEAD") { res.end(); return; }
      createReadStream(asset.path).on("error", next).pipe(res);
    }).catch(() => next(new ApiError(500, "storage_error", "Could not read the local attachment.")));
  });

  app.delete("/api/workspace/attachments/:id", (req, res, next) => {
    if (!validId(req.params.id)) return next(new ApiError(400, "invalid_attachment", "Invalid attachment identifier."));
    storage(() => workspace.deleteAttachment(req.params.id as string), res, next);
  });

  app.post("/api/chat", async (req, res, next) => {
    const {
      canvasId,
      requestId,
      messages,
      provider: providerId = LEGACY_PROVIDER,
      model = LEGACY_MODEL,
      profileId,
    } = req.body || {};
    const validId = (id: unknown) =>
      typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
    if (
      !validId(canvasId) ||
      !validId(requestId) ||
      typeof model !== "string" ||
      !MODEL_ID.test(model) ||
      !Array.isArray(messages) ||
      !messages.length ||
      !messages.every(validMessage) ||
      messages.at(-1).role !== "user"
    ) {
      next(
        new ApiError(
          400,
          "invalid_request",
          "The conversation request is invalid.",
        ),
      );
      return;
    }
    const plan = providerId === CHATGPT_PLAN ? chatGPTPlan : undefined;
    const preset = presetById(providerId);
    if (providerId === CHATGPT_PLAN && (!plan || !validId(profileId))) return next(revoked());
    if (!preset && !plan) return next(new ApiError(400, "unknown_provider", "Choose a supported provider."));
    const connection = preset && connections.get(preset.id);
    if (preset && !connection) {
      return next(new ApiError(401, "not_connected", `Connect ${preset.name} first, then retry. Your prompt is saved.`));
    }
    // Capture the exact key or plan account for this answer.
    const provider: Pick<ProviderAdapter, "generate" | "upload"> = plan
      ? { generate: (model, messages, signal) => plan.generate(profileId, model, messages, signal) }
      : connection!.adapter;
    if (active.has(canvasId)) {
      next(
        new ApiError(
          409,
          "generation_active",
          "An answer is already being written on this canvas.",
        ),
      );
      return;
    }
    const controller = new AbortController();
    active.set(canvasId, { controller, provider: providerId, profileId: plan ? profileId : undefined });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", disconnected);
    try {
      const info = plan ? await plan.model(profileId, model, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])) : modelInfo(preset!, model);
      if (!info.vision && messages.some((m: ChatMessage) => m.images || m.attachmentIds))
        throw new ApiError(400, "image_unsupported", `${info.label} can’t read images. Choose a model that sees images.`);
      const sizes: number[] = [];
      for (const m of messages as ChatMessage[]) {
        for (const id of m.attachmentIds ?? []) {
          const info = await workspace.attachmentInfo(id);
          if (!info || !/^image\/(png|jpeg|gif|webp)$/.test(info.mime)) throw new ApiError(400, "missing_attachment", "An image is missing or unreadable in local storage. Attach it again.");
          sizes.push(info.size);
        }
        for (const url of m.images ?? []) sizes.push(Buffer.from(url.split(",")[1], "base64").length);
      }
      try { checkImageBudget(sizes); } catch (error) { throw new ApiError(413, "attachment_limit", (error as Error).message); }
      const total = sizes.reduce((a, b) => a + b, 0);
      if (!messages.some((m: ChatMessage) => m.attachmentIds) && total > 64*1024*1024) throw new ApiError(413, "attachment_limit", "Inline images exceed 64 MiB.");
      // Without a Files API, images travel inside the request as base64.
      if (!provider.upload && total * 4 / 3 > MAX_REQUEST_BYTES - 1024 * 1024)
        throw new ApiError(413, "attachment_limit", `${info.providerName} receives images inside each request, which leaves room for about 35 MiB of images. Branch from an earlier message or attach fewer pages.`);
      const resolved: ChatMessage[] = [];
      for (const { role, content, images, attachmentIds } of messages as ChatMessage[]) {
        const fileIds: string[] = [];
        const inline = [...(images ?? [])];
        for (const id of attachmentIds ?? []) {
          const asset = await workspace.getAttachment(id);
          if (!asset) throw new ApiError(400, "missing_attachment", "An image is missing from local storage.");
          if (provider.upload) fileIds.push(await provider.upload(asset.bytes, asset.mime, controller.signal));
          else inline.push(`data:${asset.mime};base64,${Buffer.from(asset.bytes).toString("base64")}`);
        }
        resolved.push({ role, content, ...(inline.length ? { images: inline } : {}), ...(fileIds.length ? { fileIds } : {}) });
      }
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const result = await provider.generate(model, resolved, controller.signal);
      if (controller.signal.aborted) throw new Error("aborted");
      res.json(result);
    } catch (error) {
      next(
        controller.signal.aborted
          ? controller.signal.reason instanceof ApiError ? controller.signal.reason : new ApiError(
              504,
              "timeout",
              "This request was interrupted or timed out. Your prompt is saved; you can retry.",
            )
          : error,
      );
    } finally {
      clearTimeout(timer);
      active.delete(canvasId);
      res.off("close", disconnected);
    }
  });

  app.use("/api", (_req, res) =>
    res
      .status(404)
      .json({
        error: { code: "not_found", message: "API endpoint not found." },
      }),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof ApiError) {
        res
          .status(error.status)
          .json({ error: { code: error.code, message: error.message } });
        return;
      }
      const status = (error as { status?: number })?.status;
      const code =
        status === 413
          ? "request_too_large"
          : status === 400
            ? "invalid_request"
            : "network_error";
      const message =
        status === 413
          ? "This conversation is too large to send. Branch from an earlier message or start a new canvas."
          : status === 400
            ? "The request could not be read."
            : "Could not reach the provider or read its response. Your prompt is saved; you can retry.";
      res
        .status(status === 400 || status === 413 ? status : 502)
        .json({ error: { code, message } });
    },
  );
  return app;
}

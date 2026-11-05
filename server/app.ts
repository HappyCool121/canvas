import { createReadStream } from "node:fs";
import { checkImageBudget, MAX_IMAGES, MAX_REQUEST_BYTES } from "../shared/attachments";
import express from "express";
import { createWorkspace, validId, validCanvas } from "./workspace";
import type { ChatMessage, ProviderAdapter, ProviderStatus } from "../shared/types";
import { ApiError, deepseek } from "./provider";
import { DEFAULT_MODEL } from "../shared/models";

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

type Options = {
  provider?: ProviderAdapter;
  // Optional DeepSeek key from .env. Never sent to the browser.
  apiKey?: string;
  timeoutMs?: number;
  dataDir?: string;
};
export function createApp({
  provider = deepseek(),
  apiKey: initialKey,
  timeoutMs = 120_000,
  dataDir,
}: Options = {}) {
  const app = express();
  app.disable("x-powered-by");
  const workspace = createWorkspace(dataDir);
  const active = new Map<string, AbortController>();
  // The key lives only in this process's memory: a key entered in the app lasts
  // until Disconnect or a restart. It is never returned, stored or logged.
  let apiKey = initialKey;
  let source: ProviderStatus["source"] = initialKey ? "env" : null;
  let connectionVersion = 0;
  const connectionControllers = new Set<AbortController>();
  const status = (): ProviderStatus => ({ connected: Boolean(apiKey), source: apiKey ? source : null });

  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // Only this machine's own pages may use the key: the Host check stops DNS
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
  app.get("/api/models", (_req, res) => res.json({ models: provider.models }));
  // DeepSeek accepts request bodies up to 48 MiB; images make up most of it.
  app.use("/api", (req, res, next) => req.path.startsWith("/workspace/attachments/") ? next() : express.json({ limit: MAX_REQUEST_BYTES })(req, res, next));

  app.get("/api/provider", (_req, res) => res.json(status()));
  app.post("/api/provider", async (req, res, next) => {
    const key = req.body?.key;
    if (typeof key !== "string" || !/^[\x21-\x7e]{8,512}$/.test(key)) {
      next(new ApiError(400, "invalid_key", "Enter a valid DeepSeek API key."));
      return;
    }
    if (!provider.validateKey) {
      next(new ApiError(501, "validation_unavailable", "This provider cannot check keys."));
      return;
    }
    const version = ++connectionVersion;
    const controller = new AbortController();
    connectionControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 15_000));
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", disconnected);
    try {
      const { available } = await provider.validateKey(key, controller.signal);
      if (version !== connectionVersion || controller.signal.aborted) throw new Error("aborted");
      if (!available)
        throw new ApiError(402, "insufficient_balance", "This DeepSeek key works, but its account needs more balance. Add funds, then connect again.");
      apiKey = key;
      source = "session";
      res.json(status());
    } catch (error) {
      next(
        version !== connectionVersion
          ? new ApiError(409, "connection_changed", "The connection changed. Enter your key again if needed.")
          : controller.signal.aborted
            ? new ApiError(504, "timeout", "The key check timed out. Try again.")
            : error,
      );
    } finally {
      clearTimeout(timer);
      connectionControllers.delete(controller);
      res.off("close", disconnected);
    }
  });
  app.delete("/api/provider", (_req, res) => {
    ++connectionVersion;
    apiKey = undefined;
    source = null;
    for (const controller of connectionControllers) controller.abort();
    for (const controller of active.values()) controller.abort();
    res.json(status());
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
    if ((activeId !== undefined && !validId(activeId)) || (values !== undefined && (!values || typeof values !== "object" || Object.entries(values).some(([k, v]) => !["canvas.sidebar", "canvas.model"].includes(k) || typeof v !== "string" || v.length > 100)))) return next(new ApiError(400, "invalid_preferences", "Invalid workspace preferences."));
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
      model = DEFAULT_MODEL,
    } = req.body || {};
    const validId = (id: unknown) =>
      typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
    if (
      !validId(canvasId) ||
      !validId(requestId) ||
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
    const info = provider.models.find((m) => m.id === model);
    if (!info) {
      next(new ApiError(400, "unknown_model", "Choose a supported model."));
      return;
    }
    if (!info.vision && messages.some((m: ChatMessage) => (m.images || m.attachmentIds))) {
      next(
        new ApiError(
          400,
          "image_unsupported",
          `${info.label} can’t read images. Use DeepSeek Flash for image prompts.`,
        ),
      );
      return;
    }
    if (!apiKey) {
      next(
        new ApiError(
          401,
          "not_connected",
          "Connect your DeepSeek key first, then retry. Your prompt is saved.",
        ),
      );
      return;
    }
    // A key replaced mid-request must not change the key this answer uses.
    const key = apiKey;
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
    active.set(canvasId, controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", disconnected);
    try {
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
      if (!messages.some((m: ChatMessage) => m.attachmentIds) && sizes.reduce((a,b) => a+b,0) > 64*1024*1024) throw new ApiError(413, "attachment_limit", "Inline images exceed 64 MiB.");
      const resolved: ChatMessage[] = [];
      for (const { role, content, images, attachmentIds } of messages as ChatMessage[]) {
        const fileIds: string[] = [];
        for (const id of attachmentIds ?? []) {
          if (!provider.upload) throw new ApiError(400, "image_unsupported", "This provider cannot upload images.");
          const asset = await workspace.getAttachment(id);
          if (!asset) throw new ApiError(400, "missing_attachment", "An image is missing from local storage.");
          fileIds.push(await provider.upload(key, asset.bytes, asset.mime, controller.signal));
        }
        resolved.push({ role, content, ...(images ? { images } : {}), ...(fileIds.length ? { fileIds } : {}) });
      }
      timer = setTimeout(() => controller.abort(), timeoutMs);
      const result = await provider.generate(key, info.id, resolved, controller.signal);
      if (controller.signal.aborted) throw new Error("aborted");
      res.json(result);
    } catch (error) {
      next(
        controller.signal.aborted
          ? new ApiError(
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
            : "Could not reach DeepSeek or read its response. Your prompt is saved; you can retry.";
      res
        .status(status === 400 || status === 413 ? status : 502)
        .json({ error: { code, message } });
    },
  );
  return app;
}

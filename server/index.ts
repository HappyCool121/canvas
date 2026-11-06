import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import { createChatGPTPlan } from "./chatgpt-plan";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { presetById } from "../shared/providers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { port, connections } = loadConfig();
const chatGPTPlan = createChatGPTPlan();
const app = createApp({ connections, chatGPTPlan });
const server = createServer(app);
if (process.argv.includes("--production")) {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
// Answers aren't streamed, and reasoning models can take minutes.
server.requestTimeout = 315_000;
server.listen(port, "127.0.0.1", () =>
  console.log(
    `Canvas is ready at http://127.0.0.1:${port}` +
      (connections.length
        ? `, connected to ${connections.map((c) => presetById(c.id)!.name).join(", ")} from the environment.`
        : ". Open it and connect a provider."),
  ),
);
server.once("close", () => { void chatGPTPlan.close(); });
server.on("error", (error) => {
  console.error(
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `Port ${port} is in use. Try PORT=${port + 1} npm run dev.`
      : "Canvas could not start its local server.",
  );
  process.exitCode = 1;
});

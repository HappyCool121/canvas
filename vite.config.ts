import { cp } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "pdfjs-assets",
      async writeBundle({ dir }) {
        await Promise.all(["cmaps", "iccs", "standard_fonts", "wasm"].map((folder) =>
          cp(resolve("node_modules/pdfjs-dist", folder), resolve(dir!, "pdfjs", folder), { recursive: true }),
        ));
      },
    },
  ],
  server: { host: "127.0.0.1" },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id))
            return "react-vendor";
        },
      },
    },
  },
});

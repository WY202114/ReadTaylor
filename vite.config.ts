import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

// Keep the installed PDF.js fonts/CMaps local in both file:// Electron and the web build.
function pdfAssets(): Plugin {
  let output = "";
  const source = resolve("node_modules/pdfjs-dist");
  return {
    name: "readtaylor-pdf-assets",
    configResolved(config) { output = resolve(config.root, config.build.outDir, "pdfjs"); },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const match = req.url?.match(/^\/pdfjs\/(cmaps|standard_fonts|images)\/([A-Za-z0-9_.-]+)$/);
        if (!match) return next();
        try {
          res.setHeader("Content-Type", "application/octet-stream");
          res.end(readFileSync(resolve(source, match[1] === "images" ? "web/images" : match[1], match[2])));
        } catch { res.statusCode = 404; res.end(); }
      });
    },
    closeBundle() {
      for (const folder of ["cmaps", "standard_fonts", "images"]) cpSync(resolve(source, folder === "images" ? "web/images" : folder), resolve(output, folder), { recursive: true });
      cpSync(resolve(source, "LICENSE"), resolve(output, "LICENSE"));
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), pdfAssets()],
});

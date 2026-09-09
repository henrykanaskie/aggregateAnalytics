import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on 8017 (dashboard/config.py); the dev server proxies /api to it.
export default defineConfig({
  plugins: [react()],
  // Scopes the browser's response cache (src/lib/cache.ts) to this build, so a
  // deploy that changes a response shape starts from a clean cache.
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8017", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
});

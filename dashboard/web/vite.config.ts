import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on 8017 (dashboard/config.py); the dev server proxies /api to
// it. /password too: that page is the API's, and without the proxy a signed-out
// dev session lands on the SPA's copy of the route, which has no password box
// and only bounces itself back to /password on the next 401.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8017", changeOrigin: true },
      "/password": { target: "http://127.0.0.1:8017", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1200 },
});

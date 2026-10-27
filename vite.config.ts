import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  server: {
    port: 5173,
    // Logins are only accepted from APP_ORIGIN (localhost:5173): fail loudly instead of moving to 5174.
    strictPort: true,
    open: false,
    // Dev: the browser talks to Vite only; /api is forwarded to the Express server,
    // so cookies stay same-origin exactly as in production.
    proxy: { "/api": { target: "http://127.0.0.1:4000", changeOrigin: false } },
  },
  build: { outDir: "dist", assetsDir: "assets" },
});

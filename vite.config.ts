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
    // Dev only: Vite serves files from the project folder — never the server's code, config, data or secrets.
    fs: {
      deny: [".env", ".env.*", "*.{crt,pem,key,sql}", "**/server/**", "**/scripts/**", "**/reference-materials/**", "**/docs/**", "package*.json", "tsconfig*.json", "*.md"],
    },
  },
  // older phone browsers too (Android Chrome 64+, iOS Safari 12+): newer syntax is rewritten at build time
  build: { outDir: "dist", assetsDir: "assets", target: ["es2017", "chrome64", "safari12", "firefox68", "edge79"] },
});

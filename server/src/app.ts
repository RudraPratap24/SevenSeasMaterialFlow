import cookieParser from "cookie-parser";
import { readFileSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { authRouter } from "./authRoutes";
import { config, isProd } from "./config";
import { adminRouter } from "./admin/routes";
import { callRouter, pageHandler, shimHandler } from "./gas/bridge";
import { MODULES } from "./modules";
import { loadSession } from "./sessions";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard for every state-changing request. Three independent layers:
 * the session cookie is SameSite=Strict; the request must carry a custom header
 * that a cross-site form or image tag cannot add (and CORS is never enabled, so
 * a cross-site script cannot add it either); and Origin/Referer, when the
 * browser sends them, must be our own origin.
 */
function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE.has(req.method)) return next();
  if (req.get("x-flow-request") !== "1") {
    res.status(403).json({ error: "Request blocked." });
    return;
  }
  let origin = req.get("origin") ?? null;
  if (!origin && req.get("referer")) {
    try {
      origin = new URL(req.get("referer")!).origin;
    } catch {
      origin = "invalid";
    }
  }
  if (origin && origin !== config.APP_ORIGIN) {
    res.status(403).json({ error: "Request blocked." });
    return;
  }
  next();
}

function requestLog(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  // Captured now: inside a mounted router req.path is rewritten.
  const urlPath = req.originalUrl.split("?")[0];
  res.on("finish", () => {
    if (!urlPath.startsWith("/api")) return;
    // Paths and status only — request bodies (passwords, customer data) are never logged.
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path: urlPath,
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - start) / 1_000_000n),
        user: req.user?.username,
        ip: req.ip,
      }),
    );
  });
  next();
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          // item photos on the admin page are shown from Google Drive (the old photos live there)
          "img-src": ["'self'", "data:", "https://drive.google.com", "https://*.googleusercontent.com"],
          "connect-src": ["'self'"],
          "font-src": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "upgrade-insecure-requests": isProd ? [] : null,
        },
      },
      strictTransportSecurity: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "same-origin" },
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use((_req, res, next) => {
    // module pages may take photos on this site; no other site may use the camera
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=()");
    next();
  });

  app.use(requestLog);

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); // register data never sits in a shared or browser cache
    next();
  });
  api.use(
    rateLimit({
      windowMs: 60 * 1000,
      limit: 600,
      standardHeaders: "draft-7",
      legacyHeaders: false,
      message: { error: "Too many requests — slow down a little." },
    }),
  );
  const json = express.json({ limit: "200kb", strict: true, type: "application/json" });
  // module calls parse their own bodies (a module may allow photo uploads)
  const callPath = new RegExp(`^/(${MODULES.map((m) => m.id).join("|")})/call/`);
  api.use((req, res, next) => (callPath.test(req.path) ? next() : json(req, res, next)));
  api.use(cookieParser());
  api.use(csrfGuard);
  api.use(loadSession);

  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  api.use("/auth", authRouter);
  api.use("/admin", adminRouter);
  for (const m of MODULES) api.use("/" + m.id, callRouter(m));
  api.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use("/api", api);
  app.get("/gas/shim.js", shimHandler);
  // the admin page (masters and users): a plain page under the main strict security policy
  const adminFile = (f: string) => readFileSync(path.resolve(process.cwd(), "server/src/admin", f), "utf8");
  app.get("/admin", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(adminFile("page.html"));
  });
  app.get("/admin/admin.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("application/javascript").send(adminFile("admin.js"));
  });
  for (const m of MODULES) app.get("/" + m.id, pageHandler(m));
  // the front door: a link to each module
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const home = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Seven Seas</title>
<body style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px"><h1>Seven Seas</h1><ul>${MODULES.map((m) => `<li><a href="/${m.id}">${esc(m.title)}</a></li>`).join("")}<li><a href="/admin">Admin (users, items, vendors)</a></li></ul></body>`;
  app.get(["/", "/index.html"], (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(home);
  });
  app.use((_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  // Last resort: log the details, tell the client nothing about internals.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: status === 413 ? "Request too large." : "Bad request." });
      return;
    }
    console.error(
      JSON.stringify({ level: "error", path: req.path, user: req.user?.username, err: err instanceof Error ? err.stack : String(err) }),
    );
    res.status(500).json({ error: "Something went wrong on the server. Please try again." });
  });

  return app;
}

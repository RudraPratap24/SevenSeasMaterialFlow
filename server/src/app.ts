import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { existsSync } from "node:fs";
import path from "node:path";
import { authRouter } from "./authRoutes";
import { config, isProd } from "./config";
import { customerRouter } from "./customerRoutes";
import { flowRouter } from "./flowRoutes";
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
          "img-src": ["'self'", "data:"],
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
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
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
  api.use(express.json({ limit: "200kb", strict: true, type: "application/json" }));
  api.use(cookieParser());
  api.use(csrfGuard);
  api.use(loadSession);

  api.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  api.use("/auth", authRouter);
  api.use("/customers", customerRouter);
  api.use("/", flowRouter);
  api.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  app.use("/api", api);

  // Production: the same server hosts the built frontend — one origin, no CORS needed.
  const dist = path.resolve(process.cwd(), "dist");
  if (existsSync(path.join(dist, "index.html"))) {
    app.use(
      express.static(dist, {
        index: false,
        setHeaders(res, file) {
          res.setHeader(
            "Cache-Control",
            file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
          );
        },
      }),
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(dist, "index.html"));
    });
  }

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

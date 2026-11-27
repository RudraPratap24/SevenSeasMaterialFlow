/**
 * The Apps Script bridge: a module's client page is served exactly as the client wrote it, and its
 * google.script.run calls reach the module's functions.
 *   GET  /<id>                   the page: <?= name ?> filled in, declared patches applied, shim.js loaded first
 *   POST /api/<id>/call/:fn      {args:[…]} → {result} | {error}
 *   GET  /gas/shim.js            google.script.* for the browser
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import express, { Router, type Request, type Response } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { ModuleDef } from "../module";

const fromRoot = (p: string) => path.resolve(process.cwd(), p);

/** POST /call/:fn for one module (mounted at /api/<id>) plus the module's own routes */
export function callRouter(m: ModuleDef): Router {
  const r = Router();
  // logins: few tries per address and name (the page sends the name as the first argument)
  const guessLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "Too many tries. Wait 15 minutes." },
    keyGenerator: (req) => ipKeyGenerator(req.ip ?? "") + "|" + String(req.params.fn) + "|" + String(Array.isArray(req.body?.args) ? req.body.args[0] : "").slice(0, 80),
  });
  const guarded = new Set(m.guarded ?? []);
  r.post(
    "/call/:fn",
    express.json({ limit: m.bodyLimit ?? "1mb", strict: true, type: "application/json" }),
    (req, res, next) => (guarded.has(String(req.params.fn)) ? guessLimiter(req, res, next) : next()),
    async (req: Request, res: Response) => {
      const name = String(req.params.fn);
      const fn = Object.hasOwn(m.functions, name) ? m.functions[name] : undefined;
      if (!fn) {
        res.status(404).json({ error: "Unknown function." });
        return;
      }
      const args = Array.isArray(req.body?.args) ? (req.body.args as never[]) : [];
      try {
        const result = await fn({ req, res, token: typeof args[0] === "string" ? args[0] : "" }, ...args);
        if (!res.headersSent) res.json({ result: result === undefined ? null : result });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // the module's own messages go back as they are (the page shows them); anything unexpected is logged, not shown
        const known = !(e instanceof TypeError || e instanceof RangeError || (e as { code?: string }).code);
        if (!known) console.error(JSON.stringify({ msg: "call failed", module: m.id, fn: name, error: msg }));
        res.status(400).json({ error: known ? msg : "Something went wrong. Please try again." });
      }
    },
  );
  if (m.routes) r.use(m.routes);
  return r;
}

/** the client's page with only what serving it from here needs; throws (at startup) if the page has changed under us */
export function buildPage(m: ModuleDef): (req: Request) => string {
  let html = readFileSync(fromRoot(m.page.file), "utf8");
  for (const p of m.page.patches ?? []) {
    const n = html.split(p.find).length - 1;
    if (n !== 1) throw new Error(`${m.id}: page patch "${p.why}" matches ${n} times (must be 1) — has ${m.page.file} changed?`);
    html = html.replace(p.find, () => p.replace);
  }
  const shim = `<script src="/gas/shim.js" data-module="${m.id}"></script>`;
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => h + shim) : shim + html;
  // Apps Script template scriptlets: only <?= name ?> / <?!= name ?> are supported; anything else must be ported by hand
  const other = html.match(/<\?(?!!?=\s*[A-Za-z_$][\w$]*\s*\?>)[\s\S]{0,60}/);
  if (other) throw new Error(`${m.id}: unsupported Apps Script scriptlet in ${m.page.file}: ${other[0]}`);
  return (req) => {
    const vars = m.page.vars?.(req) ?? {};
    return html.replace(/<\?(!?)=\s*([A-Za-z_$][\w$]*)\s*\?>/g, (_s, raw: string, name: string) => {
      const v = Object.hasOwn(vars, name) ? String(vars[name]) : "";
      // printed values land inside the page's own script/HTML: only plain text may be printed unescaped by context
      if (!raw && !/^[\w .:/@-]*$/.test(v)) throw new Error(`${m.id}: unsafe value for <?= ${name} ?>`);
      return v;
    });
  };
}

/** the page's security policy: the main app's, relaxed as old Apps Script pages need (inline scripts, Google fonts) */
export function pageCsp(m: ModuleDef): string {
  const base: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:"],
    "connect-src": ["'self'"],
    "object-src": ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
  for (const [k, v] of Object.entries(m.page.csp ?? {})) base[k] = [...(base[k] ?? []), ...v];
  return Object.entries(base).map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

export function pageHandler(m: ModuleDef) {
  const render = buildPage(m);
  const csp = pageCsp(m);
  return (req: Request, res: Response) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("Cache-Control", "no-cache");
    res.type("html").send(render(req));
  };
}

let shim: string | null = null;
export function shimHandler(_req: Request, res: Response) {
  shim ??= readFileSync(fromRoot("server/src/gas/shim.js"), "utf8");
  res.setHeader("Cache-Control", "no-cache");
  res.type("application/javascript").send(shim);
}

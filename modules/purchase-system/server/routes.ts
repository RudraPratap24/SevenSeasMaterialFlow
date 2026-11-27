/**
 * Purchase System's own endpoints (the page and its calls go through the core bridge, server/src/gas/bridge.ts).
 *   GET  /api/ps/file/:id               a stored file (photo, PO PDF, signed copy) — the random id is the key
 *   GET  /api/ps/asset/:name            logos
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Router } from "express";
import { pool } from "../../../server/src/db";
import { rows } from "./store";

export const psRoutes = Router();

psRoutes.get("/file/:id", async (req, res) => {
  const id = String(req.params.id);
  if (!/^F[0-9a-f]{18}$/.test(id)) {
    res.status(404).end();
    return;
  }
  const [f] = await rows(pool, "SELECT kind, name, mime, bytes FROM ps_files WHERE id = ?", [id]);
  if (!f) {
    res.status(404).end();
    return;
  }
  // the id is the key (72 random bits), like the old "anyone with the link" Drive files — the page may be on Google's site
  res.setHeader("Content-Type", String(f.mime));
  res.setHeader("Content-Disposition", `inline; filename="${String(f.name).replace(/[^\w .-]/g, "_")}${f.mime === "application/pdf" && !/\.pdf$/i.test(f.name) ? ".pdf" : ""}"`);
  res.setHeader("Cache-Control", f.kind === "photo" ? "public, max-age=3600" : "no-store");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(Buffer.from(f.bytes));
});

const ASSETS: Record<string, string> = { "logo.png": "image/png", "logo-red4.jpg": "image/jpeg", "logo-pdf.jpg": "image/jpeg" };
psRoutes.get("/asset/:name", (req, res) => {
  const name = String(req.params.name);
  if (!ASSETS[name]) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", ASSETS[name]);
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(readFileSync(path.resolve(process.cwd(), "modules/purchase-system/server/assets", name)));
});

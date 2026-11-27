import { createHash } from "node:crypto";
import express, { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import {
  derivePmStock,
  derivePoProgress,
  emptyState,
  FlowError,
  NUMBER_TAKEN,
  planMaterials,
  PRODUCTION_FLOORS,
  PRODUCTION_LINES,
  PRODUCTION_SLOTS,
  PRODUCTION_STAGES,
  todayLabel,
  type OpenBom,
} from "../../src/flow/logic";
import { PERMS, PRICE_ROLES, READ_SCOPES, ROLES, ROLE_PROFILES, roleCan, type Role } from "../../src/flow/perms";
import type { FlowState } from "../../src/flow/types";
import { seedState } from "../seed/demoStory";
import { ACTIONS, applyAction, context, describeIssues, isActionName } from "./actions";
import { audit } from "./audit";
import { config } from "./config";
import { hashPassword, verifyPassword } from "./crypto";
import { passwordProblem } from "./authRoutes";
import { pool, type Conn, type Queryable } from "./db";
import { PLANS, stockSlice } from "./plans";
import {
  allocateNumber,
  changedSince,
  countDocuments,
  getMastersVersion,
  getVersions,
  loadConsistent,
  loadMasters,
  loadState,
  loadSuppliers,
  persistChanges,
  rowVersions,
  saveSnapshot,
  touchDocument,
  type MasterData,
  type Versions,
} from "./repository";
import { scopeStateFor } from "./scope";
import { markPush, pushPoToTally, renumberForTally } from "./tallyPush";
import { requirePasswordCurrent, requireUser } from "./sessions";

export const flowRouter = Router();
flowRouter.use(requireUser, requirePasswordCurrent);

/* ── locking ────────────────────────────────────────────────────────────────── */

/** MySQL lock names are limited to 64 characters: database + hash of the resource. */
const lockName = (key: string) => `${config.DB_NAME.slice(0, 20)}:${createHash("sha1").update(key).digest("hex").slice(0, 32)}`;

/**
 * Runs `fn` in one transaction while holding locks on exactly the given resources
 * (documents, a component's stock, a batch's FG stock). Locks are taken in one
 * fixed (sorted) order, so two actions can never wait on each other in a circle;
 * actions on unrelated documents run side by side. The transaction starts only
 * after the locks are held, so it reads the latest committed data.
 */
export async function withLocks<T>(keys: string[], fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    try {
      for (const name of [...new Set(keys.map(lockName))].sort()) {
        const [r] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 10) AS got", [name]);
        if (Number(r[0]?.got) !== 1) throw new FlowError("Someone else is working on this right now — please try again.");
      }
      await conn.beginTransaction();
      try {
        const out = await fn(conn);
        await conn.commit();
        return out;
      } catch (err) {
        await conn.rollback();
        throw err;
      }
    } finally {
      await conn.query("DO RELEASE_ALL_LOCKS()");
    }
  } finally {
    conn.release();
  }
}

/* ── reads ──────────────────────────────────────────────────────────────────── */

/** The full registers, cached per change number (re-checked on every request). */
let cache: (Versions & { state: FlowState }) | null = null;

async function withConn<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

async function fullState(): Promise<Versions & { state: FlowState }> {
  const v = await getVersions(pool);
  if (cache && cache.version === v.version && cache.resyncVersion === v.resyncVersion) return cache;
  cache = await withConn((conn) => loadConsistent(conn, "all"));
  return cache;
}

/** Masters change only by maintenance (renames, imports); cached per masters version. */
let mastersCache: MasterData | null = null;

async function currentMasters(db: Queryable = pool): Promise<MasterData> {
  const v = await getMastersVersion(db);
  if (!mastersCache || mastersCache.version !== v) mastersCache = await loadMasters(db);
  return mastersCache;
}

flowRouter.get("/version", async (_req, res) => {
  res.json({ ...(await getVersions(pool)), mastersVersion: await getMastersVersion(pool), productionVersion: await productionVersion() });
});

/**
 * Changes whenever a BOM list is made, cancelled or issued, or an indent request is raised, verified or indented —
 * screens then re-read the reservations and the indent requests.
 */
async function productionVersion(): Promise<string> {
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT CONCAT((SELECT COUNT(*) FROM bom_documents), ':', (SELECT COUNT(*) FROM bom_cancellations), ':',
                   (SELECT COUNT(*) FROM bom_issue_slips), ':', (SELECT COUNT(*) FROM indent_requests), ':',
                   (SELECT COALESCE(MAX(verified_at), '') FROM indent_requests), ':',
                   (SELECT COUNT(*) FROM purchase_indents WHERE request_no IS NOT NULL), ':',
                   (SELECT COUNT(*) FROM bom_returns), ':', (SELECT COUNT(*) FROM bom_returns WHERE status = 'APPROVED'), ':',
                   (SELECT COUNT(*) FROM bulk_reports WHERE final_at IS NOT NULL), ':', (SELECT COALESCE(MAX(decided_at), '') FROM bulk_qt), ':',
                   (SELECT COUNT(*) FROM fg_transfer_notes), ':', (SELECT COUNT(*) FROM fg_transfer_receipts)) AS v`,
  );
  return String(r[0]?.v ?? "");
}

/** Per-login brake on full reloads (each is a big read); a screen needs a handful a minute. */
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id ?? "none"}`,
  message: { error: "Too many requests — slow down a little." },
});

/** Everything this role may see — on login, and whenever a full reload is requested. */
flowRouter.get("/state", readLimiter, async (req, res) => {
  const { version, resyncVersion, state } = await fullState();
  res.json({ version, resyncVersion, state: scopeStateFor(req.user!.role, state) });
});

/** Only the documents changed after `since` — what a screen polls for. */
flowRouter.get("/changes", readLimiter, async (req, res) => {
  const since = Number(req.query.since);
  if (!Number.isInteger(since) || since < 0) {
    res.status(400).json({ error: "Invalid version." });
    return;
  }
  // "everything" comes from the cached full state, not a fresh read of every table on each call
  if (since === 0) {
    const { version, resyncVersion, state } = await fullState();
    res.json({ version, resyncVersion, changes: scopeStateFor(req.user!.role, state) });
    return;
  }
  const r = await withConn((conn) => loadConsistent(conn, changedSince(since)));
  res.json({ version: r.version, resyncVersion: r.resyncVersion, changes: scopeStateFor(req.user!.role, r.state) });
});

/** Components and products for every screen; BOM recipes only to roles that raise requisitions. */
flowRouter.get("/masters", async (req, res) => {
  const m = await currentMasters();
  res.json({
    version: m.version,
    components: m.components,
    products: m.products.map(({ name, fg, vendor, boxSize }) => ({ name, fg, vendor, boxSize })),
    bom: PERMS["req.create"].includes(req.user!.role) ? m.bom : null,
  });
});

/** The last Tally sync: when, what it brought, and POs left out (those only for Purchase/Admin). */
flowRouter.get("/tally-status", async (req, res) => {
  const role = req.user!.role;
  if (!READ_SCOPES[role].includes("tallyPos")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const [r] = await pool.query<RowDataPacket[]>("SELECT k, v FROM app_meta WHERE k IN ('tally_status', 'tally_sync_error')");
  const meta = (k: string) => JSON.parse(String(r.find((x) => x.k === k)?.v ?? "null"));
  const status = meta("tally_status");
  const syncError = meta("tally_sync_error");
  if (!PRICE_ROLES.includes(role)) {
    res.json({ status: status ? { syncedAt: status.syncedAt } : null });
    return;
  }
  res.json({ status: status || syncError ? { ...(status ?? { syncedAt: "" }), syncError } : null });
});

/** Vendor names for the gate's supplier dropdown (no rates) — the Tally vendors once Tally is connected. */
flowRouter.get("/vendors", async (req, res) => {
  if (!roleCan(req.user!.role, "gate.create")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  res.json({ vendors: (await loadSuppliers(pool)).filter((s, _, all) => s.fromTally || !all.some((x) => x.fromTally)).map((s) => s.name) });
});

/* ── the gate photo: one JPEG per gate entry, written once, never sent with the state ── */

const PHOTO_MAX = 1024 * 1024;
const photoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id ?? "none"}`,
  message: { error: "Too many photos — slow down a little." },
});

flowRouter.post("/gate-entries/:id/photo", photoLimiter, express.raw({ type: "image/jpeg", limit: PHOTO_MAX }), async (req, res) => {
  if (!roleCan(req.user!.role, "gate.create")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const id = String(req.params.id);
  const bytes = req.body as Buffer;
  if (!/^[A-Z]+-?\d+$/.test(id) || !Buffer.isBuffer(bytes) || bytes.length < 100) {
    res.status(400).json({ error: "Send the photo as a JPEG image." });
    return;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    res.status(400).json({ error: "The photo must be a JPEG image." });
    return;
  }
  try {
    await withLocks([`doc:gateEntries:${id}`], async (conn) => {
      const [[gate]] = await conn.query<RowDataPacket[]>(
        "SELECT created_by, created_at > NOW(3) - INTERVAL 24 HOUR AS recent FROM gate_entries WHERE gate_entry_no = ?",
        [id],
      );
      if (!gate) throw new FlowError(`Gate entry ${id} not found.`);
      // only the gate login that made the entry (or the admin), on the day — not anyone's old entries
      if (req.user!.role !== "admin" && (Number(gate.created_by) !== req.user!.id || Number(gate.recent) !== 1)) {
        throw new FlowError(`Only the login that made ${id} can add its photo, within a day.`);
      }
      const [[had]] = await conn.query<RowDataPacket[]>("SELECT 1 AS ok FROM gate_entry_photos WHERE gate_entry_no = ?", [id]);
      if (had) throw new FlowError(`${id} already has its photo — it cannot be replaced.`);
      await conn.query("INSERT INTO gate_entry_photos (gate_entry_no, mime, bytes, created_by) VALUES (?, 'image/jpeg', ?, ?)", [id, bytes, req.user!.id]);
      await touchDocument(conn, "gateEntries", id);
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    await audit(req, { action: "gate.photo", outcome: "rejected", message: e.message });
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "gate.photo", outcome: "ok", message: `${id}: photo ${Math.round(bytes.length / 1024)} KB` });
  res.json({ ok: true });
});

flowRouter.get("/gate-entries/:id/photo", async (req, res) => {
  if (!READ_SCOPES[req.user!.role].includes("gateEntries")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const [[p]] = await pool.query<RowDataPacket[]>("SELECT mime, bytes FROM gate_entry_photos WHERE gate_entry_no = ?", [String(req.params.id)]);
  if (!p) {
    res.status(404).json({ error: "No photo." });
    return;
  }
  res.setHeader("Cache-Control", "no-store"); // a shared gate PC must not keep it after logout
  res.type(String(p.mime)).send(p.bytes as Buffer);
});

flowRouter.get("/masters/suppliers", async (req, res) => {
  if (!PRICE_ROLES.includes(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  res.json({ suppliers: await loadSuppliers(pool) });
});

/* ── writes ─────────────────────────────────────────────────────────────────── */

const ActionBody = z.strictObject({
  args: z.array(z.unknown()).max(10),
  /** The change number the user's screen was built from. */
  basis: z.number().int().min(0),
});

const LABEL: Record<string, string> = {
  gateEntries: "Gate entry",
  poClosures: "PO status",
  grnLines: "GRN",
  qcIntimations: "QC slip",
  requisitions: "Requisition",
  fgTransfers: "FG transfer",
  dispatchSlips: "Dispatch slip",
  indents: "Indent",
  purchaseOrders: "PO",
};

flowRouter.post("/actions/:name", async (req, res) => {
  const user = req.user!;
  const name = String(req.params.name);

  if (!isActionName(name)) {
    res.status(404).json({ error: "Unknown action." });
    return;
  }
  const def = ACTIONS[name];
  if (!roleCan(user.role, def.perm)) {
    await audit(req, { action: name, outcome: "denied", message: `role ${user.role} lacks ${def.perm}` });
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = ActionBody.safeParse(req.body);
  const parsed = body.success ? def.args.safeParse(body.data.args) : null;
  if (!body.success || !parsed?.success) {
    const message = parsed && !parsed.success ? describeIssues(parsed.error) : "Invalid request.";
    await audit(req, { action: name, outcome: "invalid", message });
    res.status(400).json({ error: message });
    return;
  }
  const basis = body.data.basis;
  if (basis > (await getVersions(pool)).version) {
    res.status(409).json({ error: "Your screen is out of date — it now shows the latest; please try again.", code: "STALE" });
    return;
  }

  try {
    const plan = await PLANS[name](parsed.data, pool);
    await withLocks(
      [...plan.targets.map((t) => `doc:${t.c}:${t.key}`), ...plan.locks],
      async (conn) => {
        // Stale-screen guard: refuse if a document this action changes was changed after the user's screen loaded.
        const versions = await rowVersions(conn, plan.targets);
        plan.targets.forEach((t, i) => {
          if (versions[i] > basis) {
            throw new FlowError(
              `${LABEL[t.c] ?? "This document"} ${t.key} was changed by someone else after your screen loaded. ` +
                "Your screen now shows the latest — please check it and try again.",
            );
          }
        });
        const before = await loadState(conn, plan.slice);
        if (plan.series) before.allocated = { [plan.series]: await allocateNumber(conn, plan.series) };
        const suppliers = def.needsSuppliers ? await loadSuppliers(conn) : [];
        const masters = await currentMasters(conn);
        const after = applyAction(name, parsed.data, context(user, before, suppliers, masters));
        await audit(req, { action: name, outcome: "ok", payload: parsed.data }, conn);
        await persistChanges(conn, before, after, user.id); // last: stamps the change number just before COMMIT
      },
    );
    // Answer with what changed since the user's screen — read after COMMIT, in one consistent snapshot,
    // so it includes everyone's changes up to the version it reports.
    const r = await withConn((conn) => loadConsistent(conn, changedSince(basis)));
    res.json({ version: r.version, resyncVersion: r.resyncVersion, changes: scopeStateFor(user.role, r.state) });
    // An approved PO goes to Tally on its own, after the answer — the approval stands whatever Tally says.
    if (name === "approvePo" && config.TALLY_ALLOW_WRITE) void sendToTally(req, String(parsed.data[0]));
  } catch (err) {
    if (err instanceof FlowError) {
      await audit(req, { action: name, outcome: "rejected", message: err.message, payload: parsed.data });
      res.status(409).json({ error: err.message, code: /changed by someone else/.test(err.message) ? "STALE" : undefined });
      return;
    }
    throw err;
  }
});

/* ── approved PO → Tally ─────────────────────────────────────────────────────── */

/** Creates the PO in Tally and keeps the result on it (when; Tally's reason if it refused). Returns the error, "" = created. */
async function sendToTally(req: Request, poNo: string): Promise<string> {
  let error = "";
  try {
    await withLocks([`tally-push:${poNo}`], (conn) => pushPoToTally(conn, poNo));
  } catch (e) {
    if (e instanceof FlowError) error = e.message;
    else {
      console.error(JSON.stringify({ msg: "tally push failed", poNo, err: String(e) }));
      error = "Could not send it to Tally (server error) — try again, or ask the administrator.";
    }
  }
  try {
    await withLocks([`doc:purchaseOrders:${poNo}`], (conn) => markPush(conn, poNo, error));
    await audit(req, { action: "tally.push", outcome: error ? "rejected" : "ok", message: `${poNo}: ${error || "created in Tally"}` });
  } catch (e) {
    console.error(JSON.stringify({ msg: "tally push result not saved", poNo, err: String(e) }));
  }
  return error;
}

/* ── Users tab (admin): list, live username check, add. Reset/disable/unlock stay on the CLI. ── */

const LOGIN_ID = /^[a-z0-9._-]{3,40}$/;

function mayManageUsers(req: Request, res: express.Response): boolean {
  if (roleCan(req.user!.role, "user.manage")) return true;
  res.status(403).json({ error: "Your login is not allowed to do this." });
  return false;
}

flowRouter.get("/users", async (req, res) => {
  if (!mayManageUsers(req, res)) return;
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT username, role, label, full_name, active, DATE_FORMAT(last_login_at, '%Y-%m-%d %H:%i') AS last_login FROM users ORDER BY id",
  );
  res.json({
    users: rows.map((r) => ({
      username: r.username,
      role: r.role,
      label: r.label,
      name: r.full_name,
      active: Number(r.active) === 1,
      lastLogin: r.last_login ?? "",
    })),
  });
});

flowRouter.get("/users/check", async (req, res) => {
  if (!mayManageUsers(req, res)) return;
  const username = String(req.query.username ?? "").trim().toLowerCase();
  if (!LOGIN_ID.test(username)) {
    res.status(400).json({ error: "Username: 3–40 of a-z 0-9 . _ -" });
    return;
  }
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT 1 FROM users WHERE username = ?", [username]);
  res.json({ taken: rows.length > 0 });
});

flowRouter.post("/users", async (req, res) => {
  if (!mayManageUsers(req, res)) return;
  const body = z
    .strictObject({
      username: z.string().trim().toLowerCase().regex(LOGIN_ID),
      role: z.enum(ROLES as [Role, ...Role[]]),
      label: z.string().trim().min(1).max(80),
      name: z.string().trim().min(1).max(80),
      password: z.string().max(128),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Fill username (3–40 of a-z 0-9 . _ -), role, label, name and password." });
    return;
  }
  const { username, role, label, name, password } = body.data;
  // the admin's starting password meets the same rule as everyone's; the person must replace it at first login
  const weak = passwordProblem(password, username);
  if (weak) {
    res.status(400).json({ error: weak });
    return;
  }
  try {
    await pool.execute(
      "INSERT INTO users (username, password_hash, role, label, full_name, must_change_password) VALUES (?, ?, ?, ?, ?, 1)",
      [username, await hashPassword(password), role, label, name],
    );
  } catch (e) {
    // the unique key decides when two admins pick the same name at once
    if ((e as { code?: string }).code === "ER_DUP_ENTRY") {
      res.status(409).json({ error: `Username ${username} is taken.` });
      return;
    }
    throw e;
  }
  await audit(req, { action: "user.create", outcome: "ok", message: `${username} (${role}) — ${name}` });
  res.json({ username });
});

/** Admin gives an existing login another role (and label); the person is signed out so every screen reloads with it. */
flowRouter.post("/users/:username/role", async (req, res) => {
  if (!mayManageUsers(req, res)) return;
  const body = z
    .strictObject({ role: z.enum(ROLES as [Role, ...Role[]]), label: z.string().trim().min(1).max(80) })
    .safeParse(req.body);
  const username = String(req.params.username).toLowerCase();
  if (!body.success || !LOGIN_ID.test(username)) {
    res.status(400).json({ error: "Choose a role and a label." });
    return;
  }
  // the admin cannot take away their own access
  if (username === req.user!.username.toLowerCase()) {
    res.status(409).json({ error: "You cannot change your own role." });
    return;
  }
  const [[was]] = await pool.execute<RowDataPacket[]>("SELECT role FROM users WHERE username = ?", [username]);
  if (!was) {
    res.status(404).json({ error: `No user ${username}.` });
    return;
  }
  await pool.execute("UPDATE users SET role = ?, label = ? WHERE username = ?", [body.data.role, body.data.label, username]);
  await pool.execute("DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?", [username]);
  await audit(req, { action: "user.role", outcome: "ok", message: `${username}: ${was.role} → ${body.data.role} (${body.data.label})` });
  res.json({ ok: true });
});

flowRouter.post("/users/:username/active", async (req, res) => {
  if (!mayManageUsers(req, res)) return;
  const body = z.strictObject({ active: z.boolean() }).safeParse(req.body);
  const username = String(req.params.username).toLowerCase();
  if (!body.success || !LOGIN_ID.test(username)) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  // the admin cannot lock themselves out
  if (username === req.user!.username.toLowerCase()) {
    res.status(409).json({ error: "You cannot disable your own login." });
    return;
  }
  const [r] = await pool.execute<ResultSetHeader>("UPDATE users SET active = ? WHERE username = ?", [body.data.active ? 1 : 0, username]);
  if (r.affectedRows === 0) {
    res.status(404).json({ error: `No user ${username}.` });
    return;
  }
  // a disabled login is signed out everywhere at once
  if (!body.data.active) await pool.execute("DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?", [username]);
  await audit(req, { action: body.data.active ? "user.enable" : "user.disable", outcome: "ok", message: username });
  res.json({ ok: true });
});

/** "Retry": send an approved PO to Tally again (after Tally was closed, or a vendor/item was fixed there). */
flowRouter.post("/tally/push", async (req, res) => {
  if (!roleCan(req.user!.role, "purchase.tally")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = z.strictObject({ poNo: z.string().trim().min(1).max(40) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  const error = await sendToTally(req, body.data.poNo);
  res.status(error ? 409 : 200).json(error ? { error } : { ok: true });
});

/**
 * "New number & send": Tally refused the PO because another PO there already has its number. The PO takes the next
 * number Tally does not have (everywhere: lines, indents, every screen) and is sent under it.
 */
flowRouter.post("/tally/renumber", async (req, res) => {
  if (!roleCan(req.user!.role, "purchase.tally")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = z.strictObject({ poNo: z.string().trim().min(1).max(40) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid request." });
    return;
  }
  let poNo = body.data.poNo;
  let error = "";
  try {
    // a number typed in Tally in the very same seconds is refused at sending — then the next one
    for (let attempt = 0; attempt < 3; attempt++) {
      const was = poNo;
      poNo = await withLocks([`doc:purchaseOrders:${was}`], (conn) => renumberForTally(conn, was));
      await audit(req, { action: "tally.renumber", outcome: "ok", message: `${was} is now ${poNo}: Tally already had ${was}` });
      error = await sendToTally(req, poNo);
      if (!error.startsWith(NUMBER_TAKEN)) break;
    }
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    error = e.message;
  }
  res.status(error ? 409 : 200).json(error ? { error, poNo } : { ok: true, poNo });
});

/* ── production plans: one per day, re-saved whole ───────────────────────────── */

/** "yyyy-mm-dd" that is a real calendar date, or null. */
function planDate(v: unknown): string | null {
  const d = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d ? d : null;
}

const PlanBody = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        productName: z.string().trim().min(1).max(160),
        productType: z.string().trim().max(40),
        targetQty: z.number().int().min(1).max(10_000_000),
      }),
    )
    .min(1)
    .max(200),
});

flowRouter.get("/production-plans/:date", async (req, res) => {
  if (!ROLE_PROFILES[req.user!.role].tabs.includes("production")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const date = planDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT p.name, l.product_type, l.target_qty, u.username, pp.updated_at
       FROM production_plans pp
       JOIN production_plan_lines l ON l.plan_date = pp.plan_date
       JOIN products p ON p.id = l.product_id
       LEFT JOIN users u ON u.id = pp.updated_by
      WHERE pp.plan_date = ? ORDER BY l.line_no`,
    [date],
  );
  res.json({
    plan: r.length
      ? {
          savedBy: String(r[0].username ?? ""),
          savedAt: new Date(r[0].updated_at).toISOString(),
          lines: r.map((x) => ({ productName: String(x.name), productType: String(x.product_type), targetQty: Number(x.target_qty) })),
        }
      : null,
  });
});

flowRouter.post("/production-plans/:date", async (req, res) => {
  if (!roleCan(req.user!.role, "production.plan")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const date = planDate(req.params.date);
  const body = PlanBody.safeParse(req.body);
  if (!date || !body.success) {
    res.status(400).json({ error: "Invalid plan: each row needs a product and a whole-number qty above zero." });
    return;
  }
  const masters = await currentMasters();
  const unknown = body.data.lines.find((l) => !masters.productByName.has(l.productName));
  if (unknown) {
    res.status(400).json({ error: `Product "${unknown.productName}" is not in the product list.` });
    return;
  }
  // a plan can only promise what its PM can cover: stock less what earlier plans' open BOM lists hold
  // shortcut: stock is read outside the plan lock — two plans saved at the same instant can both pass; the BOM list still shows the truth
  const { state } = await fullState();
  const stock = [...derivePmStock(state.grnLines, state.requisitions, state.mrns, state.openings, state.minLevels, masters.components, state.bomIssues).values()];
  const short = planMaterials(
    body.data.lines.map((l) => ({ productName: l.productName, qty: l.targetQty })),
    (n) => masters.bom[n] ?? [],
    (n) => masters.productByName.get(n)?.fg ?? "",
    stock,
    { open: await loadOpenBoms(pool), planDate: date },
  ).filter((m) => m.short > 0);
  if (short.length) {
    const list = short.map((m) => `${m.name} short by ${m.short.toLocaleString("en-IN")} (${m.skus.join(", ")})`).join("; ");
    res.status(409).json({ error: `Material is short: ${list}. Please remove the item or decrease its quantity.` });
    return;
  }
  const userId = req.user!.id;
  await withLocks([`plan:${date}`], async (conn) => {
    await conn.query(
      `INSERT INTO production_plans (plan_date, created_by, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP(3)`,
      [date, userId, userId],
    );
    await conn.query("DELETE FROM production_plan_lines WHERE plan_date = ?", [date]);
    await conn.query(
      "INSERT INTO production_plan_lines (plan_date, line_no, product_id, product_type, target_qty) VALUES ?",
      [body.data.lines.map((l, i) => [date, i + 1, masters.productByName.get(l.productName)!.id, l.productType, l.targetQty])],
    );
  });
  await audit(req, { action: "production.plan", outcome: "ok", message: `plan ${date}: ${body.data.lines.length} products` });
  res.json({ ok: true });
});

const BulkUnit = z.enum(["KG", "L"]);
const BulkPlanBody = z.object({
  lines: z
    .array(z.object({ itemName: z.string().trim().min(1).max(120), unit: BulkUnit, qty: z.number().positive().max(10_000_000) }))
    .min(1)
    .max(200),
});

/**
 * Ids of the bulk items named (matched ignoring case, like the collation). A name not on the list joins it with the
 * unit given; a unit that differs from the item's is refused — so plan and report always measure an item the same way.
 */
async function bulkItemIds(conn: Queryable, lines: { itemName: string; unit: "KG" | "L" }[]): Promise<(name: string) => number> {
  const names = [...new Set(lines.map((l) => l.itemName))];
  await conn.query("INSERT IGNORE INTO bulk_items (name, unit) VALUES ?", [names.map((n) => [n, lines.find((l) => l.itemName === n)!.unit])]);
  const [rows] = await conn.query<RowDataPacket[]>("SELECT id, name, unit FROM bulk_items WHERE name IN (?)", [names]);
  const by = new Map(rows.map((x) => [String(x.name).toLowerCase(), { id: Number(x.id), name: String(x.name), unit: String(x.unit) }]));
  for (const l of lines) {
    const it = by.get(l.itemName.toLowerCase())!;
    if (it.unit !== l.unit) throw new FlowError(`${it.name} is measured in ${it.unit === "L" ? "L" : "Kg"} — change the unit of that row.`);
  }
  return (name) => by.get(name.toLowerCase())!.id;
}

const bulkItemList = async () => {
  const [items] = await pool.query<RowDataPacket[]>("SELECT name, unit FROM bulk_items ORDER BY name");
  return items.map((x) => ({ name: String(x.name), unit: String(x.unit) }));
};

async function bulkPlanLines(date: string) {
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT b.name, b.unit, l.qty, u.username, bp.updated_at
       FROM bulk_plans bp
       JOIN bulk_plan_lines l ON l.plan_date = bp.plan_date
       JOIN bulk_items b ON b.id = l.bulk_item_id
       LEFT JOIN users u ON u.id = bp.updated_by
      WHERE bp.plan_date = ? ORDER BY l.line_no`,
    [date],
  );
  return r;
}

flowRouter.get("/bulk-plans/:date", async (req, res) => {
  if (!ROLE_PROFILES[req.user!.role].tabs.includes("production")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const date = planDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const [items, r] = await Promise.all([bulkItemList(), bulkPlanLines(date)]);
  res.json({
    items,
    plan: r.length
      ? {
          savedBy: String(r[0].username ?? ""),
          savedAt: new Date(r[0].updated_at).toISOString(),
          lines: r.map((x) => ({ itemName: String(x.name), unit: String(x.unit), qty: Number(x.qty) })),
        }
      : null,
  });
});

flowRouter.post("/bulk-plans/:date", async (req, res) => {
  if (!roleCan(req.user!.role, "production.plan")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const date = planDate(req.params.date);
  const body = BulkPlanBody.safeParse(req.body);
  if (!date || !body.success) {
    res.status(400).json({ error: "Invalid plan: each row needs an item name, its unit (Kg or L) and a qty above zero." });
    return;
  }
  const userId = req.user!.id;
  try {
    await withLocks([`bulkplan:${date}`], async (conn) => {
      const idOf = await bulkItemIds(conn, body.data.lines);
      await conn.query(
        `INSERT INTO bulk_plans (plan_date, created_by, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP(3)`,
        [date, userId, userId],
      );
      await conn.query("DELETE FROM bulk_plan_lines WHERE plan_date = ?", [date]);
      await conn.query("INSERT INTO bulk_plan_lines (plan_date, line_no, bulk_item_id, qty) VALUES ?", [
        body.data.lines.map((l, i) => [date, i + 1, idOf(l.itemName), l.qty]),
      ]);
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.bulkplan", outcome: "ok", message: `bulk plan ${date}: ${body.data.lines.length} items` });
  res.json({ ok: true });
});

/* ── bulk manufacturing report: the actual batches made on a day; final submit locks it (→ Quality Testing) ─── */

/** The report of a date if saved, that day's bulk plan (to start a new report from) and the bulk item list. */
flowRouter.get("/bulk-reports/:date", async (req, res) => {
  if (!ROLE_PROFILES[req.user!.role].tabs.includes("production")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const date = planDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const [[head], [lines], items, plan] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT r.final_at, f.username AS final_by, u.username AS saved_by, r.updated_at
         FROM bulk_reports r LEFT JOIN users f ON f.id = r.final_by LEFT JOIN users u ON u.id = r.updated_by
        WHERE r.report_date = ?`,
      [date],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT l.*, DATE_FORMAT(l.order_date, '%d-%m-%Y') AS order_day, b.name, b.unit
         FROM bulk_report_lines l JOIN bulk_items b ON b.id = l.bulk_item_id
        WHERE l.report_date = ? ORDER BY l.row_no`,
      [date],
    ),
    bulkItemList(),
    bulkPlanLines(date),
  ]);
  const n = (v: unknown) => (v === null ? null : Number(v));
  res.json({
    items,
    plan: plan.map((x) => ({ itemName: String(x.name), unit: String(x.unit), qty: Number(x.qty) })),
    report: head.length
      ? {
          finalAt: head[0].final_at === null ? "" : new Date(head[0].final_at).toISOString(),
          finalBy: String(head[0].final_by ?? ""),
          savedBy: String(head[0].saved_by ?? ""),
          savedAt: new Date(head[0].updated_at).toISOString(),
          lines: lines.map((l) => ({
            itemName: String(l.name),
            unit: String(l.unit),
            shade: String(l.shade),
            orderDate: String(l.order_day ?? ""),
            responsible: String(l.responsible),
            batchSize: n(l.batch_size),
            actualQty: n(l.actual_qty),
            mfgBy: String(l.mfg_by),
            remark: String(l.remark),
          })),
        }
      : null,
  });
});

const bulkQty = z.number().min(0).max(10_000_000).nullable();
const BulkReportBody = z.strictObject({
  final: z.boolean(),
  lines: z
    .array(
      z.strictObject({
        itemName: z.string().trim().min(1).max(120),
        unit: BulkUnit,
        shade: z.string().trim().max(80),
        orderDate: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
        responsible: z.string().trim().max(80),
        batchSize: bulkQty,
        actualQty: bulkQty,
        mfgBy: z.string().trim().max(80),
        remark: z.string().trim().max(200),
      }),
    )
    .min(1)
    .max(200),
});

/** Saves the bulk report of a date whole (rows replaced); `final` also locks it. Refused once final. */
flowRouter.post("/bulk-reports/:date", async (req, res) => {
  if (!roleCan(req.user!.role, "production.report")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const date = planDate(req.params.date);
  const body = BulkReportBody.safeParse(req.body);
  if (!date || !body.success) {
    res.status(400).json({ error: "Invalid report: every row needs a bulk item and its unit (Kg or L); quantities cannot be negative." });
    return;
  }
  const { final, lines } = body.data;
  const missing = lines.findIndex((l) => l.actualQty === null || !l.responsible);
  if (final && missing >= 0) {
    res.status(400).json({ error: `Row ${missing + 1}: fill the actual batch qty and the responsible person before the final submit.` });
    return;
  }
  const userId = req.user!.id;
  try {
    await withLocks([`bulkreport:${date}`], async (conn) => {
      const [done] = await conn.query<RowDataPacket[]>("SELECT 1 FROM bulk_reports WHERE report_date = ? AND final_at IS NOT NULL", [date]);
      if (done.length) throw new FlowError(`The bulk report of ${date.split("-").reverse().join("-")} is final-submitted and locked.`);
      const idOf = await bulkItemIds(conn, lines);
      await conn.query(
        `INSERT INTO bulk_reports (report_date, final_at, final_by, created_by, updated_by) VALUES (?, ${final ? "NOW(3)" : "NULL"}, ?, ?, ?)
         ON DUPLICATE KEY UPDATE final_at = VALUES(final_at), final_by = VALUES(final_by), updated_by = VALUES(updated_by)`,
        [date, final ? userId : null, userId, userId],
      );
      await conn.query("DELETE FROM bulk_report_lines WHERE report_date = ?", [date]);
      await conn.query(
        `INSERT INTO bulk_report_lines (report_date, row_no, bulk_item_id, shade, order_date, responsible, batch_size, actual_qty, mfg_by, remark) VALUES ?`,
        [lines.map((l, i) => [date, i + 1, idOf(l.itemName), l.shade, l.orderDate || null, l.responsible, l.batchSize, l.actualQty, l.mfgBy, l.remark])],
      );
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.bulkreport", outcome: "ok", message: `bulk report ${date}: ${lines.length} rows${final ? ", final submit" : ""}` });
  res.json({ ok: true });
});

/* ── bulk quality testing: each final-submitted bulk row is accepted (all or part), rejected or held ─── */

// the screen is under Bulk Production; the qc login keeps API access (decides via qc.decide)
const seesBulkQt = (role: Role) => ROLE_PROFILES[role].tabs.includes("production") || ROLE_PROFILES[role].tabs.includes("qc");

/** Rows waiting (no decision yet, or on hold) and the last 60 days' decisions. */
flowRouter.get("/bulk-qt", async (req, res) => {
  if (!seesBulkQt(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(l.report_date, '%d-%m-%Y') AS day, DATE_FORMAT(l.report_date, '%Y-%m-%d') AS iso, l.row_no, b.name, b.unit,
              l.shade, l.actual_qty, l.mfg_by, q.status, q.accepted_qty, q.remarks, q.decided_by, q.decided_at
         FROM bulk_report_lines l
         JOIN bulk_reports r ON r.report_date = l.report_date AND r.final_at IS NOT NULL
         JOIN bulk_items b ON b.id = l.bulk_item_id
         LEFT JOIN bulk_qt q ON q.report_date = l.report_date AND q.row_no = l.row_no
        WHERE l.actual_qty > 0 AND (q.status IS NULL OR q.status = 'HOLD' OR q.decided_at > NOW() - INTERVAL 60 DAY)
        ORDER BY l.report_date DESC, l.row_no`,
  );
  res.json({
    rows: rows.map((x) => ({
      date: String(x.day),
      isoDate: String(x.iso),
      rowNo: Number(x.row_no),
      itemName: String(x.name),
      unit: String(x.unit),
      shade: String(x.shade),
      actualQty: Number(x.actual_qty),
      mfgBy: String(x.mfg_by),
      status: x.status === null ? "UNDER_TEST" : String(x.status),
      acceptedQty: x.accepted_qty === null ? null : Number(x.accepted_qty),
      remarks: String(x.remarks ?? ""),
      decidedBy: String(x.decided_by ?? ""),
      decidedAt: x.decided_at ? new Date(x.decided_at).toISOString() : "",
    })),
  });
});

/** Bulk stock per item for the stock screen: in stock = QT-accepted; under test, hold and rejected kept apart (as for PM). */
flowRouter.get("/bulk-stock", async (req, res) => {
  const tabs = ROLE_PROFILES[req.user!.role].tabs;
  if (!tabs.includes("pmstock") && !tabs.includes("production")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  // every bulk item, made or not (0 until a final report passes Quality Testing)
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT b.name, b.unit,
            COALESCE(SUM(CASE WHEN q.status = 'ACCEPTED' THEN q.accepted_qty ELSE 0 END), 0) AS stock,
            COALESCE(SUM(CASE WHEN l.row_no IS NOT NULL AND q.status IS NULL THEN l.actual_qty ELSE 0 END), 0) AS under_test,
            COALESCE(SUM(CASE WHEN q.status = 'HOLD' THEN l.actual_qty ELSE 0 END), 0) AS hold,
            COALESCE(SUM(CASE WHEN q.status = 'REJECTED' THEN l.actual_qty WHEN q.status = 'ACCEPTED' THEN l.actual_qty - q.accepted_qty ELSE 0 END), 0) AS rejected
       FROM bulk_items b
       LEFT JOIN (bulk_report_lines l JOIN bulk_reports rp ON rp.report_date = l.report_date AND rp.final_at IS NOT NULL)
              ON l.bulk_item_id = b.id AND l.actual_qty > 0
       LEFT JOIN bulk_qt q ON q.report_date = l.report_date AND q.row_no = l.row_no
      GROUP BY b.id ORDER BY b.name`,
  );
  res.json({
    items: r.map((x) => ({
      itemName: String(x.name),
      unit: String(x.unit),
      stock: Number(x.stock),
      underTest: Number(x.under_test),
      hold: Number(x.hold),
      rejected: Number(x.rejected),
    })),
  });
});

const BulkQtBody = z.strictObject({
  status: z.enum(["ACCEPTED", "REJECTED", "HOLD"]),
  acceptedQty: z.number().positive().max(10_000_000).nullable(),
  remarks: z.string().trim().max(200),
});

/** QC's decision on one bulk row. Accepted qty (null = all) goes into bulk stock; a part accept needs a reason. */
flowRouter.post("/bulk-qt/:date/:row", async (req, res) => {
  if (!roleCan(req.user!.role, "qc.decide")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const date = planDate(req.params.date);
  const rowNo = Number(req.params.row);
  const body = BulkQtBody.safeParse(req.body);
  if (!date || !Number.isInteger(rowNo) || rowNo < 1 || !body.success) {
    res.status(400).json({ error: "Invalid decision." });
    return;
  }
  const { status, acceptedQty, remarks } = body.data;
  const user = req.user!;
  try {
    const msg = await withLocks([`bulkqt:${date}:${rowNo}`], async (conn) => {
      const [l] = await conn.query<RowDataPacket[]>(
        `SELECT l.actual_qty, b.name, q.status FROM bulk_report_lines l
           JOIN bulk_reports r ON r.report_date = l.report_date AND r.final_at IS NOT NULL
           JOIN bulk_items b ON b.id = l.bulk_item_id
           LEFT JOIN bulk_qt q ON q.report_date = l.report_date AND q.row_no = l.row_no
          WHERE l.report_date = ? AND l.row_no = ?`,
        [date, rowNo],
      );
      if (!l.length || !(Number(l[0].actual_qty) > 0)) throw new FlowError("This bulk row is not waiting for Quality Testing.");
      const was = l[0].status === null ? null : String(l[0].status);
      if (was && was !== "HOLD") throw new FlowError(`${l[0].name} is already ${was.toLowerCase()}.`);
      if (status === "HOLD" && was === "HOLD") throw new FlowError(`${l[0].name} is already on hold — accept or reject it.`);
      const actual = Number(l[0].actual_qty);
      const take = status === "ACCEPTED" ? (acceptedQty ?? actual) : status === "REJECTED" ? 0 : null;
      if (take !== null && take > actual + 0.0005) throw new FlowError(`Accepted cannot be more than the ${actual.toLocaleString("en-IN")} made.`);
      if (status === "ACCEPTED" && take! < actual - 0.0005 && !remarks) throw new FlowError("Say why the rest is rejected.");
      await conn.query(
        `INSERT INTO bulk_qt (report_date, row_no, status, accepted_qty, remarks, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE status = VALUES(status), accepted_qty = VALUES(accepted_qty), remarks = VALUES(remarks),
                                 decided_by = VALUES(decided_by), decided_at = VALUES(decided_at)`,
        [date, rowNo, status, take === null ? null : Math.round(take * 1000) / 1000, remarks, user.label || user.username],
      );
      return `${l[0].name} (${date} row ${rowNo}): ${status}${take ? ` ${take}` : ""}`;
    });
    await audit(req, { action: "qc.bulk", outcome: "ok", message: msg });
    res.json({ ok: true });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
  }
});

/** A BOM list that holds PM stock: the latest of its plan date, not issued, not cancelled (alias d = bom_documents). */
const OPEN_BOM = `NOT EXISTS (SELECT 1 FROM bom_documents n WHERE n.plan_date = d.plan_date AND n.created_at > d.created_at)
  AND NOT EXISTS (SELECT 1 FROM bom_issue_slips s WHERE s.bom_no = d.bom_no)
  AND NOT EXISTS (SELECT 1 FROM bom_cancellations c WHERE c.bom_no = d.bom_no)`;

async function loadOpenBoms(db: Queryable): Promise<OpenBom[]> {
  const [r] = await db.query<RowDataPacket[]>(
    `SELECT d.bom_no, DATE_FORMAT(d.plan_date, '%Y-%m-%d') AS plan_date, d.created_at, l.component_code, l.required_qty
       FROM bom_documents d JOIN bom_document_lines l ON l.bom_no = d.bom_no
      WHERE ${OPEN_BOM} ORDER BY d.bom_no, l.line_no`,
  );
  const out = new Map<string, OpenBom>();
  for (const x of r) {
    const no = String(x.bom_no);
    let b = out.get(no);
    if (!b) out.set(no, (b = { bomNo: no, planDate: String(x.plan_date), createdAt: new Date(x.created_at).toISOString(), lines: [] }));
    b.lines.push({ code: String(x.component_code), required: Number(x.required_qty) });
  }
  return [...out.values()];
}

/** The open BOM lists, for working out what each holds — to anyone who sees PM stock or production. */
flowRouter.get("/production-reservations", async (req, res) => {
  const tabs = ROLE_PROFILES[req.user!.role].tabs;
  if (!tabs.includes("production") && !tabs.includes("pmstock")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  res.json({ open: await loadOpenBoms(pool) });
});

/** A saved requisition BOM list, as made (null if there is none by that number). */
async function loadBomDoc(db: Queryable, bomNo: string, skuOf: (name: string) => string) {
  const [d] = await db.query<RowDataPacket[]>(
    `SELECT d.bom_no, DATE_FORMAT(d.plan_date, '%Y-%m-%d') AS plan_date, d.created_at, u.username
       FROM bom_documents d LEFT JOIN users u ON u.id = d.created_by WHERE d.bom_no = ?`,
    [bomNo],
  );
  if (!d.length) return null;
  const [prods] = await db.query<RowDataPacket[]>(
    `SELECT p.name, b.target_qty FROM bom_document_products b JOIN products p ON p.id = b.product_id
      WHERE b.bom_no = ? ORDER BY b.line_no`,
    [bomNo],
  );
  const [mats] = await db.query<RowDataPacket[]>(
    `SELECT b.component_code, c.name, c.unit, b.required_qty, b.present_qty, b.used_in_skus FROM bom_document_lines b
       JOIN components c ON c.code = b.component_code WHERE b.bom_no = ? ORDER BY b.line_no`,
    [bomNo],
  );
  return {
    bomNo,
    planDate: String(d[0].plan_date),
    createdAt: new Date(d[0].created_at).toISOString(),
    createdBy: String(d[0].username ?? ""),
    products: prods.map((p) => ({ productName: String(p.name), sku: skuOf(String(p.name)), qty: Number(p.target_qty) })),
    materials: mats.map((m) => {
      const required = Number(m.required_qty);
      const present = Number(m.present_qty);
      return {
        code: String(m.component_code),
        name: String(m.name),
        required,
        // a saved list keeps only what was available to it when made (stock less what plans ahead held)
        onHand: present,
        reservedOthers: 0,
        present,
        short: Math.max(0, required - present),
        unit: String(m.unit) || "Pcs",
        skus: String(m.used_in_skus).split(", ").filter(Boolean),
      };
    }),
  };
}

/**
 * A requisition BOM list: the saved plan of a date with its PM requirement against PM stock right now, frozen under
 * the next BOM number (BOM-yyyymmdd-nnnn: today's date, one running counter). The browser prints it as the PDF.
 * Asked again before the plan is re-saved, it is the same document (same number); after an edit, a new one.
 */
flowRouter.post("/production-boms", async (req, res) => {
  if (!roleCan(req.user!.role, "production.bom")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = z.strictObject({ planDate: z.string() }).safeParse(req.body);
  const date = body.success ? planDate(body.data.planDate) : null;
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const masters = await currentMasters();
  const { state } = await fullState();
  const stock = [...derivePmStock(state.grnLines, state.requisitions, state.mrns, state.openings, state.minLevels, masters.components, state.bomIssues).values()];
  const skuOf = (name: string) => masters.productByName.get(name)?.fg ?? "";
  try {
    const doc = await withLocks([`plan:${date}`], async (conn) => {
      const [plan] = await conn.query<RowDataPacket[]>(
        `SELECT p.id, p.name, l.target_qty FROM production_plan_lines l JOIN products p ON p.id = l.product_id
          WHERE l.plan_date = ? ORDER BY l.line_no`,
        [date],
      );
      if (plan.length === 0) throw new FlowError(`No plan saved for ${date.split("-").reverse().join("-")}.`);
      // One BOM number per version of the plan: made after the plan's last save → the same document again
      const [made] = await conn.query<RowDataPacket[]>(
        `SELECT d.bom_no, d.created_at, u.username FROM bom_documents d
           JOIN production_plans pp ON pp.plan_date = d.plan_date
           LEFT JOIN users u ON u.id = d.created_by
          WHERE d.plan_date = ? AND d.created_at >= pp.updated_at
            AND NOT EXISTS (SELECT 1 FROM bom_cancellations c WHERE c.bom_no = d.bom_no)
          ORDER BY d.created_at DESC LIMIT 1`,
        [date],
      );
      if (made.length) return { ...(await loadBomDoc(conn, String(made[0].bom_no), skuOf))!, reused: true };
      const products = plan.map((p) => ({ productName: String(p.name), sku: skuOf(String(p.name)), qty: Number(p.target_qty) }));
      // plans ahead of this one in the queue (earlier date) hold their stock: "present" is what is left for this one
      const materials = planMaterials(products, (n) => masters.bom[n] ?? [], skuOf, stock, { open: await loadOpenBoms(conn), planDate: date });
      const [seq] = await conn.query<ResultSetHeader>("UPDATE document_sequences SET last_no = LAST_INSERT_ID(last_no + 1) WHERE series = 'BOM'");
      if (seq.affectedRows !== 1) throw new Error("Document series BOM is not set up — run npm run db:setup.");
      const bomNo = `BOM-${todayLabel().split("-").reverse().join("")}-${String(seq.insertId).padStart(4, "0")}`;
      await conn.query("INSERT INTO bom_documents (bom_no, plan_date, created_by) VALUES (?, ?, ?)", [bomNo, date, req.user!.id]);
      await conn.query("INSERT INTO bom_document_products (bom_no, line_no, product_id, target_qty) VALUES ?", [
        plan.map((p, i) => [bomNo, i + 1, Number(p.id), Number(p.target_qty)]),
      ]);
      if (materials.length) {
        await conn.query("INSERT INTO bom_document_lines (bom_no, line_no, component_code, required_qty, present_qty, used_in_skus) VALUES ?", [
          materials.map((m, i) => [bomNo, i + 1, m.code, m.required, m.present, m.skus.join(", ").slice(0, 500)]),
        ]);
      }
      return { ...(await loadBomDoc(conn, bomNo, skuOf))!, reused: false };
    });
    if (!doc.reused) await audit(req, { action: "production.bom", outcome: "ok", message: `${doc.bomNo} from plan ${date}` });
    res.json({ doc });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
  }
});

/* ── BOM issue slip: Store records what it actually gave against a BOM list ───── */

/** BOM lists Store can issue against: the latest of each plan date, not issued yet — newest first. */
flowRouter.get("/production-boms", async (req, res) => {
  if (!roleCan(req.user!.role, "production.issue")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT d.bom_no, DATE_FORMAT(d.plan_date, '%Y-%m-%d') AS plan_date, d.created_at,
            (SELECT COUNT(*) FROM bom_document_lines l WHERE l.bom_no = d.bom_no) AS items,
            (SELECT COUNT(*) FROM bom_document_lines l WHERE l.bom_no = d.bom_no AND l.required_qty > l.present_qty) AS shorts
       FROM bom_documents d
      WHERE ${OPEN_BOM}
      ORDER BY d.created_at DESC`,
  );
  res.json({
    boms: r.map((x) => ({
      bomNo: String(x.bom_no),
      planDate: String(x.plan_date),
      createdAt: new Date(x.created_at).toISOString(),
      items: Number(x.items),
      shorts: Number(x.shorts),
    })),
  });
});

flowRouter.get("/production-boms/:bomNo", async (req, res) => {
  if (!roleCan(req.user!.role, "production.issue")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const masters = await currentMasters();
  const doc = await loadBomDoc(pool, String(req.params.bomNo).slice(0, 24), (n) => masters.productByName.get(n)?.fg ?? "");
  if (!doc) {
    res.status(404).json({ error: "No such BOM number." });
    return;
  }
  res.json({ doc });
});

const IssueBody = z.strictObject({
  filledBy: z.string().trim().min(1).max(80),
  lines: z
    .array(
      z.strictObject({
        componentCode: z.string().max(16),
        issuedQty: z.number().finite().min(0).max(1e9),
        remark: z.string().trim().max(200),
      }),
    )
    .min(1)
    .max(2000),
});

flowRouter.post("/production-boms/:bomNo/issue", async (req, res) => {
  if (!roleCan(req.user!.role, "production.issue")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const bomNo = String(req.params.bomNo).slice(0, 24);
  const body = IssueBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid slip: fill in who filled it and the actual qty (0 or more) of every item." });
    return;
  }
  // the items' stock is locked like a requisition issue's, so two issues cannot both draw the same last pieces
  const codes = [...new Set(body.data.lines.map((l) => l.componentCode))];
  try {
    await withLocks([`bom:${bomNo}`, ...codes.map((c) => `stock:${c}`)], async (conn) => {
      const doc = await loadBomDoc(conn, bomNo, () => "");
      if (!doc) throw new FlowError(`BOM ${bomNo} not found.`);
      const [done] = await conn.query<RowDataPacket[]>("SELECT 1 FROM bom_issue_slips WHERE bom_no = ?", [bomNo]);
      if (done.length) throw new FlowError(`BOM ${bomNo} has already been issued.`);
      const [cancelled] = await conn.query<RowDataPacket[]>("SELECT 1 FROM bom_cancellations WHERE bom_no = ?", [bomNo]);
      if (cancelled.length) throw new FlowError(`BOM ${bomNo} was cancelled.`);
      const [newer] = await conn.query<RowDataPacket[]>(
        "SELECT bom_no FROM bom_documents WHERE plan_date = ? AND created_at > (SELECT created_at FROM bom_documents WHERE bom_no = ?) LIMIT 1",
        [doc.planDate, bomNo],
      );
      if (newer.length) throw new FlowError(`The plan was changed: issue against the latest BOM list ${String(newer[0].bom_no)}.`);
      const lines = body.data.lines;
      if (lines.length !== doc.materials.length || lines.some((l, i) => l.componentCode !== doc.materials[i].code)) {
        throw new FlowError("The slip's items do not match the BOM list — reload it and try again.");
      }
      const s = await loadState(conn, stockSlice(codes));
      const stock = derivePmStock(s.grnLines, s.requisitions, s.mrns, s.openings, s.minLevels, [], s.bomIssues);
      for (const [i, l] of lines.entries()) {
        const have = Math.max(0, stock.get(l.componentCode)?.closing ?? 0);
        if (l.issuedQty > have + 0.0005) throw new FlowError(`Only ${have.toLocaleString("en-IN")} of ${doc.materials[i].name} in stock — cannot issue ${l.issuedQty.toLocaleString("en-IN")}.`);
      }
      await conn.query("INSERT INTO bom_issue_slips (bom_no, filled_by, created_by) VALUES (?, ?, ?)", [bomNo, body.data.filledBy, req.user!.id]);
      await conn.query("INSERT INTO bom_issue_lines (bom_no, line_no, component_code, required_qty, issued_qty, remark) VALUES ?", [
        lines.map((l, i) => [bomNo, i + 1, l.componentCode, doc.materials[i].required, Math.round(l.issuedQty * 1000) / 1000, l.remark]),
      ]);
      await touchDocument(conn, "bomIssues", bomNo); // every screen's PM stock picks the issue up
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.issue", outcome: "ok", message: `BOM issue slip ${bomNo} by ${body.data.filledBy}` });
  res.json({ ok: true });
});

/* ── MRN against a BOM list: supervisor returns PM, Store counts it and approves it back into stock ─── */

const seesMrn = (role: Role) => ROLE_PROFILES[role].tabs.includes("production") || ROLE_PROFILES[role].tabs.includes("store");

/**
 * The items of an issued BOM list and how much of each can still come back: what reached the line (the supervisor's
 * verified qty, else the issued qty) less what earlier MRNs return (Store's count once approved, else the claim).
 */
async function returnSource(db: Queryable, bomNo: string) {
  const [r] = await db.query<RowDataPacket[]>(
    `SELECT l.component_code, c.name, c.unit, l.issued_qty, vl.received_qty,
            (SELECT COALESCE(SUM(COALESCE(rl.received_qty, rl.returned_qty)), 0)
               FROM bom_returns br JOIN bom_return_lines rl ON rl.mrn_no = br.mrn_no
              WHERE br.bom_no = l.bom_no AND rl.component_code = l.component_code) AS returned
       FROM bom_issue_lines l
       JOIN components c ON c.code = l.component_code
       LEFT JOIN bom_verification_lines vl ON vl.bom_no = l.bom_no AND vl.line_no = l.line_no
      WHERE l.bom_no = ? ORDER BY l.line_no`,
    [bomNo],
  );
  return r.map((x) => {
    const issued = Number(x.issued_qty);
    const received = x.received_qty === null ? null : Number(x.received_qty);
    const returned = Number(x.returned);
    return { code: String(x.component_code), name: String(x.name), unit: String(x.unit) || "Pcs", issued, received, returned, max: Math.max(0, (received ?? issued) - returned) };
  });
}

/** Issued BOM lists of the last 60 days (to pick from), and the MRNs: pending ones and the last 60 days'. */
flowRouter.get("/bom-returns", async (req, res) => {
  if (!seesMrn(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const [[boms], [rows]] = await Promise.all([
    pool.query<RowDataPacket[]>("SELECT bom_no, created_at FROM bom_issue_slips WHERE created_at > NOW() - INTERVAL 60 DAY ORDER BY created_at DESC"),
    pool.query<RowDataPacket[]>(
      `SELECT r.*, u.username, l.component_code, c.name, c.unit, l.returned_qty, l.received_qty, l.remark AS line_remark
         FROM bom_returns r
         JOIN bom_return_lines l ON l.mrn_no = r.mrn_no
         JOIN components c ON c.code = l.component_code
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.status = 'PENDING' OR r.created_at > NOW() - INTERVAL 60 DAY
        ORDER BY r.created_at DESC, r.mrn_no DESC, l.line_no`,
    ),
  ]);
  const returns = new Map<string, Record<string, unknown> & { lines: unknown[] }>();
  for (const x of rows) {
    const no = String(x.mrn_no);
    let m = returns.get(no);
    if (!m) {
      returns.set(no, (m = {
        mrnNo: no,
        bomNo: String(x.bom_no),
        returnedBy: String(x.returned_by),
        remarks: String(x.remarks),
        raisedBy: String(x.username ?? ""),
        raisedAt: new Date(x.created_at).toISOString(),
        status: String(x.status),
        verifiedBy: String(x.verified_by),
        verifyRemarks: String(x.verify_remarks),
        verifiedAt: x.verified_at ? new Date(x.verified_at).toISOString() : "",
        lines: [],
      }));
    }
    m.lines.push({
      code: String(x.component_code),
      name: String(x.name),
      unit: String(x.unit) || "Pcs",
      returned: Number(x.returned_qty),
      received: x.received_qty === null ? null : Number(x.received_qty),
      remark: String(x.line_remark),
    });
  }
  res.json({ boms: boms.map((b) => ({ bomNo: String(b.bom_no), issuedAt: new Date(b.created_at).toISOString() })), returns: [...returns.values()] });
});

/** The items of an issued BOM list, for filling an MRN. */
flowRouter.get("/bom-returns/source/:bomNo", async (req, res) => {
  if (!seesMrn(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const lines = await returnSource(pool, String(req.params.bomNo).slice(0, 24));
  if (!lines.length) {
    res.status(404).json({ error: "This BOM list has not been issued." });
    return;
  }
  res.json({ lines });
});

const MrnBody = z.strictObject({
  bomNo: z.string().trim().min(1).max(24),
  returnedBy: z.string().trim().min(1).max(80),
  remarks: z.string().trim().max(200),
  lines: z
    .array(z.strictObject({ code: z.string().trim().min(1).max(16), qty: z.number().positive().max(1e9), remark: z.string().trim().max(200) }))
    .min(1)
    .max(500),
});

/** The supervisor's MRN: items going back to Store against an issued BOM list. Stock moves only when Store approves. */
flowRouter.post("/bom-returns", async (req, res) => {
  if (!roleCan(req.user!.role, "production.verify")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = MrnBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid MRN: pick the BOM number and who is returning; each item needs a qty above zero." });
    return;
  }
  const { bomNo, returnedBy, remarks, lines } = body.data;
  if (new Set(lines.map((l) => l.code)).size !== lines.length) {
    res.status(400).json({ error: "An item is on the MRN twice." });
    return;
  }
  try {
    const mrnNo = await withLocks([`bomret:${bomNo}`], async (conn) => {
      const src = await returnSource(conn, bomNo);
      if (!src.length) throw new FlowError(`BOM ${bomNo} has not been issued.`);
      for (const l of lines) {
        const s = src.find((x) => x.code === l.code);
        if (!s) throw new FlowError(`Item ${l.code} was not issued against ${bomNo}.`);
        if (l.qty > s.max + 0.0005) {
          throw new FlowError(`${s.name}: only ${s.max.toLocaleString("en-IN")} can come back against ${bomNo} — cannot return ${l.qty.toLocaleString("en-IN")}.`);
        }
      }
      const [seq] = await conn.query<ResultSetHeader>("UPDATE document_sequences SET last_no = LAST_INSERT_ID(last_no + 1) WHERE series = 'MRB'");
      if (seq.affectedRows !== 1) throw new Error("Document series MRB is not set up — run npm run db:setup.");
      const no = `MRN-${todayLabel().split("-").reverse().join("")}-${String(seq.insertId).padStart(4, "0")}`;
      await conn.query("INSERT INTO bom_returns (mrn_no, bom_no, returned_by, remarks, created_by) VALUES (?, ?, ?, ?, ?)", [no, bomNo, returnedBy, remarks, req.user!.id]);
      await conn.query("INSERT INTO bom_return_lines (mrn_no, line_no, component_code, returned_qty, remark) VALUES ?", [
        lines.map((l, i) => [no, i + 1, l.code, Math.round(l.qty * 1000) / 1000, l.remark]),
      ]);
      return no;
    });
    await audit(req, { action: "production.mrn", outcome: "ok", message: `${mrnNo} against ${bomNo} by ${returnedBy}` });
    res.json({ ok: true, mrnNo });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
  }
});

/** Store counts what actually came back (per line, in order) and approves — that qty goes back into PM stock. */
flowRouter.post("/bom-returns/:no/approve", async (req, res) => {
  if (!roleCan(req.user!.role, "production.issue")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = z
    .strictObject({ received: z.array(z.number().min(0).max(1e9)).min(1).max(500), remarks: z.string().trim().max(200) })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Enter the received qty (0 or more) of every item." });
    return;
  }
  const no = String(req.params.no).slice(0, 24);
  const [head] = await pool.query<RowDataPacket[]>("SELECT bom_no FROM bom_returns WHERE mrn_no = ?", [no]);
  if (!head.length) {
    res.status(404).json({ error: `MRN ${no} not found.` });
    return;
  }
  const bomNo = String(head[0].bom_no);
  const user = req.user!;
  try {
    await withLocks([`bomret:${bomNo}`], async (conn) => {
      const [h] = await conn.query<RowDataPacket[]>("SELECT status FROM bom_returns WHERE mrn_no = ?", [no]);
      if (h[0].status !== "PENDING") throw new FlowError(`MRN ${no} is already approved.`);
      const [lines] = await conn.query<RowDataPacket[]>("SELECT line_no, returned_qty FROM bom_return_lines WHERE mrn_no = ? ORDER BY line_no", [no]);
      const got = body.data.received;
      if (got.length !== lines.length) throw new FlowError("The MRN's items changed — reload it and try again.");
      // shortcut: Store can count at most what the supervisor sent; more back than claimed needs a new MRN
      const over = lines.findIndex((l, i) => got[i] > Number(l.returned_qty) + 0.0005);
      if (over >= 0) throw new FlowError(`Line ${over + 1}: received cannot be more than the ${Number(lines[over].returned_qty).toLocaleString("en-IN")} returned.`);
      for (const [i, l] of lines.entries()) {
        await conn.query("UPDATE bom_return_lines SET received_qty = ? WHERE mrn_no = ? AND line_no = ?", [Math.round(got[i] * 1000) / 1000, no, l.line_no]);
      }
      await conn.query("UPDATE bom_returns SET status = 'APPROVED', verified_by = ?, verify_remarks = ?, verified_at = NOW(3) WHERE mrn_no = ?", [
        user.label || user.username,
        body.data.remarks,
        no,
      ]);
      await touchDocument(conn, "bomIssues", bomNo); // every screen's PM stock picks the return up
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.mrnApprove", outcome: "ok", message: `${no} against ${bomNo}` });
  res.json({ ok: true });
});

/* ── production report: one per day, draft until final submit locks it ─────────── */

/** The report of a date (yyyy-mm-dd) if saved, and that day's plan (to start a new report from). */
flowRouter.get("/production-reports/:date", async (req, res) => {
  if (!ROLE_PROFILES[req.user!.role].tabs.includes("production")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const date = planDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const [head] = await pool.query<RowDataPacket[]>(
    `SELECT r.supervisor, r.final_at, f.username AS final_by, u.username AS saved_by, r.updated_at
       FROM production_reports r LEFT JOIN users f ON f.id = r.final_by LEFT JOIN users u ON u.id = r.updated_by
      WHERE r.report_date = ?`,
    [date],
  );
  const [lines] = await pool.query<RowDataPacket[]>(
    `SELECT l.*, p.name AS product FROM production_report_lines l JOIN products p ON p.id = l.product_id
      WHERE l.report_date = ? ORDER BY l.row_no`,
    [date],
  );
  const [plan] = await pool.query<RowDataPacket[]>(
    `SELECT p.name, l.product_type, l.target_qty FROM production_plan_lines l JOIN products p ON p.id = l.product_id
      WHERE l.plan_date = ? ORDER BY l.line_no`,
    [date],
  );
  const n = (v: unknown) => (v === null ? null : Number(v));
  res.json({
    report: head.length
      ? {
          finalAt: head[0].final_at === null ? "" : new Date(head[0].final_at).toISOString(),
          finalBy: String(head[0].final_by ?? ""),
          savedBy: String(head[0].saved_by ?? ""),
          savedAt: new Date(head[0].updated_at).toISOString(),
          lines: lines.map((l) => ({
            floor: String(l.floor),
            line: String(l.line_name),
            manpower: n(l.manpower),
            leader: String(l.line_leader),
            supervisor: String(l.supervisor),
            productName: String(l.product),
            productType: String(l.product_type),
            stage: String(l.stage),
            targetQty: n(l.target_qty),
            slot: String(l.slot),
            qtyFirst: n(l.qty_first),
            qtySecond: n(l.qty_second),
            qtyEvening: n(l.qty_evening),
            sfgQty: n(l.sfg_qty),
            downtimeMin: n(l.downtime_min),
            reason: String(l.reason),
          })),
        }
      : null,
    plan: plan.map((p) => ({ productName: String(p.name), productType: String(p.product_type), targetQty: Number(p.target_qty) })),
  });
});

const qty = z.number().int().min(0).max(10_000_000).nullable();
const oneOf = (list: readonly string[]) => z.string().refine((v) => v === "" || list.includes(v), "not in the list");
const ReportBody = z.strictObject({
  final: z.boolean(),
  lines: z
    .array(
      z.strictObject({
        floor: oneOf(PRODUCTION_FLOORS),
        line: oneOf(PRODUCTION_LINES),
        manpower: z.number().int().min(0).max(1000).nullable(),
        leader: z.string().trim().max(80),
        supervisor: z.string().trim().max(80),
        productName: z.string().trim().min(1).max(160),
        productType: z.string().trim().max(40),
        stage: oneOf(PRODUCTION_STAGES),
        targetQty: qty,
        slot: oneOf(PRODUCTION_SLOTS),
        qtyFirst: qty,
        qtySecond: qty,
        qtyEvening: qty,
        sfgQty: qty,
        downtimeMin: z.number().int().min(0).max(1440).nullable(),
        reason: z.string().trim().max(200),
      }),
    )
    .min(1)
    .max(300),
});

/** Saves the report of a date whole (rows replaced); `final` also locks it. Refused once final. */
flowRouter.post("/production-reports/:date", async (req, res) => {
  if (!roleCan(req.user!.role, "production.report")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const date = planDate(req.params.date);
  const body = ReportBody.safeParse(req.body);
  if (!date || !body.success) {
    res.status(400).json({ error: "Invalid report: every row needs a product from the list; quantities are whole numbers." });
    return;
  }
  const { final, lines } = body.data;
  const noSup = lines.findIndex((l) => !l.supervisor);
  if (final && noSup >= 0) {
    res.status(400).json({ error: `Row ${noSup + 1}: pick the supervisor before the final submit.` });
    return;
  }
  const masters = await currentMasters();
  const unknown = lines.find((l) => !masters.productByName.has(l.productName));
  if (unknown) {
    res.status(400).json({ error: `Product "${unknown.productName}" is not in the product list.` });
    return;
  }
  const userId = req.user!.id;
  try {
    await withLocks([`report:${date}`], async (conn) => {
      const [done] = await conn.query<RowDataPacket[]>("SELECT 1 FROM production_reports WHERE report_date = ? AND final_at IS NOT NULL", [date]);
      if (done.length) throw new FlowError(`The production report of ${date.split("-").reverse().join("-")} is final-submitted and locked.`);
      await conn.query(
        `INSERT INTO production_reports (report_date, supervisor, final_at, final_by, created_by, updated_by) VALUES (?, '', ${final ? "NOW(3)" : "NULL"}, ?, ?, ?)
         ON DUPLICATE KEY UPDATE final_at = VALUES(final_at), final_by = VALUES(final_by), updated_by = VALUES(updated_by)`,
        [date, final ? userId : null, userId, userId],
      );
      await conn.query("DELETE FROM production_report_lines WHERE report_date = ?", [date]);
      await conn.query(
        `INSERT INTO production_report_lines (report_date, row_no, floor, line_name, manpower, line_leader, supervisor, product_id, product_type, stage,
           target_qty, slot, qty_first, qty_second, qty_evening, sfg_qty, downtime_min, reason) VALUES ?`,
        [
          lines.map((l, i) => [
            date, i + 1, l.floor, l.line, l.manpower, l.leader, l.supervisor, masters.productByName.get(l.productName)!.id, l.productType, l.stage,
            l.targetQty, l.slot, l.qtyFirst, l.qtySecond, l.qtyEvening, l.sfgQty, l.downtimeMin, l.reason,
          ]),
        ],
      );
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.report", outcome: "ok", message: `report ${date}: ${lines.length} rows${final ? ", final submit" : ""}` });
  res.json({ ok: true });
});

/* ── indent requests: Store approves an item below its minimum level, Purchase indents ─── */

/**
 * "po|code" for each item still to come in on these POs: ordered but not yet fully received, PO not closed by hand.
 * A request holds its item until then — between PO and delivery the item is still short, but already on order.
 */
async function stillOnOrder(db: Queryable, poNos: string[]): Promise<Set<string>> {
  if (poNos.length === 0) return new Set();
  const inPos = { sql: "h.po_no IN (?)", params: [poNos] };
  const s = await loadState(db, {
    purchaseOrders: inPos,
    poClosures: inPos,
    gateEntries: inPos,
    grnLines: { sql: "h.po_no IN (?) OR g.po_no IN (?)", params: [poNos, poNos] },
  });
  const closedByHand = new Set(s.poClosures.filter((c) => c.closed).map((c) => c.poNo));
  return new Set(
    derivePoProgress(s.purchaseOrders, s.gateEntries, s.grnLines)
      .filter((p) => !closedByHand.has(p.po.id))
      .flatMap((p) => p.lines.filter((l) => l.pending > 0).map((l) => `${p.po.id}|${l.code}`)),
  );
}

/** Requests that are not rejected, with their indent's PO (r = indent_requests, i = its purchase indent). */
const LIVE_REQUESTS = `SELECT r.*, DATE_FORMAT(r.required_date, '%Y-%m-%d') AS req_date, c.name, c.unit, i.indent_no, i.po_no
  FROM indent_requests r
  JOIN components c ON c.code = r.component_code
  LEFT JOIN purchase_indents i ON i.request_no = r.request_no`;

/** Marks each request open (holding its item): not rejected, and not yet on a PO or its PO line not fully received. */
async function withOpen(db: Queryable, rows: RowDataPacket[]): Promise<(RowDataPacket & { open: boolean })[]> {
  const pending = await stillOnOrder(db, [...new Set(rows.filter((r) => r.po_no).map((r) => String(r.po_no)))]);
  return rows.map((r) =>
    Object.assign(r, { open: r.status !== "REJECTED" && (!r.po_no || pending.has(`${r.po_no}|${r.component_code}`)) }),
  );
}

/** Open requests, and the last 60 days' closed ones; with each item's fixed indent qty for raising new ones. */
flowRouter.get("/indent-requests", async (req, res) => {
  const role = req.user!.role;
  const tabs = ROLE_PROFILES[role].tabs;
  if (!tabs.includes("production") && !tabs.includes("store") && !roleCan(role, "purchase.indent")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  // shortcut: every non-rejected request is read to find the open ones; closed ones older than 60 days are then dropped
  // from the list — add a received-on column when the request history grows to thousands
  const [rows, fixed] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `${LIVE_REQUESTS} WHERE r.status <> 'REJECTED' OR r.created_at > NOW() - INTERVAL 60 DAY ORDER BY r.created_at DESC, r.request_no DESC`,
    ),
    pool.query<RowDataPacket[]>("SELECT code, indent_qty FROM components WHERE indent_qty IS NOT NULL"),
  ]);
  const cutoff = Date.now() - 60 * 86_400_000;
  const shown = (await withOpen(pool, rows[0])).filter((r) => r.open || new Date(r.created_at).getTime() > cutoff);
  res.json({
    requests: shown.map((r) => ({
      requestNo: String(r.request_no),
      code: String(r.component_code),
      name: String(r.name),
      unit: String(r.unit ?? ""),
      qty: Number(r.qty),
      requiredDate: r.req_date ? String(r.req_date) : "",
      supervisor: String(r.supervisor),
      remarks: String(r.remarks),
      raisedBy: String(r.raised_by),
      raisedAt: new Date(r.created_at).toISOString(),
      status: String(r.status),
      verifyRemarks: String(r.verify_remarks),
      verifiedBy: String(r.verified_by),
      verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : "",
      indentNo: r.indent_no ? String(r.indent_no) : "",
      poNo: r.po_no ? String(r.po_no) : "",
      open: r.open,
    })),
    fixedQty: Object.fromEntries(fixed[0].map((r) => [String(r.code), Number(r.indent_qty)])),
  });
});

const RaiseBody = z.strictObject({
  supervisor: z.string().trim().max(80).default(""),
  requiredDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).default(""),
  items: z
    .array(z.strictObject({ code: z.string().trim().min(1).max(16), qty: z.number().int().min(1).max(10_000_000), remarks: z.string().trim().max(200) }))
    .min(1)
    .max(100),
});

/**
 * Store approves one request per item (made VERIFIED at once, straight to Purchase).
 * All or nothing: refused if any item already has an open request (one per item).
 */
flowRouter.post("/indent-requests", async (req, res) => {
  if (!roleCan(req.user!.role, "production.issue")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = RaiseBody.safeParse(req.body);
  const required = body.success && body.data.requiredDate ? planDate(body.data.requiredDate) : "";
  if (!body.success || required === null) {
    res.status(400).json({ error: "Invalid request: each item needs a whole-number qty above zero." });
    return;
  }
  const { supervisor, items } = body.data;
  const codes = items.map((x) => x.code);
  if (new Set(codes).size !== codes.length) {
    res.status(400).json({ error: "An item is on the list twice." });
    return;
  }
  const masters = await currentMasters();
  const unknown = codes.find((c) => !masters.componentByCode.has(c));
  if (unknown) {
    res.status(400).json({ error: `Item ${unknown} is not in the item list.` });
    return;
  }
  const user = req.user!;
  try {
    const made = await withLocks(
      codes.map((c) => `indentreq-item:${c}`),
      async (conn) => {
        const [live] = await conn.query<RowDataPacket[]>(`${LIVE_REQUESTS} WHERE r.component_code IN (?) AND r.status <> 'REJECTED'`, [codes]);
        // a delivery recorded meanwhile only frees an item, so reading receipts here (not under their locks) is safe
        const open = (await withOpen(conn, live)).filter((r) => r.open);
        if (open.length) {
          const o = open[0];
          throw new FlowError(`${masters.componentByCode.get(String(o.component_code))!.name} already has an open indent request ${o.request_no} (raised by ${o.raised_by}).`);
        }
        const nos: string[] = [];
        for (const it of items) {
          const [seq] = await conn.query<ResultSetHeader>("UPDATE document_sequences SET last_no = LAST_INSERT_ID(last_no + 1) WHERE series = 'IR'");
          if (seq.affectedRows !== 1) throw new Error("Document series IR is not set up — run npm run db:setup.");
          const no = `IR-${todayLabel().split("-").reverse().join("")}-${String(seq.insertId).padStart(4, "0")}`;
          await conn.query(
            `INSERT INTO indent_requests (request_no, component_code, qty, required_date, supervisor, remarks, raised_by, created_by, status, verified_by, verified_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'VERIFIED', ?, NOW(3))`,
            [no, it.code, it.qty, required || null, supervisor, it.remarks, user.label || user.username, user.id, user.label || user.username],
          );
          nos.push(no);
        }
        return nos;
      },
    );
    await audit(req, { action: "production.indentRequest", outcome: "ok", message: made.join(", ") });
    res.json({ ok: true, requestNos: made });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
  }
});

/** Store verifies or rejects a pending request, once. */
flowRouter.post("/indent-requests/:no/verify", async (req, res) => {
  if (!roleCan(req.user!.role, "production.issue")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = z.strictObject({ approve: z.boolean(), remarks: z.string().trim().max(200) }).safeParse(req.body);
  if (!body.success || (!body.data.approve && !body.data.remarks)) {
    res.status(400).json({ error: "A rejection needs a remark." });
    return;
  }
  const no = String(req.params.no);
  const user = req.user!;
  const [r] = await pool.query<ResultSetHeader>(
    "UPDATE indent_requests SET status = ?, verify_remarks = ?, verified_by = ?, verified_at = NOW(3) WHERE request_no = ? AND status = 'PENDING'",
    [body.data.approve ? "VERIFIED" : "REJECTED", body.data.remarks, user.label || user.username, no],
  );
  if (r.affectedRows !== 1) {
    res.status(409).json({ error: `Indent request ${no} is not pending — it was already verified or rejected.` });
    return;
  }
  await audit(req, { action: "production.indentVerify", outcome: "ok", message: `${no}: ${body.data.approve ? "verified" : "rejected"}` });
  res.json({ ok: true });
});

/* ── FG transfer note: rows filled per date, final submit makes a numbered note ─── */

const FG_LINE_COLS = "l.row_no, p.name AS product, l.product_type, l.qty_in_box, l.total_box, l.total_qty, l.pallet_no, l.supervisor";
const fgLine = (l: RowDataPacket) => ({
  productName: String(l.product),
  productType: String(l.product_type),
  qtyInBox: l.qty_in_box === null ? null : Number(l.qty_in_box),
  totalBox: l.total_box === null ? null : Number(l.total_box),
  totalQty: l.total_qty === null ? null : Number(l.total_qty),
  palletNo: String(l.pallet_no),
  supervisor: String(l.supervisor),
});

/** The draft of a date (yyyy-mm-dd) and the notes already final-submitted on it. */
flowRouter.get("/fg-transfer/:date", async (req, res) => {
  if (!ROLE_PROFILES[req.user!.role].tabs.includes("production")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const date = planDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const [[head], [draft], [notes]] = await Promise.all([
    pool.query<RowDataPacket[]>(
      "SELECT u.username, d.updated_at FROM fg_transfer_drafts d LEFT JOIN users u ON u.id = d.updated_by WHERE d.note_date = ?",
      [date],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT ${FG_LINE_COLS} FROM fg_transfer_draft_lines l JOIN products p ON p.id = l.product_id WHERE l.note_date = ? ORDER BY l.row_no`,
      [date],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT n.note_no, n.created_at, u.username, ${FG_LINE_COLS}
         FROM fg_transfer_notes n
         JOIN fg_transfer_note_lines l ON l.note_no = n.note_no
         JOIN products p ON p.id = l.product_id
         LEFT JOIN users u ON u.id = n.created_by
        WHERE n.note_date = ? ORDER BY n.created_at, n.note_no, l.row_no`,
      [date],
    ),
  ]);
  const byNo = new Map<string, { noteNo: string; createdAt: string; createdBy: string; lines: ReturnType<typeof fgLine>[] }>();
  for (const r of notes) {
    const no = String(r.note_no);
    if (!byNo.has(no)) byNo.set(no, { noteNo: no, createdAt: new Date(r.created_at).toISOString(), createdBy: String(r.username ?? ""), lines: [] });
    byNo.get(no)!.lines.push(fgLine(r));
  }
  res.json({
    draft: head.length
      ? { savedBy: String(head[0].username ?? ""), savedAt: new Date(head[0].updated_at).toISOString(), lines: draft.map(fgLine) }
      : null,
    notes: [...byNo.values()],
  });
});

const boxQty = z.number().int().min(1).max(10_000_000).nullable();
const FgTransferBody = z.strictObject({
  final: z.boolean(),
  lines: z
    .array(
      z.strictObject({
        productName: z.string().trim().min(1).max(160),
        productType: z.string().trim().max(160),
        qtyInBox: boxQty,
        totalBox: boxQty,
        totalQty: boxQty,
        palletNo: z.string().trim().max(20),
        supervisor: z.string().trim().max(80),
      }),
    )
    .min(1)
    .max(300),
});

/** Saves the draft of a date whole; `final` turns it into a new numbered note instead and clears the draft. */
flowRouter.post("/fg-transfer/:date", async (req, res) => {
  if (!roleCan(req.user!.role, "production.report")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const date = planDate(req.params.date);
  const body = FgTransferBody.safeParse(req.body);
  if (!date || !body.success) {
    res.status(400).json({ error: "Invalid FG transfer note: every row needs a product; quantities are whole numbers above zero." });
    return;
  }
  const { final, lines } = body.data;
  if (final && lines.some((l) => l.qtyInBox === null || l.totalBox === null || l.totalQty === null || !l.supervisor)) {
    res.status(400).json({ error: "Before the final submit every row needs qty in box, total box, total qty and the supervisor name." });
    return;
  }
  const masters = await currentMasters();
  const unknown = lines.find((l) => !masters.productByName.has(l.productName));
  if (unknown) {
    res.status(400).json({ error: `Product "${unknown.productName}" is not in the product list.` });
    return;
  }
  const values = (key: string) =>
    lines.map((l, i) => [key, i + 1, masters.productByName.get(l.productName)!.id, l.productType, l.qtyInBox, l.totalBox, l.totalQty, l.palletNo, l.supervisor]);
  const COLS = "row_no, product_id, product_type, qty_in_box, total_box, total_qty, pallet_no, supervisor";
  const userId = req.user!.id;
  const noteNo = await withLocks([`fgnote:${date}`], async (conn) => {
    if (!final) {
      await conn.query(
        "INSERT INTO fg_transfer_drafts (note_date, updated_by) VALUES (?, ?) ON DUPLICATE KEY UPDATE updated_by = VALUES(updated_by), updated_at = CURRENT_TIMESTAMP(3)",
        [date, userId],
      );
      await conn.query("DELETE FROM fg_transfer_draft_lines WHERE note_date = ?", [date]);
      await conn.query(`INSERT INTO fg_transfer_draft_lines (note_date, ${COLS}) VALUES ?`, [values(date)]);
      return "";
    }
    const [seq] = await conn.query<ResultSetHeader>("UPDATE document_sequences SET last_no = LAST_INSERT_ID(last_no + 1) WHERE series = 'FTN'");
    if (seq.affectedRows !== 1) throw new Error("Document series FTN is not set up — run npm run db:setup.");
    const no = `FTN-${date.replaceAll("-", "")}-${String(seq.insertId).padStart(4, "0")}`;
    await conn.query("INSERT INTO fg_transfer_notes (note_no, note_date, created_by) VALUES (?, ?, ?)", [no, date, userId]);
    await conn.query(`INSERT INTO fg_transfer_note_lines (note_no, ${COLS}) VALUES ?`, [values(no)]);
    await conn.query("DELETE FROM fg_transfer_drafts WHERE note_date = ?", [date]);
    return no;
  });
  await audit(req, { action: "production.fgnote", outcome: "ok", message: final ? `${noteNo}: ${lines.length} rows` : `FG transfer draft ${date}: ${lines.length} rows` });
  res.json({ ok: true, noteNo });
});

/* ── FG transfer verify: the FG warehouse counts a final-submitted note and marks it received ─── */

const seesFgNotes = (role: Role) => ROLE_PROFILES[role].tabs.includes("fg") || ROLE_PROFILES[role].tabs.includes("production");

/** Notes to pick from: every one not yet received, and the last 60 days' received ones. */
flowRouter.get("/fg-transfer-notes", async (req, res) => {
  if (!seesFgNotes(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT n.note_no, DATE_FORMAT(n.note_date, '%d-%m-%Y') AS day, COUNT(*) AS rows_n,
            SUM(COALESCE(l.total_qty, l.qty_in_box * l.total_box, 0)) AS total, v.verified_by, v.created_at AS received_at
       FROM fg_transfer_notes n
       JOIN fg_transfer_note_lines l ON l.note_no = n.note_no
       LEFT JOIN fg_transfer_receipts v ON v.note_no = n.note_no
      WHERE v.note_no IS NULL OR v.created_at > NOW() - INTERVAL 60 DAY
      GROUP BY n.note_no ORDER BY n.created_at DESC`,
  );
  res.json({
    notes: r.map((x) => ({
      noteNo: String(x.note_no),
      date: String(x.day),
      rows: Number(x.rows_n),
      totalQty: Number(x.total),
      status: x.verified_by === null ? "PENDING" : "RECEIVED",
      verifiedBy: String(x.verified_by ?? ""),
      receivedAt: x.received_at ? new Date(x.received_at).toISOString() : "",
    })),
  });
});

/** One note's rows, with the warehouse's count once received. */
flowRouter.get("/fg-transfer-notes/:no", async (req, res) => {
  if (!seesFgNotes(req.user!.role)) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const no = String(req.params.no).slice(0, 24);
  const [[head], [lines]] = await Promise.all([
    pool.query<RowDataPacket[]>(
      `SELECT DATE_FORMAT(n.note_date, '%d-%m-%Y') AS day, v.verified_by, v.created_at AS received_at
         FROM fg_transfer_notes n LEFT JOIN fg_transfer_receipts v ON v.note_no = n.note_no WHERE n.note_no = ?`,
      [no],
    ),
    pool.query<RowDataPacket[]>(
      `SELECT ${FG_LINE_COLS}, rl.verified_qty, rl.remark
         FROM fg_transfer_note_lines l JOIN products p ON p.id = l.product_id
         LEFT JOIN fg_transfer_receipt_lines rl ON rl.note_no = l.note_no AND rl.row_no = l.row_no
        WHERE l.note_no = ? ORDER BY l.row_no`,
      [no],
    ),
  ]);
  if (!head.length) {
    res.status(404).json({ error: `FG transfer note ${no} not found.` });
    return;
  }
  res.json({
    noteNo: no,
    date: String(head[0].day),
    status: head[0].verified_by === null ? "PENDING" : "RECEIVED",
    verifiedBy: String(head[0].verified_by ?? ""),
    receivedAt: head[0].received_at ? new Date(head[0].received_at).toISOString() : "",
    lines: lines.map((l) => ({ ...fgLine(l), verifiedQty: l.verified_qty === null ? null : Number(l.verified_qty), remark: String(l.remark ?? "") })),
  });
});

const FgReceiveBody = z.strictObject({
  verifiedBy: z.string().trim().min(1).max(80),
  lines: z.array(z.strictObject({ verifiedQty: z.number().int().min(0).max(10_000_000), remark: z.string().trim().max(200) })).min(1).max(300),
});

/** The warehouse's count of every row (in row order); the note is then RECEIVED and cannot change. */
flowRouter.post("/fg-transfer-notes/:no/receive", async (req, res) => {
  if (!roleCan(req.user!.role, "fg.receive")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = FgReceiveBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Fill in who verified, and the verified qty (0 or more, whole number) of every row." });
    return;
  }
  const no = String(req.params.no).slice(0, 24);
  const { verifiedBy, lines } = body.data;
  try {
    await withLocks([`fgrecv:${no}`], async (conn) => {
      const [rows] = await conn.query<RowDataPacket[]>(
        `SELECT l.row_no, (SELECT 1 FROM fg_transfer_receipts v WHERE v.note_no = l.note_no) AS done
           FROM fg_transfer_note_lines l WHERE l.note_no = ? ORDER BY l.row_no`,
        [no],
      );
      if (!rows.length) throw new FlowError(`FG transfer note ${no} not found.`);
      if (rows[0].done) throw new FlowError(`${no} is already received.`);
      if (rows.length !== lines.length) throw new FlowError("The note's rows changed — reload it and try again.");
      await conn.query("INSERT INTO fg_transfer_receipts (note_no, verified_by, created_by) VALUES (?, ?, ?)", [no, verifiedBy, req.user!.id]);
      await conn.query("INSERT INTO fg_transfer_receipt_lines (note_no, row_no, verified_qty, remark) VALUES ?", [
        rows.map((r, i) => [no, r.row_no, lines[i].verifiedQty, lines[i].remark]),
      ]);
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "fg.receiveNote", outcome: "ok", message: `${no} received, verified by ${verifiedBy}` });
  res.json({ ok: true });
});

/* ── pending work counts for the "Your pending work" strip (numbers only; each screen checks its own access) ─── */

flowRouter.get("/pending-counts", async (_req, res) => {
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT
       (SELECT COUNT(*) FROM bom_returns WHERE status = 'PENDING') AS mrn_to_verify,
       (SELECT COUNT(*) FROM bom_issue_slips s WHERE NOT EXISTS (SELECT 1 FROM bom_verifications v WHERE v.bom_no = s.bom_no)
                                                AND s.created_at > NOW() - INTERVAL 60 DAY) AS boms_to_verify,
       (SELECT COUNT(*) FROM indent_requests r WHERE r.status = 'VERIFIED'
                                                AND NOT EXISTS (SELECT 1 FROM purchase_indents i WHERE i.request_no = r.request_no)) AS requests_to_indent,
       (SELECT COUNT(*) FROM bulk_report_lines l JOIN bulk_reports b ON b.report_date = l.report_date AND b.final_at IS NOT NULL
          LEFT JOIN bulk_qt q ON q.report_date = l.report_date AND q.row_no = l.row_no
         WHERE l.actual_qty > 0 AND (q.status IS NULL OR q.status = 'HOLD')) AS bulk_to_test,
       (SELECT COUNT(*) FROM fg_transfer_notes n WHERE NOT EXISTS (SELECT 1 FROM fg_transfer_receipts v WHERE v.note_no = n.note_no)) AS notes_to_receive`,
  );
  const x = r[0];
  res.json({
    mrnToVerify: Number(x.mrn_to_verify),
    bomsToVerify: Number(x.boms_to_verify),
    requestsToIndent: Number(x.requests_to_indent),
    bulkToTest: Number(x.bulk_to_test),
    notesToReceive: Number(x.notes_to_receive),
  });
});

/* ── supervisor BOM verify: what reached the line, per issued BOM list ─────────── */

/** BOM lists Store issued on a date (yyyy-mm-dd), with each one's verification if done. */
flowRouter.get("/production-verifications/:date", async (req, res) => {
  const tabs = ROLE_PROFILES[req.user!.role].tabs;
  if (!tabs.includes("production") && !tabs.includes("store")) {
    res.status(403).json({ error: "Not allowed." });
    return;
  }
  const date = planDate(req.params.date);
  if (!date) {
    res.status(400).json({ error: "Invalid date." });
    return;
  }
  const [r] = await pool.query<RowDataPacket[]>(
    `SELECT s.bom_no, s.filled_by, s.created_at, l.line_no, l.component_code, c.name, c.unit, l.required_qty, l.issued_qty, l.remark,
            v.verified_by, v.created_at AS verified_at, vl.received_qty
       FROM bom_issue_slips s
       JOIN bom_issue_lines l ON l.bom_no = s.bom_no
       JOIN components c ON c.code = l.component_code
       LEFT JOIN bom_verifications v ON v.bom_no = s.bom_no
       LEFT JOIN bom_verification_lines vl ON vl.bom_no = l.bom_no AND vl.line_no = l.line_no
      WHERE s.created_at >= ? AND s.created_at < ? + INTERVAL 1 DAY
      ORDER BY s.created_at, l.line_no`,
    [date, date],
  );
  const slips = new Map<string, { bomNo: string; filledBy: string; issuedAt: string; verifiedBy: string; verifiedAt: string; lines: unknown[] }>();
  for (const x of r) {
    const no = String(x.bom_no);
    let s = slips.get(no);
    if (!s) {
      slips.set(no, (s = {
        bomNo: no,
        filledBy: String(x.filled_by),
        issuedAt: new Date(x.created_at).toISOString(),
        verifiedBy: x.verified_by === null ? "" : String(x.verified_by),
        verifiedAt: x.verified_at === null ? "" : new Date(x.verified_at).toISOString(),
        lines: [],
      }));
    }
    s.lines.push({
      code: String(x.component_code),
      name: String(x.name),
      unit: String(x.unit) || "Pcs",
      required: Number(x.required_qty),
      issued: Number(x.issued_qty),
      remark: String(x.remark),
      received: x.received_qty === null ? null : Number(x.received_qty),
    });
  }
  res.json({ slips: [...slips.values()] });
});

const VerifyBody = z.strictObject({
  verifiedBy: z.string().trim().min(1).max(80),
  boms: z
    .array(z.strictObject({ bomNo: z.string().max(24), received: z.array(z.number().finite().min(0).max(1e9)).min(1).max(2000) }))
    .min(1)
    .max(100),
});

/** Marks issued BOM lists verified with what the line received. Each once; received never above what was issued. */
flowRouter.post("/production-verifications", async (req, res) => {
  if (!roleCan(req.user!.role, "production.verify")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const body = VerifyBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Invalid verification: fill in who verified and the received qty (0 or more) of every item." });
    return;
  }
  const { verifiedBy, boms } = body.data;
  try {
    await withLocks(boms.map((b) => `bom:${b.bomNo}`), async (conn) => {
      for (const b of boms) {
        const [lines] = await conn.query<RowDataPacket[]>(
          `SELECT l.line_no, l.issued_qty, c.name FROM bom_issue_lines l JOIN components c ON c.code = l.component_code
            WHERE l.bom_no = ? ORDER BY l.line_no`,
          [b.bomNo],
        );
        if (!lines.length) throw new FlowError(`BOM ${b.bomNo} has not been issued.`);
        const [done] = await conn.query<RowDataPacket[]>("SELECT 1 FROM bom_verifications WHERE bom_no = ?", [b.bomNo]);
        if (done.length) throw new FlowError(`BOM ${b.bomNo} is already verified.`);
        if (b.received.length !== lines.length) throw new FlowError(`BOM ${b.bomNo}: the items do not match the issue slip — reload and try again.`);
        for (const [i, l] of lines.entries()) {
          if (b.received[i] > Number(l.issued_qty) + 0.0005) {
            throw new FlowError(`BOM ${b.bomNo}: received ${String(l.name)} cannot be more than was issued (${Number(l.issued_qty)}).`);
          }
        }
        await conn.query("INSERT INTO bom_verifications (bom_no, verified_by, created_by) VALUES (?, ?, ?)", [b.bomNo, verifiedBy, req.user!.id]);
        await conn.query("INSERT INTO bom_verification_lines (bom_no, line_no, received_qty) VALUES ?", [
          lines.map((l, i) => [b.bomNo, Number(l.line_no), Math.round(b.received[i] * 1000) / 1000]),
        ]);
      }
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.verify", outcome: "ok", message: `${boms.map((b) => b.bomNo).join(", ")} verified by ${verifiedBy}` });
  res.json({ ok: true });
});

/** Cancels an open BOM list: it stops holding PM stock and leaves the issue list. Its plan stays as it is. */
flowRouter.post("/production-boms/:bomNo/cancel", async (req, res) => {
  if (!roleCan(req.user!.role, "production.bom")) {
    res.status(403).json({ error: "Your login is not allowed to do this." });
    return;
  }
  const bomNo = String(req.params.bomNo).slice(0, 24);
  const body = z.strictObject({ reason: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: "Give a reason for cancelling." });
    return;
  }
  try {
    await withLocks([`bom:${bomNo}`], async (conn) => {
      const [open] = await conn.query<RowDataPacket[]>(`SELECT 1 FROM bom_documents d WHERE d.bom_no = ? AND ${OPEN_BOM}`, [bomNo]);
      if (!open.length) throw new FlowError(`BOM ${bomNo} is not open (already issued, cancelled or replaced by a newer list).`);
      await conn.query("INSERT INTO bom_cancellations (bom_no, reason, created_by) VALUES (?, ?, ?)", [bomNo, body.data.reason, req.user!.id]);
    });
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    res.status(409).json({ error: e.message });
    return;
  }
  await audit(req, { action: "production.cancel", outcome: "ok", message: `${bomNo} cancelled: ${body.data.reason}` });
  res.json({ ok: true });
});

/* ── demo reset: admin only, switched on per system, re-authenticated ─────────── */

/** The phrase the admin must type — the server checks it, not only the browser. */
export const RESET_PHRASES = { clear: "CLEAR ALL", load: "LOAD DEMO" } as const;

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Counts failed attempts per account; a correct reset does not use up the allowance.
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `user:${req.user?.id ?? "anon"}`,
  message: { error: "Too many reset attempts. Try again in 15 minutes." },
});

const ResetBody = z.strictObject({
  password: z.string().min(1).max(200),
  confirm: z.string().max(40),
});

flowRouter.post("/demo/:op", resetLimiter, async (req, res) => {
  const user = req.user!;
  const op = String(req.params.op);
  if (op !== "load" && op !== "clear") {
    res.status(404).json({ error: "Unknown operation." });
    return;
  }
  if (!config.ALLOW_DEMO_RESET || !roleCan(user.role, "demo.data")) {
    await audit(req, { action: `demo.${op}`, outcome: "denied" });
    res.status(403).json({ error: "Demo reset is switched off on this system." });
    return;
  }
  if (op !== "load" && op !== "clear") {
    res.status(404).json({ error: "Unknown operation." });
    return;
  }
  const body = ResetBody.safeParse(req.body);
  if (!body.success || body.data.confirm.trim() !== RESET_PHRASES[op]) {
    await audit(req, { action: `demo.${op}`, outcome: "invalid", message: "confirmation phrase missing or wrong" });
    res.status(400).json({ error: `Type ${RESET_PHRASES[op]} exactly to confirm.` });
    return;
  }

  // Re-authenticate: an unattended screen or a stolen session is not enough to wipe the registers.
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT password_hash, (locked_until IS NOT NULL AND locked_until > NOW(3)) AS locked FROM users WHERE id = ?",
    [user.id],
  );
  if (!rows[0] || Number(rows[0].locked) === 1) {
    await audit(req, { action: `demo.${op}`, outcome: "denied", message: "account locked" });
    res.status(429).json({ error: "This login is locked after wrong passwords. Try again later." });
    return;
  }
  if (!(await verifyPassword(body.data.password, rows[0].password_hash))) {
    // Wrong passwords here count toward the same lockout as at login.
    await pool.execute("UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?", [user.id]);
    await pool.execute(
      `UPDATE users SET failed_logins = 0, locked_until = DATE_ADD(NOW(3), INTERVAL ? MINUTE)
        WHERE id = ? AND failed_logins >= ?`,
      [config.LOGIN_LOCK_MINUTES, user.id, config.LOGIN_MAX_FAILURES],
    );
    await audit(req, { action: `demo.${op}`, outcome: "denied", message: "wrong password" });
    res.status(403).json({ error: "Wrong password — nothing was changed." });
    return;
  }
  await pool.execute("UPDATE users SET failed_logins = 0 WHERE id = ?", [user.id]);

  const snapshotId = await withLocks(["maintenance:reset"], async (conn) => {
    const before = await loadState(conn);
    // Safety copy first — in the same transaction, so there is never a reset without one.
    const id = await saveSnapshot(conn, before, `before demo.${op}`, user);
    await audit(req, { action: `demo.${op}`, outcome: "ok", message: `snapshot #${id} saved (${countDocuments(before)} documents)` }, conn);
    await persistChanges(conn, before, op === "load" ? seedState() : emptyState(), user.id, true);
    return id;
  });
  const { version, resyncVersion, state } = await fullState();
  res.json({ version, resyncVersion, state: scopeStateFor(user.role, state), snapshotId });
});

import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import rateLimit from "express-rate-limit";
import type { RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { emptyState, FlowError, NUMBER_TAKEN } from "../../src/flow/logic";
import { PERMS, PRICE_ROLES, READ_SCOPES, roleCan } from "../../src/flow/perms";
import type { FlowState } from "../../src/flow/types";
import { seedState } from "../seed/demoStory";
import { ACTIONS, applyAction, context, describeIssues, isActionName } from "./actions";
import { audit } from "./audit";
import { config } from "./config";
import { verifyPassword } from "./crypto";
import { pool, type Conn, type Queryable } from "./db";
import { PLANS } from "./plans";
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
  res.json({ ...(await getVersions(pool)), mastersVersion: await getMastersVersion(pool) });
});

/** Everything this role may see — on login, and whenever a full reload is requested. */
flowRouter.get("/state", async (req, res) => {
  const { version, resyncVersion, state } = await fullState();
  res.json({ version, resyncVersion, state: scopeStateFor(req.user!.role, state) });
});

/** Only the documents changed after `since` — what a screen polls for. */
flowRouter.get("/changes", async (req, res) => {
  const since = Number(req.query.since);
  if (!Number.isInteger(since) || since < 0) {
    res.status(400).json({ error: "Invalid version." });
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
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    await withLocks([`doc:purchaseOrders:${poNo}`], (conn) => markPush(conn, poNo, error));
    await audit(req, { action: "tally.push", outcome: error ? "rejected" : "ok", message: `${poNo}: ${error || "created in Tally"}` });
  } catch (e) {
    console.error(JSON.stringify({ msg: "tally push result not saved", poNo, err: String(e) }));
  }
  return error;
}

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

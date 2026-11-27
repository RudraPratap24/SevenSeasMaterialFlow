/**
 * Admin page API (/api/admin, role admin only): the shared masters every module reads.
 *   users                      list · check name · add · edit · enable/disable · new starting password
 *   items | fg | vendors       list (search, 100 a page) · add · edit
 *   rates                      item ↔ vendor: list for an item · save · remove
 * Every change is written to the audit log. Encrypted columns (phone, bank account, rate) are decrypted only here.
 */
import { Router, type Request, type Response } from "express";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { z } from "zod";
import { audit } from "../audit";
import { passwordProblem } from "../authRoutes";
import { decryptValue, encryptValue, hashPassword } from "../crypto";
import { pool } from "../db";
import { photoId } from "../photos";
import { ROLE_LABELS, ROLES } from "../roles";

export const adminRouter = Router();

adminRouter.use((req, res, next) => {
  if (!req.user) return void res.status(401).json({ error: "Please log in." });
  if (req.user.mustChangePassword) return void res.status(403).json({ error: "Please set a new password first.", code: "PASSWORD_CHANGE_REQUIRED" });
  if (req.user.role !== "admin") return void res.status(403).json({ error: "Only the admin can do this." });
  next();
});

const q = async (sql: string, params: unknown[] = []) => (await pool.query<RowDataPacket[]>(sql, params))[0];
const bad = (res: Response, error: string, status = 400) => void res.status(status).json({ error });
const dup = (e: unknown) => (e as { code?: string }).code === "ER_DUP_ENTRY";

/* ── masters: one description per table drives list, add and edit ────────────── */

interface Field {
  col: string;
  label: string;
  max: number;
  /** stored encrypted (encryptValue); NULL when empty */
  enc?: boolean;
  options?: string[];
  required?: boolean;
  /** an empty value is stored as NULL (unique columns) */
  nullable?: boolean;
  /** an item photo: a Google Drive link or id (or our file id), stored as the id */
  photo?: boolean;
}
interface Master {
  table: string;
  key: string;
  /** the key is typed by the admin (item code) rather than numbered by the database */
  keyTyped?: boolean;
  search: string[];
  fields: Field[];
}
const PS_ITEM: Field[] = [
  { col: "ps_item_type", label: "Item type", max: 80 },
  { col: "ps_uom", label: "UOM", max: 20 },
  { col: "ps_pack_size", label: "Pack size", max: 120 },
  { col: "ps_status", label: "Status", max: 40, options: ["Active", "Inactive"] },
  { col: "ps_hsn", label: "HSN", max: 20 },
  { col: "ps_gst", label: "GST %", max: 10 },
  { col: "ps_moq", label: "MOQ", max: 20 },
  { col: "ps_mrp", label: "MRP", max: 40 },
  { col: "ps_spec", label: "Specification", max: 1000 },
  { col: "ps_remarks", label: "Remarks", max: 1000 },
  { col: "ps_photo", label: "Photo (Google Drive link)", max: 500, photo: true },
];
const MASTERS: Record<string, Master> = {
  items: {
    table: "components", key: "code", keyTyped: true, search: ["code", "name", "category"],
    fields: [
      { col: "code", label: "Code", max: 16, required: true },
      { col: "name", label: "Name", max: 160, required: true },
      { col: "kind", label: "Kind", max: 8, options: ["PM", "RM", "BULK", "PROMO", "MRO"], required: true },
      { col: "category", label: "Category", max: 60 },
      { col: "origin", label: "Origin", max: 20 },
      { col: "unit", label: "Unit", max: 16 },
      { col: "ps_brand", label: "Brand", max: 60 },
      ...PS_ITEM,
      { col: "active", label: "Active", max: 1, options: ["1", "0"] },
    ],
  },
  fg: {
    table: "products", key: "id", search: ["name", "fg_code", "category", "brand"],
    fields: [
      { col: "name", label: "Name", max: 160, required: true },
      { col: "fg_code", label: "FG code", max: 80 },
      { col: "category", label: "Category", max: 60 },
      { col: "brand", label: "Brand", max: 60 },
      { col: "origin", label: "Origin", max: 20 },
      { col: "ps_type", label: "Type", max: 60 },
      ...PS_ITEM,
      { col: "active", label: "Active", max: 1, options: ["1", "0"] },
    ],
  },
  vendors: {
    table: "suppliers", key: "id", search: ["name", "vendor_code", "city", "gstin"],
    fields: [
      { col: "name", label: "Name", max: 120, required: true },
      { col: "vendor_code", label: "Vendor code", max: 20, nullable: true },
      { col: "vm_status", label: "Status", max: 40, options: ["Active", "Inactive"], nullable: true },
      { col: "contact_person", label: "Contact person", max: 160 },
      { col: "phone_enc", label: "Phone", max: 40, enc: true },
      { col: "email", label: "Email", max: 255 },
      { col: "address", label: "Address", max: 600 },
      { col: "city", label: "City", max: 80 },
      { col: "gstin", label: "GSTIN", max: 20 },
      { col: "payment_terms", label: "Payment terms", max: 160 },
      { col: "bank_account_enc", label: "Bank account", max: 40, enc: true },
      { col: "ifsc", label: "IFSC", max: 20 },
      { col: "bank_name", label: "Bank name", max: 120 },
      { col: "udyam_no", label: "Udyam no.", max: 60 },
      { col: "active", label: "Active", max: 1, options: ["1", "0"] },
    ],
  },
};

const master = (req: Request, res: Response) => {
  const m = Object.hasOwn(MASTERS, String(req.params.master)) ? MASTERS[String(req.params.master)] : undefined;
  if (!m) bad(res, "Unknown list.", 404);
  return m;
};
const out = (m: Master, r: RowDataPacket) => {
  const o: Record<string, string> = { _key: String(r[m.key]) };
  for (const f of m.fields) o[f.col] = r[f.col] === null || r[f.col] === undefined ? "" : f.enc ? String(decryptValue(String(r[f.col]))) : String(r[f.col]);
  return o;
};
/** the submitted values, checked against the description; `partial` for edits (only what was sent) */
function values(m: Master, body: unknown, partial: boolean): Record<string, string | null> | string {
  if (!body || typeof body !== "object") return "Invalid request.";
  const v: Record<string, string | null> = {};
  for (const f of m.fields) {
    const raw = (body as Record<string, unknown>)[f.col];
    if (raw === undefined) {
      if (!partial && f.required) return `${f.label} is required.`;
      continue;
    }
    const s = String(raw).trim();
    if (s.length > f.max) return `${f.label}: at most ${f.max} characters.`;
    if (f.required && !s) return `${f.label} is required.`;
    if (f.options && s && !f.options.includes(s)) return `${f.label}: one of ${f.options.join(", ")}.`;
    if (f.photo) {
      const id = photoId(s);
      if (id === null) return `${f.label}: paste the Google Drive link of the photo (…/file/d/<id>/view).`;
      v[f.col] = id;
      continue;
    }
    v[f.col] = f.enc ? (s ? encryptValue(s) : null) : f.nullable && !s ? null : s;
  }
  if (partial && m.keyTyped) delete v[m.key]; // an item's code is its identity: never edited
  return Object.keys(v).length ? v : "Nothing to save.";
}
const fieldInfo = (m: Master) => m.fields.map(({ col, label, max, options, required, photo }) => ({ col, label, max, options, required, photo, key: m.keyTyped && col === m.key }));

adminRouter.get("/meta", (_req, res) => {
  res.json({
    masters: Object.fromEntries(Object.entries(MASTERS).map(([k, m]) => [k, fieldInfo(m)])),
    roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r] })),
  });
});

/* ── users (Purchase System fields included: its login name, steps, item types, email) ── */

const LOGIN_ID = /^[a-z0-9._-]{3,40}$/;
const UserBody = z.strictObject({
  username: z.string().trim().toLowerCase().regex(LOGIN_ID),
  role: z.enum(ROLES),
  label: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  password: z.string().max(128),
  psName: z.string().trim().max(120).optional(),
  psAccess: z.string().trim().max(120).optional(),
  psTypes: z.string().trim().max(120).optional(),
  psEmail: z.string().trim().max(255).optional(),
});
const UserEdit = UserBody.omit({ username: true, password: true }).partial();
const psCols = (b: { psName?: string; psAccess?: string; psTypes?: string; psEmail?: string }) => ({
  ...(b.psName !== undefined ? { ps_name: b.psName || null } : {}),
  ...(b.psAccess !== undefined ? { ps_access: b.psAccess } : {}),
  ...(b.psTypes !== undefined ? { ps_types: b.psTypes } : {}),
  ...(b.psEmail !== undefined ? { ps_email: b.psEmail } : {}),
});
const signOut = (username: string) => pool.execute("DELETE s FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.username = ?", [username]);

adminRouter.get("/users", async (_req, res) => {
  const rows = await q(
    `SELECT username, role, label, full_name, active, ps_name, ps_access, ps_types, ps_email,
            DATE_FORMAT(last_login_at, '%Y-%m-%d %H:%i') AS last_login FROM users ORDER BY id`,
  );
  res.json({
    users: rows.map((r) => ({
      username: r.username, role: r.role, label: r.label, name: r.full_name, active: Number(r.active) === 1, lastLogin: r.last_login ?? "",
      psName: r.ps_name ?? "", psAccess: r.ps_access, psTypes: r.ps_types, psEmail: r.ps_email,
    })),
  });
});

adminRouter.get("/users/check", async (req, res) => {
  const username = String(req.query.username ?? "").trim().toLowerCase();
  if (!LOGIN_ID.test(username)) return bad(res, "Username: 3–40 of a-z 0-9 . _ -");
  res.json({ taken: (await q("SELECT 1 FROM users WHERE username = ?", [username])).length > 0 });
});

adminRouter.post("/users", async (req, res) => {
  const body = UserBody.safeParse(req.body);
  if (!body.success) return bad(res, "Fill username (3–40 of a-z 0-9 . _ -), role, label, name and password.");
  const b = body.data;
  const weak = passwordProblem(b.password, b.username);
  if (weak) return bad(res, weak);
  const extra = psCols(b);
  try {
    await pool.query("INSERT INTO users SET ?", [
      { username: b.username, password_hash: await hashPassword(b.password), role: b.role, label: b.label, full_name: b.name, must_change_password: 1, ...extra },
    ]);
  } catch (e) {
    if (dup(e)) return bad(res, `Username ${b.username} or Purchase System name is taken.`, 409);
    throw e;
  }
  await audit(req, { action: "user.create", outcome: "ok", message: `${b.username} (${b.role}) — ${b.name}` });
  res.json({ username: b.username });
});

adminRouter.put("/users/:username", async (req, res) => {
  const username = String(req.params.username).toLowerCase();
  const body = UserEdit.safeParse(req.body);
  if (!body.success || !LOGIN_ID.test(username)) return bad(res, "Invalid request.");
  const b = body.data;
  if (b.role && b.role !== "admin" && username === req.user!.username.toLowerCase()) return bad(res, "You cannot change your own role.", 409);
  const set = { ...(b.role ? { role: b.role } : {}), ...(b.label ? { label: b.label } : {}), ...(b.name ? { full_name: b.name } : {}), ...psCols(b) };
  if (!Object.keys(set).length) return bad(res, "Nothing to save.");
  try {
    const [r] = await pool.query<ResultSetHeader>("UPDATE users SET ? WHERE username = ?", [set, username]);
    if (!r.affectedRows) return bad(res, `No user ${username}.`, 404);
  } catch (e) {
    if (dup(e)) return bad(res, "That Purchase System name is taken.", 409);
    throw e;
  }
  if (b.role) await signOut(username); // every screen reloads with the new role
  await audit(req, { action: "user.edit", outcome: "ok", message: `${username}: ${Object.keys(set).join(", ")}` });
  res.json({ ok: true });
});

adminRouter.post("/users/:username/active", async (req, res) => {
  const username = String(req.params.username).toLowerCase();
  const body = z.strictObject({ active: z.boolean() }).safeParse(req.body);
  if (!body.success || !LOGIN_ID.test(username)) return bad(res, "Invalid request.");
  if (username === req.user!.username.toLowerCase()) return bad(res, "You cannot disable your own login.", 409);
  const [r] = await pool.execute<ResultSetHeader>("UPDATE users SET active = ? WHERE username = ?", [body.data.active ? 1 : 0, username]);
  if (!r.affectedRows) return bad(res, `No user ${username}.`, 404);
  if (!body.data.active) await signOut(username);
  await audit(req, { action: body.data.active ? "user.enable" : "user.disable", outcome: "ok", message: username });
  res.json({ ok: true });
});

/** a new starting password from the admin; the person must replace it at next login */
adminRouter.post("/users/:username/password", async (req, res) => {
  const username = String(req.params.username).toLowerCase();
  const body = z.strictObject({ password: z.string().max(128) }).safeParse(req.body);
  if (!body.success || !LOGIN_ID.test(username)) return bad(res, "Invalid request.");
  const weak = passwordProblem(body.data.password, username);
  if (weak) return bad(res, weak);
  const [r] = await pool.execute<ResultSetHeader>(
    "UPDATE users SET password_hash = ?, must_change_password = 1, failed_logins = 0, locked_until = NULL WHERE username = ?",
    [await hashPassword(body.data.password), username],
  );
  if (!r.affectedRows) return bad(res, `No user ${username}.`, 404);
  await signOut(username);
  await audit(req, { action: "user.reset-password", outcome: "ok", message: username });
  res.json({ ok: true });
});

/* ── item ↔ vendor (rate encrypted; empty = vendor supplies it without a fixed rate) ── */

adminRouter.get("/rates", async (req, res) => {
  const code = String(req.query.code ?? "");
  const rows = await q(
    `SELECT r.supplier_id, s.name, s.vendor_code, r.rate_enc, r.vendor_item_name
       FROM supplier_rates r JOIN suppliers s ON s.id = r.supplier_id WHERE r.component_code = ? ORDER BY r.ps_row IS NULL, r.ps_row, s.name`,
    [code],
  );
  res.json({
    rates: rows.map((r) => ({ supplierId: Number(r.supplier_id), vendor: r.name, vendorCode: r.vendor_code ?? "", rate: r.rate_enc ? String(decryptValue(String(r.rate_enc))) : "", vendorItem: r.vendor_item_name })),
  });
});

const RateBody = z.strictObject({
  code: z.string().trim().min(1).max(16),
  supplierId: z.number().int().positive(),
  rate: z.string().trim().max(20).regex(/^(\d+(\.\d+)?)?$/),
  vendorItem: z.string().trim().max(300),
});
adminRouter.put("/rates", async (req, res) => {
  const body = RateBody.safeParse(req.body);
  if (!body.success) return bad(res, "Choose the vendor; the rate is a number or empty.");
  const b = body.data;
  if (!(await q("SELECT 1 FROM components WHERE code = ?", [b.code])).length) return bad(res, `No item ${b.code}.`, 404);
  if (!(await q("SELECT 1 FROM suppliers WHERE id = ?", [b.supplierId])).length) return bad(res, "No such vendor.", 404);
  await pool.execute(
    `INSERT INTO supplier_rates (supplier_id, component_code, rate_enc, vendor_item_name) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE rate_enc = VALUES(rate_enc), vendor_item_name = VALUES(vendor_item_name)`,
    [b.supplierId, b.code, b.rate ? encryptValue(b.rate) : null, b.vendorItem],
  );
  await audit(req, { action: "rate.save", outcome: "ok", message: `${b.code} ← vendor ${b.supplierId}`, payload: { rate: b.rate } });
  res.json({ ok: true });
});

adminRouter.delete("/rates/:supplierId/:code", async (req, res) => {
  const [r] = await pool.execute<ResultSetHeader>("DELETE FROM supplier_rates WHERE supplier_id = ? AND component_code = ?", [
    Number(req.params.supplierId), String(req.params.code),
  ]);
  if (!r.affectedRows) return bad(res, "Not found.", 404);
  await audit(req, { action: "rate.remove", outcome: "ok", message: `${req.params.code} ← vendor ${req.params.supplierId}` });
  res.json({ ok: true });
});

/* ── masters (after the fixed paths above) ─────────────────────────────────────── */

adminRouter.get("/:master", async (req, res) => {
  const m = master(req, res);
  if (!m) return;
  const text = String(req.query.q ?? "").trim().slice(0, 80);
  const page = Math.max(0, Math.floor(Number(req.query.page) || 0));
  const where = text ? "WHERE " + m.search.map((c) => `${c} LIKE ?`).join(" OR ") : "";
  const params = text ? m.search.map(() => `%${text.replace(/[\\%_]/g, (c) => "\\" + c)}%`) : [];
  const [{ n }] = await q(`SELECT COUNT(*) AS n FROM ${m.table} ${where}`, params);
  const rows = await q(`SELECT ${m.key}, ${m.fields.map((f) => f.col).join(", ")} FROM ${m.table} ${where} ORDER BY ${m.key === "id" ? "name" : m.key} LIMIT 100 OFFSET ?`, [...params, page * 100]);
  res.json({ total: Number(n), page, rows: rows.map((r) => out(m, r)) });
});

adminRouter.post("/:master", async (req, res) => {
  const m = master(req, res);
  if (!m) return;
  const v = values(m, req.body, false);
  if (typeof v === "string") return bad(res, v);
  try {
    const [r] = await pool.query<ResultSetHeader>(`INSERT INTO ${m.table} SET ?`, [v]);
    await audit(req, { action: `${req.params.master}.create`, outcome: "ok", message: String(v.name ?? "") });
    res.json({ key: m.keyTyped ? v[m.key] : r.insertId });
  } catch (e) {
    if (dup(e)) return bad(res, "Already on the list (same name or code).", 409);
    throw e;
  }
});

adminRouter.put("/:master/:key", async (req, res) => {
  const m = master(req, res);
  if (!m) return;
  const v = values(m, req.body, true);
  if (typeof v === "string") return bad(res, v);
  try {
    const [r] = await pool.query<ResultSetHeader>(`UPDATE ${m.table} SET ? WHERE ${m.key} = ?`, [v, String(req.params.key)]);
    if (!r.affectedRows) return bad(res, "Not found.", 404);
  } catch (e) {
    if (dup(e)) return bad(res, "Another entry already has that name or code.", 409);
    throw e;
  }
  await audit(req, { action: `${req.params.master}.edit`, outcome: "ok", message: `${req.params.key}: ${Object.keys(v).join(", ")}` });
  res.json({ ok: true });
});

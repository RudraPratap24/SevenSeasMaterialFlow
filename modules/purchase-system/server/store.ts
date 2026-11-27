/**
 * Purchase System — reading the data the way the script read its sheets, and the few write helpers.
 * Everything is loaded per call (the data is small); nothing is cached between calls.
 */
import { createHash, randomBytes } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { config } from "../../../server/src/config";
import { decryptValue } from "../../../server/src/crypto";
import { pool, type Queryable } from "../../../server/src/db";
import {
  attachSets, blankStep, chemPacks, CFG, gateOf, groupPo, key, num, str, STEPS, toDate,
  type GrnRow, type Item, type Line, type PoRow,
} from "./core";

export async function rows(db: Queryable, sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [r] = await db.query<RowDataPacket[]>(sql, params);
  return r;
}
export async function exec(db: Queryable, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await db.query<ResultSetHeader>(sql, params);
  return r;
}

/** One writer at a time, like the script's LockService (30 s wait), inside one transaction. */
export async function withLock<T>(fn: (c: PoolConnection) => Promise<T>, waitSec = 30): Promise<T> {
  const c = await pool.getConnection();
  try {
    const [[got]] = await c.query<RowDataPacket[]>("SELECT GET_LOCK('ps_write', ?) AS ok", [waitSec]);
    if (Number(got.ok) !== 1) throw new Error("The system is busy. Please try again in 1 minute.");
    try {
      await c.beginTransaction();
      const out = await fn(c);
      await c.commit();
      return out;
    } catch (e) {
      await c.rollback();
      throw e;
    } finally {
      await c.query("SELECT RELEASE_LOCK('ps_write')");
    }
  } finally {
    c.release();
  }
}

/** the pool returns DATETIME as "yyyy-mm-dd hh:mm:ss" text (dateStrings): read as local time */
const d = (v: unknown): Date | null => (v === null || v === undefined || v === "" ? null : toDate(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/* ── FMS lines ── */
export async function loadLines(db: Queryable, where = "", params: unknown[] = []): Promise<Line[]> {
  // the line + the PO values it shows (its current PO's header and its own PO line)
  const ls = await rows(db, `SELECT l.*, pl.item_code, pl.qty, pl.rate, pl.total AS value, p.vendor, p.po_date, p.edd, p.pdf, p.lead_days
                               FROM ps_lines l LEFT JOIN ps_pos p ON p.po_no = l.po_no LEFT JOIN ps_po_lines pl ON pl.po_no = l.po_no AND pl.line_id = l.line_id
                               ${where} ORDER BY l.seq`, params);
  const st = ls.length ? await rows(db, `SELECT * FROM ps_line_steps WHERE line_id IN (?)`, [ls.map((l) => l.line_id)]) : [];
  const steps = new Map<string, RowDataPacket[]>();
  for (const s of st) steps.set(s.line_id, [...(steps.get(s.line_id) ?? []), s]);
  return ls.map((r): Line => {
    const own: Line["steps"] = {};
    for (const s of STEPS) own[s.id] = blankStep();
    for (const s of steps.get(r.line_id) ?? []) own[s.step] = { act: d(s.actual), st: str(s.status), ex: str(s.remark), nx: d(s.next_date), history: str(s.history) };
    return {
      id: r.line_id, seq: Number(r.seq), ts: d(r.ts), ind: str(r.indent_no), item: str(r.item), party: str(r.party), urg: str(r.urgency), by: str(r.filled_by), rem: str(r.remark),
      iqty: str(r.indent_qty), signed: str(r.signed_link), po: str(r.po_no), code: str(r.item_code), qty: n(r.qty), rate: n(r.rate), value: n(r.value), vendor: str(r.vendor),
      poDate: d(r.po_date), edd: d(r.edd), pdf: str(r.pdf), override: str(r.override), signedAt: d(r.signed_at), mailedAt: d(r.mailed_at), note: str(r.note),
      lead: str(r.lead_days), unit: str(r.unit), steps: own,
    };
  });
}

export async function loadPoRows(db: Queryable): Promise<PoRow[]> {
  const sql = `SELECT pl.id, p.po_no, p.po_date, p.edd, p.vendor, pl.item_code, pl.item_name, pl.hsn, pl.qty, pl.unit, pl.rate, pl.gst, pl.gst_amt, pl.amount, pl.total,
                      pl.indent_no, p.doer, p.pdf, p.approval, p.approved_by, p.approved_at, p.lead_days, IFNULL(pl.line_id, '') AS line_id, p.remarks, p.vendor_code,
                      pl.vendor_item, p.tax_type, pl.cgst, pl.sgst, pl.igst
                 FROM ps_po_lines pl JOIN ps_pos p ON p.po_no = pl.po_no ORDER BY pl.id`;
  return (await rows(db, sql)).map((r) => ({
    id: Number(r.id), po_no: str(r.po_no), po_date: d(r.po_date), edd: d(r.edd), vendor: str(r.vendor), item_code: str(r.item_code), item_name: str(r.item_name), hsn: str(r.hsn),
    qty: Number(r.qty), unit: str(r.unit), rate: Number(r.rate), gst: str(r.gst), gst_amt: Number(r.gst_amt), amount: Number(r.amount), total: Number(r.total),
    indent_no: str(r.indent_no), doer: str(r.doer), pdf: str(r.pdf), approval: str(r.approval), approved_by: str(r.approved_by), approved_at: d(r.approved_at),
    lead_days: str(r.lead_days), line_id: str(r.line_id), remarks: str(r.remarks), vendor_code: str(r.vendor_code), vendor_item: str(r.vendor_item), tax_type: str(r.tax_type),
    cgst: Number(r.cgst), sgst: Number(r.sgst), igst: Number(r.igst),
  }));
}

export async function loadGrn(db: Queryable): Promise<GrnRow[]> {
  return (await rows(db, "SELECT grn_id, gate_entry_id, po_no, po_line_code, po_item_name, po_qty, unit, store_received_qty, decision, approved_qty, po_status FROM ps_grn ORDER BY id")) as unknown as GrnRow[];
}

/** what calcRow needs: GRN received per PO line, POs grouped, today */
export async function context(db: Queryable, today: Date) {
  const poRows = await loadPoRows(db);
  return { gate: gateOf(await loadGrn(db)), po: groupPo(poRows), today, poRows };
}

/* ── Item Master (shared masters, as the script's items_()) ── */
export async function loadItems(db: Queryable): Promise<Item[]> {
  const comps = await rows(db, `SELECT code, name, type, category, ps_brand AS brand, origin, ps_item_type, ps_uom, ps_pack_size, ps_status, ps_photo, ps_hsn, ps_gst, ps_moq, 0 AS fg
                                  FROM components WHERE ps_item_type <> ''`);
  const fgs = await rows(db, `SELECT fg_code AS code, name, ps_type AS type, category, brand, origin, ps_item_type, ps_uom, ps_pack_size, ps_status, ps_photo, ps_hsn, ps_gst, ps_moq, 1 AS fg
                                FROM products WHERE ps_item_type <> ''`);
  const rates = await rows(db, `SELECT r.component_code, r.rate_enc, r.vendor_item_name, r.ps_origin, s.name AS vendor, s.vendor_code
                                  FROM supplier_rates r JOIN suppliers s ON s.id = r.supplier_id WHERE r.ps_row IS NOT NULL ORDER BY r.ps_row`);
  const byCode = new Map<string, Item>();
  const list: Item[] = [];
  for (const c of [...comps, ...fgs]) {
    const gsN = num(str(c.ps_gst).replace("%", ""));
    const it: Item = {
      n: str(c.name), s: str(c.code), t: str(c.ps_item_type), c: str(c.category), b: str(c.brand), u: str(c.ps_uom).toUpperCase(), pk: str(c.ps_pack_size),
      o: str(c.origin).toUpperCase() || "INDIAN", ph: str(c.ps_photo), st: str(c.ps_status), hs: str(c.ps_hsn), gs: str(c.ps_gst) !== "" && CFG.GST_RATES.includes(gsN) ? gsN : "",
      v: [], fg: Number(c.fg) === 1 ? 1 : 0, ty: str(c.ps_item_type) ? [str(c.ps_item_type)] : [], packs: str(c.ps_pack_size) ? [str(c.ps_pack_size)] : [],
      moq: num(c.ps_moq) > 0 ? num(c.ps_moq) : 0, pt: str(c.type),
    };
    if (Number(c.fg) !== 1) byCode.set(str(c.code), it);
    list.push(it);
  }
  for (const r of rates) {
    const it = byCode.get(str(r.component_code));
    if (!it || str(r.ps_origin) === "CHINA") continue;
    const cost = r.rate_enc ? Number(decryptValue<string>(String(r.rate_enc))) : 0;
    const old = it.v.find((x) => x[0].toLowerCase() === str(r.vendor).toLowerCase());
    if (!old) it.v.push([str(r.vendor), cost, str(r.vendor_item_name), str(r.vendor_code)]);
    else if (cost > 0 && (!(old[1] > 0) || cost < old[1])) old[1] = cost;
  }
  list.forEach((it) => it.v.sort((a, b) => (a[1] > 0 ? a[1] : 1e12) - (b[1] > 0 ? b[1] : 1e12)));
  list.forEach((it) => {
    it.ch = it.v.length > 1 && it.v[0][1] > 0 ? 1 : 0;
    it.pkgs = chemPacks(it.pk, it.u, it.ty, it.c);
  });
  attachSets(list);
  return list;
}
export function itemMap(list: Item[]): Record<string, Item> {
  const m: Record<string, Item> = {};
  list.forEach((it) => {
    m[it.n.toLowerCase()] = it;
    if (it.s && !m["sku:" + it.s.toLowerCase()]) m["sku:" + it.s.toLowerCase()] = it;
  });
  return m;
}
export const findItem = (m: Record<string, Item>, name: unknown, sku?: unknown) =>
  m[str(name).toLowerCase()] || (sku ? m["sku:" + str(sku).toLowerCase()] : null) || null;

/* ── Vendor Master ── */
export interface Vendor {
  code: string;
  n: string;
  contact: string;
  phone: string;
  email: string;
  address: string;
  gstin: string;
  terms: string;
  status: string;
  acc: string;
  ifsc: string;
  bank: string;
  udyam: string;
  src: string;
}
const opened = (v: unknown) => (v ? String(decryptValue<string>(String(v))) : "");
export async function loadVendors(db: Queryable, items: Item[]): Promise<Vendor[]> {
  const vm = await rows(db, `SELECT name, vendor_code, vm_status, contact_person, phone_enc, email, address, gstin, payment_terms, bank_account_enc, ifsc, bank_name, udyam_no
                               FROM suppliers WHERE vm_status IS NOT NULL ORDER BY id`);
  const out: Vendor[] = vm.map((r) => ({
    code: str(r.vendor_code), n: str(r.name), contact: str(r.contact_person), phone: opened(r.phone_enc), email: str(r.email).toLowerCase(), address: str(r.address),
    gstin: str(r.gstin).toUpperCase(), terms: str(r.payment_terms), status: str(r.vm_status), acc: opened(r.bank_account_enc), ifsc: str(r.ifsc).toUpperCase(),
    bank: str(r.bank_name), udyam: str(r.udyam_no), src: "Vendor Master",
  }));
  const byKey: Record<string, Vendor | 1> = {};
  out.forEach((x) => (byKey[key(x.n)] = x));
  items.forEach((it) => it.v.forEach((x) => {
    if (!byKey[key(x[0])]) {
      byKey[key(x[0])] = 1;
      out.push({ code: x[3] || "", n: x[0], contact: "", phone: "", email: "", address: "", gstin: "", terms: "", status: "", acc: "", ifsc: "", bank: "", udyam: "", src: "Item Master only" });
    }
  }));
  out.sort((a, b) => a.n.localeCompare(b.n));
  return out;
}
/** vendor by code first (exact), then exact name, then the closest name start */
export function vendorFind(l: Vendor[], name: unknown, code?: unknown): Vendor | null {
  const c = str(code).toUpperCase().replace(/\s+/g, "");
  if (c) {
    const x = l.find((v) => v.code.toUpperCase().replace(/\s+/g, "") === c);
    if (x) return x;
  }
  const k = key(name);
  if (!k) return null;
  return l.find((x) => key(x.n) === k) || l.find((x) => key(x.n).indexOf(k) === 0 || k.indexOf(key(x.n)) === 0) || null;
}
export const blankVendor = (nm: unknown): Vendor => ({ n: str(nm), code: "", contact: "", phone: "", email: "", address: "", gstin: "", terms: "", status: "", acc: "", ifsc: "", bank: "", udyam: "", src: "" });

/* ── Doer (logins) ── */
export interface Doer {
  id: number;
  name: string;
  steps: number[];
  admin: boolean;
  email: string;
  types: string[];
  active: boolean;
}
export function doerOf(r: RowDataPacket): Doer {
  const t = str(r.ps_access).toUpperCase(), all = /\bALL\b/.test(t);
  return {
    id: Number(r.id), name: str(r.ps_name), steps: all ? STEPS.map((s) => s.id) : (t.match(/\d+/g) || []).map(Number).filter((x) => x >= 1 && x <= 5), admin: all,
    email: str(r.ps_email).toLowerCase(), types: str(r.ps_types).split(/[,/;&]+/).map(key).filter(Boolean), active: Number(r.active) === 1,
  };
}
export async function loadDoers(db: Queryable, activeOnly = true): Promise<Doer[]> {
  return (await rows(db, `SELECT id, ps_name, ps_access, ps_types, ps_email, active FROM users WHERE ps_name IS NOT NULL ${activeOnly ? "AND active = 1" : ""} ORDER BY id`)).map(doerOf);
}

/* ── settings (the script's Script Properties) ── */
export async function setting(db: Queryable, k: string): Promise<string> {
  return str((await rows(db, "SELECT v FROM ps_settings WHERE k = ?", [k]))[0]?.v);
}
export async function setSetting(db: Queryable, k: string, v: string) {
  await exec(db, "INSERT INTO ps_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [k, v]);
}

/* ── files stored here ── */
export async function saveFile(db: Queryable, kind: string, name: string, mime: string, bytes: Buffer, by: string): Promise<string> {
  const id = "F" + randomBytes(9).toString("hex");
  await exec(db, "INSERT INTO ps_files (id, kind, name, mime, size, sha256, bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
    id, kind, name.slice(0, 300), mime, bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes, by.slice(0, 120),
  ]);
  return id;
}
/** our file ids look like F + 18 hex; anything else is an old Google Drive id */
export const isOurFile = (id: string) => /^F[0-9a-f]{18}$/.test(id);
/** full link (the page may run on Google's site): ours from this server, old ones on Google Drive */
export const fileUrl = (id: string) => (!id ? "" : isOurFile(id) ? config.APP_ORIGIN + "/api/ps/file/" + id : "https://drive.google.com/file/d/" + id + "/view");

/**
 * Purchase System workbook → database, merged by key ("is it already there?"). See docs/03-adding-a-module.md.
 *   python -I tools/xlsx2json.py "modules/purchase-system/source/<workbook>.xlsx"        → source/out/sheets.json
 *   npm run ps:import                         dry run: does it all, reports, then rolls back
 *   npm run ps:import -- --apply              keeps it (back the database up first)
 *   npm run ps:import -- --apply --only=grn   refreshes only the GRN copy (until the GRN module writes it)
 *   npm run ps:import -- --apply --live       cut-over: keeps it and marks the module live (the database is the record)
 *   [file.json] other export · --overwrite: after go-live, let the sheet overwrite what differs (normally only reported)
 *
 * Nothing is deleted. New rows are added; a row already there is compared field by field: before go-live the sheet
 * wins (updated), after go-live the database wins (listed as a conflict). The GRN copy always follows the sheet.
 * Lines without a LINE ID in the sheet are matched to the database by time + item + indent no., so a re-import of the
 * same sheet changes nothing. The sheets' duplicate copies become one record per fact (records.ts, same as migration
 * 44). Each line is recalculated with the script's rules and compared with the sheet's stored stage / receipt status /
 * planned dates. Writes <folder of the file>/ps-import-report.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Connection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { encryptValue, hashPassword } from "../../../server/src/crypto";
import { maintenanceConnection } from "../../../server/src/db";
import { syncLines, syncRows, type SyncReport } from "../../../server/src/sync";
import {
  calcRow, gateOf, groupPo, key, lineId, num, normPo, str, STEPS, today, toDate, blankStep,
  type GrnRow, type Line, type PoRow,
} from "./core";
import { oneRecordPerFact, type Rec } from "./records";

type Cell = string | number | boolean;
type Sheets = Record<string, Cell[][]>;
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "modules/purchase-system/source/out/sheets.json";
const apply = args.includes("--apply"), goLive = args.includes("--live"), force = args.includes("--overwrite");
const only = (args.find((a) => a.startsWith("--only=")) ?? "").slice(7);

const cell = (r: Cell[] | undefined, i: number): Cell => (r && r[i] !== undefined ? r[i] : "");
const s = (r: Cell[] | undefined, i: number) => {
  const v = str(cell(r, i));
  return /^#(REF|N\/A|VALUE|ERROR|NAME|DIV)/i.test(v) ? "" : v;
};
const filled = (r: Cell[]) => r.some((v) => str(v) !== "");
/** a whole number stays as typed; other numbers as the sheet shows them (no float noise) */
const text = (v: Cell) => (typeof v === "number" ? String(Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6) : str(v));
const dt = (v: Cell) => toDate(v);

interface Report {
  counts: Record<string, number>;
  lists: Record<string, string[]>;
}
const rep: Report = { counts: {}, lists: {} };
const count = (k: string, n = 1) => (rep.counts[k] = (rep.counts[k] ?? 0) + n);
const list = (k: string, line: string) => (rep.lists[k] ??= []).push(line);

async function q(conn: Connection, sql: string, params: unknown[] = []) {
  const [r] = await conn.query<RowDataPacket[] & ResultSetHeader>(sql, params);
  return r;
}

/* ── Doer → users (Purchase System logins; passwords stored only as hashes) ── */
async function doers(conn: Connection, rows: Cell[][]) {
  const head = rows[0].map((h) => str(h).toLowerCase());
  let pc = head.findIndex((h) => /pass/.test(h));
  if (pc < 0) pc = 2;
  let mc = head.findIndex((h) => /mail/.test(h));
  if (mc < 0 && rows.slice(1).some((r) => /@/.test(s(r, 3)))) mc = 3;
  const tc = head.findIndex((h) => /^type/.test(h));
  let ic = head.findIndex((h) => /^indent/.test(h));
  if (ic < 0) ic = 4;
  const indentPw: string[] = [];
  for (const r of rows.slice(1)) {
    const name = s(r, 0);
    if (s(r, ic)) indentPw.push(s(r, ic));
    if (!name) continue;
    const pass = s(r, pc);
    const [u] = await q(conn, "SELECT id FROM users WHERE ps_name = ?", [name]);
    const slug = "ps." + name.toLowerCase().replace(/\(director\)/, "dir").replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "").slice(0, 36);
    const fields = [s(r, 1), tc >= 0 ? s(r, tc) : "", mc >= 0 && /@/.test(s(r, mc)) ? s(r, mc).toLowerCase() : ""];
    if (u) {
      // the password is set once, when the login is made: after that it belongs to the person
      await q(conn, "UPDATE users SET ps_access = ?, ps_types = ?, ps_email = ?, active = ? WHERE id = ?", [...fields, pass ? 1 : 0, u.id]);
      count("Doer logins updated");
    } else {
      // no password in the sheet = the login is off there; kept off here (no usable hash)
      const hash = pass ? await hashPassword(pass) : await hashPassword(lineId() + Math.random());
      await q(conn, `INSERT INTO users (username, password_hash, role, label, full_name, must_change_password, ps_name, ps_access, ps_types, ps_email, active)
                     VALUES (?, ?, 'purchase', 'Purchase System', ?, 0, ?, ?, ?, ?, ?)`, [slug, hash, name, name, ...fields, pass ? 1 : 0]);
      count("Doer logins added");
    }
    if (!pass) list("Doer rows without a password (login off, as in the sheet)", name);
  }
  // indent-form passwords: kept only as hashes
  const hashes = await Promise.all(indentPw.map((p) => hashPassword(p)));
  await q(conn, "INSERT INTO ps_settings (k, v) VALUES ('indent_passwords', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [JSON.stringify(hashes)]);
  count("Indent-form passwords", hashes.length);
}

/* ── Vendor Master → suppliers ── */
const vendorKey = (x: string) => key(x).replace(/^ms/, "").replace(/privatelimited|pvtltd|limited|private|pvt|ltd/g, "");
async function vendorMaster(conn: Connection, rows: Cell[][]) {
  const H = rows[0].map((h) => str(h).toLowerCase().replace(/\s+/g, " "));
  const f = (re: RegExp) => H.findIndex((h) => re.test(h));
  const C = { code: f(/vendor\s*code/), name: f(/vendor\s*name|^name$/), contact: f(/contact/), phone: f(/phone|mobile/), email: f(/e-?mail/), address: f(/address/),
    gstin: f(/gstin|^gst/), terms: f(/payment/), status: f(/^status/), acc: f(/account/), ifsc: f(/ifsc/), bank: f(/bank/), udyam: f(/udyam|msme/) };
  const cellText = (v: Cell) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)) : str(v));
  const g = (r: Cell[], k: keyof typeof C) => (C[k] >= 0 ? cellText(cell(r, C[k])) : "");
  const sups = await q(conn, "SELECT id, name, vendor_code FROM suppliers");
  const byCode = new Map(sups.filter((x) => x.vendor_code).map((x) => [String(x.vendor_code).toUpperCase(), x]));
  const byName = new Map(sups.map((x) => [key(x.name), x]));
  const loose = new Map<string, RowDataPacket | null>();
  for (const x of sups) loose.set(vendorKey(x.name), loose.has(vendorKey(x.name)) ? null : x);
  for (const r of rows.slice(1)) {
    const name = g(r, "name");
    if (!name) continue;
    const code = g(r, "code").toUpperCase();
    let hit = (code && byCode.get(code)) || byName.get(key(name)) || loose.get(vendorKey(name)) || null;
    const vals = [g(r, "status"), g(r, "contact"), g(r, "phone") ? encryptValue(g(r, "phone")) : null, g(r, "email").toLowerCase(), g(r, "address"),
      g(r, "gstin").toUpperCase(), g(r, "terms"), g(r, "acc") ? encryptValue(g(r, "acc")) : null, g(r, "ifsc").toUpperCase(), g(r, "bank"), g(r, "udyam")];
    if (!hit) {
      const [x] = await q(conn, "SELECT id FROM suppliers WHERE name = ?", [name.slice(0, 120)]);
      if (x) hit = x;
    }
    if (hit) {
      // a second Vendor Master row for the same supplier: keep the Active one (script: Inactive only when no Active row)
      const [cur] = await q(conn, "SELECT vm_status FROM suppliers WHERE id = ?", [hit.id]);
      if (cur.vm_status !== null && !/inactive/i.test(cur.vm_status) && /inactive/i.test(vals[0] as string)) {
        list("Vendor Master: second row for the same vendor (Inactive) — Active row kept", `${code} ${name}`);
        continue;
      }
      if (code) await q(conn, "UPDATE suppliers SET vendor_code = NULL WHERE vendor_code = ? AND id <> ?", [code, hit.id]);
      await q(conn, `UPDATE suppliers SET vendor_code = COALESCE(NULLIF(?, ''), vendor_code), vm_status = ?, contact_person = ?, phone_enc = ?, email = ?, address = ?, gstin = ?,
                     payment_terms = ?, bank_account_enc = ?, ifsc = ?, bank_name = ?, udyam_no = ? WHERE id = ?`, [code, ...vals, hit.id]);
      count("Vendor Master rows → existing suppliers");
      if (key(hit.name) !== key(name)) list("Vendor Master name differs from the supplier name in the app (matched by code / company words)", `${code} "${name}" ↔ "${hit.name}"`);
    } else {
      const ins = await q(conn, `INSERT INTO suppliers (name, vendor_code, approved, from_tally, vm_status, contact_person, phone_enc, email, address, gstin, payment_terms,
                                    bank_account_enc, ifsc, bank_name, udyam_no) VALUES (?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [name.slice(0, 120), code || null, ...vals]);
      count("Vendor Master rows → new suppliers");
      byName.set(key(name), { id: ins.insertId, name } as RowDataPacket);
    }
  }
}

/* ── Item Master → components / products (+ supplier_rates per vendor row) ── */
async function itemMaster(conn: Connection, rows: Cell[][]) {
  const H = rows[0].map((h) => str(h).toLowerCase().replace(/\s+/g, " "));
  const f = (re: RegExp) => H.findIndex((h) => re.test(h));
  const C = { sku: f(/^sku/), itype: f(/^item type$/), name: f(/^item name$/), cat: f(/^category$/), brand: f(/^brand$/), ptype: f(/^type$/), uom: f(/^uom$/), pack: f(/^pack size$/),
    vcode: f(/^vendor code$/), vname: f(/^vendor name$/), vitem: f(/^vendor item name$/), cost: f(/^purchase cost/), spec: f(/^specification$/), mrp: f(/^mrp$/), status: f(/^status$/),
    origin: f(/^origin$/), remarks: f(/^remarks$/), photo: f(/^item photo$/), hsn: f(/hsn/), gst: f(/^gst|gst %|tax %/), moq: f(/^moq$/) };
  const g = (r: Cell[], k: keyof typeof C) => (C[k] >= 0 ? s(r, C[k]) : "");
  const comps = new Map((await q(conn, "SELECT code, name FROM components")).map((x) => [String(x.code).toUpperCase(), String(x.name)]));
  const prods = await q(conn, "SELECT id, name, fg_code FROM products");
  const prodByCode = new Map(prods.filter((p) => p.fg_code).map((p) => [String(p.fg_code).toUpperCase(), p]));
  const prodByName = new Map(prods.map((p) => [key(p.name), p]));
  const sups = await q(conn, "SELECT id, name, vendor_code FROM suppliers");
  const supByCode = new Map(sups.filter((x) => x.vendor_code).map((x) => [String(x.vendor_code).toUpperCase(), x]));
  const supByName = new Map(sups.map((x) => [key(x.name), x]));
  const seenItem = new Set<string>(), seenPair = new Set<string>();
  let rowNo = 0;
  // origin of an item: INDIAN if any of its rows is INDIAN (script: INDIAN wins), else the first given
  const originOf = new Map<string, string>();
  for (const r of rows.slice(1)) {
    const n = g(r, "name");
    if (!n) continue;
    const o = g(r, "origin").toUpperCase(), k = n.toLowerCase();
    if (o === "INDIAN" || (!originOf.get(k) && o)) originOf.set(k, o);
  }
  for (const r of rows.slice(1)) {
    rowNo++;
    const name = g(r, "name");
    if (!name || name.startsWith("#")) continue;
    const sku = g(r, "sku").toUpperCase(), itype = g(r, "itype"), k = name.toLowerCase();
    const fg = /^finished\s+goods?$/i.test(itype);
    const ps = [itype, g(r, "uom").toUpperCase(), g(r, "pack"), g(r, "status"), (/[-\w]{25,}/.exec(g(r, "photo").replace(/^.*\/d\//, "")) || [""])[0],
      g(r, "spec"), g(r, "mrp"), g(r, "remarks"), g(r, "hsn"), g(r, "gst"), g(r, "moq")];
    if (!seenItem.has(k)) {
      seenItem.add(k);
      if (fg) {
        const hit = (sku && prodByCode.get(sku)) || prodByName.get(key(name));
        if (hit) {
          await q(conn, `UPDATE products SET ps_item_type = ?, ps_uom = ?, ps_pack_size = ?, ps_status = ?, ps_photo = ?, ps_spec = ?, ps_mrp = ?, ps_remarks = ?, ps_hsn = ?, ps_gst = ?,
                         ps_moq = ?, ps_type = ?, category = COALESCE(NULLIF(?, ''), category), brand = COALESCE(NULLIF(?, ''), brand), origin = ? WHERE id = ?`,
            [...ps, g(r, "ptype"), g(r, "cat"), g(r, "brand"), originOf.get(k) || "", hit.id]);
          if (key(hit.name) !== key(name)) list("FG name in the Purchase System differs from the app's product name (kept the app's; matched by code)", `${sku} "${name}" ↔ "${hit.name}"`);
          count("Item Master FG → existing products");
        } else {
          const x = await q(conn, `INSERT INTO products (name, fg_code, category, brand, origin, ps_item_type, ps_uom, ps_pack_size, ps_status, ps_photo, ps_spec, ps_mrp, ps_remarks,
                                     ps_hsn, ps_gst, ps_moq, ps_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [name.slice(0, 160), sku, g(r, "cat"), g(r, "brand"), originOf.get(k) || "", ...ps, g(r, "ptype")]);
          prodByName.set(key(name), { id: x.insertId, name } as RowDataPacket);
          count("Item Master FG → new products");
        }
      } else {
        if (!sku) {
          list("Item Master row without SKU code (kept, code made from the name)", name);
        }
        const code = sku || "PSX-" + key(name).slice(0, 11).toUpperCase();
        const kind = { "Packaging Material": "PM", "Raw Material": "RM", "Promotional Material": "PROMO" }[itype] ?? (/^MRO/.test(itype) ? "MRO" : "");
        if (comps.has(code)) {
          if (key(comps.get(code)) !== key(name)) list("Item name changed to the Purchase System's (same code)", `${code} "${comps.get(code)}" → "${name}"`);
          await q(conn, "UPDATE components SET name = ?, category = ?, type = ?, kind = COALESCE(NULLIF(?, ''), kind), origin = ? WHERE code = ?",
            [name.slice(0, 160), g(r, "cat").slice(0, 60), g(r, "ptype").slice(0, 40), kind, (originOf.get(k) || "").slice(0, 20), code]);
          count("Item Master items → existing items");
        } else {
          await q(conn, "INSERT INTO components (code, name, type, kind, category, origin) VALUES (?, ?, ?, ?, ?, ?)",
            [code, name.slice(0, 160), g(r, "ptype").slice(0, 40), kind, g(r, "cat").slice(0, 60), (originOf.get(k) || "").slice(0, 20)]);
          comps.set(code, name);
          count("Item Master items → new items");
        }
        await q(conn, `UPDATE components SET ps_item_type = ?, ps_uom = ?, ps_pack_size = ?, ps_status = ?, ps_photo = ?, ps_spec = ?, ps_mrp = ?, ps_remarks = ?, ps_hsn = ?, ps_gst = ?,
                       ps_moq = ?, ps_brand = ? WHERE code = ?`, [...ps, g(r, "brand").slice(0, 60), code]);
      }
    }
    // vendor row → supplier_rates (item × vendor: cost, vendor item name, origin of that row)
    const vname = g(r, "vname");
    if (!vname || fg) {
      if (vname && fg) list("Vendor on a Finished Good row (FG are not bought — not mapped)", `${sku} ${name} ← ${vname}`);
      continue;
    }
    const code = sku || "PSX-" + key(name).slice(0, 11).toUpperCase();
    const vcode = g(r, "vcode").toUpperCase();
    let sup = (vcode && supByCode.get(vcode)) || supByName.get(key(vname));
    if (!sup) {
      const x = await q(conn, "INSERT INTO suppliers (name, vendor_code, approved, from_tally) VALUES (?, ?, 1, 0)", [vname.slice(0, 120), vcode || null]);
      sup = { id: x.insertId, name: vname } as RowDataPacket;
      supByName.set(key(vname), sup);
      list("Vendor named only in Item Master (added; not on the Vendor Master)", vname);
    }
    const cost = num(cell(r, C.cost));
    if (seenPair.has(sup.id + "|" + code)) {
      // the same item × vendor twice in the Item Master: the script keeps the lower cost
      if (cost > 0) await q(conn, "UPDATE supplier_rates SET rate_enc = ? WHERE supplier_id = ? AND component_code = ? AND (rate_enc IS NULL)", [encryptValue(String(cost)), sup.id, code]);
      list("Item × vendor twice in the Item Master (lower cost kept)", `${code} × ${vname}`);
      continue;
    }
    seenPair.add(sup.id + "|" + code);
    await q(conn, `INSERT INTO supplier_rates (supplier_id, component_code, rate_enc, vendor_item_name, ps_origin, ps_row) VALUES (?, ?, ?, ?, ?, ?)
                   ON DUPLICATE KEY UPDATE rate_enc = COALESCE(VALUES(rate_enc), rate_enc), vendor_item_name = VALUES(vendor_item_name), ps_origin = VALUES(ps_origin), ps_row = VALUES(ps_row)`,
      [sup.id, code, cost > 0 ? encryptValue(String(cost)) : null, g(r, "vitem").slice(0, 300), g(r, "origin").toUpperCase(), rowNo]);
    count("Item Master vendor rows → item × vendor");
  }
}

/* ── Guidelines ── */
function guidelines(rows: Cell[][]): Rec[] {
  const out: Rec[] = [];
  let cur = "";
  for (const r of rows.slice(1)) {
    const a = s(r, 0), b = s(r, 1);
    if (a) cur = a;
    if (!cur || !b) continue;
    for (const x of b.split(/\n+/).map((y) => str(y).replace(/^[•\-*·]\s*/, "")).filter(Boolean)) out.push({ type: cur.slice(0, 120), spec: x.slice(0, 1000) });
  }
  return out;
}

/* ── Indent sheet (id = the row in the sheet) ── */
function indents(rows: Cell[][]): Rec[] {
  const out: Rec[] = [];
  rows.forEach((r, i) => {
    if (i === 0 || !filled(r)) return;
    out.push({ id: i + 1, ts: dt(cell(r, 0)), indent_no: s(r, 1), item: s(r, 2), party: s(r, 3), origin: s(r, 4), qty: text(cell(r, 5)), unit: s(r, 6), urgency: s(r, 7),
      image_url: s(r, 8), filled_by: s(r, 9), remarks: s(r, 10), submitted_by: s(r, 11), email_status: s(r, 12), category: s(r, 13), item_type: s(r, 14),
      designer_status: s(r, 15), designer_at: text(cell(r, 16)), designer_image: s(r, 17), mrp: text(cell(r, 18)), mrp_date: text(cell(r, 19)), sku: s(r, 20), brand: s(r, 21),
      line_id: s(r, 22), po_no: s(r, 23) });
  });
  count("Indent rows", out.length);
  return out;
}

/* ── FMS → lines ── */
const F = { ts: 0, ind: 1, item: 2, party: 3, urg: 4, by: 5, rem: 6, iqty: 7, signed: 8, po: 9, code: 10, qty: 11, rate: 12, value: 13, vendor: 14, poDate: 15, edd: 16, pdf: 17,
  gate: 38, receipt: 46, stage: 52, override: 53, signedAt: 54, mailedAt: 55, note: 56, lead: 57, unit: 58, id: 59 };
const STEP_COL: Record<number, { plan: number; act: number; st: number; delay: number; ex: number }> = {
  1: { plan: 18, act: 19, st: 20, delay: 21, ex: 22 }, 2: { plan: 23, act: 24, st: 25, delay: 26, ex: 27 }, 3: { plan: 28, act: 29, st: 30, delay: 31, ex: 32 },
  4: { plan: 33, act: 34, st: 35, delay: 36, ex: 37 }, 5: { plan: 47, act: 48, st: 49, delay: 50, ex: 51 },
};
function fmsLines(rows: Cell[][], refItem: Map<string, string>): { lines: Line[]; raw: Map<string, Cell[]>; made: Set<number> } {
  const data = rows.slice(6).filter(filled);
  // LINE IDs: blank → new; repeated → renewed except the one the Indent / PO sheet points to with the same item (assignLineIds_)
  const groups = new Map<string, number[]>();
  data.forEach((r, i) => {
    const id = s(r, F.id);
    if (id) groups.set(id, [...(groups.get(id) ?? []), i]);
  });
  const ids = data.map((r) => s(r, F.id));
  const made = new Set<number>();
  for (const [id, g] of groups) {
    if (g.length < 2) continue;
    let keep = g.find((i) => refItem.get(id) && key(s(data[i], F.item)) === refItem.get(id));
    if (keep === undefined) keep = g[0];
    for (const i of g) if (i !== keep) {
      ids[i] = lineId();
      made.add(i);
      list("FMS: repeated LINE ID renewed", `${id} (row with ${s(data[i], F.item)})`);
    }
  }
  ids.forEach((id, i) => {
    if (!id) {
      ids[i] = lineId();
      made.add(i);
      count("FMS lines given a new LINE ID");
    }
  });
  const raw = new Map<string, Cell[]>();
  const lines = data.map((r, i): Line => {
    raw.set(ids[i], r);
    const steps: Line["steps"] = {};
    for (const st of STEPS) {
      const c = STEP_COL[st.id], ex = cell(r, c.ex);
      const nx = st.exType === "NEXT_DATE" ? toDate(ex) : null;
      steps[st.id] = { ...blankStep(), act: dt(cell(r, c.act)), st: s(r, c.st).toUpperCase(), ex: nx ? "" : text(ex), nx };
    }
    return {
      id: ids[i], seq: i + 1, ts: dt(cell(r, F.ts)), ind: s(r, F.ind), item: s(r, F.item), party: s(r, F.party), urg: s(r, F.urg), by: s(r, F.by), rem: s(r, F.rem),
      iqty: text(cell(r, F.iqty)), signed: s(r, F.signed), po: s(r, F.po), code: s(r, F.code), qty: str(cell(r, F.qty)) === "" ? null : num(cell(r, F.qty)),
      rate: str(cell(r, F.rate)) === "" ? null : num(cell(r, F.rate)), value: str(cell(r, F.value)) === "" ? null : num(cell(r, F.value)), vendor: s(r, F.vendor),
      poDate: dt(cell(r, F.poDate)), edd: dt(cell(r, F.edd)), pdf: s(r, F.pdf), override: s(r, F.override).toUpperCase(), signedAt: dt(cell(r, F.signedAt)),
      mailedAt: dt(cell(r, F.mailedAt)), note: s(r, F.note), lead: text(cell(r, F.lead)), unit: s(r, F.unit), steps,
    };
  });
  return { lines, raw, made };
}

/** a line the sheet gives no (or a repeated) LINE ID: the database line with the same time (±1 s), item and indent no. */
async function keepIds(conn: Connection, lines: Line[], made: Set<number>) {
  const sec = (d: Date | null) => (d ? Math.round(d.getTime() / 1000) : 0);
  const given = new Set(lines.filter((_l, i) => !made.has(i)).map((l) => l.id));
  const db = new Map<string, string[]>();
  for (const r of await q(conn, "SELECT line_id, ts, item, indent_no FROM ps_lines ORDER BY seq")) {
    if (given.has(String(r.line_id))) continue;
    const k = key(r.item) + "|" + str(r.indent_no).toUpperCase(), t = sec(toDate(r.ts));
    for (const x of [t - 1, t, t + 1]) db.set(x + "|" + k, [...(db.get(x + "|" + k) ?? []), String(r.line_id)]);
  }
  const used = new Set<string>();
  lines.forEach((l, i) => {
    if (!made.has(i)) return;
    const hit = (db.get(sec(l.ts) + "|" + key(l.item) + "|" + l.ind.toUpperCase()) ?? []).find((x) => !used.has(x));
    if (!hit) return count("FMS lines new to the database");
    used.add(hit);
    l.id = hit;
  });
}

/* ── PO lines: one per FMS line (the FMS is the reliable per-line record); the PO sheet gives the PO fields ── */
type Out = PoRow & { company: string; unmatched: 0 | 1 };
function poRows(rows: Cell[][], lines: Line[]): Out[] {
  const data = rows.slice(1).filter((r) => s(r, 0));
  const toRow = (r: Cell[], i: number): Out => ({
    id: i, po_no: s(r, 0), po_date: dt(cell(r, 1)), edd: dt(cell(r, 2)), vendor: s(r, 4), item_code: s(r, 5), item_name: s(r, 6), hsn: s(r, 7), qty: num(cell(r, 8)), unit: s(r, 9),
    rate: num(cell(r, 10)), gst: str(cell(r, 11)) === "" ? "" : text(cell(r, 11)), gst_amt: num(cell(r, 12)), amount: num(cell(r, 13)), total: num(cell(r, 14)), indent_no: s(r, 15),
    doer: text(cell(r, 16)), pdf: s(r, 17), approval: s(r, 18).toUpperCase(), approved_by: s(r, 19), approved_at: dt(cell(r, 20)), lead_days: text(cell(r, 21)), line_id: s(r, 22),
    remarks: s(r, 23), vendor_code: s(r, 24), vendor_item: s(r, 25), tax_type: s(r, 26), cgst: num(cell(r, 27)), sgst: num(cell(r, 28)), igst: num(cell(r, 29)),
    company: s(r, 3), unmatched: 0,
  });
  const filledN = (r: Out) => Object.values(r).filter((v) => v !== "" && v !== null && v !== 0).length;
  /** the doubled rows are exact copies except date / GST format: same PO, item, qty, rate, indent no., amount */
  const copyKey = (r: Out) => [normPo(r.po_no), key(r.item_name || r.item_code), r.qty, r.rate, normPo(r.indent_no), r.amount].join("|");
  const sheet = new Map<string, Out[]>();
  data.forEach((r, i) => {
    const row = toRow(r, i + 2);
    sheet.set(normPo(row.po_no), [...(sheet.get(normPo(row.po_no)) ?? []), row]);
  });
  const fms = new Map<string, Line[]>();
  for (const l of lines) if (l.po) fms.set(normPo(l.po), [...(fms.get(normPo(l.po)) ?? []), l]);
  const merge = (copies: Out[]) => {
    copies.sort((a, b) => filledN(b) - filledN(a) || a.id - b.id);
    const m: Out = { ...copies[0] };
    for (const c of copies.slice(1)) {
      for (const f of Object.keys(m) as (keyof Out)[]) {
        const cur = m[f], val = c[f];
        if ((cur === "" || cur === null || cur === 0) && val !== "" && val !== null && val !== 0) (m as unknown as Record<string, unknown>)[f] = val;
      }
    }
    return m;
  };
  const out: Out[] = [];
  const order = [...new Set([...sheet.keys(), ...fms.keys()])];
  for (const po of order) {
    const rowsOf = sheet.get(po) ?? [], ls = fms.get(po) ?? [];
    const groups = new Map<string, Out[]>();
    rowsOf.forEach((r) => groups.set(copyKey(r), [...(groups.get(copyKey(r)) ?? []), r]));
    const distinct = [...groups.values()].map((g) => merge(g));
    count("PO sheet rows that were exact copies", rowsOf.length - distinct.length);
    if (!ls.length) {
      // a PO only in the PO sheet (old, no FMS line): kept as the sheet has it
      distinct.forEach((d) => out.push(d));
      if (distinct.length) count("POs only in the PO sheet (no FMS line)");
      continue;
    }
    const head = distinct.length ? merge(distinct.map((d) => ({ ...d }))) : null;
    const used = new Set<number>();
    for (const l of ls) {
      // the PO-sheet row of this line: same LINE ID, else same item (code or name) and qty, else same item
      const cand = distinct.map((d, i) => ({ d, i })).filter((x) => !used.has(x.i));
      const sameItem = (r: Out) => [key(l.code), key(l.item)].filter(Boolean).some((k) => k === key(r.item_name) || k === key(r.item_code));
      const hit = cand.find((x) => x.d.line_id && x.d.line_id === l.id)
        ?? cand.find((x) => sameItem(x.d) && x.d.qty === num(l.qty))
        ?? cand.find((x) => sameItem(x.d));
      if (hit) used.add(hit.i);
      const m = hit?.d;
      const qty = l.qty !== null ? num(l.qty) : num(m?.qty), rate = l.rate !== null ? num(l.rate) : num(m?.rate);
      const amount = Math.round(qty * rate * 100) / 100;
      const total = l.value !== null ? num(l.value) : num(m?.total);
      let gst = m ? m.gst : "";
      if (gst === "" && amount > 0 && total > 0) {
        const g = Math.round((total / amount - 1) * 10000) / 100;
        if ([0, 5, 12, 18, 28].includes(g)) gst = String(g);
      }
      const gstAmt = m && m.gst_amt ? m.gst_amt : Math.max(0, Math.round((total - amount) * 100) / 100);
      if (!hit) list("FMS line with no matching PO-sheet row (line built from the FMS; GST from its value)", `${l.po} ${l.item || l.code} ${qty} × ${rate}`);
      out.push({
        ...(head as Out),
        id: m?.id ?? (head ? head.id : 0),
        po_date: l.poDate ?? head?.po_date ?? null, edd: l.edd ?? head?.edd ?? null, vendor: l.vendor || head?.vendor || "",
        item_code: l.code || m?.item_code || "", item_name: l.item || m?.item_name || l.code, hsn: m?.hsn ?? "", qty, unit: m?.unit || l.unit, rate, gst, gst_amt: gstAmt,
        amount: m && m.amount ? m.amount : amount, total, indent_no: m?.indent_no || (/IND\d+/i.test(l.ind) ? l.ind : ""), vendor_item: m?.vendor_item ?? "",
        cgst: m?.cgst ?? 0, sgst: m?.sgst ?? 0, igst: m?.igst ?? 0, line_id: l.id, lead_days: l.lead || head?.lead_days || "", unmatched: 0,
        company: head?.company ?? "", doer: head?.doer ?? "", pdf: l.pdf || head?.pdf || "", approval: head?.approval ?? "", approved_by: head?.approved_by ?? "",
        approved_at: head?.approved_at ?? null, remarks: head?.remarks ?? "", vendor_code: head?.vendor_code ?? "", tax_type: head?.tax_type ?? "",
      });
      count("PO lines from FMS lines");
    }
    distinct.forEach((d, i) => {
      if (used.has(i)) return;
      out.push({ ...d, unmatched: 1 });
      list("PO-sheet row with no FMS line (stored, marked unmatched)", `${d.po_no} ${d.item_name} ${d.qty} × ${d.rate} (${d.indent_no || "no indent"})`);
    });
  }
  return out;
}

/* ── GRN sheet (a copy of the GRN system: always as the sheet has it) ── */
const GRN_COLS = ["grn_id", "gate_entry_id", "po_no", "po_line_code", "po_item_name", "po_qty", "unit", "store_received_qty", "all_ok", "issue_details", "decision", "approved_qty",
  "rejected_qty", "decision_by", "decision_at", "po_status", "vendor_check", "qty_check", "exception_flag", "store_remark", "source_row", "invoice_file_id", "invoice_file_name",
  "invoice_mime", "damaged_qty", "damage_type", "category", "location", "gate_entry_complete", "damage_photo_ids", "damage_photo_names", "transport_name", "bilty_charges",
  "bilty_charges_2", "bilty_lr_no", "damage_photo_sizes", "damage_photo_hashes", "item_photo_id", "item_photo_name", "item_photo_mime", "coa_file_id", "coa_file_name", "coa_mime",
  "packing_details", "packing_total", "indent_no", "grn_line_no", "submit_key", "vendor_item_code", "vendor_item_name"];
function grn(rows: Cell[][]): Rec[] {
  const head = rows[0].map((h) => str(h));
  if (head[0] !== "GRN ID" || head.length < GRN_COLS.length) throw new Error(`GRN sheet headers changed (${head.length} columns, first "${head[0]}").`);
  const out: Rec[] = [];
  for (const r of rows.slice(1)) {
    if (!s(r, 0) && !s(r, 2)) continue;
    out.push(Object.fromEntries(GRN_COLS.map((c, i) => [c, c === "decision_at" ? dt(cell(r, i)) : text(cell(r, i))])));
  }
  count("GRN rows", out.length);
  return out;
}

/** the FMS line as a row (with its PO copies, which records.ts turns into the PO tables) */
const lineRow = (l: Line): Rec => ({
  line_id: l.id, ts: l.ts, indent_no: l.ind, item: l.item, party: l.party, urgency: l.urg, filled_by: l.by, remark: l.rem, indent_qty: l.iqty, signed_link: l.signed,
  po_no: l.po, override: l.override, signed_at: l.signedAt, mailed_at: l.mailedAt, note: l.note, unit: l.unit,
  item_code: l.code, qty: l.qty, rate: l.rate, value: l.value, vendor: l.vendor, po_date: l.poDate, edd: l.edd, pdf: l.pdf, lead_days: l.lead,
});
const PO_COPIES = ["item_code", "qty", "rate", "value", "vendor", "po_date", "edd", "pdf", "lead_days"];
const REGISTER: Rec = { in_register: 0, register_no: "", origin: "", image_url: "", submitted_by: "", email_status: "", category: "", item_type: "", sku: "", brand: "",
  designer_status: "", designer_at: "", designer_image: "", mrp: "", mrp_date: "" };

/** recalculates every line with the ported rules and compares with what the sheet had stored */
function reconcile(lines: Line[], raw: Map<string, Cell[]>, po: PoRow[], grnRows: GrnRow[]) {
  const ctx = { gate: gateOf(grnRows), po: groupPo((po as Out[]).filter((r) => !r.unmatched)), today: today() };
  // per PO: lines in the PO table vs FMS lines with that PO
  const fmsN = new Map<string, number>(), poN = new Map<string, number>();
  for (const l of lines) if (l.po) fmsN.set(normPo(l.po), (fmsN.get(normPo(l.po)) ?? 0) + 1);
  for (const r of po as Out[]) if (!r.unmatched) poN.set(normPo(r.po_no), (poN.get(normPo(r.po_no)) ?? 0) + 1);
  for (const k of new Set([...fmsN.keys(), ...poN.keys()])) {
    const a = poN.get(k) ?? 0, b = fmsN.get(k) ?? 0;
    if (a === b) count("POs with the same line count as the FMS");
    else list("PO line count differs from the FMS (PO table / FMS lines)", `${k}: ${a} / ${b}`);
  }
  for (const l of lines) {
    const r = raw.get(l.id)!, c = calcRow(l, ctx);
    const was = s(r, F.stage), rc = s(r, F.receipt);
    if (was && was !== c.stage) list("Stage differs from the sheet's (sheet → now)", `${l.po || l.ind} ${l.item}: ${was} → ${c.stage}`);
    else count("Stage same as the sheet");
    if (l.po && rc !== c.rc) list("Receipt status differs from the sheet's (sheet → now)", `${l.po} ${l.item}: ${rc || "(blank)"} → ${c.rc}`);
    for (const st of STEPS) {
      const sheet = toDate(cell(r, STEP_COL[st.id].plan)), now = c.plans[st.id];
      const a = sheet ? sheet.getTime() : 0, b = now ? (now as Date).getTime() : 0;
      if (Math.abs(a - b) > 60000) list(`Step ${st.id} planned date differs from the sheet's`, `${l.po} ${l.item}: ${sheet?.toLocaleString() ?? "-"} → ${now ? (now as Date).toLocaleString() : "-"}`);
      else count("Planned dates same as the sheet");
    }
  }
}

async function main() {
  const sh = JSON.parse(readFileSync(file, "utf8")) as Sheets;
  for (const n of ["Doer", "Vendor Master", "Item Master", "Guidelines", "Indent", "PO", "FMS", "GRN"]) if (!sh[n]) throw new Error(`Sheet "${n}" missing in ${file}.`);
  if (str(cell(sh["FMS"][5], 1)) !== "INDENT NO" || str(cell(sh["FMS"][5], 52)) !== "LINE STAGE") throw new Error("FMS row 6 headers moved.");
  if (str(cell(sh["PO"][0], 0)) !== "PO No" || str(cell(sh["Indent"][0], 1)) !== "INDENT NO") throw new Error("PO / Indent headers moved.");
  const conn = await maintenanceConnection();
  try {
    await conn.beginTransaction();
    const [lv] = await q(conn, "SELECT v FROM ps_settings WHERE k = 'live'");
    const live = lv ? str(lv.v) : "";
    // before go-live the sheet is the record; after it the database is (the sheet only fills what is new)
    const overwrite = !live || force;
    const reps: SyncReport[] = [];
    const grnRows = grn(sh["GRN"]);
    reps.push(await syncRows(conn, "ps_grn", ["grn_id", "grn_line_no", "po_no", "po_line_code"], grnRows, { overwrite: true }));
    if (only !== "grn") {
      if (overwrite) {
        await doers(conn, sh["Doer"]);
        await vendorMaster(conn, sh["Vendor Master"]);
        await itemMaster(conn, sh["Item Master"]);
      } else list("Masters not read (the module is live: users, items and vendors are kept on the admin page)", live);
      reps.push(await syncRows(conn, "ps_guidelines", ["type", "spec"], guidelines(sh["Guidelines"]), { overwrite }));
      const ind = indents(sh["Indent"]);
      // the LINE ID the Indent / PO sheet points to, with its item (keeps that row's id when an id is repeated in the FMS)
      const refItem = new Map<string, string>();
      for (const r of sh["Indent"].slice(1)) if (s(r, 22) && !refItem.has(s(r, 22))) refItem.set(s(r, 22), key(s(r, 2)));
      for (const r of sh["PO"].slice(1)) if (s(r, 22) && !refItem.has(s(r, 22))) refItem.set(s(r, 22), key(s(r, 6)));
      const { lines, raw, made } = fmsLines(sh["FMS"], refItem);
      await keepIds(conn, lines, made);
      const po = poRows(sh["PO"], lines);
      const rec = oneRecordPerFact(lines.map(lineRow), po as unknown as Rec[], ind);
      const lineRows = lines.map((l) => {
        const r = { ...lineRow(l), ...REGISTER, ...(rec.lineSets.get(l.id) ?? {}) };
        for (const c of PO_COPIES) delete r[c];
        return r;
      });
      const steps = lines.flatMap((l) => STEPS.map((st) => ({ st, x: l.steps[st.id] })).filter(({ x }) => x.act || x.st || x.ex || x.nx)
        .map(({ st, x }) => ({ line_id: l.id, step: st.id, actual: x.act, status: x.st, remark: x.ex.slice(0, 1000), next_date: x.nx })));
      count("FMS lines", lines.length);
      count("POs", rec.pos.length);
      count("PO lines", rec.poLines.length);
      reps.push(await syncRows(conn, "ps_lines", ["line_id"], lineRows, { overwrite }));
      reps.push(await syncRows(conn, "ps_line_steps", ["line_id", "step"], steps, { overwrite }));
      reps.push(await syncRows(conn, "ps_pos", ["po_no"], rec.pos, { overwrite }));
      reps.push(await syncRows(conn, "ps_po_lines", ["po_no", "line_id"], rec.poLines.filter((r) => r.line_id), { overwrite, where: "line_id IS NOT NULL" }));
      reps.push(await syncRows(conn, "ps_po_lines", ["po_no", "item_code", "item_name"], rec.poLines.filter((r) => !r.line_id), { overwrite, where: "line_id IS NULL" }));
      // the audit is this import's own report of the copies it did not keep: replaced, not merged
      if (overwrite) {
        await q(conn, "DELETE FROM ps_import_audit");
        for (const x of rec.audits) await q(conn, "INSERT INTO ps_import_audit SET ?", [x]);
        count("Sheet values not kept (ps_import_audit)", rec.audits.length);
      }
      reconcile(lines, raw, po, grnRows as unknown as GrnRow[]);
    }
    if (apply && goLive) await q(conn, "INSERT INTO ps_settings (k, v) VALUES ('live', ?) ON DUPLICATE KEY UPDATE v = v", [new Date().toISOString().slice(0, 10)]);
    const out = [`# Purchase System import — ${apply ? "APPLIED" : "dry run (nothing kept)"}${only ? " — only " + only : ""}`,
      `\n${live ? `The module is live since ${live}: the database is the record${force ? " (--overwrite: the sheet won anyway)" : ""}.` : "Not live yet: the sheet is the record."}\n`,
      ...syncLines(reps), "\n## Reading the sheet\n", "| | count |", "|---|---|", ...Object.entries(rep.counts).map(([k, v]) => `| ${k} | ${v} |`)];
    for (const [k, l] of Object.entries(rep.lists)) out.push(`\n### ${k} — ${l.length}\n`, ...l.slice(0, 400).map((x) => `- ${x}`), ...(l.length > 400 ? [`- … ${l.length - 400} more`] : []));
    if (apply) {
      await q(conn, "INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', 'ps.import', 'ok', ?)",
        [JSON.stringify(reps.map((r) => [r.table, r.added, r.updated, r.conflicts.length])).slice(0, 500)]);
      await conn.commit();
    } else {
      await conn.rollback();
    }
    const at = join(dirname(file), "ps-import-report.md");
    writeFileSync(at, out.join("\n") + "\n");
    console.log(reps.map((r) => `${r.table.padEnd(16)} +${r.added} new · ${r.same} same · ${r.updated} updated · ${r.conflicts.length} conflicts · ${r.onlyInDb} only in DB`).join("\n"));
    console.log(Object.entries(rep.lists).map(([k, l]) => `  ${l.length} × ${k}`).join("\n"));
    console.log(`\n${apply ? "Applied." : "Dry run — rolled back, nothing changed."} Report: ${at}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});

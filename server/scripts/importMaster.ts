/**
 * Loads the client's item master (made by `python extract_master.py`) into the database.
 *   npm run master:import -- reference-materials/out/master.json            dry run: does it all, then rolls back
 *   npm run master:import -- reference-materials/out/master.json --apply    keeps it (back the database up first)
 *
 * In one transaction:
 *  - vendors: matched to suppliers by name (vendor code recorded); new ones added (not Tally ledgers);
 *  - items: every old code (PMS/PMR/T…) that is a Rudra item — by the planning sheet's old→new pairs, else by its
 *    name or Tally name — is RE-CODED everywhere it is used (GRNs, POs, indents, BOMs, stock settings…); Rudra
 *    items not in the app yet are added; kind (PM/RM/BULK/PROMO/MRO), category and origin set on all;
 *  - finished goods: matched by FG code, else name; category/brand/origin set; new ones added; the BOM of every FG
 *    in the sheet is replaced by the sheet's (qty per 100);
 *  - item × vendor costs (encrypted);
 *  - bulk (semi-finished) names into the bulk item list; chemicals are raw material, not bulk.
 * Writes reference-materials/out/import-report.md with everything that was not matched. Nothing is guessed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { encryptValue } from "../src/crypto";
import { maintenanceConnection } from "../src/db";

interface Master {
  fg: { code: string; name: string; category: string; brand: string; origin: string; active: boolean }[];
  items: { code: string; name: string; kind: string; category: string; type: string; uom: string; origin: string }[];
  vendors: { code: string; name: string }[];
  rates: { item: string; vendor: string; cost: number }[];
  /** Every item × vendor the sheet names, with or without a cost. */
  supplies?: { item: string; vendor: string }[];
  bom: { fg: string; item: string; per100: number; source?: "SHEET" | "PACK" }[];
  oldToNew: { old: string; new: string; how: string; name: string }[];
  /** Bulk (semi-finished) item names. */
  bulk: string[];
}

/** Every column holding an item code, and whether it is a locked register (re-coded under @flow_renumber). */
const CODE_COLUMNS: [string, string][] = [
  ["bom_lines", "component_code"],
  ["bom_document_lines", "component_code"],
  ["bom_issue_lines", "component_code"],
  ["bom_return_lines", "component_code"],
  ["goods_receipts", "component_code"],
  ["goods_receipts", "po_item_code"],
  ["indent_requests", "component_code"],
  ["material_return_lines", "component_code"],
  ["purchase_indents", "component_code"],
  ["purchase_order_lines", "component_code"],
  ["requisition_lines", "component_code"],
  ["stock_settings", "component_code"],
  ["supplier_rates", "component_code"],
  ["gate_entry_lines", "item_code"],
  ["tally_po_lines", "item_code"],
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** A vendor name without "M/s" and company-form words, for names Tally writes differently. */
const vendorKey = (s: string) => key(s).replace(/^ms/, "").replace(/privatelimited|pvtltd|limited|private|pvt|ltd/g, "");
const UNIT: Record<string, string> = { PCS: "Pcs", KG: "Kg", LTR: "Ltr", GRS: "Grs", SET: "Set", DZ: "Dz", BOX: "Box" };

const [file, flag] = process.argv.slice(2);

async function rows(conn: Connection, sql: string, params: unknown[] = []) {
  const [r] = await conn.query<RowDataPacket[]>(sql, params);
  return r;
}

async function run(conn: Connection, m: Master, out: string[]) {
  const list = (title: string, lines: string[]) => {
    out.push(`\n### ${title} — ${lines.length}\n`, ...lines.map((l) => `- ${l}`));
  };
  const count: Record<string, number> = {};
  const bump = (k: string, n = 1) => (count[k] = (count[k] ?? 0) + n);

  // ── vendors ────────────────────────────────────────────────────────────────
  const suppliers = await rows(conn, "SELECT id, name, vendor_code FROM suppliers");
  const supplierByName = new Map(suppliers.map((s) => [key(String(s.name)), s]));
  const looser = new Map<string, RowDataPacket | null>(); // null = two suppliers share it: no match
  for (const s of suppliers) looser.set(vendorKey(String(s.name)), looser.has(vendorKey(String(s.name))) ? null : s);
  const supplierId = new Map<string, number>(); // vendor code → supplier id
  for (const v of m.vendors) {
    const hit = supplierByName.get(key(v.name)) ?? looser.get(vendorKey(v.name)) ?? undefined;
    if (hit) {
      if (hit.vendor_code !== v.code) {
        await conn.query("UPDATE suppliers SET vendor_code = NULL WHERE vendor_code = ? AND id <> ?", [v.code, hit.id]);
        await conn.query("UPDATE suppliers SET vendor_code = ? WHERE id = ?", [v.code, hit.id]);
      }
      supplierId.set(v.code, Number(hit.id));
      bump("vendors matched");
    } else {
      const [r] = await conn.query<import("mysql2/promise").ResultSetHeader>(
        "INSERT INTO suppliers (name, vendor_code, approved, from_tally) VALUES (?, ?, 1, 0)",
        [v.name.slice(0, 120), v.code],
      );
      supplierId.set(v.code, r.insertId);
      bump("vendors added (not in Tally)");
    }
  }

  // ── items: old code → Rudra code ───────────────────────────────────────────
  const items = new Map(m.items.map((i) => [i.code, i]));
  const byName = new Map<string, string[]>();
  for (const i of m.items) byName.set(key(i.name), [...(byName.get(key(i.name)) ?? []), i.code]);
  const pairs = new Map(m.oldToNew.map((p) => [p.old, p.new]));
  const comps = await rows(conn, "SELECT code, name, unit, tally_name FROM components");
  const inDb = new Set(comps.map((c) => String(c.code)));
  const recode = new Map<string, string>(); // old → new
  const claimedBy = new Map<string, string>(); // new → old
  const unmatched: string[] = [];
  const clash: string[] = [];
  for (const c of comps) {
    const code = String(c.code);
    if (items.has(code)) continue; // already a Rudra code
    const named = (n: unknown) => (n ? byName.get(key(String(n))) : undefined);
    const hits = [...new Set([pairs.get(code), ...(named(c.name) ?? []), ...(named(c.tally_name) ?? [])].filter(Boolean))] as string[];
    const target = pairs.get(code) ?? (hits.length === 1 ? hits[0] : undefined);
    if (!target) {
      unmatched.push(`${code} ${c.name}${hits.length > 1 ? ` — several Rudra items share the name: ${hits.join(", ")}` : ""}`);
      continue;
    }
    if (claimedBy.has(target) || (inDb.has(target) && !recode.has(target))) {
      clash.push(`${code} ${c.name} → ${target}, already taken by ${claimedBy.get(target) ?? target} — left as is`);
      continue;
    }
    recode.set(code, target);
    claimedBy.set(target, code);
  }
  await conn.query("SET @flow_renumber = 1");
  try {
    for (const [from, to] of recode) {
      const [old] = await rows(conn, "SELECT * FROM components WHERE code = ?", [from]);
      await conn.query("UPDATE components SET tally_name = NULL WHERE code = ?", [from]);
      await conn.query("INSERT INTO components (code, name, type, unit, tally_name, active) VALUES (?, ?, ?, ?, ?, ?)", [
        to,
        old.name,
        old.type,
        old.unit,
        old.tally_name,
        old.active,
      ]);
      for (const [table, col] of CODE_COLUMNS) {
        const [r] = await conn.query<import("mysql2/promise").ResultSetHeader>(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`, [to, from]);
        if (r.affectedRows) bump(`re-coded rows in ${table}.${col}`, r.affectedRows);
      }
      await conn.query("DELETE FROM components WHERE code = ?", [from]);
      bump("items re-coded");
    }
  } finally {
    await conn.query("SET @flow_renumber = NULL");
  }

  // ── items: Rudra details on every item; new ones added ──────────────────────
  const now = new Map((await rows(conn, "SELECT code, unit, tally_name FROM components")).map((c) => [String(c.code), c]));
  for (const i of m.items) {
    const was = now.get(i.code);
    const unit = was?.tally_name ? String(was.unit) : (UNIT[i.uom] ?? i.uom).slice(0, 16);
    if (was) {
      await conn.query("UPDATE components SET name = ?, type = ?, kind = ?, category = ?, origin = ?, unit = ?, active = 1 WHERE code = ?", [
        i.name.slice(0, 160), i.type.slice(0, 40), i.kind, i.category.slice(0, 60), i.origin.slice(0, 20), unit, i.code,
      ]);
      bump("items updated");
    } else {
      await conn.query("INSERT INTO components (code, name, type, kind, category, origin, unit) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        i.code, i.name.slice(0, 160), i.type.slice(0, 40), i.kind, i.category.slice(0, 60), i.origin.slice(0, 20), unit,
      ]);
      bump("items added");
    }
  }

  // ── finished goods + BOM ───────────────────────────────────────────────────
  const products = await rows(conn, "SELECT id, name, fg_code FROM products");
  const productByCode = new Map(products.filter((p) => p.fg_code).map((p) => [String(p.fg_code).toUpperCase(), p]));
  const productByName = new Map(products.map((p) => [key(String(p.name)), p]));
  const productId = new Map<string, number>();
  const fgSkipped: string[] = [];
  const claimed = new Map<number, string>(); // product id → FG code that took it
  for (const f of m.fg) {
    const hit = productByCode.get(f.code) ?? productByName.get(key(f.name));
    if (hit && claimed.has(Number(hit.id))) {
      fgSkipped.push(`${f.code} ${f.name} — same product as ${claimed.get(Number(hit.id))}`);
    } else if (hit) {
      claimed.set(Number(hit.id), f.code);
      await conn.query("UPDATE products SET fg_code = ?, category = ?, brand = ?, origin = ? WHERE id = ?", [
        f.code, f.category.slice(0, 60), f.brand.slice(0, 60), f.origin.slice(0, 20), hit.id,
      ]);
      productId.set(f.code, Number(hit.id));
      bump("FG matched");
    } else {
      const [r] = await conn.query<import("mysql2/promise").ResultSetHeader>(
        "INSERT INTO products (name, fg_code, category, brand, origin, active) VALUES (?, ?, ?, ?, ?, ?)",
        [f.name.slice(0, 160), f.code, f.category.slice(0, 60), f.brand.slice(0, 60), f.origin.slice(0, 20), f.active ? 1 : 0],
      );
      productId.set(f.code, r.insertId);
      claimed.set(r.insertId, f.code);
      productByName.set(key(f.name), { id: r.insertId } as RowDataPacket);
      bump("FG added");
    }
  }
  const bomOf = new Map<number, Master["bom"]>();
  for (const b of m.bom) {
    const id = productId.get(b.fg);
    if (id) bomOf.set(id, [...(bomOf.get(id) ?? []), b]);
  }
  for (const [id, lines] of bomOf) {
    await conn.query("DELETE FROM bom_lines WHERE product_id = ?", [id]);
    for (const l of lines) {
      await conn.query("INSERT INTO bom_lines (product_id, component_code, per_100, qty_source) VALUES (?, ?, ?, ?)", [
        id, l.item, l.per100, l.source ?? "SHEET",
      ]);
    }
    bump("BOM lines written", lines.length);
  }
  bump("FG with a BOM from the sheet", bomOf.size);

  // ── costs ──────────────────────────────────────────────────────────────────
  for (const r of m.rates) {
    const sid = supplierId.get(r.vendor);
    if (!sid) continue;
    await conn.query(
      "INSERT INTO supplier_rates (supplier_id, component_code, rate_enc) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE rate_enc = VALUES(rate_enc)",
      [sid, r.item, encryptValue(String(r.cost))],
    );
    bump("item × vendor costs");
  }

  // vendors named for an item without a cost: mapped, no fixed rate (a costed mapping is never replaced)
  for (const p of m.supplies ?? []) {
    const sid = supplierId.get(p.vendor);
    if (!sid) continue;
    const [r] = await conn.query<import("mysql2/promise").ResultSetHeader>(
      "INSERT IGNORE INTO supplier_rates (supplier_id, component_code, rate_enc) VALUES (?, ?, NULL)",
      [sid, p.item],
    );
    if (r.affectedRows) bump("item × vendor mapped without a cost");
  }

  // ── bulk: semi-finished items made here (chemicals are raw material, not bulk) ──
  for (const name of m.bulk) {
    const [r] = await conn.query<import("mysql2/promise").ResultSetHeader>(
      "INSERT IGNORE INTO bulk_items (name, unit) VALUES (?, ?)",
      [name.slice(0, 120), /lip oil|foundation|liquid/i.test(name) ? "L" : "KG"],
    );
    if (r.affectedRows) bump("bulk items added");
  }
  const chemicals = await rows(conn, "SELECT id, name FROM bulk_items WHERE code IS NOT NULL");
  const keptChemicals: string[] = [];
  for (const d of chemicals) {
    await conn.query("SAVEPOINT chem");
    try {
      await conn.query("DELETE FROM bulk_items WHERE id = ?", [d.id]);
      bump("chemicals taken off the bulk list");
    } catch {
      await conn.query("ROLLBACK TO SAVEPOINT chem"); // used by a bulk plan/report: kept
      keptChemicals.push(String(d.name));
    }
  }

  await conn.query("UPDATE app_meta SET v = CAST(v AS UNSIGNED) + 1 WHERE k IN ('masters_version', 'state_version', 'resync_version')");

  out.push("| | count |", "|---|---|", ...Object.entries(count).map(([k, v]) => `| ${k} | ${v} |`));
  list("Old items with no Rudra item (kept as they are)", unmatched);
  list("Old items whose Rudra code is already taken (kept as they are)", clash);
  list("FG that is the same product as another FG code (skipped)", fgSkipped);
  list("Chemicals still on the bulk list (used by a plan or report)", keptChemicals);
  return count;
}

async function main() {
  if (!file || (flag && flag !== "--apply")) throw new Error("Usage: npm run master:import -- <master.json> [--apply]");
  const m = JSON.parse(readFileSync(file, "utf8")) as Master;
  const conn = await maintenanceConnection();
  const out = [`# Item master import — ${flag ? "APPLIED" : "dry run (nothing kept)"}\n`];
  try {
    await conn.beginTransaction();
    const count = await run(conn, m, out);
    if (flag === "--apply") {
      await conn.query("INSERT INTO audit_log (username, role, action, outcome, message) VALUES ('cli', 'admin', 'master.import', 'ok', ?)", [
        JSON.stringify(count).slice(0, 500),
      ]);
      await conn.commit();
    } else {
      await conn.rollback();
    }
    const report = join(dirname(file), "import-report.md");
    writeFileSync(report, out.join("\n") + "\n");
    console.log(out.slice(0, out.findIndex((l) => l.startsWith("\n### "))).join("\n"));
    console.log(`\n${flag ? "Applied." : "Dry run — rolled back, nothing changed."} Lists: ${report}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

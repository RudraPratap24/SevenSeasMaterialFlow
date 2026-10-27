/**
 * Migration 3/4 data steps: from the migration-1 tables (one JSON document per row)
 * to the relational schema. Runs on the admin connection inside `npm run db:setup`.
 *
 *   1. set the old JSON tables aside as legacy_*;
 *   2. create the relational tables and load the masters (components, products, BOM);
 *   3. copy every document across through the normal writer;
 *   4. reconcile — document counts, stock per component, FG stock per batch, PO and
 *      order balances must all match — before anything is kept;
 *   5. (migration 4) drop the legacy tables.
 *
 * Safe to re-run: a failed step leaves the legacy data untouched.
 */
import type { Connection, RowDataPacket } from "mysql2/promise";
import {
  deriveFgStock,
  deriveOrderProgress,
  derivePmStock,
  derivePoProgress,
  emptyState,
} from "../../src/flow/logic";
import type { FlowState } from "../../src/flow/types";
import { BOM_SOURCE, SEED_COMPONENTS, SEED_PRODUCTS } from "../seed/masterData";
import { decryptValue, encryptValue, isEncrypted } from "./crypto";
import { countDocuments, loadState, persistChanges, saveSnapshot, seedSequences } from "./repository";
import { HEADER } from "./tables";
import { LEGACY_DOC_TABLES, RELATIONAL_TABLES } from "./schema";

/** Migration-1 storage: FlowState collection → table, and its encrypted top-level fields. */
const LEGACY_SPEC: Record<string, { collection: keyof FlowState; encrypt: string[] }> = {
  gate_entries: { collection: "gateEntries", encrypt: ["vehicleNo", "lrNo"] },
  grn_lines: { collection: "grnLines", encrypt: [] },
  qc_intimations: { collection: "qcIntimations", encrypt: [] },
  ar_records: { collection: "arRecords", encrypt: [] },
  requisitions: { collection: "requisitions", encrypt: [] },
  material_returns: { collection: "mrns", encrypt: [] },
  fg_transfers: { collection: "fgTransfers", encrypt: [] },
  pdi_records: { collection: "pdiRecords", encrypt: [] },
  customer_orders: { collection: "orders", encrypt: ["partyName", "partyAddress", "custPoNo"] },
  dispatch_slips: { collection: "dispatchSlips", encrypt: ["partyName", "partyAddress", "invoiceNo"] },
  purchase_indents: { collection: "indents", encrypt: [] },
  purchase_orders: { collection: "purchaseOrders", encrypt: ["lines"] },
};

async function tableExists(conn: Connection, table: string): Promise<boolean> {
  const [r] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    [table],
  );
  return r.length > 0;
}
async function columnExists(conn: Connection, table: string, column: string): Promise<boolean> {
  const [r] = await conn.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column],
  );
  return r.length > 0;
}

/** Components, products and their BOM — inserted if missing, never overwriting edits made since. */
export async function importMasterData(conn: Connection): Promise<void> {
  for (const c of SEED_COMPONENTS) {
    await conn.execute("INSERT IGNORE INTO components (code, name, type) VALUES (?, ?, ?)", [c.code, c.name, c.type]);
  }
  for (const p of SEED_PRODUCTS) {
    await conn.execute("INSERT IGNORE INTO products (name, fg_code, vendor, box_size) VALUES (?, ?, ?, ?)", [
      p.name,
      p.fg,
      p.vendor,
      p.boxSize,
    ]);
  }
  const [ids] = await conn.query<RowDataPacket[]>("SELECT id, name FROM products");
  const idByName = new Map(ids.map((r) => [String(r.name), Number(r.id)]));
  for (const p of BOM_SOURCE) {
    const id = idByName.get(p.name);
    if (!id) continue;
    for (const c of p.comps) {
      await conn.execute("INSERT IGNORE INTO bom_lines (product_id, component_code, per_100) VALUES (?, ?, ?)", [id, c.c, c.p]);
    }
  }
}

async function loadLegacyState(conn: Connection): Promise<FlowState> {
  const state = emptyState();
  for (const [table, spec] of Object.entries(LEGACY_SPEC)) {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT data FROM legacy_${table} ORDER BY seq`);
    (state[spec.collection] as unknown[]) = rows.map((r) => {
      const doc = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
      for (const f of spec.encrypt) if (isEncrypted(doc[f])) doc[f] = decryptValue(doc[f] as string);
      return doc;
    });
  }
  const [levels] = await conn.query<RowDataPacket[]>("SELECT code, opening, min_level FROM legacy_stock_levels");
  for (const r of levels) {
    if (r.opening !== null) state.openings[r.code] = Number(r.opening);
    if (r.min_level !== null) state.minLevels[r.code] = Number(r.min_level);
  }
  return state;
}

/** Throws unless the converted registers give exactly the same figures as the originals. */
function reconcile(a: FlowState, b: FlowState): void {
  const problems: string[] = [];
  for (const k of Object.keys(LEGACY_SPEC).map((t) => LEGACY_SPEC[t].collection)) {
    const x = (a[k] as unknown[]).length;
    const y = (b[k] as unknown[]).length;
    if (x !== y) problems.push(`${k}: ${x} documents before, ${y} after`);
  }
  const pm = (s: FlowState) =>
    [...derivePmStock(s.grnLines, s.requisitions, s.mrns, s.openings, s.minLevels).values()]
      .map((r) => `${r.code}:${r.closing}/${r.underTest}/${r.hold}/${r.rejected}`)
      .sort()
      .join(",");
  if (pm(a) !== pm(b)) problems.push("store stock differs");
  const fg = (s: FlowState) =>
    [...deriveFgStock(s).values()]
      .map((r) => `${r.productName}::${r.batchNo}:${r.inStock}:${r.pdi}`)
      .sort()
      .join(",");
  if (fg(a) !== fg(b)) problems.push("FG stock differs");
  const po = (s: FlowState) =>
    derivePoProgress(s.purchaseOrders, s.gateEntries, s.grnLines)
      .map((p) => `${p.po.id}:${p.po.status}:${p.value}:${p.lines.map((l) => l.pending).join("/")}`)
      .join(",");
  if (po(a) !== po(b)) problems.push("PO balances differ");
  const orders = (s: FlowState) =>
    deriveOrderProgress(s.orders, s.dispatchSlips)
      .map((o) => `${o.order.id}:${o.lines.map((l) => l.balance).join("/")}`)
      .join(",");
  if (orders(a) !== orders(b)) problems.push("order balances differ");
  if (problems.length) throw new Error(`Conversion check failed — nothing kept:\n  ${problems.join("\n  ")}`);
}

export async function convertLegacyData(conn: Connection): Promise<void> {
  // 1. set the JSON tables aside (only if they are still the migration-1 shape)
  if (await columnExists(conn, "gate_entries", "data")) {
    const renames = [...LEGACY_DOC_TABLES, "stock_levels"].map((t) => `${t} TO legacy_${t}`).join(", ");
    await conn.query(`RENAME TABLE ${renames}`);
  }
  // suppliers: rates move to their own table; unapproved suppliers can be recorded
  if (!(await columnExists(conn, "suppliers", "approved"))) {
    await conn.query("ALTER TABLE suppliers ADD COLUMN approved TINYINT(1) NOT NULL DEFAULT 1 AFTER city");
  }
  if (await columnExists(conn, "suppliers", "rates")) {
    await conn.query("ALTER TABLE suppliers MODIFY rates TEXT NULL");
  }
  await conn.query("INSERT IGNORE INTO app_meta (k, v) VALUES ('masters_version', '0')");

  // 2. relational tables + masters
  for (const ddl of RELATIONAL_TABLES) await conn.query(ddl);
  await importMasterData(conn);

  if (await columnExists(conn, "suppliers", "rates")) {
    const [sup] = await conn.query<RowDataPacket[]>("SELECT id, rates FROM suppliers WHERE rates IS NOT NULL");
    for (const s of sup) {
      const rates = decryptValue<Record<string, number>>(String(s.rates));
      for (const [code, rate] of Object.entries(rates)) {
        await conn.execute("INSERT IGNORE INTO supplier_rates (supplier_id, component_code, rate_enc) VALUES (?, ?, ?)", [
          s.id,
          code,
          encryptValue(String(rate)),
        ]);
      }
    }
  }

  // 3–4. copy and reconcile, all or nothing
  if (!(await tableExists(conn, "legacy_gate_entries"))) return; // fresh install: nothing to convert
  const legacy = await loadLegacyState(conn);
  await ensureVersioningSchema(conn); // the writer stamps change numbers
  await conn.beginTransaction();
  try {
    await saveSnapshot(conn, legacy, "before relational migration", { id: null, username: "migration" });
    await persistChanges(conn, emptyState(), legacy, null, true);
    const converted = await loadState(conn);
    reconcile(legacy, converted);
    await conn.commit();
    console.log(`  converted ${countDocuments(legacy)} documents; counts and stock reconcile exactly.`);
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

export async function dropLegacyTables(conn: Connection): Promise<void> {
  for (const t of [...LEGACY_DOC_TABLES, "stock_levels"]) await conn.query(`DROP TABLE IF EXISTS legacy_${t}`);
  if (await columnExists(conn, "suppliers", "rates")) await conn.query("ALTER TABLE suppliers DROP COLUMN rates");
}

/** Change numbers on register documents + the numbering sequences (idempotent DDL). */
async function ensureVersioningSchema(conn: Connection): Promise<void> {
  await conn.query(`CREATE TABLE IF NOT EXISTS document_sequences (
    series  VARCHAR(8)   NOT NULL PRIMARY KEY,
    last_no INT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  await conn.query("INSERT IGNORE INTO app_meta (k, v) VALUES ('resync_version', '0')");
  for (const { table } of Object.values(HEADER)) {
    if (!(await columnExists(conn, table, "row_version"))) {
      await conn.query(
        `ALTER TABLE ${table} ADD COLUMN row_version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'state version of the last change', ADD KEY ix_row_version (row_version)`,
      );
    }
  }
}

/** Migration 5: versioning schema, then each series continues from the highest number in use. */
export async function addVersioning(conn: Connection): Promise<void> {
  await ensureVersioningSchema(conn);
  await seedSequences(conn, await loadState(conn));
}

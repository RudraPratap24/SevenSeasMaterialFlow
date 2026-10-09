// Data-integrity checks: renames stay consistent everywhere, and MySQL itself
// rejects broken references and impossible values (not only the application).
// Requires a DEVELOPMENT database with --dev-passwords and the demo data loaded.
// Usage: node server/test/integrity.mjs [baseUrl]
import "dotenv/config";
import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";

const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, x)));

function client() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", "x-flow-request": "1", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json };
  };
}
// Runs the maintenance command directly (no shell — arguments are passed as-is).
const npm = (...args) => execFileSync(process.execPath, ["--import", "tsx", "server/scripts/master.ts", ...args], { encoding: "utf8" });
const q = (s) => s;

const admin = client();
await admin("POST", "/api/auth/login", { username: "admin", password: "seven@admin" });
const state = async () => (await admin("GET", "/api/state")).json.state;
const fgStock = (s) => {
  const m = {};
  for (const t of s.fgTransfers) if (t.status === "RECEIVED") for (const l of t.lines) m[`${l.productName}::${l.batchNo}`] = (m[`${l.productName}::${l.batchNo}`] ?? 0) + l.totalQty;
  for (const d of s.dispatchSlips) for (const l of d.lines) m[`${l.productName}::${l.batchNo}`] = (m[`${l.productName}::${l.batchNo}`] ?? 0) - l.totalQty;
  return m;
};

console.log("product rename is consistent everywhere");
{
  const before = await state();
  const old = before.fgTransfers[0].lines[0].productName;
  const renamed = `${old} (renamed)`;
  const mentions = (s, name) => JSON.stringify(s).split(JSON.stringify(name)).length - 1;
  const used = mentions(before, old);
  npm("rename-product", q(old), q(renamed));
  const after = await state();
  check("old name gone from every document", mentions(after, old) === 0, `${mentions(after, old)} left`);
  check("new name on every document that had the old one", mentions(after, renamed) === used, `${mentions(after, renamed)} vs ${used}`);
  const m = (await admin("GET", "/api/masters")).json;
  check("product list shows the new name", m.products.some((p) => p.name === renamed) && !m.products.some((p) => p.name === old));
  const fgB = fgStock(before), fgA = fgStock(after);
  check(
    "FG stock unchanged — same batches, same quantities",
    Object.keys(fgB).every((k) => fgA[k.replace(old, renamed)] === fgB[k]) && Object.keys(fgA).length === Object.keys(fgB).length,
  );
  const pdiBatch = after.pdiRecords.find((p) => p.productName === renamed && p.status === "PASSED");
  check("PDI result still belongs to the renamed product's batch", !!pdiBatch);
  npm("rename-product", q(renamed), q(old));
  check("rename back restores the original", mentions(await state(), old) === used);
}

console.log("supplier rename is consistent everywhere");
{
  const before = await state();
  const old = before.grnLines[0].supplierName;
  const renamed = `${old} LLP`;
  npm("rename-supplier", q(old), q(renamed));
  const after = await state();
  const grns = after.grnLines.filter((g) => g.gateEntryId === before.grnLines[0].gateEntryId);
  const gate = after.gateEntries.find((g) => g.id === before.grnLines[0].gateEntryId);
  check("gate entry, its GRNs and QC slips all show the new name",
    gate.supplierName === renamed && grns.every((g) => g.supplierName === renamed) &&
    after.qcIntimations.filter((x) => grns.some((g) => g.grnNo === x.grnNo)).every((x) => x.supplierName === renamed));
  check("POs to that supplier follow", after.purchaseOrders.filter((p) => before.purchaseOrders.find((b) => b.id === p.id)?.supplierName === old).every((p) => p.supplierName === renamed));
  npm("rename-supplier", q(renamed), q(old));
}

console.log("customer rename (encrypted name) is consistent everywhere");
{
  const before = await state();
  const old = before.orders[0].partyName;
  const renamed = `${old} Pvt Ltd`;
  npm("rename-customer", q(old), q(renamed));
  const after = await state();
  check("orders and dispatches show the new name",
    after.orders.filter((o, i) => before.orders[i].partyName === old).every((o) => o.partyName === renamed) &&
    after.dispatchSlips.filter((d, i) => before.dispatchSlips[i].partyName === old).every((d) => d.partyName === renamed));
  npm("rename-customer", q(renamed), q(old));
}

console.log("customer edit (API) is consistent, guarded and role-restricted");
{
  const acc = client();
  await acc("POST", "/api/auth/login", { username: "accounts", password: "seven@accounts" });
  const list = (await acc("GET", "/api/customers")).json.customers;
  const c = list.find((x) => x.orders > 0 && x.dispatches > 0) ?? list[0];
  const before = await state();
  const r = await acc("POST", `/api/customers/${c.id}`, { name: `${c.name} Traders`, address: "New Address, Delhi", version: c.version });
  check("accounts can edit a customer", r.status === 200, JSON.stringify(r.json));
  const after = await state();
  const touched = (s) => [...s.orders, ...s.dispatchSlips].filter((d) => d.partyName.startsWith(c.name));
  check("every order and dispatch shows the new name and address",
    touched(after).length === touched(before).length && touched(after).every((d) => d.partyName === `${c.name} Traders` && d.partyAddress === "New Address, Delhi"));
  const stale = await acc("POST", `/api/customers/${c.id}`, { name: "Lost Update", address: "", version: c.version });
  check("stale edit refused — no lost update (409)", stale.status === 409, JSON.stringify(stale.json));
  const other = list.find((x) => x.id !== c.id);
  const fresh = (await acc("GET", "/api/customers")).json.customers.find((x) => x.id === c.id);
  if (other) {
    const dup = await acc("POST", `/api/customers/${c.id}`, { name: other.name.toUpperCase(), address: "", version: fresh.version });
    check("duplicate name refused, case-insensitively (409)", dup.status === 409, JSON.stringify(dup.json));
  }
  const fg = client();
  await fg("POST", "/api/auth/login", { username: "fgwh", password: "seven@fgwh" });
  check("FG warehouse can view but not edit customers",
    (await fg("GET", "/api/customers")).status === 200 &&
      (await fg("POST", `/api/customers/${c.id}`, { name: "x", address: "", version: fresh.version })).status === 403);
  const qc = client();
  await qc("POST", "/api/auth/login", { username: "qc", password: "seven@qc" });
  check("QC cannot list customers", (await qc("GET", "/api/customers")).status === 403);
  const back = await acc("POST", `/api/customers/${c.id}`, { name: c.name, address: c.address, version: fresh.version });
  check("edit back restores the original", back.status === 200);
}

console.log("the database enforces integrity itself (as the app account)");
{
  const db = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const refused = async (sql, params, code) => {
    try { await db.execute(sql, params); return false; } catch (e) { return !code || e.code === code || e.errno === code; }
  };
  check("GRN for a gate entry that does not exist → foreign key error",
    await refused("INSERT INTO goods_receipts (grn_no, gate_entry_no, component_code, received_date, total_qty) VALUES ('TST1','GE-9999','PMS0001','2026-01-01',5)", [], "ER_NO_REFERENCED_ROW_2"));
  check("GRN for an unknown component → foreign key error",
    await refused("INSERT INTO goods_receipts (grn_no, gate_entry_no, component_code, received_date, total_qty) VALUES ('TST2','GE-0001','XX0000','2026-01-01',5)", [], "ER_NO_REFERENCED_ROW_2"));
  check("negative quantity → check constraint error",
    await refused("INSERT INTO goods_receipts (grn_no, gate_entry_no, component_code, received_date, total_qty) VALUES ('TST3','GE-0001','PMS0001','2026-01-01',-5)", [], 3819));
  check("invalid QC status → rejected",
    await refused("INSERT INTO qc_results (ar_no, intimation_no, decided_on, status) VALUES ('TST4','QCI-0001','2026-01-01','MAYBE')", []));
  check("gate-out without invoice → check constraint error",
    await refused("UPDATE dispatch_slips SET gate_out_at = NOW(3) WHERE invoice_no_enc IS NULL LIMIT 1", [], 3819));
  check("a written total that disagrees with boxes × per box → impossible (generated column)",
    await refused("UPDATE dispatch_lines SET total_qty = 1 LIMIT 1", []));
  check("deleting the audit trail → no privilege", await refused("DELETE FROM audit_log LIMIT 1", [], "ER_TABLEACCESS_DENIED_ERROR"));
  check("renaming a product as the app account → no privilege",
    await refused("UPDATE products SET name = 'x' WHERE id = 1", [], "ER_TABLEACCESS_DENIED_ERROR"));

  // Stage locks — enforced by MySQL triggers, whatever the application does.
  const one = async (sql) => { const [r] = await db.query(sql); return r[0] ? Object.values(r[0])[0] : null; };
  const SIGNAL = 1644;
  const intimated = await one("SELECT grn_no FROM qc_intimations LIMIT 1");
  check("DB: GRN quantity cannot change once sent to QC",
    await refused("UPDATE goods_receipts SET total_qty = total_qty + 1 WHERE grn_no = ?", [intimated], SIGNAL));
  const pasted = await one("SELECT grn_no FROM goods_receipts WHERE barcoded = 1 LIMIT 1");
  check("DB: a recorded barcode cannot be un-recorded",
    await refused("UPDATE goods_receipts SET barcoded = 0 WHERE grn_no = ?", [pasted], SIGNAL));
  check("DB: a gate entry cannot be edited",
    await refused("UPDATE gate_entries SET remark = 'edited' WHERE gate_entry_no = 'GE-0001'", [], SIGNAL));
  check("DB: a QC result cannot be edited",
    await refused("UPDATE qc_results SET status = 'APPROVED' WHERE status = 'REJECTED' LIMIT 1", [], SIGNAL));
  const issued = await one("SELECT req_no FROM requisitions WHERE issued_at IS NOT NULL LIMIT 1");
  check("DB: issued quantities cannot change",
    await refused("UPDATE requisition_lines SET qty_issued = qty_issued + 1 WHERE req_no = ? LIMIT 1", [issued], SIGNAL));
  check("DB: an approved PO's approval cannot be changed",
    await refused("UPDATE purchase_orders SET approved_by = (SELECT MIN(id) FROM users) + 1 WHERE approved_by IS NOT NULL LIMIT 1", [], SIGNAL));
  const out = await one("SELECT dispatch_no FROM dispatch_slips WHERE gate_out_at IS NOT NULL LIMIT 1");
  check("DB: a gate-out cannot be re-timed",
    await refused("UPDATE dispatch_slips SET gate_out_at = NOW(3) WHERE dispatch_no = ?", [out], SIGNAL));
  check("DB: a dispatch's invoice cannot be replaced",
    await refused("UPDATE dispatch_slips SET invoice_date = '2020-01-01' WHERE dispatch_no = ?", [out], SIGNAL));
  check("DB: register entries cannot be deleted (even where DELETE is granted)",
    await refused("DELETE FROM pdi_records LIMIT 1", [], process.env.ALLOW_DEMO_RESET === "true" ? SIGNAL : "ER_TABLEACCESS_DENIED_ERROR"));
  check("DB: bookkeeping (change numbers) still updates",
    !(await refused("UPDATE gate_entries SET row_version = row_version WHERE gate_entry_no = 'GE-0001'", [])));
  if (process.env.DB_ADMIN_USER) {
    const root = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_ADMIN_USER,
      password: process.env.DB_ADMIN_PASSWORD ?? "", database: process.env.DB_NAME,
    });
    let blocked = false;
    try { await root.query("UPDATE audit_log SET message = 'tampered' LIMIT 1"); } catch (e) { blocked = e.errno === SIGNAL; }
    check("DB: even the database admin cannot edit the audit log", blocked);
    await root.end();
  }

  // Atomicity: a transaction that fails part-way leaves nothing behind.
  await db.beginTransaction();
  await db.execute("INSERT INTO locations (name) VALUES ('ATOMICITY TEST')");
  const failed = await refused("INSERT INTO goods_receipts (grn_no, gate_entry_no, component_code, received_date, total_qty) VALUES ('TST5','GE-9999','PMS0001','2026-01-01',5)", []);
  await db.rollback();
  const [left] = await db.query("SELECT COUNT(*) AS n FROM locations WHERE name = 'ATOMICITY TEST'");
  check("failed transaction rolls back completely", failed && Number(left[0].n) === 0);
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

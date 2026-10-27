// GRN against gate-checked Tally PO items: one GRN per item, in the PO's unit, never more than came in at
// the gate; Store's count is what the PO counts as received; a PMS code picked by Store is remembered.
// Requires a DEVELOPMENT database with --dev-passwords and the demo data loaded (npm run db:demo).
// Usage: node server/test/grn.mjs [baseUrl]
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const login = async (u) => {
  const c = client();
  await c("POST", "/api/auth/login", { username: u, password: `seven@${u}` });
  return c;
};
const act = async (c, name, args) => c("POST", `/api/actions/${name}`, { args, basis: (await c("GET", "/api/version")).json.version });
const tally = (file) => execFileSync(process.execPath, ["--import", "tsx", "server/scripts/tally.ts", "import", file], { encoding: "utf8" });

// A PO of our own per run: APF CAP (in the master, 7000 Pcs) and an item not in the master (12.5 Kg).
const run = Date.now().toString(36).toUpperCase();
const PO = `G${run}`, ITEM = `TEST LABEL ${run}`;
const file = join(mkdtempSync(join(tmpdir(), "grn-")), "pos.xml");
writeFileSync(
  file,
  readFileSync("server/test/fixtures/tally-purchase-orders.xml", "utf8")
    .replaceAll("26SEV910", PO)
    .replaceAll("26SEV911", `${PO}X`)
    .replaceAll("APF STICKER", ITEM),
);
tally(file);

const gate = await login("gate");
const store = await login("store");
const line = (itemName, qty) => ({ itemName, itemCode: "", unit: "", qty, remark: "" });
const gateIn = (lines) =>
  act(gate, "addGateEntry", [{
    date: "", supplierName: "", productDesc: "", invoiceNo: `G-${run}-${Math.random().toString(36).slice(2, 7)}`, invoiceDate: "",
    poNo: PO, invoiceQty: null, transportName: "", lrNo: "", vehicleNo: "HR55-T-0002", timeIn: "00:00", timeOut: "",
    driverSign: false, remark: "", lines,
  }]);
const ge = (await gateIn([line("APF CAP", 5000), line(ITEM, 12.5)])).json?.changes?.gateEntries?.at(-1);
check("vehicle checked in at the gate with 2 items", ge?.lines.length === 2, JSON.stringify(ge));

const grn = (gateLineNo, over = {}) => ({
  gateEntryId: ge.id, gateLineNo, componentCode: "PMS0002", componentName: "", type: "", brandName: "SEVEN SEAS",
  receivedDate: "", poNo: "", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: null, totalBoxes: null,
  totalQty: 1, unit: "", remarkStore: "", location: "Store — Floor 1", ...over,
});
const refused = async (name, args, pattern, who = store, action = "addGrnLine") => {
  const r = await act(who, action, args);
  check(name, [400, 403, 409].includes(r.status) && (!pattern || pattern.test(r.json?.error ?? "")), `${r.status} ${r.json?.error}`);
};

console.log("Store sees what came in");
const ss = (await store("GET", "/api/state")).json.state;
check("the gate-checked items are visible to Store", ss.gateEntries.find((g) => g.id === ge.id)?.lines.length === 2);

console.log("GRN is refused when");
await refused("no item of the gate entry is picked", [grn(null)], /Pick the item/);
await refused("the count is more than came in at the gate", [grn(1, { totalQty: 5001 })], /more than the 5000 Pcs checked in/);
await refused("boxes × qty per box is more than came in", [grn(1, { qtyPerBox: 501, totalBoxes: 10 })], /more than the 5000 Pcs/);
await refused("the PMS code is not the item's own", [grn(1, { componentCode: "PMS0003", totalQty: 10 })], /must use that code/);
await refused("the count has more than 3 decimals", [grn(2, { componentCode: "PMS0003", totalQty: 1.2345 })], /3 decimals/);
await refused("an unknown PMS code is picked", [grn(2, { componentCode: "PMS9999", totalQty: 1 })], /not a known component/);
await refused("the gate does it", [grn(1, { totalQty: 10 })], null, gate);

console.log("GRN per item");
const g1 = await act(store, "addGrnLine", [grn(1, { qtyPerBox: 480, totalBoxes: 10, unit: "Box", poNo: "WRONG", supplierName: "WRONG" })]);
const r1 = g1.json?.changes?.grnLines?.at(-1);
check("counted in boxes: 480 × 10 = 4800 (short of 5000)", g1.status === 200 && r1?.totalQty === 4800, JSON.stringify(g1.json));
check("unit, PO, supplier and PO qty are the PO's, not the screen's", r1?.unit === "Pcs" && r1?.poNo === PO && r1?.supplierName === "Test Packaging & Co" && r1?.poQty === 7000, JSON.stringify(r1));
await refused("a second GRN for the same item", [grn(1, { totalQty: 10 })], /already has a GRN/);
const g2 = await act(store, "addGrnLine", [grn(2, { componentCode: "PMS0003", totalQty: 12.25 })]);
const r2 = g2.json?.changes?.grnLines?.at(-1);
check("an item without code: Store's PMS code, Kg with decimals", g2.status === 200 && r2?.componentCode === "PMS0003" && r2?.unit === "Kg" && r2?.totalQty === 12.25, JSON.stringify(g2.json));

console.log("Store's count is what the PO has received");
{
  const { tsImport } = await import("tsx/esm/api");
  const { deriveTallyPoProgress } = await tsImport("../../src/flow/logic.ts", import.meta.url);
  const s = (await gate("GET", "/api/state")).json.state;
  const p = deriveTallyPoProgress(s.tallyPos.filter((x) => x.poNo === PO), s.gateEntries, s.grnLines)[0];
  check("APF CAP pending = 7000 − Store's count 4800 = 2200", p?.lines.find((l) => l.itemName === "APF CAP")?.pending === 2200, JSON.stringify(p?.lines));
}
await refused("the gate can't take more than that (2201)", [{
  date: "", supplierName: "", productDesc: "", invoiceNo: `G-${run}-x`, invoiceDate: "", poNo: PO, invoiceQty: null, transportName: "",
  lrNo: "", vehicleNo: "HR55-T-0002", timeIn: "00:00", timeOut: "", driverSign: false, remark: "", lines: [line("APF CAP", 2201)],
}], /more than the 2200 Pcs/, gate, "addGateEntry");
const rest = await gateIn([line("APF CAP", 2200), line(ITEM, 0.25)]);
check("the shortfall stays open and can still arrive (2200 Pcs, 0.25 Kg)", rest.status === 200, JSON.stringify(rest.json));

console.log("correction before QC");
await refused("not above what came in at the gate", [r2.grnNo, 12.75], /more than the 12.5 Kg/, store, "updateGrnQty");
const fix = await act(store, "updateGrnQty", [r2.grnNo, 12.5]);
check("a Kg count keeps its decimals", fix.status === 200 && fix.json.changes.grnLines.find((g) => g.grnNo === r2.grnNo)?.totalQty === 12.5, JSON.stringify(fix.json));

console.log("remembered PMS code");
tally(file);
const po = (await gate("GET", "/api/state")).json.state.tallyPos.find((p) => p.poNo === PO);
check("next Tally import gives the item Store's code", po?.lines.find((l) => l.itemName === ITEM)?.itemCode === "PMS0003", JSON.stringify(po?.lines));

console.log("the database itself");
const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const blocked = async (sql, params) => { try { await db.execute(sql, params); return false; } catch { return true; } };
check("one GRN per gate-checked item", await blocked(
  `INSERT INTO goods_receipts (grn_no, gate_entry_no, gate_line_no, component_code, received_date, total_qty, unit)
   VALUES (?, ?, 1, 'PMS0002', CURDATE(), 1, 'Pcs')`, [`X${run}`.slice(0, 20), ge.id]));
check("a GRN can't point at an item the gate never checked in", await blocked(
  `INSERT INTO goods_receipts (grn_no, gate_entry_no, gate_line_no, component_code, received_date, total_qty, unit)
   VALUES (?, ?, 9, 'PMS0002', CURDATE(), 1, 'Pcs')`, [`Y${run}`.slice(0, 20), ge.id]));
await act(store, "sendToQc", [r1.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
check("the count is locked once sent to QC", await blocked("UPDATE goods_receipts SET total_qty = 1 WHERE grn_no = ?", [r1.grnNo]));
await db.end();

console.log("QC acceptance updates stock");
// The app's own stock rule (opening + QC-approved − issued + returned), as the screens and server use it.
const { tsImport } = await import("tsx/esm/api");
const { derivePmStock } = await tsImport("../../src/flow/logic.ts", import.meta.url);
const stock = async () => {
  const s = (await store("GET", "/api/state")).json.state;
  return derivePmStock(s.grnLines, s.requisitions, s.mrns, s.openings, s.minLevels);
};
const qc = await login("qc");
const decide = async (grnNo, status) => {
  const slip = (await qc("GET", "/api/state")).json.state.qcIntimations.find((q) => q.grnNo === grnNo);
  return act(qc, "recordAr", [slip.id, status, "test"]);
};
const before = (await stock()).get("PMS0002");
check("before QC: the 4800 Pcs are under test, not usable", before.underTest >= 4800);
const ok1 = await decide(r1.grnNo, "APPROVED");
const after = (await stock()).get("PMS0002");
check("QC approves → +4800 Pcs usable stock, −4800 under test",
  ok1.status === 200 && after.received - before.received === 4800 && after.closing - before.closing === 4800 && before.underTest - after.underTest === 4800,
  JSON.stringify({ ok1: ok1.status, before, after }));
await act(store, "sendToQc", [r2.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
const held = await decide(r2.grnNo, "HOLD");
const kgHeld = (await stock()).get("PMS0003 · Kg");
check("QC holds → not usable (12.5 Kg on hold, nothing in stock)", held.status === 200 && kgHeld?.hold >= 12.5 && kgHeld.closing === kgHeld.received, JSON.stringify(kgHeld));
const kgBefore = kgHeld.received;
const pcsBefore = (await stock()).get("PMS0003").received;
await decide(r2.grnNo, "APPROVED");
const after2 = await stock();
const kg = after2.get("PMS0003 · Kg");
check("QC approves a Kg receipt → its own Kg stock row grows by 12.5 Kg", kg?.unit === "Kg" && kg.received - kgBefore === 12.5, JSON.stringify(kg));
check("the Kg receipt is not added to the pieces row", after2.get("PMS0003").received === pcsBefore);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Gate in against Tally purchase orders: import (read only), search data, item-wise check-in,
// partial delivery keeping the PO open, vehicle out — on the server and in the database.
// Requires a DEVELOPMENT database with --dev-passwords and the demo data loaded (npm run db:demo).
// Usage: node server/test/gate.mjs [baseUrl]
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
const tally = (file) => {
  try {
    return { ok: true, out: execFileSync(process.execPath, ["--import", "tsx", "server/scripts/tally.ts", "import", file], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr) + String(e.stdout) };
  }
};

// Unique PO numbers per run, so the test can be repeated.
const run = Date.now().toString(36).toUpperCase();
const PO = `T${run}A`, CANCELLED = `T${run}B`;
const dir = mkdtempSync(join(tmpdir(), "gate-"));
const file = join(dir, "pos.xml");
writeFileSync(file, readFileSync("server/test/fixtures/tally-purchase-orders.xml", "utf8").replaceAll("26SEV910", PO).replaceAll("26SEV911", CANCELLED));

console.log("Tally import (read only)");
const imp = tally(file);
check("the export is imported", imp.ok && /2 added/.test(imp.out), imp.out);
const bad = join(dir, "bad.xml");
writeFileSync(bad, readFileSync(file, "utf8").replace(" 12.500 Kg", " 2 Box 5 Pcs"));
const refusedImport = tally(bad);
check("a PO with a quantity it cannot read is skipped and named (never guessed); the rest still come in",
  refusedImport.ok && new RegExp(`${PO}: .*APF STICKER`).test(refusedImport.out) && /1 unchanged/.test(refusedImport.out), refusedImport.out);

const gate = await login("gate");
const state = async () => (await gate("GET", "/api/state")).json.state;
const s0 = await state();
const po = s0.tallyPos.find((p) => p.poNo === PO);
const item = (name) => po?.lines.find((l) => l.itemName === name);
check("the gate sees the PO, supplier name decoded", po?.supplierName === "Test Packaging & Co", JSON.stringify(po));
check("one row per item; the same item twice on the PO is merged", po?.lines.length === 3 && item("APF CAP")?.qty === 7000, JSON.stringify(po?.lines));
check("units and decimals exactly as in Tally", item("APF STICKER")?.qty === 12.5 && item("APF STICKER")?.unit === "Kg" && item("6 ML EYE LINER box 12pcs")?.unit === "Pcs", JSON.stringify(po?.lines));
check("PMS code from the component master", item("APF CAP")?.itemCode === "PMS0002", item("APF CAP")?.itemCode);
check("the cancelled PO is marked cancelled", s0.tallyPos.find((p) => p.poNo === CANCELLED)?.cancelled === true);
check("the Sales voucher is ignored", !s0.tallyPos.some((p) => p.poNo === "S-1"));
const store = await login("store");
check("other departments do not receive the Tally POs", (await store("GET", "/api/state")).json.state.tallyPos.length === 0);

const inv = () => `T-${run}-${Math.random().toString(36).slice(2, 7)}`;
const entry = (over = {}) => ({
  date: "", supplierName: "", productDesc: "", invoiceNo: inv(), invoiceDate: "", poNo: PO, invoiceQty: null,
  transportName: "", lrNo: "", vehicleNo: "HR55-T-0001", timeIn: "00:00", timeOut: "", driverSign: false, remark: "", lines: [], ...over,
});
const line = (itemName, qty, over = {}) => ({ itemName, itemCode: "", unit: "", qty, remark: "", ...over });
const refused = async (name, e, pattern) => {
  const r = await act(gate, "addGateEntry", [e]);
  check(name, (r.status === 400 || r.status === 409) && (!pattern || pattern.test(r.json?.error ?? "")), `${r.status} ${r.json?.error}`);
};

console.log("gate in is refused when");
await refused("the PO is not from Tally", entry({ poNo: "26SEV999X", lines: [line("APF CAP", 1)] }), /not among the purchase orders/);
await refused("the PO is cancelled in Tally", entry({ poNo: CANCELLED, lines: [line("APF CAP", 1)] }), /cancelled/);
await refused("no item is ticked", entry(), /at least one item/);
await refused("an item is not on the PO", entry({ lines: [line("SOMETHING ELSE", 1)] }), /not on PO/);
await refused("more arrives than is pending (no over-supply accepted)", entry({ lines: [line("APF CAP", 7001)] }), /more than the 7000 Pcs/);
await refused("a quantity has more than 3 decimals", entry({ lines: [line("APF STICKER", 1.2345)] }), /3 decimals/);
await refused("items are sent without a PO", entry({ poNo: "", supplierName: "X", productDesc: "x", lines: [line("APF CAP", 1)] }), /against a PO/);
await refused("no PO and no supplier name", entry({ poNo: "", supplierName: "", productDesc: "caps" }), /Supplier name is required/);
await refused("no PO and no material", entry({ poNo: "", supplierName: "X", productDesc: "" }), /material is required/);
await refused("the invoice date is not a real date", entry({ invoiceDate: "31-02-2026", lines: [line("APF CAP", 1)] }), /real date/);
await refused("the invoice date is after today", entry({ invoiceDate: "01-01-2099", lines: [line("APF CAP", 1)] }), /after today/);
await refused("the vehicle number is missing", entry({ vehicleNo: "", lines: [line("APF CAP", 1)] }), /vehicleNo/);
await refused("time in is missing", entry({ timeIn: "", lines: [line("APF CAP", 1)] }), /timeIn/);
if (new Date().toTimeString().slice(0, 5) < "23:59") {
  await refused("time in is later than now", entry({ timeIn: "23:59", lines: [line("APF CAP", 1)] }), /later than now/);
}

console.log("partial delivery");
const first = await act(gate, "addGateEntry", [
  entry({ supplierName: "Typed Wrong", lines: [line("APF CAP", 5000, { itemCode: "HACK", unit: "Box", remark: "2000 Pcs short" })] }),
]);
const made = first.json?.changes?.gateEntries?.at(-1);
check("accepted", first.status === 200, JSON.stringify(first.json));
check("supplier, item code and unit are the PO's, not the screen's", made?.supplierName === "Test Packaging & Co" && made?.lines[0].itemCode === "PMS0002" && made?.lines[0].unit === "Pcs", JSON.stringify(made));
check("the short remark is kept on the item", made?.lines[0].remark === "2000 Pcs short");
const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[row]] = await db.query("SELECT po_no, external_po_ref, tally_po_no FROM gate_entries WHERE gate_entry_no = ?", [made?.id]);
check("stored as a real link to the Tally PO", row?.tally_po_no === PO && row.po_no === null && row.external_po_ref === null, JSON.stringify(row));
await refused("more than what is still pending after it", entry({ lines: [line("APF CAP", 2001)] }), /more than the 2000 Pcs/);
await refused("the same supplier invoice twice", entry({ invoiceNo: made?.invoiceNo, lines: [line("APF CAP", 1)] }), /already in the gate register/);

console.log("the rest arrives");
const rest = await act(gate, "addGateEntry", [entry({ lines: [line("APF CAP", 2000), line("6 ML EYE LINER box 12pcs", 120), line("APF STICKER", 12.5)] })]);
check("accepted, one row per item, decimals kept", rest.status === 200 && rest.json.changes.gateEntries.at(-1).lines.length === 3 && rest.json.changes.gateEntries.at(-1).lines[2].qty === 12.5, JSON.stringify(rest.json));
await refused("the PO is now fully received", entry({ lines: [line("APF CAP", 1)] }), /fully received/);

console.log("direct arrival without PO");
const direct = await act(gate, "addGateEntry", [entry({ poNo: "", supplierName: "Free Samples Co", productDesc: "POP tray" })]);
check("accepted with supplier and material typed in", direct.status === 200 && direct.json.changes.gateEntries.at(-1).lines.length === 0, JSON.stringify(direct.json));

console.log("vehicle out");
const out = await act(gate, "recordVehicleOut", [made.id, true, "01:00"]);
const after = out.json?.changes?.gateEntries?.find((g) => g.id === made.id);
check("records time out from the server clock and the driver's sign", out.status === 200 && /^\d{2}:\d{2}$/.test(after?.timeOut) && after.timeOut !== "01:00" && after.driverSign, JSON.stringify(out.json));
const again = await act(gate, "recordVehicleOut", [made.id, true, ""]);
check("cannot be recorded twice", again.status === 409 && /already left/.test(again.json?.error), JSON.stringify(again.json));
check("other departments cannot record it", (await act(store, "recordVehicleOut", [made.id, true, ""])).status === 403);

console.log("the database itself");
const blocked = async (sql, params) => { try { await db.execute(sql, params); return false; } catch { return true; } };
check("time out cannot be changed once recorded", await blocked("UPDATE gate_entries SET time_out = '00:01' WHERE gate_entry_no = ?", [made.id]));
check("driver sign cannot be removed", await blocked("UPDATE gate_entries SET driver_signed = 0 WHERE gate_entry_no = ?", [made.id]));
check("the rest of the entry cannot be changed", await blocked("UPDATE gate_entries SET vehicle_no_enc = NULL WHERE gate_entry_no = ?", [made.id]));
check("a checked-in item cannot be changed", await blocked("UPDATE gate_entry_lines SET qty = 1 WHERE gate_entry_no = ?", [made.id]));
check("a checked-in item cannot be deleted", await blocked("DELETE FROM gate_entry_lines WHERE gate_entry_no = ?", [made.id]));
await db.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

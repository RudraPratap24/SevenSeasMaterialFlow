// The gate register as a manual record: the vehicle and its paper (supplier, invoice, qty + unit, driver), one
// photo, server date/time in, vehicle out — no PO at the gate (Store picks it at GRN). Plus the Tally PO import.
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
  return async (method, path, body, type = "application/json") => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": type, "x-flow-request": "1", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : body,
    });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(";")[0];
    const raw = Buffer.from(await res.arrayBuffer());
    let json = null;
    try { json = JSON.parse(raw.toString("utf8")); } catch {}
    return { status: res.status, json, raw, type: res.headers.get("content-type") ?? "" };
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
const store = await login("store");
const s0 = (await store("GET", "/api/state")).json.state;
const po = s0.tallyPos.find((p) => p.poNo === PO);
const item = (name) => po?.lines.find((l) => l.itemName === name);
check("Store sees the PO (it picks it at GRN), supplier name decoded", po?.supplierName === "Test Packaging & Co", JSON.stringify(po));
check("one row per item; the same item twice on the PO is merged", po?.lines.length === 3 && item("APF CAP")?.qty === 7000, JSON.stringify(po?.lines));
check("units and decimals exactly as in Tally", item("APF STICKER")?.qty === 12.5 && item("APF STICKER")?.unit === "Kg" && item("6 ML EYE LINER box 12pcs")?.unit === "Pcs", JSON.stringify(po?.lines));
check("PMS code from the component master", item("APF CAP")?.itemCode === "PMS0002", item("APF CAP")?.itemCode);
check("the cancelled PO is marked cancelled", s0.tallyPos.find((p) => p.poNo === CANCELLED)?.cancelled === true);
check("the Sales voucher is ignored", !s0.tallyPos.some((p) => p.poNo === "S-1"));
const g0 = (await gate("GET", "/api/state")).json.state;
check("the gate gets no POs any more — only its register (and which entries have their GRN)", g0.tallyPos.length === 0 && g0.purchaseOrders.length === 0);

console.log("the vendor list for the supplier dropdown");
const vendors = (await gate("GET", "/api/vendors")).json?.vendors ?? [];
const MAX = "MAXCOMM INDIA PVT LTD";
check("the gate gets vendor names (no rates)", vendors.includes(MAX) && typeof vendors[0] === "string", JSON.stringify(vendors.slice(0, 3)));
check("other departments don't need it", (await store("GET", "/api/vendors")).status === 403);

const inv = () => `T-${run}-${Math.random().toString(36).slice(2, 7)}`;
const entry = (over = {}) => ({
  supplierName: MAX, invoiceNo: inv(), invoiceDate: "", invoiceQty: 12, invoiceQtyUnit: "Box", transportName: "Blue Dart",
  lrNo: "LR-1", vehicleNo: "HR55-T-0001", driverName: "Ramesh", driverPhone: "9876543210", ...over,
});
const refused = async (name, e, pattern, who = gate) => {
  const r = await act(who, "addGateEntry", [e]);
  check(name, [400, 403, 409].includes(r.status) && (!pattern || pattern.test(r.json?.error ?? "")), `${r.status} ${r.json?.error}`);
};

console.log("a gate entry is refused when");
await refused("the supplier is not an approved vendor", entry({ supplierName: "Nobody Pvt Ltd" }), /not an approved supplier/);
await refused("the vehicle number is missing", entry({ vehicleNo: "" }), /vehicleNo/);
await refused("the invoice date is not a real date", entry({ invoiceDate: "31-02-2026" }), /real date/);
await refused("the invoice date is after today", entry({ invoiceDate: "01-01-2099" }), /after today/);
await refused("the driver phone is not a phone number", entry({ driverPhone: "12345" }), /10-digit/);
await refused("a quantity without its unit", entry({ invoiceQtyUnit: "" }), /unit of the quantity/);
await refused("a quantity with more than 3 decimals", entry({ invoiceQty: 1.2345 }), /3 decimals/);
await refused("the old PO fields are sent (the gate has no PO now)", { ...entry(), poNo: PO, lines: [] }, /poNo|lines|Unrecognized/i);
await refused("the screen tries to set the time in", { ...entry(), timeIn: "01:00" }, /timeIn|Unrecognized/i);
await refused("Store does it", entry(), null, store);

console.log("a gate entry");
const before = Date.now();
const first = await act(gate, "addGateEntry", [entry({ invoiceQty: 12.5, invoiceQtyUnit: "Drum" })]);
const made = first.json?.changes?.gateEntries?.at(-1);
const nowHm = new Date(before).toTimeString().slice(0, 5);
check("accepted, numbered by the server", first.status === 200 && /^GE-\d+$/.test(made?.id ?? ""), JSON.stringify(first.json));
check("date and time in are the server's (today, now)", /^\d{2}-\d{2}-\d{4}$/.test(made?.date) && /^\d{2}:\d{2}$/.test(made?.timeIn) && (made.timeIn >= nowHm || nowHm >= "23:59"), `${made?.date} ${made?.timeIn} vs ${nowHm}`);
check("no PO, no items; qty with its own unit (typed: Drum, decimals kept)", made?.poNo === "" && made?.lines.length === 0 && made?.invoiceQty === 12.5 && made?.invoiceQtyUnit === "Drum", JSON.stringify(made));
check("driver name and phone kept; no photo yet", made?.driverName === "Ramesh" && made?.driverPhone === "9876543210" && made?.hasPhoto === false);
const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[row]] = await db.query("SELECT po_no, external_po_ref, tally_po_no, invoice_qty_unit, driver_phone_enc FROM gate_entries WHERE gate_entry_no = ?", [made?.id]);
check("stored without a PO; the driver phone encrypted at rest", row && row.po_no === null && row.tally_po_no === null && row.external_po_ref === null &&
  row.invoice_qty_unit === "Drum" && row.driver_phone_enc && !String(row.driver_phone_enc).includes("9876543210"), JSON.stringify(row));
await refused("the same supplier invoice twice", entry({ invoiceNo: made?.invoiceNo }), /already in the gate register/);

console.log("the photo (one per entry, JPEG, written once)");
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7), Buffer.from([0xff, 0xd9])]);
const photo = (who, id, body, type = "image/jpeg") => who("POST", `/api/gate-entries/${id}/photo`, body, type);
check("Store can't add it", (await photo(store, made.id, jpeg)).status === 403);
check("not a JPEG → refused", (await photo(gate, made.id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(500)]))).status === 400);
check("an unknown gate entry → refused", (await photo(gate, "GE-99999", jpeg)).status === 409);
check("more than 1 MB → refused", (await photo(gate, made.id, Buffer.concat([jpeg, Buffer.alloc(1100 * 1024)]))).status === 413);
const up = await photo(gate, made.id, jpeg);
check("the gate adds it", up.status === 200, JSON.stringify(up.json));
check("…the entry now says it has one", (await gate("GET", "/api/state")).json.state.gateEntries.find((g) => g.id === made.id)?.hasPhoto === true);
const got = await store("GET", `/api/gate-entries/${made.id}/photo`);
check("Store can look at it (same bytes, image/jpeg)", got.status === 200 && got.type.startsWith("image/jpeg") && got.raw.equals(jpeg), `${got.status} ${got.type} ${got.raw.length}`);
const again = await photo(gate, made.id, jpeg);
check("a second photo is refused (it cannot be replaced)", again.status === 409 && /cannot be replaced/.test(again.json?.error), JSON.stringify(again.json));
check("no photo of an entry without one → 404", (await gate("GET", `/api/gate-entries/GE-99999/photo`)).status === 404);

console.log("vehicle out");
const out = await act(gate, "recordVehicleOut", [made.id, true, "01:00"]);
const after = out.json?.changes?.gateEntries?.find((g) => g.id === made.id);
check("records time out from the server clock and the driver's sign", out.status === 200 && /^\d{2}:\d{2}$/.test(after?.timeOut) && after.timeOut !== "01:00" && after.driverSign, JSON.stringify(out.json));
const twice = await act(gate, "recordVehicleOut", [made.id, true, ""]);
check("cannot be recorded twice", twice.status === 409 && /already left/.test(twice.json?.error), JSON.stringify(twice.json));
check("other departments cannot record it", (await act(store, "recordVehicleOut", [made.id, true, ""])).status === 403);

console.log("the database itself");
const blocked = async (sql, params) => { try { await db.execute(sql, params); return false; } catch { return true; } };
check("time out cannot be changed once recorded", await blocked("UPDATE gate_entries SET time_out = '00:01' WHERE gate_entry_no = ?", [made.id]));
check("driver sign cannot be removed", await blocked("UPDATE gate_entries SET driver_signed = 0 WHERE gate_entry_no = ?", [made.id]));
check("the rest of the entry cannot be changed (driver, vehicle)", await blocked("UPDATE gate_entries SET driver_name = 'X' WHERE gate_entry_no = ?", [made.id]) &&
  await blocked("UPDATE gate_entries SET vehicle_no_enc = NULL WHERE gate_entry_no = ?", [made.id]));
check("the photo cannot be changed", await blocked("UPDATE gate_entry_photos SET mime = 'image/png' WHERE gate_entry_no = ?", [made.id]));
check("the photo cannot be deleted", await blocked("DELETE FROM gate_entry_photos WHERE gate_entry_no = ?", [made.id]));
await db.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

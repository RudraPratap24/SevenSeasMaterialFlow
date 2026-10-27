// The inward flow end to end, as the business runs it:
//   Tally PO open → gate searches it (PO no / vendor / item code) → gate entry, items ticked
//   → Store counts, marks a shortage with a remark, makes the GRN → PO stays open while anything is short
//   → QC: approved goes into PM stock; rejected is added to the material's rejected count.
// Requires a DEVELOPMENT database with --dev-passwords and the demo data (npm test sets one up).
// Usage: node server/test/flow.mjs [baseUrl]
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";

const L = await tsImport("../../src/flow/logic.ts", import.meta.url); // the same rules the screens and server use
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
const state = async (c) => (await c("GET", "/api/state")).json.state;
const [gate, store, qc] = await Promise.all(["gate", "store", "qc"].map(login));

// The Tally export: one PO, 3 items — APF CAP 7000 Pcs, eyeliner box 120 Pcs, APF STICKER 12.5 Kg.
const run = Date.now().toString(36).toUpperCase();
const PO = `F${run}`;
const file = join(mkdtempSync(join(tmpdir(), "flow-")), "pos.xml");
writeFileSync(file, readFileSync("server/test/fixtures/tally-purchase-orders.xml", "utf8").replaceAll("26SEV910", PO).replaceAll("26SEV911", `${PO}X`));
execFileSync(process.execPath, ["--import", "tsx", "server/scripts/tally.ts", "import", file], { encoding: "utf8" });

const poOf = async () => {
  const s = await state(gate);
  return L.deriveTallyPoProgress(s.tallyPos, s.gateEntries, s.grnLines).find((p) => p.po.poNo === PO);
};
const pending = (p, item) => p.lines.find((l) => l.itemName === item)?.pending;

console.log("1. the PO from Tally is open at the gate");
let po = await poOf();
check("open, all 3 items pending", po?.open && po.lines.length === 3);
const openPos = L.deriveTallyPoProgress((await state(gate)).tallyPos, [], []).filter((p) => p.open);
for (const [by, term] of [["PO number", PO.toLowerCase()], ["vendor name", "packaging &"], ["item code", "pms0002"], ["item name", "apf cap"]]) {
  check(`  found by ${by} ("${term}")`, L.searchPos(openPos, term).some((p) => p.po.poNo === PO));
}

console.log("2. gate entry: the vehicle brings part of the order");
const gateIn = async (lines) => {
  const r = await act(gate, "addGateEntry", [{
    date: "", supplierName: "", productDesc: "", invoiceNo: `F-${run}-${Math.random().toString(36).slice(2, 7)}`, invoiceDate: "",
    poNo: PO, invoiceQty: null, transportName: "", lrNo: "", vehicleNo: "HR55-F-0001", timeIn: "00:00", timeOut: "",
    driverSign: false, remark: "", lines: lines.map(([itemName, qty, remark = ""]) => ({ itemName, itemCode: "", unit: "", qty, remark })),
  }]);
  return r.json?.changes?.gateEntries?.at(-1) ?? r;
};
const ge1 = await gateIn([["APF CAP", 5000, "2000 Pcs short on invoice"], ["6 ML EYE LINER box 12pcs", 120], ["APF STICKER", 12.5]]);
check("saved with 3 items", ge1.lines?.length === 3, JSON.stringify(ge1));
check("vehicle out recorded after unloading", (await act(gate, "recordVehicleOut", [ge1.id, true, ""])).status === 200);
po = await poOf();
check("PO still open: APF CAP 2000 Pcs pending", po.open && pending(po, "APF CAP") === 2000);

console.log("3. Store counts, marks the shortage, makes the GRNs");
let s = await state(store);
const waiting = L.searchAwaitingGrn(L.awaitingGrn(s.gateEntries, s.grnLines), ge1.id);
check("the 3 items wait for GRN", waiting.length === 3);
check("  found by PO number", L.searchAwaitingGrn(L.awaitingGrn(s.gateEntries, s.grnLines), PO).length === 3);
const grn = async (lineNo, code, totalQty, remarkStore = "") => {
  const r = await act(store, "addGrnLine", [{
    gateEntryId: ge1.id, gateLineNo: lineNo, componentCode: code, componentName: "", type: "", brandName: "SEVEN SEAS", receivedDate: "",
    poNo: "", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: null, totalBoxes: null, totalQty, unit: "", remarkStore,
    location: "Store — Floor 1",
  }]);
  return r.json?.changes?.grnLines?.at(-1) ?? r;
};
const cap = await grn(1, "PMS0002", 4800, "200 Pcs short against gate count");
const box = await grn(2, "PMS0846", 120);
const sticker = await grn(3, "PMS0003", 12.5);
check("3 GRNs, short remark kept", cap.grnNo && box.grnNo && sticker.grnNo && cap.remarkStore === "200 Pcs short against gate count", JSON.stringify({ cap, box, sticker }));
s = await state(store);
check("nothing left waiting for this vehicle", L.awaitingGrn(s.gateEntries, s.grnLines).every((w) => w.gate.id !== ge1.id));
po = await poOf();
check("PO open on Store's count: APF CAP 7000 − 4800 = 2200 pending", po.open && pending(po, "APF CAP") === 2200);

console.log("4. QC: approved → PM stock; rejected → rejected count");
const stock = async () => {
  const st = await state(store);
  return L.derivePmStock(st.grnLines, st.requisitions, st.mrns, st.openings, st.minLevels);
};
const decide = async (g, status) => {
  await act(store, "sendToQc", [g.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
  const slip = (await state(qc)).qcIntimations.find((q) => q.grnNo === g.grnNo);
  return act(qc, "recordAr", [slip.id, status, "test"]);
};
const s0 = await stock();
check("before QC the counted 4800 Pcs are under test, not usable", s0.get("PMS0002").underTest >= 4800, JSON.stringify(s0.get("PMS0002")));
await decide(cap, "APPROVED");
await decide(box, "REJECTED");
await decide(sticker, "APPROVED");
const s1 = await stock();
const d = (code, f) => (s1.get(code)?.[f] ?? 0) - (s0.get(code)?.[f] ?? 0);
check("APF CAP approved: PM stock +4800 Pcs", d("PMS0002", "received") === 4800 && d("PMS0002", "closing") === 4800, JSON.stringify(s1.get("PMS0002")));
check("eyeliner box rejected: rejected count +120, stock unchanged", d("PMS0846", "rejected") === 120 && d("PMS0846", "closing") === 0, JSON.stringify(s1.get("PMS0846")));
check("APF STICKER approved: its Kg stock row +12.5 Kg", d("PMS0003 · Kg", "received") === 12.5, JSON.stringify(s1.get("PMS0003 · Kg")));

console.log("5. the rest arrives; rejections keep adding up");
const ge2 = await gateIn([["APF CAP", 2200]]);
const rest = await act(store, "addGrnLine", [{
  gateEntryId: ge2.id, gateLineNo: 1, componentCode: "PMS0002", componentName: "", type: "", brandName: "SEVEN SEAS", receivedDate: "",
  poNo: "", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: null, totalBoxes: null, totalQty: 2200, unit: "", remarkStore: "",
  location: "Store — Floor 1",
}]);
check("GRN for the balance", rest.status === 200, JSON.stringify(rest.json));
po = await poOf();
check("every item fully received → PO closed (gone from the gate search)", po && !po.open);
await decide(rest.json.changes.grnLines.at(-1), "REJECTED");
const s2 = await stock();
check("rejected count adds up: APF CAP rejected +2200, usable stock unchanged",
  (s2.get("PMS0002").rejected - s1.get("PMS0002").rejected) === 2200 && s2.get("PMS0002").closing === s1.get("PMS0002").closing);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

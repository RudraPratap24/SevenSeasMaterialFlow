// The inward flow end to end, as the business runs it:
//   Tally PO open → gate searches it (PO no / vendor / item code) → gate entry, items ticked
//   → Store counts, marks a shortage with a remark, makes the GRN → every count completes its item; a >20% shortfall goes to escalation
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
  const s = await state(store);
  return L.deriveTallyPoProgress(s.tallyPos, s.gateEntries, s.grnLines).find((p) => p.po.poNo === PO);
};
const pending = (p, item) => p.lines.find((l) => l.itemName === item)?.pending;

console.log("1. the PO from Tally is open for Store to pick at GRN");
let po = await poOf();
check("open, all 3 items pending", po?.open && po.lines.length === 3);
const openPos = L.deriveTallyPoProgress((await state(store)).tallyPos, [], []).filter((p) => p.open);
for (const [by, term] of [["PO number", PO.toLowerCase()], ["vendor name", "packaging &"], ["item code", "pms0002"], ["item name", "apf cap"]]) {
  check(`  found by ${by} ("${term}")`, L.searchPos(openPos, term).some((p) => p.po.poNo === PO));
}

console.log("2. gate entry: the vehicle and its invoice (no PO at the gate)");
const gateIn = async () => {
  const r = await act(gate, "addGateEntry", [{
    supplierName: "MAXCOMM INDIA PVT LTD", invoiceNo: `F-${run}-${Math.random().toString(36).slice(2, 7)}`, invoiceDate: "",
    invoiceQty: 3, invoiceQtyUnit: "Box", transportName: "", lrNo: "", vehicleNo: "HR55-F-0001", driverName: "", driverPhone: "",
  }]);
  return r.json?.changes?.gateEntries?.at(-1) ?? r;
};
const ge1 = await gateIn();
check("saved", Boolean(ge1.id), JSON.stringify(ge1));
check("vehicle out recorded after unloading", (await act(gate, "recordVehicleOut", [ge1.id, true, ""])).status === 200);
check("the vehicle waits for its GRN", L.awaitingGrn((await state(store)).gateEntries, []).some((w) => w.gate.id === ge1.id));

console.log("3. Store reads the invoice, picks the PO, counts each item");
const grn = async (ge, poItemName, code, totalQty, remarkStore = "") => {
  const r = await act(store, "addGrnLine", [{
    gateEntryId: ge.id, gateLineNo: null, componentCode: code, componentName: "", type: "", brandName: "SEVEN SEAS", receivedDate: "",
    poNo: PO, poItemName, poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: null, totalBoxes: null, totalQty, unit: "", remarkStore,
    location: "Store — Floor 1",
  }]);
  return r.json?.changes?.grnLines?.at(-1) ?? r;
};
const cap = await grn(ge1, "APF CAP", "PMS0002", 4800, "2200 Pcs to follow");
const box = await grn(ge1, "6 ML EYE LINER box 12pcs", "PMS0846", 120);
const sticker = await grn(ge1, "APF STICKER", "PMS0003", 12.5);
check("3 GRNs, remark kept", cap.grnNo && box.grnNo && sticker.grnNo && cap.remarkStore === "2200 Pcs to follow", JSON.stringify({ cap, box, sticker }));
check("4800 of 7000 is more than 20% short: SHORT (escalation), the item complete", cap.variance === "SHORT" && cap.closesItem === true);
check("the full eyeliner and sticker quantities complete their items", box.closesItem && sticker.closesItem && !box.variance && !sticker.variance);
po = await poOf();
check("every item done → PO closed (the 2200 short is for the escalation, not this PO)",
  !po.open && pending(po, "APF CAP") === 0 && pending(po, "6 ML EYE LINER box 12pcs") === 0 && pending(po, "APF STICKER") === 0);

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Purchase → gate: indents name their vendor; ONE PO gathers a vendor's ticked indents (one line per item);
// once the owner approves it, the gate finds it like a Tally PO; the Purchase screen and the gate agree on
// what is pending; a PO number that later comes from Tally is used once (the Tally copy), never twice.
// Requires a DEVELOPMENT database with --dev-passwords and the demo data (npm test sets one up).
// Usage: node server/test/purchase.mjs [baseUrl]
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mysql from "mysql2/promise";
import { tsImport } from "tsx/esm/api";

const L = await tsImport("../../src/flow/logic.ts", import.meta.url);
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
const [purchase, admin, gate, store] = await Promise.all(["purchase", "admin", "gate", "store"].map(login));
const refused = async (name, who, action, args, pattern) => {
  const r = await act(who, action, args);
  check(name, [400, 403, 409].includes(r.status) && (!pattern || pattern.test(r.json?.error ?? "")), `${r.status} ${r.json?.error}`);
};

const MAX = "MAXCOMM INDIA PVT LTD";
const indent = (code, qty, supplierName = MAX, rate = 2.1) => ({ date: "", componentCode: code, componentName: "", qty, reason: "test", supplierName, rate });
const newIndent = async (code, qty, vendor) => (await act(purchase, "addIndent", [indent(code, qty, vendor)])).json?.changes?.indents?.at(-1);

console.log("indents name their vendor");
await refused("a vendor not on the approved list is refused", purchase, "addIndent", [indent("PMS0158", 10, "Nobody Pvt Ltd")], /not an approved supplier/);
const i1 = await newIndent("PMS0158", 1000);
const i2 = await newIndent("PMS0160", 1000);
const i3 = await newIndent("PMS0158", 500); // same item again: one PO line of 1500
const other = await newIndent("PMS0002", 100, "Shree Packwell");
check("3 MAXCOMM indents + 1 Shree Packwell indent, vendor kept", [i1, i2, i3].every((i) => i?.supplierName === MAX) && other?.supplierName === "Shree Packwell");

console.log("one PO for a vendor's ticked indents");
const po = (indentIds, lines, supplierName = MAX) => ({ date: "", supplierName, lines, expectedDate: "", indentIds });
const line = (componentCode, qty, rate = 2) => ({ componentCode, componentName: "", qty, rate });
await refused("no indent ticked", purchase, "raisePo", [po([], [line("PMS0158", 1)])], /at least one indent/);
await refused("an indent of another vendor", purchase, "raisePo", [po([i1.id, other.id], [line("PMS0158", 1000), line("PMS0002", 100)])], /is for Shree Packwell/);
await refused("a ticked indent's item missing from the PO", purchase, "raisePo", [po([i1.id, i2.id], [line("PMS0158", 1000)])], /not on the PO/);
await refused("an item without a ticked indent", purchase, "raisePo", [po([i1.id], [line("PMS0158", 1000), line("PMS0164", 5)])], /no ticked indent/);
await refused("the same item on two lines", purchase, "raisePo", [po([i1.id, i3.id], [line("PMS0158", 1000), line("PMS0158", 500)])], /only once/);
await refused("an indent without a rate", purchase, "addIndent", [{ ...indent("PMS0158", 10), rate: null }], /rate/);
await refused("a PO line without a rate", purchase, "raisePo", [po([i1.id, i2.id, i3.id], [line("PMS0158", 1500, null), line("PMS0160", 1000)])], /rate/);
const raised = await act(purchase, "raisePo", [po([i1.id, i2.id, i3.id], [line("PMS0158", 1500, 2.1), line("PMS0160", 1000, 1.6)])]);
const PO = raised.json?.changes?.purchaseOrders?.at(-1);
check("ONE PO: 3 indents, 2 lines (LL-112 bottle 1500, cap 1000)", raised.status === 200 && PO?.indentIds.length === 3 && PO.lines.length === 2, JSON.stringify(raised.json));
check("the indent keeps its rate", i1?.rate === 2.1, JSON.stringify(i1));
const value = L.derivePoProgress([PO], [], []).at(0)?.value;
check("the PO has its total: 1500 × 2.1 + 1000 × 1.6 = 4750", value === 4750, String(value));
check("its number is new — not one a Tally PO already has", !(await state(gate)).tallyPos.some((p) => p.poNo === PO?.id), PO?.id);
const inds = (await state(purchase)).indents.filter((i) => [i1.id, i2.id, i3.id].includes(i.id));
check("all three indents now PO_RAISED", inds.every((i) => i.status === "PO_RAISED"));
await refused("an indent can't go on a second PO", purchase, "raisePo", [po([i1.id], [line("PMS0158", 1)])], /already has a PO/);

console.log("the gate sees it only once the owner approves");
const openAtGate = async () => {
  const s = await state(gate);
  return L.deriveTallyPoProgress(L.gatePos(s), s.gateEntries, s.grnLines).filter((p) => p.open);
};
check("pending approval: not at the gate", !(await openAtGate()).some((p) => p.po.poNo === PO.id));
const gateEntry = (lines) => ({
  date: "", supplierName: "", productDesc: "", invoiceNo: `P-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, invoiceDate: "",
  poNo: PO.id, invoiceQty: null, transportName: "", lrNo: "", vehicleNo: "HR55-P-0001", timeIn: "00:00", timeOut: "", driverSign: false, remark: "",
  lines: lines.map(([itemName, qty]) => ({ itemName, itemCode: "", unit: "", qty, remark: "" })),
});
await refused("gate entry before approval", gate, "addGateEntry", [gateEntry([["LL-112 BOTTLE", 10]])], /waiting for the owner's approval/);
check("owner approves", (await act(admin, "approvePo", [PO.id, ""])).status === 200);
const open = await openAtGate();
const atGate = open.find((p) => p.po.poNo === PO.id);
check("approved: at the gate with its 2 items in Pcs", atGate?.lines.length === 2 && atGate.lines.every((l) => l.unit === "Pcs"), JSON.stringify(atGate));
for (const term of [PO.id, "maxcomm", "pms0160"]) check(`  found by "${term}"`, L.searchPos(open, term).some((p) => p.po.poNo === PO.id));
check("the gate never receives PO rates", (await state(gate)).purchaseOrders.every((p) => p.lines.every((l) => l.rate === null)));

console.log("gate in and GRN against it");
const ge = (await act(gate, "addGateEntry", [gateEntry([["LL-112 BOTTLE", 1500], ["LL-112 CAP", 600]])])).json?.changes?.gateEntries?.at(-1);
check("gate entry with 2 items, codes from the PO", ge?.lines.map((l) => l.itemCode).join() === "PMS0158,PMS0160", JSON.stringify(ge));
const grn = await act(store, "addGrnLine", [{
  gateEntryId: ge.id, gateLineNo: 1, componentCode: "PMS0158", componentName: "", type: "", brandName: "SEVEN SEAS", receivedDate: "",
  poNo: "", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: null, totalBoxes: null, totalQty: 1400, unit: "", remarkStore: "100 short",
  location: "Store — Floor 1",
}]);
const g = grn.json?.changes?.grnLines?.at(-1);
check("GRN: PO no and PO qty from the app PO", g?.poNo === PO.id && g.poQty === 1500 && g.unit === "Pcs", JSON.stringify(grn.json));
const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[row]] = await db.query("SELECT po_no, tally_po_no FROM gate_entries WHERE gate_entry_no = ?", [ge.id]);
check("stored as a link to the app PO", row?.po_no === PO.id && row.tally_po_no === null, JSON.stringify(row));
await db.end();

console.log("one pending figure everywhere");
const sp = await state(purchase);
const onPurchase = L.derivePoProgress(sp.purchaseOrders, sp.gateEntries, sp.grnLines).find((p) => p.po.id === PO.id);
const onGate = (await openAtGate()).find((p) => p.po.poNo === PO.id);
const pend = (lines, code) => lines.find((l) => (l.code ?? l.itemCode) === code)?.pending;
check("bottle 1500 − counted 1400 = 100 pending on both screens", pend(onPurchase.lines, "PMS0158") === 100 && pend(onGate.lines, "PMS0158") === 100);
check("cap 1000 − 600 at gate = 400 pending on both screens", pend(onPurchase.lines, "PMS0160") === 400 && pend(onGate.lines, "PMS0160") === 400);

console.log("the librarian learns what Tally has confirmed");
const status = async () => L.tallyStatusOf((await state(purchase)).purchaseOrders.find((p) => p.id === PO.id), (await state(purchase)).tallyPos);
check("approved here, not yet read back from Tally: NOT IN TALLY YET", (await status()) === "NOT_IN_TALLY");
const dir = mkdtempSync(join(tmpdir(), "po-"));
const tallyRead = (name, xml) => {
  const f = join(dir, name);
  writeFileSync(f, xml);
  execFileSync(process.execPath, ["--import", "tsx", "server/scripts/tally.ts", "import", f], { encoding: "utf8" });
};
// Tally's answer for our PO: same number, same items and quantities (as Accounts would have entered/imported it).
const voucher = (items) => `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
  <VOUCHER VCHTYPE="Purchase Order"><DATE>20261016</DATE><VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${PO.id}</VOUCHERNUMBER><PARTYLEDGERNAME>${MAX}</PARTYLEDGERNAME>
  ${items.map(([n, q]) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${n}</STOCKITEMNAME><ACTUALQTY> ${q} Pcs</ACTUALQTY></ALLINVENTORYENTRIES.LIST>`).join("")}
  </VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
tallyRead("same.xml", voucher([["LL-112 BOTTLE", 1500], ["LL-112 CAP", 1000]]));
check("read back with the same items: IN TALLY", (await status()) === "IN_TALLY");
const copyLines = (await state(gate)).tallyPos.find((p) => p.poNo === PO.id)?.lines ?? [];
const cl = (n) => copyLines.find((l) => l.itemName === n)?.itemCode;
check("a name the master gives to 2 components (LL-112 CAP: PMS0160, PMS0171) gets no guessed code", cl("LL-112 CAP") === "", JSON.stringify(copyLines));
check("…unless Store already picked one at GRN (LL-112 BOTTLE → PMS0158, remembered)", cl("LL-112 BOTTLE") === "PMS0158", JSON.stringify(copyLines));
const both = L.gatePos(await state(gate)).filter((p) => p.poNo === PO.id);
check("shown once at the gate — from the app's own record (Tally's copy only confirms it)", both.length === 1 && both[0].syncedAt === "" && both[0].date === PO.date, JSON.stringify(both));
const atGateNow = L.deriveTallyPoProgress(both, (await state(gate)).gateEntries, (await state(gate)).grnLines)[0];
check("receipts still count against it (bottle 100, cap 400 pending)",
  atGateNow.lines.find((l) => l.itemName === "LL-112 BOTTLE")?.pending === 100 && atGateNow.lines.find((l) => l.itemName === "LL-112 CAP")?.pending === 400,
  JSON.stringify(atGateNow.lines));
tallyRead("edited.xml", voucher([["LL-112 BOTTLE", 1200], ["LL-112 CAP", 1000]]));
check("someone changed it in Tally: DIFFERS", (await status()) === "DIFFERS");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// GRN with the PO picked by Store (the gate records no PO): each item counted against what is still pending on the
// PO, ±20% — within it the item is complete; more than 20% short stays open (SHORT); more than 20% over is all
// accepted and completes the item (EXCESS). The PO closes when all its items are complete. Then QC moves stock.
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
const { tsImport } = await import("tsx/esm/api");
const L = await tsImport("../../src/flow/logic.ts", import.meta.url);

// A PO per run: APF CAP (in the master, 7000 Pcs), an item not in the master (12.5 Kg), the eye liner (120 Pcs).
const run = Date.now().toString(36).toUpperCase();
const PO = `G${run}`, ITEM = `TEST LABEL ${run}`, LINER = "6 ML EYE LINER box 12pcs";
const file = join(mkdtempSync(join(tmpdir(), "grn-")), "pos.xml");
writeFileSync(
  file,
  readFileSync("server/test/fixtures/tally-purchase-orders.xml", "utf8").replaceAll("26SEV910", PO).replaceAll("26SEV911", `${PO}X`).replaceAll("APF STICKER", ITEM),
);
tally(file);

const gate = await login("gate");
const store = await login("store");
const ge = (await act(gate, "addGateEntry", [{
  supplierName: "MAXCOMM INDIA PVT LTD", invoiceNo: `G-${run}`, invoiceDate: "", invoiceQty: 40, invoiceQtyUnit: "Box",
  transportName: "", lrNo: "", vehicleNo: "HR55-T-0002", driverName: "", driverPhone: "",
}])).json?.changes?.gateEntries?.at(-1);
check("the vehicle is in the gate register (no PO there)", ge?.id && ge.poNo === "", JSON.stringify(ge));

const progress = async () => {
  const s = (await store("GET", "/api/state")).json.state;
  return L.deriveTallyPoProgress(L.gatePos(s).filter((p) => p.poNo === PO), s.gateEntries, s.grnLines)[0];
};
const pendingOf = async (name) => (await progress())?.lines.find((l) => l.itemName === name)?.pending;
const linerCode = (await progress())?.lines.find((l) => l.itemName === LINER)?.itemCode || "PMS0004";

const grn = (over = {}) => ({
  gateEntryId: ge.id, gateLineNo: null, componentCode: "PMS0002", componentName: "", type: "", brandName: "SEVEN SEAS",
  receivedDate: "", poNo: PO, poItemName: "APF CAP", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: null, totalBoxes: null,
  totalQty: 1, unit: "", remarkStore: "", location: "Store — Floor 1", ...over,
});
const refused = async (name, args, pattern, who = store, action = "addGrnLine") => {
  const r = await act(who, action, args);
  check(name, [400, 403, 409].includes(r.status) && (!pattern || pattern.test(r.json?.error ?? "")), `${r.status} ${r.json?.error}`);
};
const made = async (over) => {
  const r = await act(store, "addGrnLine", [grn(over)]);
  return { status: r.status, error: r.json?.error, row: r.json?.changes?.grnLines?.at(-1) };
};

console.log("GRN is refused when");
await refused("the PO is not an open PO", [grn({ poNo: "NOPE-1" })], /not among the open purchase orders/);
await refused("the item is not on the PO", [grn({ poItemName: "SOMETHING ELSE" })], /not on PO/);
await refused("the PMS code is not the item's own", [grn({ componentCode: "PMS0003", totalQty: 10 })], /must use that code/);
await refused("the count has more than 3 decimals", [grn({ poItemName: ITEM, componentCode: "PMS0003", totalQty: 1.2345 })], /3 decimals/);
await refused("an unknown PMS code is picked", [grn({ poItemName: ITEM, componentCode: "PMS9999" })], /not a known component/);
await refused("the count is zero", [grn({ totalQty: 0 })], null);
await refused("the gate does it", [grn({ totalQty: 10 })], null, gate);

console.log("±20% of what is pending, per item");
const a1 = await made({ qtyPerBox: 500, totalBoxes: 10, unit: "Box", supplierName: "WRONG" });
check("5000 of 7000 pending (more than 20% short): accepted, flagged SHORT, the item complete (rest → escalation)",
  a1.status === 200 && a1.row?.totalQty === 5000 && a1.row.variance === "SHORT" && a1.row.closesItem === true && a1.row.pendingBefore === 7000, JSON.stringify(a1));
check("…unit and PO qty are the PO's, supplier/invoice the gate entry's (not the screen's)",
  a1.row?.unit === "Pcs" && a1.row.poQty === 7000 && a1.row.poNo === PO && a1.row.supplierName === "MAXCOMM INDIA PVT LTD", JSON.stringify(a1.row));
check("…nothing pending any more (the 2000 short is not expected on this PO)", (await pendingOf("APF CAP")) === 0);
await refused("a further GRN for that item", [grn({ totalQty: 10 })], /already fully received/);
const k1 = await made({ poItemName: ITEM, componentCode: "PMS0003", totalQty: 15.5 });
check("15.5 Kg of 12.5 pending (more than 20% over): all accepted in Kg, flagged EXCESS, the item complete",
  k1.status === 200 && k1.row?.unit === "Kg" && k1.row.totalQty === 15.5 && k1.row.variance === "EXCESS" && k1.row.closesItem === true, JSON.stringify(k1));
check("the PO is still open (the eye liner has not come)", (await progress())?.open === true);
const e1 = await made({ poItemName: LINER, componentCode: linerCode, totalQty: 50 });
check("50 of 120 eye liners: SHORT, the last item done → the PO closes", e1.status === 200 && e1.row?.variance === "SHORT" && (await progress())?.open === false, JSON.stringify(e1));

console.log("correcting the count before QC is judged again");
const fix = await act(store, "updateGrnQty", [e1.row.grnNo, 110]);
const fixed = fix.json?.changes?.grnLines?.find((g) => g.grnNo === e1.row.grnNo);
check("50 → 110 of 120: now within 20%, the item complete", fix.status === 200 && fixed?.totalQty === 110 && fixed.variance === "" && fixed.closesItem === true, JSON.stringify(fix.json));
const done = await progress();
check("every item complete → the PO closes (no longer open)", done && done.open === false, JSON.stringify(done?.lines));
await refused("a GRN against the completed PO", [grn({ poItemName: LINER, componentCode: linerCode, totalQty: 5 })], /PO .* is already fully received/);

console.log("free material without a PO");
const f1 = await made({ poNo: "", poItemName: "", componentCode: "PMS0014", totalQty: 24 });
check("accepted in pcs, no PO, no judgement", f1.status === 200 && f1.row?.poNo === "" && f1.row.unit === "" && f1.row.variance === "" && f1.row.pendingBefore === null, JSON.stringify(f1));

console.log("remembered PMS code");
tally(file);
const poNow = (await store("GET", "/api/state")).json.state.tallyPos.find((p) => p.poNo === PO);
check("next Tally import gives the uncoded item Store's code", poNow?.lines.find((l) => l.itemName === ITEM)?.itemCode === "PMS0003", JSON.stringify(poNow?.lines));

console.log("the database itself");
const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[stored]] = await db.query("SELECT tally_po_no, po_no, po_item_name, variance, closes_item, pending_before FROM goods_receipts WHERE grn_no = ?", [a1.row.grnNo]);
check("the GRN keeps its own PO, item and judgement", stored?.tally_po_no === PO && stored.po_no === null && stored.po_item_name === "APF CAP" &&
  stored.variance === "SHORT" && stored.closes_item === 1 && Number(stored.pending_before) === 7000, JSON.stringify(stored));
const blocked = async (sql, params) => { try { await db.execute(sql, params); return false; } catch { return true; } };
check("only SHORT / EXCESS / nothing is a variance", await blocked("UPDATE goods_receipts SET variance = 'BAD' WHERE grn_no = ?", [a1.row.grnNo]));
check("the PO item it counts cannot be changed", await blocked("UPDATE goods_receipts SET po_item_name = 'X' WHERE grn_no = ?", [a1.row.grnNo]));
await act(store, "sendToQc", [a1.row.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
check("the count and its judgement are locked once sent to QC", await blocked("UPDATE goods_receipts SET total_qty = 1 WHERE grn_no = ?", [a1.row.grnNo]) &&
  await blocked("UPDATE goods_receipts SET closes_item = 0 WHERE grn_no = ?", [a1.row.grnNo]));
await db.end();

console.log("QC acceptance updates stock");
const stock = async () => {
  const s = (await store("GET", "/api/state")).json.state;
  return L.derivePmStock(s.grnLines, s.requisitions, s.mrns, s.openings, s.minLevels);
};
const qc = await login("qc");
const decide = async (grnNo, status) => {
  const slip = (await qc("GET", "/api/state")).json.state.qcIntimations.find((q) => q.grnNo === grnNo);
  return act(qc, "recordAr", [slip.id, status, "test"]);
};
const before = (await stock()).get("PMS0002");
check("before QC: the 5000 Pcs are under test, not usable", before.underTest >= 5000);
const ok1 = await decide(a1.row.grnNo, "APPROVED");
const after = (await stock()).get("PMS0002");
check("QC approves → +5000 Pcs usable stock, −5000 under test",
  ok1.status === 200 && after.received - before.received === 5000 && after.closing - before.closing === 5000 && before.underTest - after.underTest === 5000,
  JSON.stringify({ ok1: ok1.status, before, after }));
await act(store, "sendToQc", [k1.row.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
const held = await decide(k1.row.grnNo, "HOLD");
const kgHeld = (await stock()).get("PMS0003 · Kg");
check("QC holds → not usable (15.5 Kg on hold)", held.status === 200 && kgHeld?.hold >= 15.5 && kgHeld.closing === kgHeld.received, JSON.stringify(kgHeld));
const kgBefore = kgHeld.received;
const pcsBefore = (await stock()).get("PMS0003").received;
await decide(k1.row.grnNo, "APPROVED");
const after2 = await stock();
check("QC approves a Kg receipt → its own Kg stock row grows by 15.5 Kg", after2.get("PMS0003 · Kg")?.received - kgBefore === 15.5, JSON.stringify(after2.get("PMS0003 · Kg")));
check("the Kg receipt is not added to the pieces row", after2.get("PMS0003").received === pcsBefore);

console.log("QC accepts part of a lot; the rest goes to a debit note");
const lot = await made({ poNo: "", poItemName: "", componentCode: "PMS0014", totalQty: 1000 });
await act(store, "sendToQc", [lot.row.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
const slipOf = async (grnNo) => (await qc("GET", "/api/state")).json.state.qcIntimations.find((q) => q.grnNo === grnNo);
const lotSlip = await slipOf(lot.row.grnNo);
const qcSays = (status, remark, accepted) => act(qc, "recordAr", [lotSlip.id, status, remark, accepted]);
let r = await qcSays("APPROVED", "", 950);
check("accepting part without saying why is refused", r.status === 409 && /Say why 50/.test(r.json?.error), JSON.stringify(r.json));
r = await qcSays("APPROVED", "x", 1001);
check("more than the lot is refused", r.status === 409 && /more than the 1000/.test(r.json?.error), JSON.stringify(r.json));
r = await qcSays("APPROVED", "x", 950.5);
check("part of a piece is refused", r.status === 409 && /whole pieces/.test(r.json?.error), JSON.stringify(r.json));
check("the gate can't decide", (await act(gate, "recordAr", [lotSlip.id, "APPROVED", "x", 950])).status === 403);
const pms14 = (await stock()).get("PMS0014");
r = await qcSays("APPROVED", "50 caps cracked", 950);
const lotAfter = r.json?.changes?.grnLines?.find((g) => g.grnNo === lot.row.grnNo);
check("950 accepted, 50 rejected: approved with its accepted qty", r.status === 200 && lotAfter?.qcStatus === "APPROVED" && lotAfter.acceptedQty === 950, JSON.stringify(r.json));
const pms14b = (await stock()).get("PMS0014");
check("only the 950 go into stock; the 50 count as rejected",
  pms14b.received - pms14.received === 950 && pms14b.closing - pms14.closing === 950 && pms14b.rejected - pms14.rejected === 50, JSON.stringify({ pms14, pms14b }));

const purchase = await login("purchase");
const pState = async () => (await purchase("GET", "/api/state")).json.state;
const due = L.debitNotesDue(await pState()).find((d) => d.grn.grnNo === lot.row.grnNo);
check("Purchase sees it waiting for a debit note: 50 pcs, QC's reason", due?.qty === 50 && due.reason === "50 caps cracked", JSON.stringify(due));
const dn = (who, over = {}) => act(who, "addDebitNote", [{ grnNo: lot.row.grnNo, rate: 2.5, reason: "50 caps cracked", ...over }]);
check("QC can't raise it", (await dn(qc)).status === 403);
check("Store can't raise it", (await dn(store)).status === 403);
check("…nor see debit notes or their amounts", (await store("GET", "/api/state")).json.state.debitNotes.length === 0);
check("no rate → refused", (await dn(purchase, { rate: 0 })).status === 400);
check("no reason → refused", (await dn(purchase, { reason: " " })).status === 400);
r = await dn(purchase, { date: "01-01-1999" });
check("the screen can't date it", r.status === 400, JSON.stringify(r.json));
r = await dn(purchase);
const note = r.json?.changes?.debitNotes?.at(-1);
check("Purchase raises it: 50 × ₹2.50 = ₹125, numbered, dated and signed by the server",
  r.status === 200 && /^DN-\d{4}$/.test(note?.id ?? "") && note.qty === 50 && note.rate === 2.5 && note.amount === 125 &&
  note.supplierName === "MAXCOMM INDIA PVT LTD" && note.raisedBy && /^\d{2}-\d{2}-\d{4}$/.test(note.date), JSON.stringify(r.json));
check("…with the supplier's invoice number as the reference (from the gate entry)", note?.invoiceNo === ge.invoiceNo && note.invoiceNo !== "", JSON.stringify(note));
check("…and it reads back the same from the database", (await pState()).debitNotes.find((n) => n.id === note?.id)?.invoiceNo === ge.invoiceNo);
check("a second one for the same GRN is refused", (await dn(purchase)).status === 409);
check("…and it is no longer waiting", !L.debitNotesDue(await pState()).some((d) => d.grn.grnNo === lot.row.grnNo));

const whole = await made({ poNo: "", poItemName: "", componentCode: "PMS0014", totalQty: 40 });
await act(store, "sendToQc", [whole.row.grnNo, { batchNo: "", mfgDate: "", expiryDate: "" }]);
await act(qc, "recordAr", [(await slipOf(whole.row.grnNo)).id, "REJECTED", "wrong colour"]);
check("a whole lot rejected waits for its debit note too (40 pcs)", L.debitNotesDue(await pState()).find((d) => d.grn.grnNo === whole.row.grnNo)?.qty === 40);
check("an older all-or-nothing rejection (before the split) does not", !L.debitNotesDue(await pState()).some((d) => d.grn.grnNo === "GR0005"));

const db2 = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const [[dnRow]] = await db2.query("SELECT qty, rate_enc FROM debit_notes WHERE dn_no = ?", [note?.id]);
check("stored with the rate encrypted", Number(dnRow?.qty) === 50 && dnRow.rate_enc && !String(dnRow.rate_enc).includes("2.5"), JSON.stringify(dnRow));
const blocked2 = async (sql, params) => { try { await db2.execute(sql, params); return false; } catch { return true; } };
check("a debit note cannot be changed or deleted", await blocked2("UPDATE debit_notes SET qty = 1 WHERE dn_no = ?", [note?.id]) &&
  await blocked2("DELETE FROM debit_notes WHERE dn_no = ?", [note?.id]));
check("the accepted qty of a QC decision cannot be changed", await blocked2(
  "UPDATE qc_results SET accepted_qty = 1000 WHERE intimation_no = ?", [lotSlip.id]));
await db2.end();

console.log("escalations: GRNs beyond ±20%, open until closed with a resolution");
const openEsc = async () => L.openEscalations(await pState()).map((g) => g.grnNo);
let esc = await openEsc();
check("the SHORT and the EXCESS GRNs are open escalations", esc.includes(a1.row.grnNo) && esc.includes(k1.row.grnNo), JSON.stringify(esc));
check("a GRN within the tolerance is not (the corrected eye liner)", !esc.includes(e1.row.grnNo));
const closeEsc = (who, grnNo, resolution) => act(who, "closeEscalation", [grnNo, resolution, "", ""]);
check("Store can't close one", (await closeEsc(store, a1.row.grnNo, "x")).status === 403);
check("QC can't close one", (await closeEsc(qc, a1.row.grnNo, "x")).status === 403);
check("no resolution → refused", (await closeEsc(purchase, a1.row.grnNo, "  ")).status === 400);
r = await closeEsc(purchase, e1.row.grnNo, "nothing to do");
check("a GRN without an escalation can't be closed", r.status === 409 && /within the tolerance/.test(r.json?.error), JSON.stringify(r.json));
const balance = (who, grnNo, o = {}) => act(who, "escalationIndent", [{ grnNo, qty: 2000, rate: 1.5, reason: "vendor sends the rest", ...o }]);
check("new PO for balance: Store can't", (await balance(store, a1.row.grnNo)).status === 403);
check("new PO for balance: not on an EXCESS escalation", (await balance(purchase, k1.row.grnNo)).status === 409);
check("new PO for balance: needs a rate", (await balance(purchase, a1.row.grnNo, { rate: 0 })).status === 400);
r = await balance(purchase, a1.row.grnNo);
const closedEsc = r.json?.changes?.escalationClosures?.find((c) => c.grnNo === a1.row.grnNo);
const balInd = r.json?.changes?.indents?.at(-1);
check("new PO for balance: an open indent from the GRN's vendor, the escalation closed with its number, dated and signed",
  r.status === 200 && balInd?.status === "OPEN" && balInd.qty === 2000 && balInd.componentCode === a1.row.componentCode &&
  balInd.supplierName === "MAXCOMM INDIA PVT LTD" && closedEsc?.resolution.startsWith(`Indent ${balInd.id} raised for the balance`) &&
  closedEsc.by && /^\d{2}-\d{2}-\d{4}$/.test(closedEsc.date), JSON.stringify(r.json));
esc = await openEsc();
check("…it is no longer open; the EXCESS one still is", !esc.includes(a1.row.grnNo) && esc.includes(k1.row.grnNo), JSON.stringify(esc));
check("closing it twice is refused", (await closeEsc(purchase, a1.row.grnNo, "again")).status === 409);
check("Store doesn't receive the closures", (await store("GET", "/api/state")).json.state.escalationClosures.length === 0);
const admin = await login("admin");
check("Admin closes the EXCESS one", (await closeEsc(admin, k1.row.grnNo, "Excess kept, vendor bills it")).status === 200 && !(await openEsc()).includes(k1.row.grnNo));
const db3 = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const blocked3 = async (sql, params) => { try { await db3.execute(sql, params); return false; } catch { return true; } };
check("a closure cannot be changed or deleted", await blocked3("UPDATE escalation_closures SET resolution = 'x' WHERE grn_no = ?", [a1.row.grnNo]) &&
  await blocked3("DELETE FROM escalation_closures WHERE grn_no = ?", [a1.row.grnNo]));
await db3.end();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// The Tally sync (the librarian) against a FAKE Tally — made-up data, never the company's: items become the
// app's items (alias = code, else T + MasterID, Tally's unit), vendors become suppliers, POs come in with codes;
// only changes are fetched (AlterID); a rename keeps the code; an edited PO is updated; a deleted PO is cancelled by
// a full sync; a PO number held by another Tally voucher is refused. Then PO closing: by hand, reopen, cut-over.
// Requires a DEVELOPMENT database with --dev-passwords and the demo data (npm test sets one up).
// Usage: node server/test/tallysync.mjs [baseUrl]
import "dotenv/config";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import mysql from "mysql2/promise";
import { tsImport } from "tsx/esm/api";

const L = await tsImport("../../src/flow/logic.ts", import.meta.url);
const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, x)));

/* ── a fake TallyPrime: answers the three read requests from the objects below, honouring "$AlterID > N" ── */
const run = Date.now();
let alter = run; // Tally's change counter
const next = () => ++alter;
const tag = String(run).slice(-5);
const CODE = `PMS7${tag}`; // an alias in the client's series, not in the master
const items = [
  { name: `Test Cap ${tag}`, alias: CODE, unit: "Pcs", group: "PM For Test", masterId: run % 1e7, alterId: next() },
  { name: `Test Oxide ${tag}`, alias: "", unit: "Kg", group: "Color Chemicals", masterId: (run % 1e7) + 1, alterId: next() },
  { name: `Test Unbought ${tag}`, alias: "", unit: "Pcs", group: "Finished goods", masterId: (run % 1e7) + 2, alterId: next() },
];
const vendors = [
  { name: `Test Vendor ${tag} Pvt Ltd`, alterId: next() },
  { name: `Test Vendor B ${tag}`, alterId: next() }, // later removed from Tally, to see Tally refuse a PO
];
const PO1 = `S${tag}A`, PO2 = `S${tag}B`;
const pos = [
  { no: PO1, guid: `g-${tag}-1`, date: "20261005", party: vendors[0].name, alterId: next(), lines: [[items[0].name, "100 Pcs"], [items[1].name, "2.500 Kg"]] },
  { no: PO2, guid: `g-${tag}-2`, date: "20261006", party: vendors[0].name, alterId: next(), lines: [[items[0].name, "50 Pcs"]] },
];
const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
let lastImport = ""; // the last "create" request the fake Tally received
const answer = (body) => {
  if (body.includes("<TALLYREQUEST>Import</TALLYREQUEST>")) {
    lastImport = body;
    const v = (t) => body.match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1] ?? "";
    const party = v("PARTYLEDGERNAME").replace(/&amp;/g, "&");
    // like Tally: an unknown ledger refuses the whole voucher
    if (!vendors.some((x) => x.name === party)) {
      return `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><ERRORS>1</ERRORS><LINEERROR>Ledger '${party}' does not exist!</LINEERROR></RESPONSE>`;
    }
    const lines = [...body.matchAll(/<STOCKITEMNAME>([^<]*)<\/STOCKITEMNAME>[\s\S]*?<ACTUALQTY> ([^<]*)<\/ACTUALQTY>/g)].map((m) => [m[1].replace(/&amp;/g, "&"), m[2]]);
    pos.push({ no: v("VOUCHERNUMBER"), guid: `g-${tag}-${v("VOUCHERNUMBER")}`, date: v("DATE"), party, alterId: next(), lines });
    return `<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><LASTVCHID>99</LASTVCHID></RESPONSE>`;
  }
  const since = Number(body.match(/\$AlterID > (\d+)/)?.[1] ?? 0);
  const newer = (xs) => xs.filter((x) => x.alterId > since);
  let data = "";
  if (body.includes("SSBItems")) {
    data = newer(items).map((i) => `<STOCKITEM NAME="${esc(i.name)}"><PARENT>${esc(i.group)}</PARENT><BASEUNITS>${i.unit}</BASEUNITS>
      <MASTERID> ${i.masterId}</MASTERID><ALTERID> ${i.alterId}</ALTERID>
      <LANGUAGENAME.LIST><NAME.LIST><NAME>${esc(i.name)}</NAME>${i.alias ? `<NAME>${i.alias}</NAME>` : ""}</NAME.LIST></LANGUAGENAME.LIST></STOCKITEM>`).join("");
  } else if (body.includes("SSBVendors")) {
    data = newer(vendors).map((v) => `<LEDGER NAME="${esc(v.name)}"><PARENT>Sundry Creditors</PARENT><ALTERID> ${v.alterId}</ALTERID></LEDGER>`).join("");
  } else {
    const only = body.match(/\$VoucherNumber = "([^"]+)"/)?.[1];
    data = newer(pos).filter((p) => !only || p.no === only).map((p) => `<VOUCHER VCHTYPE="Purchase Order"><DATE TYPE="Date">${p.date}</DATE><GUID>${p.guid}</GUID>
      <VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME><VOUCHERNUMBER>${p.no}</VOUCHERNUMBER><PARTYLEDGERNAME>${esc(p.party)}</PARTYLEDGERNAME>
      <ISCANCELLED>No</ISCANCELLED><ALTERID> ${p.alterId}</ALTERID>
      ${p.lines.map(([n, q]) => `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${esc(n)}</STOCKITEMNAME><ACTUALQTY> ${q}</ACTUALQTY></ALLINVENTORYENTRIES.LIST>`).join("")}
      </VOUCHER>`).join("");
  }
  return `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DESC><CMPINFO><STOCKITEM>${items.length}</STOCKITEM></CMPINFO></DESC><DATA><COLLECTION>${data}</COLLECTION></DATA></BODY></ENVELOPE>`;
};
const fake = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c)).on("end", () => {
    res.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
    res.end(answer(body));
  });
});
// the port the test API sends approved POs to (run.mjs sets its TALLY_URL)
await new Promise((r) => fake.listen(4011, "127.0.0.1", r));
const TALLY_URL = "http://127.0.0.1:4011";
const tally = async (args, env = {}) => {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "server/scripts/tally.ts", ...args], {
      env: { ...process.env, TALLY_URL, TALLY_COMPANY: "", TALLY_ALLOW_WRITE: "false", ...env },
    });
    return stdout;
  } catch (e) {
    return `FAILED ${e.stdout}${e.stderr}`;
  }
};
const sync = (...args) => tally(["sync", ...args]);

const db = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const comp = async (where, p) => (await db.query(`SELECT code, name, unit, tally_name FROM components WHERE ${where}`, p))[0][0];
const poLines = async (no) => (await db.query("SELECT item_name, item_code, qty, unit FROM tally_po_lines WHERE po_no = ? ORDER BY line_no", [no]))[0];

console.log("first sync");
let out = await sync("--full");
check("ran", /Tally sync \(full\)/.test(out), out);
const cap = await comp("tally_name = ?", [items[0].name]);
check("an item with a PMS alias gets that code, Tally's name and unit", cap?.code === CODE && cap.name === items[0].name && cap.unit === "Pcs", JSON.stringify(cap));
const oxide = await comp("tally_name = ?", [items[1].name]);
check("a bought item without alias gets T + MasterID, in Kg", oxide?.code === `T${items[1].masterId}` && oxide.unit === "Kg", JSON.stringify(oxide));
check("an item neither bought nor ours stays in Tally only", !(await comp("tally_name = ?", [items[2].name])));
check("the vendor is an approved supplier", (await db.query("SELECT approved FROM suppliers WHERE name = ?", [vendors[0].name]))[0][0]?.approved === 1);
const l1 = await poLines(PO1);
check("PO lines carry the item codes", l1.map((l) => l.item_code).join() === `${CODE},T${items[1].masterId}` && Number(l1[1].qty) === 2.5, JSON.stringify(l1));

console.log("only changes are fetched");
out = await sync();
check("nothing changed in Tally → nothing read", /items:\s+0 read/.test(out) && /POs:\s+0 read/.test(out), out);

console.log("changes in Tally");
items[0].name = `Test Cap RENAMED ${tag}`;
items[0].alterId = next();
pos[0].lines[0][1] = "120 Pcs";
pos[0].alterId = next();
out = await sync();
const renamed = await comp("code = ?", [CODE]);
check("a renamed item keeps its code, takes the new name", renamed?.name === items[0].name && renamed.tally_name === items[0].name, JSON.stringify(renamed));
check("an edited PO is updated (120 Pcs)", /1 updated/.test(out) && Number((await poLines(PO1))[0].qty) === 120, out);

console.log("a PO number held by another Tally voucher");
pos.push({ no: PO2, guid: `g-${tag}-OTHER`, date: "20261007", party: vendors[0].name, alterId: next(), lines: [[items[0].name, "1 Pcs"]] });
out = await sync();
check("is refused and reported", /already used by another Tally PO/.test(out) && Number((await poLines(PO2))[0].qty) === 50, out);
pos.pop();

console.log("a PO deleted in Tally");
pos.splice(1, 1); // PO2 deleted
out = await sync("--full");
check("a full sync marks it cancelled (kept, not deleted)", /1 gone from Tally/.test(out) && (await db.query("SELECT cancelled FROM tally_purchase_orders WHERE po_no = ?", [PO2]))[0][0]?.cancelled === 1, out);
out = await sync("--full");
check("a second full sync changes nothing", /0 added, 0 updated, \d+ unchanged, 0 gone/.test(out) && /items:.*0 new in the app, 0 renamed/.test(out), out);

/* ── PO closed in MySQL ── */
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
const [gate, purchase, admin] = await Promise.all(["gate", "purchase", "admin"].map(login));

console.log("the scheduled sync (watch)");
out = await tally(["watch", "--once"], { TALLY_URL: "http://127.0.0.1:4019" }); // nothing answers there: Tally closed
const failing = (await purchase("GET", "/api/tally-status")).json.status;
check("Tally closed: the run does not stop, the failure is recorded for Purchase (since, why)",
  !/^FAILED/.test(out) && /does not answer/.test(failing?.syncError?.error ?? "") && failing.syncedAt !== "", JSON.stringify(failing));
check("…the gate only sees when the list was last updated", JSON.stringify(Object.keys((await gate("GET", "/api/tally-status")).json.status ?? {})) === '["syncedAt"]');
check("…and the app keeps working (POs still there)", (await purchase("GET", "/api/state")).json.state.tallyPos.some((p) => p.poNo === PO1));
out = await tally(["watch", "--once"]);
check("Tally back: the next run works and clears the failure", (await purchase("GET", "/api/tally-status")).json.status?.syncError === null, out);

console.log("a PO raised here is created in Tally");
const raise = async (vendor) => {
  const ind = (await act(purchase, "addIndent", [{ date: "", componentCode: CODE, componentName: "", qty: 10, reason: "test", supplierName: vendor, rate: 2 }])).json?.changes?.indents?.at(-1);
  const r = await act(purchase, "raisePo", [{ date: "", supplierName: vendor, lines: [{ componentCode: CODE, componentName: "", qty: 10, rate: 2 }], expectedDate: "", indentIds: [ind.id] }]);
  return r.json?.changes?.purchaseOrders?.at(-1)?.id;
};
const waitForSend = async (po) => {
  for (let i = 0; i < 40; i++) {
    const p = (await purchase("GET", "/api/state")).json.state.purchaseOrders.find((x) => x.id === po);
    if (p?.tallyPushedAt) return p;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const inTally = async (po) => {
  const s = (await purchase("GET", "/api/state")).json.state;
  return L.tallyStatusOf(s.purchaseOrders.find((p) => p.id === po), s.tallyPos);
};

const APP_PO = await raise(vendors[0].name);
out = await tally(["push", APP_PO]);
check("the command: writing to Tally is off unless switched on", /switched off/.test(out) && !lastImport, out);
out = await tally(["push", APP_PO], { TALLY_ALLOW_WRITE: "true" });
check("an unapproved PO is not sent", /not approved/.test(out) && !lastImport, out);
await act(admin, "approvePo", [APP_PO, ""]);
const sent = await waitForSend(APP_PO);
check("approval sends it to Tally on its own", sent && sent.tallyError === "", JSON.stringify(sent));
check("…with Tally's own names, number and amounts",
  lastImport.includes(`<VOUCHERNUMBER>${APP_PO}</VOUCHERNUMBER>`) && lastImport.includes(`<STOCKITEMNAME>${items[0].name}</STOCKITEMNAME>`) &&
  lastImport.includes(`<PARTYLEDGERNAME>${vendors[0].name}</PARTYLEDGERNAME>`) && lastImport.includes("<AMOUNT>-20.00</AMOUNT>") && lastImport.includes("<AMOUNT>20.00</AMOUNT>"),
  lastImport.slice(0, 600));
check("read back: the app shows it IN TALLY", (await inTally(APP_PO)) === "IN_TALLY");
lastImport = "";
out = await tally(["push", APP_PO], { TALLY_ALLOW_WRITE: "true" });
check("sending it again is refused (Tally is asked first: it has that number)", /already has a PO numbered/.test(out) && !lastImport, out);

console.log("Tally already has our number (typed there by hand) → new number & send");
const CLASH = await raise(vendors[0].name);
const plus = (no, k) => no.replace(/\d+$/, (d) => String(Number(d) + k).padStart(d.length, "0"));
// Accounts typed this number in Tally, and the next one too — both are other POs
for (const k of [0, 1]) pos.push({ no: plus(CLASH, k), guid: `g-${tag}-hand-${k}`, date: "20261001", party: vendors[0].name, alterId: next(), lines: [[items[1].name, "1 Kg"]] });
lastImport = "";
await act(admin, "approvePo", [CLASH, ""]);
const clashed = await waitForSend(CLASH);
check("nothing is sent; the PO says its number is taken in Tally", L.numberTaken(clashed) && !lastImport, JSON.stringify(clashed));
check("the gate can't give a new number", (await gate("POST", "/api/tally/renumber", { poNo: CLASH })).status === 403);
const clashIndent = clashed.indentIds[0];
const renum = await purchase("POST", "/api/tally/renumber", { poNo: CLASH });
const NEW_NO = plus(CLASH, 2);
check("Purchase: new number & send — the next number Tally does not have (taken ones skipped), created in Tally",
  renum.status === 200 && renum.json?.poNo === NEW_NO && lastImport.includes(`<VOUCHERNUMBER>${NEW_NO}</VOUCHERNUMBER>`), JSON.stringify(renum.json));
const clashState = (await purchase("GET", "/api/state")).json.state;
const moved = clashState.purchaseOrders.find((p) => p.id === NEW_NO);
check("one number everywhere: the PO is now the new number, in Tally, and its indent points to it",
  moved && moved.tallyError === "" && L.tallyStatusOf(moved, clashState.tallyPos) === "IN_TALLY" &&
  !clashState.purchaseOrders.some((p) => p.id === CLASH) && clashIndent && moved.indentIds.includes(clashIndent),
  JSON.stringify({ moved, clashIndent }));
await sync(); // Tally's own hand-made POs come in with the next sync
const atGate = L.gatePos((await gate("GET", "/api/state")).json.state);
check("the gate sees ours once under its number, and the old number only as Tally's own PO",
  atGate.filter((p) => p.poNo === NEW_NO).length === 1 && atGate.filter((p) => p.poNo === CLASH).length === 1 && atGate.find((p) => p.poNo === CLASH).lines[0]?.unit === "Kg",
  JSON.stringify(atGate.filter((p) => [CLASH, NEW_NO].includes(p.poNo))));
check("asking again is refused (it was not refused for its number any more)", (await purchase("POST", "/api/tally/renumber", { poNo: NEW_NO })).status === 409);
let blocked = "not refused";
try { await db.query("UPDATE purchase_orders SET po_no = 'X-HACK' WHERE po_no = ?", [NEW_NO]); } catch (e) { blocked = e.message; }
check("outside the renumber step the database still refuses a new PO number", /cannot change/.test(blocked), blocked);

console.log("only Tally vendors");
const notTally = await act(purchase, "addIndent", [{ date: "", componentCode: CODE, componentName: "", qty: 10, reason: "test", supplierName: "Shree Packwell", rate: 2 }]);
check("an indent for a vendor that is no Tally ledger is refused", notTally.status === 409 && /not a vendor in Tally/.test(notTally.json?.error), JSON.stringify(notTally.json));

console.log("Tally refuses → NOT SENT, Retry");
const B = vendors.splice(1, 1)[0]; // the ledger disappears from Tally (renamed/deleted there)
const REFUSED = await raise(B.name);
await act(admin, "approvePo", [REFUSED, ""]);
const refusedPo = await waitForSend(REFUSED);
check("Tally's reason is kept on the PO", /does not exist/.test(refusedPo?.tallyError ?? ""), JSON.stringify(refusedPo));
check("…and the approval stands", refusedPo?.status === "APPROVED");
check("the gate can't retry", (await gate("POST", "/api/tally/push", { poNo: REFUSED })).status === 403);
vendors.push(B); // fixed in Tally
const retry = await purchase("POST", "/api/tally/push", { poNo: REFUSED });
check("Purchase retries: created", retry.status === 200 && (await inTally(REFUSED)) === "IN_TALLY", JSON.stringify(retry.json));
check("…and the reason is cleared", (await waitForSend(REFUSED))?.tallyError === "");
await db.end();
fake.close();
const isOpen = async (no) => {
  const s = (await gate("GET", "/api/state")).json.state;
  return L.deriveTallyPoProgress(L.gatePos(s), s.gateEntries, s.grnLines).find((p) => p.po.poNo === no)?.open;
};
const gateIn = (no) => act(gate, "addGateEntry", [{
  date: "", supplierName: "", productDesc: "", invoiceNo: `C-${tag}-${Math.random().toString(36).slice(2, 6)}`, invoiceDate: "",
  poNo: no, invoiceQty: null, transportName: "", lrNo: "", vehicleNo: "HR55-C-0001", timeIn: "00:00", timeOut: "", driverSign: false,
  remark: "", lines: [{ itemName: items[0].name.replace("RENAMED ", ""), itemCode: "", unit: "", qty: 1, remark: "" }],
}]);

console.log("PO closed in MySQL");
check("open before", (await isOpen(PO1)) === true);
check("Purchase closes it with a reason", (await act(purchase, "closePo", [PO1, "Vendor will not supply the balance", "", ""])).status === 200);
check("closed: not open at the gate", (await isOpen(PO1)) === false);
const refused = await gateIn(PO1);
check("the gate cannot receive against it", refused.status === 409 && /closed/.test(refused.json?.error), JSON.stringify(refused.json));
check("closing twice is refused", (await act(purchase, "closePo", [PO1, "again", "", ""])).status === 409);
check("Purchase reopens it", (await act(purchase, "reopenPo", [PO1, "", ""])).status === 200 && (await isOpen(PO1)) === true);
check("the gate can't close POs", (await act(gate, "closePo", [PO1, "x", "", ""])).status === 403);

console.log("go-live cut-over");
check("only the owner may run it", (await act(purchase, "closePosBefore", ["01-01-2027", "go-live", "", ""])).status === 403);
const recv = await gateIn(PO1); // PO1 now has a receipt in the app
check("(a receipt against PO1)", recv.status === 200, JSON.stringify(recv.json));
const cut = await act(admin, "closePosBefore", ["01-01-2027", "Received before go-live", "", ""]);
check("closes old POs without receipts", cut.status === 200 && cut.json.changes.poClosures.length > 0, JSON.stringify(cut.json).slice(0, 300));
check("…but not a PO with a receipt in the app", (await isOpen(PO1)) === true);
const st = (await purchase("GET", "/api/tally-status")).json.status;
check("Purchase sees the sync status", typeof st?.syncedAt === "string" && Array.isArray(st.skipped), JSON.stringify(st).slice(0, 200));
const gs = (await gate("GET", "/api/tally-status")).json.status;
check("the gate sees only the sync time", gs && Object.keys(gs).join() === "syncedAt", JSON.stringify(gs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

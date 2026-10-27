// Requires a DEVELOPMENT database set up with --dev-passwords and demo data loaded (npm run db:demo).
// Never point this at production. Usage: node server/test/security.mjs [baseUrl]
// API smoke test against a running server. Usage: node smoke.mjs [baseUrl]
const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok  ", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};

/** Actions carry the change number the caller's screen is current as of (fresh, unless given). */
async function withBasis(path, body, headers) {
  if (!path.startsWith("/api/actions/") || !body || body.basis !== undefined) return body;
  const v = await fetch(BASE + "/api/version", { headers }).then((r) => r.json()).catch(() => ({ version: 0 }));
  return { ...body, basis: v.version ?? 0 };
}

function client() {
  let cookie = "";
  return async function call(method, path, body, headers = { "x-flow-request": "1" }) {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(await withBasis(path, body, cookie ? { cookie } : {})),
    });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, headers: res.headers };
  };
}

async function login(u, p) {
  const c = client();
  const r = await c("POST", "/api/auth/login", { username: u, password: p });
  return { c, r };
}

console.log("auth");
{
  const anon = client();
  check("state needs login", (await anon("GET", "/api/state")).status === 401);
  check("POST without csrf header blocked", (await anon("POST", "/api/auth/login", { username: "admin", password: "seven@admin" }, {})).status === 403);
  check("cross-origin POST blocked", (await anon("POST", "/api/auth/login", { username: "admin", password: "seven@admin" }, { "x-flow-request": "1", origin: "https://evil.example" })).status === 403);
  const bad = await anon("POST", "/api/auth/login", { username: "admin", password: "nope" });
  check("wrong password 401 + generic message", bad.status === 401 && bad.json.error === "Wrong ID or password.");
  const unk = await anon("POST", "/api/auth/login", { username: "ghost", password: "nope" });
  check("unknown user same message", unk.status === 401 && unk.json.error === bad.json.error);
  const extra = await anon("POST", "/api/auth/login", { username: "admin", password: "x", role: "admin" });
  check("unknown fields rejected", extra.status === 400);
}

const { c: admin, r: ar } = await login("admin", "seven@admin");
check("admin login", ar.status === 200 && ar.json.user.role === "admin");
check("no password in response", !JSON.stringify(ar.json).includes("seven@"));
const st = await admin("GET", "/api/state");
check("admin sees all registers", st.status === 200 && st.json.state.dispatchSlips.length > 0 && st.json.state.purchaseOrders.length > 0);
check("admin sees customer + rates", st.json.state.dispatchSlips[0].partyName !== "" && st.json.state.purchaseOrders.some(p => p.lines.some(l => l.rate !== null)));
check("security headers", st.headers.get("cache-control") === "no-store" && st.headers.get("x-content-type-options") === "nosniff" && !st.headers.get("x-powered-by"));

console.log("role restrictions");
const { c: gate } = await login("gate", "seven@gate");
const gs = (await gate("GET", "/api/state")).json.state;
check("gate gets no dispatch/orders/QC", gs.dispatchSlips.length === 0 && gs.orders.length === 0 && gs.qcIntimations.length === 0);
check("gate gets Tally POs and app POs, never their rates", gs.tallyPos.length > 0 && gs.purchaseOrders.length > 0 && gs.purchaseOrders.every((p) => p.lines.every((l) => l.rate === null)) && !JSON.stringify(gs.tallyPos).includes("rate"));
check("gate cannot read supplier rates", (await gate("GET", "/api/masters/suppliers")).status === 403);
const deny = await gate("POST", "/api/actions/recordAr", { args: ["QCI-0001", "APPROVED", ""] });
check("gate cannot make QC decision (403)", deny.status === 403);
check("gate cannot approve PO", (await gate("POST", "/api/actions/approvePo", { args: ["26SEV231", "x"] })).status === 403);

const { c: qc } = await login("qc", "seven@qc");
const qs = (await qc("GET", "/api/state")).json.state;
check("qc sees dispatches redacted", qs.dispatchSlips.length > 0 && qs.dispatchSlips.every(d => d.partyName === "" && d.partyAddress === ""));
const { c: purchase } = await login("purchase", "seven@purchase");
const sup = await purchase("GET", "/api/masters/suppliers");
check("purchase reads supplier rates", sup.status === 200 && sup.json.suppliers.some((s) => Object.keys(s.rates).length > 0));
check("purchase cannot approve own PO", (await purchase("POST", "/api/actions/approvePo", { args: ["26SEV231", "x"] })).status === 403);
check("demo reset admin-only", (await purchase("POST", "/api/demo/clear")).status === 403);

console.log("actions + rules");
const ge = await gate("POST", "/api/actions/addGateEntry", { args: [{ date: "01-01-1999", supplierName: "Test Supplier", productDesc: "x", invoiceNo: "INV1", invoiceDate: "", poNo: "", invoiceQty: 10, transportName: "", lrNo: "LR1", vehicleNo: "HR-1", timeIn: "00:00", timeOut: "", driverSign: false, remark: "", lines: [] }] });
const newGe = ge.json?.changes?.gateEntries?.at(-1);
check("gate entry created", ge.status === 200 && newGe?.supplierName === "Test Supplier");
check("server stamps date (client backdate ignored)", newGe?.date !== "01-01-1999", newGe?.date);
const badIn = await gate("POST", "/api/actions/addGateEntry", { args: [{ date: "", supplierName: "", productDesc: "", invoiceNo: "", invoiceDate: "", poNo: "", invoiceQty: null, transportName: "", lrNo: "", vehicleNo: "", timeIn: "", timeOut: "", driverSign: false, remark: "", lines: [] }] });
check("validation: empty supplier refused", badIn.status === 400, JSON.stringify(badIn.json));
const inj = await gate("POST", "/api/actions/addGateEntry", { args: [{ date: "", supplierName: "x', 'y'); DROP TABLE users; --", productDesc: "<script>alert(1)</script>", invoiceNo: "", invoiceDate: "", poNo: "", invoiceQty: null, transportName: "", lrNo: "", vehicleNo: "HR55-T-0001", timeIn: "00:00", timeOut: "", driverSign: false, remark: "", lines: [] }] });
check("SQL-ish text stored as plain data", inj.status === 200 && inj.json.changes.gateEntries.at(-1).supplierName.includes("DROP TABLE"));

const { c: store } = await login("store", "seven@store");
const s0 = (await store("GET", "/api/state")).json.state;
const geId = s0.gateEntries.at(-1).id;
const grn = await store("POST", "/api/actions/addGrnLine", { args: [{ gateEntryId: geId, gateLineNo: null, unit: "", componentCode: "PMS0014", componentName: "HACKED", type: "x", brandName: "SEVEN SEAS", receivedDate: "", poNo: "", poQty: null, invoiceNo: "", supplierName: "Someone else", qtyPerBox: 100, totalBoxes: 24, totalQty: 999999, remarkStore: "", location: "Store" }] });
const g = grn.json?.changes?.grnLines?.at(-1);
check("GRN created UNDER_TEST", grn.status === 200 && g?.qcStatus === "UNDER_TEST");
check("GRN name/supplier/total from server", g?.componentName !== "HACKED" && g?.totalQty === 2400, JSON.stringify(g));
const req = (await store("GET", "/api/state")).json.state.requisitions.find(r => r.status === "PENDING");
if (req) {
  const over = await store("POST", "/api/actions/issueRequisition", { args: [req.id, req.lines.map(() => 99999999), "Store"] });
  const issued = over.json?.changes?.requisitions?.find(r => r.id === req.id);
  check("over-issue clamped to stock", over.status === 200 && issued.lines.every(l => l.qtyIssued < 99999999));
  const again = await store("POST", "/api/actions/issueRequisition", { args: [req.id, [1], "Store"] });
  check("re-issue rejected with reason (409)", again.status === 409 && /already issued/.test(again.json.error), JSON.stringify(again.json));
}
const { c: fg } = await login("fgwh", "seven@fgwh");
const fs = (await fg("GET", "/api/state")).json.state;
const dispatch = await fg("POST", "/api/actions/addDispatch", { args: [{ date: "", orderId: "", partyName: "X", partyAddress: "", lines: [{ productName: fs.fgTransfers[0].lines[0].productName, productCode: "", batchNo: fs.fgTransfers[0].lines[0].batchNo, qtyPerBox: 12, totalBoxes: 999999, totalQty: 1 }], dispatchSign: "FG", remark: "" }] });
check("over-dispatch rejected (409)", dispatch.status === 409, JSON.stringify(dispatch.json));
const { c: sec } = await login("security", "seven@security");
const open = (await sec("GET", "/api/state")).json.state.dispatchSlips.find(d => !d.invoiceNo);
if (open) {
  const go = await sec("POST", "/api/actions/gateOut", { args: [open.id, "Guard", "00:00"] });
  check("gate-out without invoice rejected", go.status === 409, JSON.stringify(go.json));
}

console.log("logout");
await gate("POST", "/api/auth/logout");
check("session gone after logout", (await gate("GET", "/api/state")).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

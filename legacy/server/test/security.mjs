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
  const call = async (method, path, body, headers = { "x-flow-request": "1" }) => {
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
  call.cookie = () => cookie;
  return call;
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
check("gate gets no POs at all (it records vehicles; Store picks the PO)", gs.tallyPos.length === 0 && gs.purchaseOrders.length === 0);
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
const gateIn = (over) => gate("POST", "/api/actions/addGateEntry", { args: [{ supplierName: "Shree Packwell", invoiceNo: "", invoiceDate: "", invoiceQty: 10, invoiceQtyUnit: "Box", transportName: "", lrNo: "LR1", vehicleNo: "HR-1", driverName: "", driverPhone: "", ...over }] });
const ge = await gateIn({ invoiceNo: `INV1-${Date.now()}` });
const newGe = ge.json?.changes?.gateEntries?.at(-1);
check("gate entry created", ge.status === 200 && newGe?.supplierName === "Shree Packwell");
check("the server dates it (the client cannot send a date)", /^\d{2}-\d{2}-\d{4}$/.test(newGe?.date) && (await gateIn({ date: "01-01-1999" })).status === 400, newGe?.date);
const badIn = await gateIn({ supplierName: "" });
check("validation: empty supplier refused", badIn.status === 400, JSON.stringify(badIn.json));
check("a supplier not on file is refused", (await gateIn({ supplierName: "x', 'y'); DROP TABLE users; --" })).status === 409);
const inj = await gateIn({ driverName: "x', 'y'); DROP TABLE users; --", transportName: "<script>alert(1)</script>" });
check("SQL-ish text stored as plain data", inj.status === 200 && inj.json.changes.gateEntries.at(-1).driverName.includes("DROP TABLE"));

const { c: store } = await login("store", "seven@store");
const s0 = (await store("GET", "/api/state")).json.state;
const geId = s0.gateEntries.at(-1).id;
const grn = await store("POST", "/api/actions/addGrnLine", { args: [{ gateEntryId: geId, gateLineNo: null, unit: "", componentCode: "PMS0014", componentName: "HACKED", type: "x", brandName: "SEVEN SEAS", receivedDate: "", poNo: "", poItemName: "", poQty: null, invoiceNo: "", supplierName: "Someone else", qtyPerBox: 100, totalBoxes: 24, totalQty: 999999, remarkStore: "", location: "Store" }] });
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
console.log("hardening (pentest findings)");
{
  const raw = async (p) => fetch(BASE + p);
  const page = await raw("/");
  check("only / serves the app page", page.status === 200);
  for (const p of ["/anything", "/.env", "/server/src/config.ts", "/package.json", "/admin"]) {
    const r = await raw(p);
    check(`  ${p} → plain 404 (not the page)`, r.status === 404 && !(r.headers.get("content-type") ?? "").includes("html"));
  }
  const nope = await gate("POST", "/api/demo/<script>", { password: "x", confirm: "x" });
  check("an unknown demo operation is refused before it reaches the audit log", nope.status === 404);
  const future = await gate("POST", "/api/actions/recordVehicleOut", { args: [geId, true, ""], basis: 9e15 });
  check("a screen cannot claim a future version to skip the stale-screen guard", future.status === 409, JSON.stringify(future.json));
  const gs2 = (await gate("GET", "/api/state")).json.state;
  check("the gate gets only which entries have a GRN — every detail blank",
    gs2.grnLines.length > 0 && gs2.grnLines.every((g) => g.totalQty === 0 && !g.poNo && !g.supplierName && !g.componentCode && g.acceptedQty === null));
  // the gate's screen computes stock and PO figures from what it receives: it must not crash on the blanked GRNs
  const { tsImport } = await import("tsx/esm/api");
  const L = await tsImport("../../src/flow/logic.ts", import.meta.url);
  let crash = "";
  try {
    L.derivePmStock(gs2.grnLines, gs2.requisitions, gs2.mrns, gs2.openings, gs2.minLevels);
    L.derivePoProgress(gs2.purchaseOrders, gs2.gateEntries, gs2.grnLines);
    L.awaitingGrn(gs2.gateEntries, gs2.grnLines);
  } catch (e) {
    crash = String(e);
  }
  check("…and the gate's screen code runs on it without crashing (it went blank before)", crash === "", crash);
  const ss = (await store("GET", "/api/state")).json.state;
  check("Store does not get drivers' names or phones", ss.gateEntries.every((g) => !g.driverPhone && !g.driverName));
  check("…nor Tally errors or rates on POs", ss.purchaseOrders.every((p) => !p.tallyError && p.lines.every((l) => l.rate === null)));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]);
  const { c: gate2 } = await login("gate", "seven@gate");
  const photoOld = await fetch(`${BASE}/api/gate-entries/GE-0001/photo`, {
    method: "POST",
    headers: { "content-type": "image/jpeg", "x-flow-request": "1", cookie: gate2.cookie() },
    body: jpeg,
  });
  const why = await photoOld.json().catch(() => ({}));
  check("a photo cannot be attached to someone else's / an old gate entry", photoOld.status === 409 && /Only the login that made/.test(why.error ?? ""), JSON.stringify(why));
  const req = (await store("GET", "/api/state")).json.state.requisitions.find((r) => r.status === "PENDING");
  if (req) {
    const issued = await store("POST", "/api/actions/issueRequisition", { args: [req.id, req.lines.map(() => 0), "The Owner"] });
    const signedAs = issued.json?.changes?.requisitions?.find((r) => r.id === req.id)?.storeSign;
    check("a signature is the logged-in user, never the name the screen sends", issued.status !== 200 || (signedAs && signedAs !== "The Owner"), JSON.stringify(signedAs));
  }
}

console.log("users tab");
{
  check("only admin lists users", (await gate("GET", "/api/users")).status === 403);
  check("only admin adds users", (await gate("POST", "/api/users", { username: "x_gate_2", role: "gate", label: "Gate", name: "X", password: "Start#Pass2026" })).status === 403);
  check("taken username says taken", (await admin("GET", "/api/users/check?username=gate")).json?.taken === true);
  const fresh = `t_${Date.now() % 1e9}`;
  check("free username says available", (await admin("GET", `/api/users/check?username=${fresh}`)).json?.taken === false);
  check("bad username refused", (await admin("GET", "/api/users/check?username=A%20B")).status === 400);
  check("name is required", (await admin("POST", "/api/users", { username: fresh, role: "gate", label: "Gate Entry", name: "", password: "Start#Pass2026" })).status === 400);
  const weak = await admin("POST", "/api/users", { username: fresh, role: "gate", label: "Gate Entry", name: "Test Guard", password: "seven@gate" });
  check("a weak starting password is refused with the reason", weak.status === 400 && /characters|default|guess|Mix/.test(weak.json?.error ?? ""), JSON.stringify(weak.json));
  const made = await admin("POST", "/api/users", { username: fresh, role: "gate", label: "Gate Entry", name: "Test Guard", password: "Start#Pass2026" });
  check("admin adds a user with the password they typed; it is not sent back", made.status === 200 && made.json.username === fresh && !("password" in made.json));
  check("same username again is refused", (await admin("POST", "/api/users", { username: fresh, role: "store", label: "Store", name: "Other", password: "Start#Pass2026" })).status === 409);
  const listed = (await admin("GET", "/api/users")).json.users.find((u) => u.username === fresh);
  check("listed with name, label and role; no password", listed?.name === "Test Guard" && listed.label === "Gate Entry" && listed.role === "gate" && !("password" in listed));
  const { c: newbie, r: first } = await login(fresh, "Start#Pass2026");
  check("new user must set their own password first", first.status === 200 && first.json.user.mustChangePassword === true && first.json.user.name === "Test Guard");
  check("only admin can disable", (await gate("POST", `/api/users/${fresh}/active`, { active: false })).status === 403);
  check("admin cannot disable themselves", (await admin("POST", "/api/users/admin/active", { active: false })).status === 409);
  check("admin disables a user", (await admin("POST", `/api/users/${fresh}/active`, { active: false })).status === 200);
  check("…who is signed out at once", (await newbie("GET", "/api/auth/me")).status === 401);
  check("…and cannot log in", (await login(fresh, "Start#Pass2026")).r.status === 401);
  check("…listed as disabled", (await admin("GET", "/api/users")).json.users.find((u) => u.username === fresh)?.active === false);
  check("admin enables them again", (await admin("POST", `/api/users/${fresh}/active`, { active: true })).status === 200);
  check("…and they can log in again", (await login(fresh, "Start#Pass2026")).r.status === 200);
  check("only admin changes a role", (await gate("POST", `/api/users/${fresh}/role`, { role: "store", label: "Store" })).status === 403);
  check("admin cannot change their own role", (await admin("POST", "/api/users/admin/role", { role: "store", label: "Store" })).status === 409);
  check("an unknown role is refused", (await admin("POST", `/api/users/${fresh}/role`, { role: "boss", label: "Boss" })).status === 400);
  const { c: before } = await login(fresh, "Start#Pass2026");
  check("admin changes gate → store", (await admin("POST", `/api/users/${fresh}/role`, { role: "store", label: "Store" })).status === 200);
  check("…the user is signed out", (await before("GET", "/api/auth/me")).status === 401);
  const relog = (await login(fresh, "Start#Pass2026")).r;
  check("…and logs in with the new role and label", relog.json?.user?.role === "store" && relog.json.user.label === "Store", JSON.stringify(relog.json?.user));
}

await gate("POST", "/api/auth/logout");
check("session gone after logout", (await gate("GET", "/api/state")).status === 401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

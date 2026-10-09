// Requires a DEVELOPMENT database set up with --dev-passwords and demo data (npm run db:demo).
// Leaves the "accounts" login locked (npm run user -- unlock accounts) and changes the "security" password.
const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, x)));
/** Actions carry the change number the caller's screen is current as of (fresh, unless given). */
async function withBasis(path, body, headers) {
  if (!path.startsWith("/api/actions/") || !body || body.basis !== undefined) return body;
  const v = await fetch(BASE + "/api/version", { headers }).then((r) => r.json()).catch(() => ({ version: 0 }));
  return { ...body, basis: v.version ?? 0 };
}

function client() {
  let cookie = "";
  return async (method, path, body) => {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-flow-request": "1", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(await withBasis(path, body, cookie ? { cookie } : {})) });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(";")[0];
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, json, cookie };
  };
}

console.log("concurrency: 8 GRNs at once get 8 distinct numbers");
{
  const c = client(); await c("POST", "/api/auth/login", { username: "store", password: "seven@store" });
  const ge = (await c("GET", "/api/state")).json.state.gateEntries[0].id;
  const body = { args: [{ gateEntryId: ge, componentCode: "PMS0002", componentName: "", type: "", brandName: "", receivedDate: "", poNo: "", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: 10, totalBoxes: 1, totalQty: 10, remarkStore: "", location: "" }] };
  const rs = await Promise.all(Array.from({ length: 8 }, () => c("POST", "/api/actions/addGrnLine", body)));
  check("all 8 succeeded", rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
  const nos = (await c("GET", "/api/state")).json.state.grnLines.map((g) => g.grnNo);
  check("GRN numbers unique", new Set(nos).size === nos.length, nos.join(","));
}

console.log("concurrency: two parallel issues cannot overdraw stock");
{
  const p = client(); await p("POST", "/api/auth/login", { username: "packing", password: "seven@packing" });
  const code = "PMS0848"; // opening 0 + approved GRN qty in seed
  const stock = () => p("GET", "/api/state").then((r) => r.json.state);
  const mk = () => p("POST", "/api/actions/addRequisition", { args: [{ date: "", department: "T", productName: "", batchNo: "", lines: [{ materialName: "", materialCode: code, unit: "Pcs", qtyRequired: 1000000, qtyIssued: null, returnQty: null, remark: "" }], packingSign: "", storeSign: "" }] });
  await mk(); await mk();
  const s = client(); await s("POST", "/api/auth/login", { username: "store", password: "seven@store" });
  const reqs = (await stock()).requisitions.filter((r) => r.department === "T" && r.status === "PENDING").slice(-2);
  await Promise.all(reqs.map((r) => s("POST", "/api/actions/issueRequisition", { args: [r.id, [1000000], "S"] })));
  const st = (await stock());
  const issued = st.requisitions.filter((r) => reqs.some((x) => x.id === r.id)).reduce((n, r) => n + (r.lines[0].qtyIssued ?? 0), 0);
  const approved = st.grnLines.filter((g) => g.componentCode === code && g.qcStatus === "APPROVED").reduce((n, g) => n + g.totalQty, 0) + (st.openings[code] ?? 0);
  const otherIssued = st.requisitions.filter((r) => !reqs.some((x) => x.id === r.id)).flatMap((r) => r.lines).filter((l) => l.materialCode === code).reduce((n, l) => n + (l.qtyIssued ?? 0), 0);
  const returned = st.mrns.flatMap((m) => m.lines).filter((l) => l.componentCode === code).reduce((n, l) => n + l.qty, 0);
  check("total issued ≤ available", issued <= approved - otherIssued + returned, `${issued} vs ${approved - otherIssued + returned}`);
}

console.log("account lockout");
{
  for (let i = 0; i < 5; i++) await client()("POST", "/api/auth/login", { username: "accounts", password: "wrong" + i });
  const r = await client()("POST", "/api/auth/login", { username: "accounts", password: "seven@accounts" });
  check("locked after 5 failures even with right password", r.status === 429, JSON.stringify(r.json));
}

console.log("password change");
{
  const a = client(); const b = client();
  await a("POST", "/api/auth/login", { username: "security", password: "seven@security" });
  await b("POST", "/api/auth/login", { username: "security", password: "seven@security" });
  check("weak password refused", (await a("POST", "/api/auth/change-password", { currentPassword: "seven@security", newPassword: "short" })).status === 400);
  check("wrong current refused", (await a("POST", "/api/auth/change-password", { currentPassword: "nope", newPassword: "Str0ng-Passw0rd!" })).status === 400);
  check("strong password accepted", (await a("POST", "/api/auth/change-password", { currentPassword: "seven@security", newPassword: "Str0ng-Passw0rd!" })).status === 200);
  check("other session signed out", (await b("GET", "/api/state")).status === 401);
  check("current session kept", (await a("GET", "/api/state")).status === 200);
  check("old password no longer works", (await client()("POST", "/api/auth/login", { username: "security", password: "seven@security" })).status === 401);
  // put it back for later manual testing
  await a("POST", "/api/auth/change-password", { currentPassword: "Str0ng-Passw0rd!", newPassword: "Back-to-dev-pw-2026" });
}

console.log("tampered cookie");
{
  const r = await fetch(BASE + "/api/state", { headers: { cookie: "flow_sid=" + "A".repeat(43) } });
  check("forged token rejected", r.status === 401);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

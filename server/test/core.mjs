// Core: front door, login, admin page API (users, masters, item ↔ vendor), who may use it. Synthetic data only.
// Usage: node server/test/core.mjs [baseUrl]   (run by npm test against its own _test database)
const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, x)));

function client() {
  let cookie = "";
  return async (method, path, body, headers = { "x-flow-request": "1" }) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", ...headers, ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(";")[0];
    let json = null;
    try { json = await res.clone().json(); } catch {}
    return { status: res.status, json, text: json ? "" : await res.text(), res };
  };
}

console.log("front door");
const anon = client();
const home = await anon("GET", "/");
check("/ lists the modules and the admin page", /href="\/ps"/.test(home.text) && /href="\/admin"/.test(home.text));
const page = await anon("GET", "/admin");
check("/admin page under the strict policy (no inline scripts)", /<script src="\/admin\/admin.js">/.test(page.text) && !/script-src[^;]*unsafe-inline/.test(page.res.headers.get("content-security-policy") ?? ""));
check("admin API needs a login", (await anon("GET", "/api/admin/users")).status === 401);
check("unknown module call → 404", (await anon("POST", "/api/ps/call/nope", { args: [] })).status === 404);
check("calls without the request header are blocked", (await anon("POST", "/api/ps/call/getLoginBoot", { args: [] }, {})).status === 403);

console.log("admin: users");
const admin = client();
check("admin logs in", (await admin("POST", "/api/auth/login", { username: "admin", password: "seven@admin" })).status === 200);
check("name check: admin taken", (await admin("GET", "/api/admin/users/check?username=admin")).json?.taken === true);
check("name check: free name", (await admin("GET", "/api/admin/users/check?username=zz.core")).json?.taken === false);
const add = (b) => admin("POST", "/api/admin/users", b);
check("weak starting password refused", (await add({ username: "zz.core", role: "store", label: "Store", name: "Zed Core", password: "short" })).status === 400);
check("user added", (await add({ username: "zz.core", role: "store", label: "Store", name: "Zed Core", password: "Start#Pass2026", psName: "Zed PS" })).status === 200);
check("same login twice → 409", (await add({ username: "zz.core", role: "store", label: "Store", name: "Zed", password: "Start#Pass2026" })).status === 409);
check("same Purchase System name twice → 409", (await add({ username: "zz.core2", role: "store", label: "Store", name: "Zed", password: "Start#Pass2026", psName: "Zed PS" })).status === 409);
const zed = client();
const z1 = await zed("POST", "/api/auth/login", { username: "zz.core", password: "Start#Pass2026" });
check("new user must change the starting password", z1.status === 200 && z1.json.user.mustChangePassword === true);
check("non-admin cannot use the admin API", (await zed("GET", "/api/admin/users")).status === 403);
check("role change", (await admin("PUT", "/api/admin/users/zz.core", { role: "qc", label: "QC" })).status === 200);
check("role change signs the person out", (await zed("GET", "/api/auth/me")).status === 401);
check("admin cannot disable themselves", (await admin("POST", "/api/admin/users/admin/active", { active: false })).status === 409);
check("disable", (await admin("POST", "/api/admin/users/zz.core/active", { active: false })).status === 200);
check("disabled login refused", (await zed("POST", "/api/auth/login", { username: "zz.core", password: "Start#Pass2026" })).status === 401);
check("new starting password", (await admin("POST", "/api/admin/users/zz.core/password", { password: "Other#Pass2026" })).status === 200);

console.log("admin: masters");
check("item added", (await admin("POST", "/api/admin/items", { code: "ZZC01", name: "ZZ CORE CAP", kind: "PM", ps_status: "Active" })).status === 200);
check("item without a name refused", (await admin("POST", "/api/admin/items", { code: "ZZC02", kind: "PM" })).status === 400);
check("item kind must be on the list", (await admin("POST", "/api/admin/items", { code: "ZZC02", name: "X", kind: "ZZ" })).status === 400);
check("same item code twice → 409", (await admin("POST", "/api/admin/items", { code: "ZZC01", name: "Other", kind: "PM" })).status === 409);
check("item edited (code kept)", (await admin("PUT", "/api/admin/items/ZZC01", { name: "ZZ CORE CAP 2", code: "HACK" })).status === 200);
const items = await admin("GET", "/api/admin/items?q=ZZ%20CORE");
check("search finds it under the same code", items.json?.rows.length === 1 && items.json.rows[0].code === "ZZC01" && items.json.rows[0].name === "ZZ CORE CAP 2");
check("LIKE wildcards are literal", (await admin("GET", "/api/admin/items?q=%25")).json?.rows.every((r) => JSON.stringify(r).includes("%")));
const v = await admin("POST", "/api/admin/vendors", { name: "ZZ Core Vendor", vendor_code: "V-ZZ1", phone_enc: "9999900000", bank_account_enc: "123456789" });
check("vendor added", v.status === 200 && v.json.key > 0);
const vrow = (await admin("GET", "/api/admin/vendors?q=V-ZZ1")).json?.rows[0];
check("phone and bank account readable on the admin page", vrow?.phone_enc === "9999900000" && vrow?.bank_account_enc === "123456789");
check("FG added", (await admin("POST", "/api/admin/fg", { name: "ZZ Core FG", brand: "ZZ" })).status === 200);
check("photo: a Drive link is stored as its file id",
  (await admin("PUT", "/api/admin/items/ZZC01", { ps_photo: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view?usp=drivesdk" })).status === 200 &&
  (await admin("GET", "/api/admin/items?q=ZZC01")).json?.rows[0]?.ps_photo === "1AbCdEfGhIjKlMnOpQrStUvWxYz");
check("photo: anything else is refused", (await admin("PUT", "/api/admin/items/ZZC01", { ps_photo: "my photo.jpg" })).status === 400);
check("unknown list → 404",(await admin("GET", "/api/admin/nope")).status === 404);

console.log("admin: item ↔ vendor");
check("vendor mapped with a rate", (await admin("PUT", "/api/admin/rates", { code: "ZZC01", supplierId: v.json.key, rate: "12.5", vendorItem: "Cap 28mm" })).status === 200);
check("rate must be a number", (await admin("PUT", "/api/admin/rates", { code: "ZZC01", supplierId: v.json.key, rate: "abc", vendorItem: "" })).status === 400);
const rates = (await admin("GET", "/api/admin/rates?code=ZZC01")).json?.rates ?? [];
check("rate stored and read back", rates.length === 1 && rates[0].rate === "12.5" && rates[0].vendorItem === "Cap 28mm");
check("mapping removed", (await admin("DELETE", `/api/admin/rates/${v.json.key}/ZZC01`)).status === 200);

console.log("import merge (server/src/sync.ts)");
{
  const mysql = (await import("mysql2/promise")).default;
  const { syncRows } = await import("../src/sync.ts");
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_ADMIN_USER,
    password: process.env.DB_ADMIN_PASSWORD ?? "", database: process.env.DB_NAME, dateStrings: true });
  await db.query("DROP TABLE IF EXISTS zz_sync");
  await db.query("CREATE TABLE zz_sync (id INT AUTO_INCREMENT PRIMARY KEY, k VARCHAR(20), n DECIMAL(10,2), d DATETIME NULL, t VARCHAR(20) NOT NULL DEFAULT '')");
  const rows = [{ k: "a", n: 1.5, d: new Date(2026, 0, 2, 3, 4, 5), t: "x" }, { k: "b", n: 2, d: null, t: "" }, { k: "b", n: 3, d: null, t: "" }];
  const r1 = await syncRows(db, "zz_sync", ["k"], rows, { overwrite: false });
  check("new rows added (same key twice = two rows)", r1.added === 3);
  const r2 = await syncRows(db, "zz_sync", ["k"], rows, { overwrite: false });
  check("same sheet again: nothing changes (dates, decimals, NULL = '')", r2.same === 3 && r2.added === 0 && !r2.conflicts.length, JSON.stringify(r2));
  const r3 = await syncRows(db, "zz_sync", ["k"], [{ ...rows[0], t: "y" }], { overwrite: false });
  check("a difference is a conflict when not overwriting; the rest are only in the table", r3.conflicts.length === 1 && r3.onlyInDb === 2);
  check("… and the table keeps its value", (await db.query("SELECT t FROM zz_sync WHERE k = 'a'"))[0][0].t === "x");
  const r4 = await syncRows(db, "zz_sync", ["k"], [{ ...rows[0], t: "y" }], { overwrite: true });
  check("overwrite updates it", r4.updated === 1 && (await db.query("SELECT t FROM zz_sync WHERE k = 'a'"))[0][0].t === "y");
  await db.query("DROP TABLE zz_sync");
  await db.end();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

// Checks the protections on "Clear all" / "Load demo data".
// Requires a DEVELOPMENT database with --dev-passwords and ALLOW_DEMO_RESET=true.
// Never point this at production — it really does clear and reload the registers.
// Usage: node server/test/reset.mjs [baseUrl]
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

const admin = client();
await admin("POST", "/api/auth/login", { username: "admin", password: "seven@admin" });
const docs = (s) => Object.entries(s).filter(([k]) => k !== "openings" && k !== "minLevels").reduce((n, [, v]) => n + v.length, 0);
const before = docs((await admin("GET", "/api/state")).json.state);
check("registers have data to protect", before > 0, String(before));

check("one-click clear (no body) refused", (await admin("POST", "/api/demo/clear")).status === 400);
check("wrong phrase refused", (await admin("POST", "/api/demo/clear", { password: "seven@admin", confirm: "clear all" })).status === 400);
const wrong = await admin("POST", "/api/demo/clear", { password: "guess", confirm: "CLEAR ALL" });
check("wrong password refused (403)", wrong.status === 403, JSON.stringify(wrong.json));
check("load phrase cannot clear", (await admin("POST", "/api/demo/clear", { password: "seven@admin", confirm: "LOAD DEMO" })).status === 400);
check("nothing deleted by refused attempts", docs((await admin("GET", "/api/state")).json.state) === before);

const store = client();
await store("POST", "/api/auth/login", { username: "store", password: "seven@store" });
check("non-admin refused even with right phrase", (await store("POST", "/api/demo/clear", { password: "seven@store", confirm: "CLEAR ALL" })).status === 403);

const ok = await admin("POST", "/api/demo/clear", { password: "seven@admin", confirm: "CLEAR ALL" });
check("correct password + phrase clears", ok.status === 200 && docs(ok.json.state) === 0, JSON.stringify(ok.json?.error));
check("snapshot id returned", Number.isInteger(ok.json?.snapshotId), String(ok.json?.snapshotId));
check("other users see it empty", docs((await store("GET", "/api/state")).json.state) === 0);

const load = await admin("POST", "/api/demo/load", { password: "seven@admin", confirm: "LOAD DEMO" });
check("load demo with password + phrase", load.status === 200 && docs(load.json.state) > 0);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`(restore the data from before this test with: npm run snapshot -- restore ${ok.json?.snapshotId})`);
process.exit(fail ? 1 : 0);

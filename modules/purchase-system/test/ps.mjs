// Purchase System (the old sheet + Apps Script, now on the database): the page's calls end to end, synthetic data only.
// Usage: node modules/purchase-system/test/ps.mjs [baseUrl]   (run by npm test against its own _test database)
import mysql from "mysql2/promise";

const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, x)));

function client() {
  let cookie = "";
  const http = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { "content-type": "application/json", "x-flow-request": "1", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) cookie = sc.split(";")[0];
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, json, res };
  };
  /** like google.script.run: resolves with the result, rejects with the server's message */
  http.call = async (fn, ...args) => {
    const r = await http("POST", "/api/ps/call/" + fn, { args });
    if (r.json && "result" in r.json) return r.json.result;
    throw new Error(r.json?.error ?? "HTTP " + r.status);
  };
  http.raw = async (path) => fetch(BASE + path, { headers: cookie ? { cookie } : {} });
  return http;
}
const refused = async (name, p, re) => {
  try {
    await p;
    check(name, false, "was accepted");
  } catch (e) {
    check(name, re.test(e.message), e.message);
  }
};

// ── synthetic master data (admin SQL) + Purchase System logins (made on the admin page API)
const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_ADMIN_USER,
  password: process.env.DB_ADMIN_PASSWORD ?? "", database: process.env.DB_NAME });
const admin = client();
await admin("POST", "/api/auth/login", { username: "admin", password: "seven@admin" });
const PW = "Test#Pass2026";
for (const [u, name, access, type] of [["ps.buyer", "Test Buyer", "STEP 1,STEP 2, STEP 3, STEP 4", "Other"], ["ps.tally", "Test Tally", "STEP 5", ""],
  ["ps.boss", "Boss (Director)", "ALL", ""], ["ps.chem", "Chem Buyer", "STEP 1,STEP 2, STEP 3, STEP 4", "Chemical"]]) {
  const made = await admin("POST", "/api/admin/users", { username: u, role: "purchase", label: "Purchase", name, password: PW, psName: name, psAccess: access, psTypes: type });
  if (made.status !== 200) throw new Error("admin users: " + JSON.stringify(made.json));
  await db.query("UPDATE users SET must_change_password = 0 WHERE username = ?", [u]);
}
const [f] = await db.query("INSERT INTO ps_files (id, kind, name, mime, size, sha256, bytes) VALUES ('F0000000000000000a1', 'photo', 'p', 'image/png', 4, REPEAT('0', 64), 'abcd')");
void f;
const item = async (code, name, itype, cat, uom, pack = "", photo = "F0000000000000000a1") =>
  db.query(`INSERT INTO components (code, name, type, kind, category, origin, ps_item_type, ps_uom, ps_pack_size, ps_status, ps_photo, ps_brand)
            VALUES (?, ?, '', ?, ?, 'INDIAN', ?, ?, ?, 'Active', ?, 'ZZ')`, [code, name, itype === "Raw Material" ? "RM" : "PM", cat, itype, uom, pack, photo]);
await item("ZZT01", "ZZ-10 MONO CARTON", "Packaging Material", "Test", "PCS");
await item("ZZT02", "ZZ-10 BOX 24 PCS", "Packaging Material", "Test", "PCS");
await item("ZZT03", "ZZ-11 CAP", "Packaging Material", "Test", "PCS");
await item("ZZT04", "ZZ TEST CHEM", "Raw Material", "Chemical", "KG", "25 kg bag");
const [v] = await db.query(`INSERT INTO suppliers (name, vendor_code, approved, from_tally, vm_status, email, gstin, payment_terms, address)
                            VALUES ('ZZ Test Vendor', 'V-TEST1', 1, 0, 'Active', 'vendor@example.com', '06AAAAA0000A1Z5', '30 days', 'Sonipat, Haryana')`);
const [v2] = await db.query("INSERT INTO suppliers (name, vendor_code, approved, from_tally, vm_status) VALUES ('ZZ Old Vendor', 'V-TEST2', 1, 0, 'Inactive')");
let rowNo = 90000;
for (const code of ["ZZT01", "ZZT02", "ZZT03", "ZZT04"]) {
  await db.query("INSERT INTO supplier_rates (supplier_id, component_code, rate_enc, ps_row) VALUES (?, ?, NULL, ?)", [v.insertId, code, rowNo++]);
}
await db.query("INSERT INTO supplier_rates (supplier_id, component_code, rate_enc, ps_row) VALUES (?, 'ZZT03', NULL, ?)", [v2.insertId, rowNo++]);
await db.query("INSERT INTO ps_settings (k, v) VALUES ('indent_passwords', '[]') ON DUPLICATE KEY UPDATE v = '[]'");

console.log("page");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../source/Index.html", import.meta.url), "utf8");
  const page = await (await fetch(BASE + "/ps")).text();
  const ind = await (await fetch(BASE + "/ps?page=indent")).text();
  // undo exactly what the server is allowed to do: the shim tag, the MODE value, the one declared patch
  const back = (h, mode) => h.replace('<script src="/gas/shim.js" data-module="ps"></script>', "")
    .replace(`const MODE = '${mode}';`, "const MODE = '<?= mode ?>';")
    .replace("const thumb = (id, sz) => /^F[0-9a-f]{18}$/.test(id) ? '/api/ps/file/' + id : 'https://drive.google.com/thumbnail?id='", "const thumb = (id, sz) => 'https://drive.google.com/thumbnail?id='");
  check("served page = the client's Index.html + shim + MODE + one declared patch, nothing else", back(page, "app") === src && back(ind, "indent") === src);
  check("shim served", /google\.script/.test(await (await fetch(BASE + "/gas/shim.js")).text()));
}

console.log("login");
const anon = client();
const boot = await anon.call("getLoginBoot");
check("login list from the Doer logins, with their steps", boot.users.some((u) => u.name === "Test Buyer" && u.role === "Step 1, 2, 3, 4") && boot.users.some((u) => u.name === "Boss (Director)" && u.role === "Admin"), JSON.stringify(boot.users));
await refused("wrong password", anon.call("login", "Test Buyer", "nope"), /Wrong name or password/);
await refused("no session → SESSION_EXPIRED (the page signs out on this text)", anon.call("getHome", "x"), /^SESSION_EXPIRED$/);
const buyer = client(), boss = client(), tally = client(), chem = client();
const tB = (await buyer.call("login", "Test Buyer", PW)).token;
const tBoss = (await boss.call("login", "Boss (Director)", PW)).token;
const tTally = (await tally.call("login", "Test Tally", PW)).token;
const tChem = (await chem.call("login", "Chem Buyer", PW)).token;
await refused("another user's token is not a session (a made-up one)", buyer.call("getHome", "S" + "x".repeat(43)), /^SESSION_EXPIRED$/);
check("login gives the page a token", typeof tB === "string" && tB.length > 10);
const app = await buyer.call("getAppBoot", tB);
check("boot: user, steps, GST list, items, vendors", app.user.name === "Test Buyer" && app.user.canPo === true && app.steps.length === 5 && app.gst.includes(18) &&
  app.items.some((i) => i.n === "ZZ-10 MONO CARTON" && i.set?.ok === 1 && i.set.capacity === 24) && app.vendors.includes("ZZ Test Vendor") && !app.vendors.includes("ZZ Old Vendor"), JSON.stringify(app.items.find((i) => i.n === "ZZ-10 MONO CARTON")));
await refused("unknown function", anon.call("dropEverything"), /Unknown function/);

console.log("indent (public form, no password set)");
const pub = await anon.call("getPublicBoot", "");
check("public form opens (no indent password)", !pub.needPass && pub.items.length >= 3);
const ind = await anon.call("submitIndent", "", { filledBy: "Test Buyer", remarks: "test", lines: [{ item: "ZZ-10 MONO CARTON", qty: "30", unit: "PCS", urgency: "Within 7 days", vendor: "ZZ Test Vendor", pack: "" }, { item: "ZZ-11 CAP", qty: "100", unit: "PCS", urgency: "Urgent (1-2 days)", vendor: "N/A", pack: "" }] });
check("one indent no. for the submission; dibbi adds its box (30 ÷ 24 → 2 boxes)", /^IND\d+$/.test(ind.requestId) && ind.lines === 3, JSON.stringify(ind));
await refused("unknown item refused", anon.call("submitIndent", "", { filledBy: "Test Buyer", lines: [{ item: "NOPE", qty: 1, unit: "PCS", urgency: "Within 7 days" }] }), /not in the list/);
await refused("chemical without vendor link on the form still needs a name from the list", anon.call("submitIndent", "", { filledBy: "Nobody", lines: [{ item: "ZZ-11 CAP", qty: 1, unit: "PCS", urgency: "Within 7 days" }] }), /Filled by/);
const open = (await buyer.call("getIndents", tB)).list.filter((x) => x.ind === ind.requestId);
const box = open.find((x) => x.it === "ZZ-10 BOX 24 PCS");
check("open indents show the 3 lines; box qty 2", open.length === 3 && box?.q === 2 && open.every((x) => x.stage === "INDENT – NO PO"), JSON.stringify(open));
check("repeat check finds the item", (await anon.call("checkRepeat", "ZZ-11 CAP")).some((x) => x.ind === ind.requestId));
const chemSees = (await chem.call("getIndents", tChem)).list.filter((x) => x.ind === ind.requestId);
check("a Chemical-only buyer does not get Other items", chemSees.length === 0);

console.log("PO");
const ids = open.filter((x) => x.it !== "ZZ-11 CAP").map((x) => x.id);
const maker = await buyer.call("getPoMakerData", tB, ids);
check("Make PO: lines from the indents, vendor suggested from the indent", maker.lines.length === 2 && maker.vendor === "ZZ Test Vendor" && /^26SEV\d+$/.test(maker.nextPo), JSON.stringify(maker.lines));
await refused("inactive vendor needs confirmation", buyer.call("createPo", tB, { vendor: "ZZ Old Vendor", poDate: "2026-12-05", edd: "2026-12-20", lines: [{ it: "ZZ-11 CAP", qty: 5, rate: 1, gst: 18, unit: "PCS" }] }), /^INACTIVE_VENDOR: /);
await refused("ECOMMERCE and other items on one PO refused", buyer.call("createPo", tB, { vendor: "ZZ Test Vendor", poDate: "2026-12-05", edd: "2026-12-20",
  lines: [{ it: "ECOMMERCE BAG", qty: 1, rate: 1, gst: 18 }, { it: "ZZ-11 CAP", qty: 1, rate: 1, gst: 18 }] }), /separate POs/);
// 2026-12-05 is a Saturday: Step 1 is planned on the next working day (Monday, Sunday skipped), 6 PM
const po = await buyer.call("createPo", tB, { vendor: "ZZ Test Vendor", poDate: "2026-12-05", edd: "2026-12-20", terms: "", remarks: "r",
  lines: maker.lines.map((l) => ({ lid: l.lid, ind: l.ind, it: l.it, sku: l.sku, hsn: "4819", qty: l.qty, unit: l.unit, rate: 10, gst: 18 })) });
check("PO created, lead time 15 days, PDF made (full link — the page may run on Google's site)", /^26SEV\d+$/.test(po.po) && po.lead === 15 && /^https?:\/\/[^/]+\/api\/ps\/file\/F[0-9a-f]{18}$/.test(po.pdf), JSON.stringify(po));
const [[pr]] = await db.query("SELECT COUNT(*) n, MAX(p.tax_type) t, SUM(pl.cgst) c, SUM(pl.sgst) s, SUM(pl.igst) i, SUM(pl.total) tot, MAX(p.approval) a FROM ps_po_lines pl JOIN ps_pos p ON p.po_no = pl.po_no WHERE pl.po_no = ?", [po.po]);
check("PO rows: same-state vendor → CGST + SGST; 18% on 320 = 57.60; total 377.60; PENDING", pr.n === 2 && pr.t === "CGST+SGST" && Number(pr.c) === 28.8 && Number(pr.s) === 28.8 &&
  Number(pr.i) === 0 && Number(pr.tot) === 377.6 && pr.a === "PENDING", JSON.stringify(pr));
const pdf = await anon.raw(new URL(po.pdf).pathname);
check("the PO PDF opens with its link (like the old Drive files)", pdf.status === 200 && (await pdf.arrayBuffer()).byteLength > 1000 && pdf.headers.get("content-type") === "application/pdf");
check("a made-up file id gets nothing", (await anon.raw("/api/ps/file/F" + "0".repeat(17) + "9")).status === 404);
await refused("Step 1 user cannot approve", buyer.call("approvePo", tB, po.po), /Only the Admin/);
await refused("mail before approval refused", buyer.call("getMailDraft", tB, po.po), /not approved yet/);
check("PO register: pending approval", (await buyer.call("getPoVisibility", tB)).list.find((x) => x.po === po.po)?.appr === "PENDING");
const ap = await boss.call("approvePo", tBoss, po.po);
check("Director approves; PDF made again", /approved/.test(ap.message) && ap.pdf !== po.pdf);
const draft = await buyer.call("getMailDraft", tB, po.po);
check("mail draft to the vendor email, director in CC", draft.to === "vendor@example.com" && /Purchase Order/.test(draft.subject));
await refused("sending needs SMTP set up (says so)", buyer.call("sendPoMail", tB, { po: po.po, to: "vendor@example.com", cc: "", subject: "s", message: "m" }), /Email is not set up/);

console.log("follow-up steps");
let tasks = (await buyer.call("getTasks", tB)).list.filter((t) => t.po === po.po);
const t1 = tasks.find((t) => t.s === 1);
check("Step 1 planned Monday 07-12-2026 18:00 (Saturday PO, Sunday skipped)", t1 && new Date(t1.pl).toString().startsWith("Mon Dec 07 2026 18:00"), t1 && new Date(t1.pl).toString());
await refused("Tally user cannot do Step 1", tally.call("updateTasks", tTally, { ids: [t1.id], step: 1, status: "DONE" }), /not assigned/);
await refused("Step 2 NOT RECEIVED needs a remark", buyer.call("updateTasks", tB, { ids: [t1.id], step: 2, status: "NOT RECEIVED" }), /remark is required/);
const lineIds = tasks.filter((t) => t.s === 1).map((t) => t.id);
const u1 = await buyer.call("updateTasks", tB, { ids: lineIds, step: 1, status: "DONE", remark: "sent on WhatsApp" });
check("Step 1 done on both lines", /^2 line\(s\) updated/.test(u1.message), u1.message);
tasks = (await buyer.call("getTasks", tB)).list.filter((t) => t.po === po.po);
check("Step 2 now open", tasks.some((t) => t.s === 2 && t.b !== "done"));
check("line stage: PO SENT – FOLLOW UP", (await buyer.call("getHome", tB)).stages["PO SENT – FOLLOW UP"] >= 2);

console.log("GRN receipt → stage; Tally step closes the line");
await db.query("INSERT INTO ps_grn (grn_id, gate_entry_id, po_no, po_line_code, po_item_name, po_qty, store_received_qty, decision, approved_qty, po_status) VALUES ('GRN-T1', 'GE-T1', ?, 'ZZT01', 'ZZ-10 MONO CARTON', '30', '30', 'Approve', '30', 'OPEN')", [po.po]);
const grn = (await buyer.call("getGrnList", tB)).list.filter((x) => x.po === po.po);
check("GRN list: carton RECEIVED (30 of 30) → done", grn.find((x) => x.it === "ZZ-10 MONO CARTON")?.b === "done" && grn.find((x) => x.it === "ZZ-10 MONO CARTON")?.got === 30, JSON.stringify(grn));
// the script's rule: a PO with one GRN line → that GRN counts for every item of the PO (box: 30 got vs 2 ordered → excess)
const boxRow = (await boss.call("getAnalytics", tBoss)).rows.find((x) => x.po === po.po && x.it === "ZZ-10 BOX 24 PCS");
check("one GRN line on the PO counts for every item (script rule): box → REVIEW - EXCESS QTY", boxRow?.rc === "REVIEW - EXCESS QTY", JSON.stringify(boxRow && boxRow.rc));
const t5 = (await tally.call("getTasks", tTally)).list.find((t) => t.po === po.po && t.s === 5 && t.it === "ZZ-10 MONO CARTON");
check("received → Tally task opens for Step 5", !!t5 && t5.b !== "done", JSON.stringify(t5));
await tally.call("updateTasks", tTally, { ids: [t5.id], step: 5, status: "DONE" });
const an = (await boss.call("getAnalytics", tBoss)).rows.find((x) => x.id === t5.id);
check("Tally done → line CLOSED (archived), still in the dashboard data", an?.stage === "CLOSED" && an.arch === 1, JSON.stringify(an && { stage: an.stage, arch: an.arch }));
const xml = await buyer.call("getTallyXml", tB, [po.po]);
check("Tally XML for the approved PO", xml.includes("<VOUCHERNUMBER>" + po.po + "</VOUCHERNUMBER>") && xml.includes("Seven Seas Beauty Products Pvt Ltd (HR)"));

console.log("cancel a PO → its indent is open again");
const ind2 = await anon.call("submitIndent", "", { filledBy: "Test Buyer", lines: [{ item: "ZZ-11 CAP", qty: "7", unit: "PCS", urgency: "Within 7 days", vendor: "N/A" }] });
const cap = (await buyer.call("getIndents", tB)).list.find((x) => x.ind === ind2.requestId);
const po2 = await buyer.call("createPo", tB, { vendor: "ZZ Test Vendor", poDate: "2026-12-07", edd: "2026-12-10", lines: [{ lid: cap.id, ind: cap.ind, it: cap.it, qty: 7, unit: "PCS", rate: 2, gst: 5 }] });
await refused("cancel needs a reason", buyer.call("cancelPo", tB, po2.po, ""), /reason/);
await buyer.call("cancelPo", tB, po2.po, "wrong rate");
const back = (await buyer.call("getIndents", tB)).list.find((x) => x.id === cap.id);
check("cancelled PO: the indent line is open again, no PO", back && back.po === "" && back.stage === "INDENT – NO PO", JSON.stringify(back));
check("cancelled PO leaves the register", !(await buyer.call("getPoVisibility", tB)).list.some((x) => x.po === po2.po));

console.log("users (Director only)");
await refused("a buyer cannot manage users", buyer.call("getUsersAdmin", tB), /Director/);
const ua = await boss.call("getUsersAdmin", tBoss);
check("Director sees the logins", ua.users.some((u) => u.name === "Test Tally" && u.active));
await boss.call("setUserActive", tBoss, "Test Tally", false);
await refused("a switched-off user is signed out", tally.call("getTasks", tTally), /SESSION_EXPIRED/);
await refused("a Director cannot be switched off", boss.call("setUserActive", tBoss, "Boss (Director)", false), /cannot be switched off/);
await refused("short password refused", boss.call("setUserPassword", tBoss, "Test Buyer", "short"), /8 to 64/);

await db.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

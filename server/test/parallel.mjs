// Simultaneous users: stale screens are refused, unrelated work runs in parallel,
// numbering stays gap-free, and screens receive only what changed.
// Requires a DEVELOPMENT database with --dev-passwords and the demo data loaded.
// Usage: node server/test/parallel.mjs [baseUrl]
import "dotenv/config";
import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

const BASE = process.argv[2] ?? "http://127.0.0.1:4000";
let pass = 0, fail = 0;
const check = (n, c, x = "") => (c ? (pass++, console.log("  ok  ", n)) : (fail++, console.log("  FAIL", n, x)));

/** A logged-in "screen": remembers the change number it last synced, like the browser does. */
async function screen(username) {
  let cookie = "";
  const call = async (method, path, body) => {
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
  await call("POST", "/api/auth/login", { username, password: `seven@${username}` });
  const s = { call, version: 0, state: null };
  s.sync = async () => {
    const r = await call("GET", "/api/state");
    s.version = r.json.version;
    s.state = r.json.state;
  };
  s.act = async (name, args, basis = s.version) => {
    const r = await call("POST", `/api/actions/${name}`, { args, basis });
    if (r.status === 200) s.version = r.json.version;
    return r;
  };
  await s.sync();
  return s;
}

const gate = await screen("gate");
const store = await screen("store");
const qc = await screen("qc");

const blankGate = (supplierName) => ({
  date: "", supplierName, productDesc: "parallel test", invoiceNo: "", invoiceDate: "", poNo: "", invoiceQty: null,
  transportName: "", lrNo: "", vehicleNo: "HR55-T-0001", timeIn: "00:00", timeOut: "", driverSign: false, remark: "", lines: [],
});

const newGrn = async (qty) => {
  const ge = await gate.act("addGateEntry", [blankGate("Shree Packwell")]);
  const geId = ge.json.changes.gateEntries.at(-1).id;
  await store.sync();
  const grn = await store.act("addGrnLine", [{
    gateEntryId: geId, gateLineNo: null, unit: "", componentCode: "PMS0002", componentName: "", type: "", brandName: "SEVEN SEAS", receivedDate: "",
    poNo: "", poQty: null, invoiceNo: "", supplierName: "", qtyPerBox: 100, totalBoxes: qty / 100, totalQty: qty, remarkStore: "", location: "Store — Floor 1",
  }]);
  return grn.json.changes.grnLines.at(-1).grnNo;
};

console.log("passed stages are locked: once a GRN is with QC, its quantity cannot change");
let qciId, grnNo;
{
  grnNo = await newGrn(3000);
  const early = await store.act("updateGrnQty", [grnNo, 2900]);
  check("before Send to QC the count can still be corrected", early.status === 200, JSON.stringify(early.json));
  const sent = await store.act("sendToQc", [grnNo, { batchNo: "LOT-9", mfgDate: "", expiryDate: "" }]);
  qciId = sent.json.changes.qcIntimations.find((q) => q.grnNo === grnNo).id;
  const late = await store.act("updateGrnQty", [grnNo, 2800]);
  check("after Send to QC the quantity is locked (409)", late.status === 409 && /locked/.test(late.json.error), JSON.stringify(late.json));
}

console.log("stale screen: two QC screens decide the same slip");
{
  const qc2 = await screen("qc"); // a second QC person, same moment
  await qc.sync();
  const hold = await qc.act("recordAr", [qciId, "HOLD", "re-test colour"]);
  check("QC 1 puts the slip on hold", hold.status === 200, JSON.stringify(hold.json));
  const stale = await qc2.act("recordAr", [qciId, "REJECTED", "looks off"]); // QC 2 still sees UNDER TEST
  check("QC 2's decision on the old screen is refused (409 STALE)", stale.status === 409 && stale.json.code === "STALE", JSON.stringify(stale.json));
  const changes = await qc2.call("GET", `/api/changes?since=${qc2.version}`);
  check("QC 2's screen catches up: the GRN now shows HOLD", changes.json.changes.grnLines.find((g) => g.grnNo === grnNo)?.qcStatus === "HOLD");
  qc2.version = changes.json.version;
  const again = await qc2.act("recordAr", [qciId, "HOLD", "hold again"]);
  check("a held item cannot be held a second time (409)", again.status === 409, JSON.stringify(again.json));
  const ok = await qc2.act("recordAr", [qciId, "APPROVED", "re-tested, fine"]);
  check("after seeing the hold, the re-test decision goes through", ok.status === 200, JSON.stringify(ok.json));
  check("the GRN (whose status is derived) arrives in the same change set as APPROVED",
    ok.json.changes.grnLines.find((g) => g.grnNo === grnNo)?.qcStatus === "APPROVED");
  const after = await qc2.act("recordAr", [qciId, "REJECTED", "changed my mind"]);
  check("a final QC decision cannot be overturned (409)", after.status === 409, JSON.stringify(after.json));
  await store.sync();
  const stick = await store.act("setBarcoded", [grnNo, true]);
  const unstick = await store.act("setBarcoded", [grnNo, false]);
  check("barcode can be recorded once and never un-recorded", stick.status === 200 && unstick.status === 409, `${stick.status}/${unstick.status}`);
}

console.log("screens receive only what changed");
{
  await store.sync(); // Store's screen is up to date …
  const before = store.version;
  const r = await gate.act("addGateEntry", [blankGate("Aplay Creation")]); // … then Gate files one entry
  const delta = await store.call("GET", `/api/changes?since=${before}`);
  const n = Object.entries(delta.json.changes).filter(([k]) => k !== "openings" && k !== "minLevels").reduce((a, [, v]) => a + v.length, 0);
  check("store's update after Gate's entry carries just that one document", n === 1 && delta.json.changes.gateEntries[0].id === r.json.changes.gateEntries.at(-1).id, `${n} documents`);
}

console.log("unrelated work runs in parallel; numbers stay unique and gap-free");
{
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => gate.act("addGateEntry", [blankGate(`Parallel Supplier ${i}`)], 0)));
  check("12 simultaneous gate entries all saved", rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
  await gate.sync();
  const mine = gate.state.gateEntries.filter((g) => g.supplierName.startsWith("Parallel Supplier")).map((g) => Number(g.id.slice(3))).sort((a, b) => a - b);
  check("12 distinct numbers with no gaps", mine.length === 12 && mine.every((n, i) => i === 0 || n === mine[i - 1] + 1), mine.join(","));
  console.log(`        (12 parallel saves in ${Date.now() - t0} ms)`);
}

console.log("a long action on one document does not block work on another");
{
  const a = { grnNo: await newGrn(500), totalQty: 500 };
  const b = { grnNo: await newGrn(600), totalQty: 600 };
  if (!a || !b) {
    check("two quarantined GRNs available", false);
  } else {
    // Hold GRN a's lock from outside, as if another action were busy on it.
    const db = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER,
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });
    const name = `${process.env.DB_NAME.slice(0, 20)}:${createHash("sha1").update(`doc:grnLines:${a.grnNo}`).digest("hex").slice(0, 32)}`;
    await db.query("SELECT GET_LOCK(?, 5)", [name]);
    const t1 = Date.now();
    const other = await store.act("updateGrnQty", [b.grnNo, b.totalQty], 1e12);
    check(`GRN ${b.grnNo} saved at once while ${a.grnNo} is busy`, other.status === 200 && Date.now() - t1 < 2000, `${Date.now() - t1} ms`);
    const t2 = Date.now();
    const waiting = store.act("updateGrnQty", [a.grnNo, a.totalQty], 1e12);
    setTimeout(() => db.query("DO RELEASE_LOCK(?)", [name]), 1500);
    const same = await waiting;
    check(`GRN ${a.grnNo} waited for the busy action, then saved`, same.status === 200 && Date.now() - t2 >= 1400, `${Date.now() - t2} ms`);
    await db.end();
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

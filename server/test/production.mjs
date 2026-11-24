// Production plans: one per date, saved whole, read back; only Packing/Admin save.
// Usage: node server/test/production.mjs [baseUrl]
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

const packing = await login("packing");
const store = await login("store");
const P = "BL-686 Blush blusher powder";
const DATE = "2026-11-05";

let r = await packing("GET", `/api/production-plans/${DATE}`);
check("no plan yet → null", r.status === 200 && r.json.plan === null, JSON.stringify(r.json));

r = await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 1200 }] });
check("packing saves a plan", r.status === 200, JSON.stringify(r.json));
r = await packing("GET", `/api/production-plans/${DATE}`);
check("plan reads back", r.json.plan?.lines.length === 1 && r.json.plan.lines[0].targetQty === 1200 && r.json.plan.savedBy === "packing", JSON.stringify(r.json));

r = await packing("POST", `/api/production-plans/${DATE}`, {
  lines: [{ productName: P, productType: "Blush", targetQty: 500 }, { productName: P, productType: "", targetQty: 100 }],
});
r = await packing("GET", `/api/production-plans/${DATE}`);
check("re-save replaces the lines", r.json.plan?.lines.length === 2 && r.json.plan.lines[0].targetQty === 500 && r.json.plan.lines[0].productType === "Blush", JSON.stringify(r.json));

check("unknown product refused", (await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: "Nope", productType: "", targetQty: 1 }] })).status === 400);
check("zero qty refused", (await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 0 }] })).status === 400);
check("empty plan refused", (await packing("POST", `/api/production-plans/${DATE}`, { lines: [] })).status === 400);
r = await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 9_000_000 }] });
check("plan with short material refused", r.status === 409 && /Material is short: .+ short by .+remove the item or decrease/.test(r.json.error), JSON.stringify(r.json));
check("bad date refused", (await packing("GET", "/api/production-plans/2026-02-30")).status === 400);
check("store cannot save", (await store("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 1 }] })).status === 403);
const gate = await login("gate");
check("gate cannot read plans", (await gate("GET", `/api/production-plans/${DATE}`)).status === 403);
r = await packing("GET", `/api/production-plans/${DATE}`);
check("refused saves changed nothing", r.json.plan?.lines.length === 2, JSON.stringify(r.json));

// Requisition BOM list: the saved plan frozen under a running BOM number
r = await packing("POST", "/api/production-boms", { planDate: DATE });
const today = new Date().toLocaleDateString("en-CA").replaceAll("-", "");
check("BOM list made from the plan", r.status === 200 && new RegExp(`^BOM-${today}-\\d{4}$`).test(r.json.doc?.bomNo ?? ""), JSON.stringify(r.json));
const first = r.json.doc;
check("its products are the plan's", first?.products.length === 2 && first.products[0].qty === 500);
check("PM requirement = BOM × qty, summed", first?.materials.length > 0 && first.materials.every((m) => m.required > 0 && m.skus.length === 1), JSON.stringify(first?.materials?.[0]));
r = await packing("POST", "/api/production-boms", { planDate: DATE });
check("plan unchanged → same BOM number again", r.json.doc?.bomNo === first?.bomNo && r.json.doc.reused === true, r.json.doc?.bomNo);
check("…with the same requirement", JSON.stringify(r.json.doc?.materials) === JSON.stringify(first?.materials), JSON.stringify(r.json.doc?.materials?.[0]));
await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 700 }] });
r = await packing("POST", "/api/production-boms", { planDate: DATE });
check("plan edited → next BOM number (+1)", Number(r.json.doc?.bomNo.slice(-4)) === Number(first?.bomNo.slice(-4)) + 1 && r.json.doc.products[0].qty === 700, r.json.doc?.bomNo);
check("no plan → refused", (await packing("POST", "/api/production-boms", { planDate: "2026-01-02" })).status === 409);
check("store cannot make a BOM list", (await store("POST", "/api/production-boms", { planDate: DATE })).status === 403);

// BOM issue slip: Store issues against the latest BOM list of a plan, once
const latest = r.json.doc;
let list = (await store("GET", "/api/production-boms")).json?.boms ?? [];
check("issue list shows the latest BOM of the plan only", list.some((b) => b.bomNo === latest.bomNo) && !list.some((b) => b.bomNo === first.bomNo), JSON.stringify(list));
// what is in stock, at most the requirement (the demo stock may be short)
const give = (m) => Math.max(1, Math.min(m.required, m.present));
const slip = (qty) => ({ filledBy: "Ramesh", lines: latest.materials.map((m) => ({ componentCode: m.code, issuedQty: qty ?? give(m), remark: "" })) });
check("demo has stock to issue", latest.materials.every((m) => m.present >= 1), JSON.stringify(latest.materials));
check("more than the stock refused", (await store("POST", `/api/production-boms/${latest.bomNo}/issue`, { ...slip(), lines: latest.materials.map((m) => ({ componentCode: m.code, issuedQty: m.present + 1, remark: "" })) })).status === 409);
check("packing cannot issue", (await packing("POST", `/api/production-boms/${latest.bomNo}/issue`, slip())).status === 403);
check("superseded BOM refused", (await store("POST", `/api/production-boms/${first.bomNo}/issue`, { ...slip(), lines: first.materials.map((m) => ({ componentCode: m.code, issuedQty: 1, remark: "" })) })).status === 409);
check("missing filled-by refused", (await store("POST", `/api/production-boms/${latest.bomNo}/issue`, { ...slip(), filledBy: " " })).status === 400);
check("negative qty refused", (await store("POST", `/api/production-boms/${latest.bomNo}/issue`, slip(-1))).status === 400);
check("items not matching the BOM refused", (await store("POST", `/api/production-boms/${latest.bomNo}/issue`, { ...slip(), lines: slip().lines.map((l, i) => (i ? l : { ...l, componentCode: "PMS9999" })) })).status === 409);
r = await store("POST", `/api/production-boms/${latest.bomNo}/issue`, slip());
check("store submits the issue slip", r.status === 200, JSON.stringify(r.json));
check("issued only once", (await store("POST", `/api/production-boms/${latest.bomNo}/issue`, slip())).status === 409);
list = (await store("GET", "/api/production-boms")).json?.boms ?? [];
check("issued BOM leaves the list", !list.some((b) => b.bomNo === latest.bomNo));
// the issue takes PM out of stock: a fresh BOM list of the plan sees less present
await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 700 }] });
r = await packing("POST", "/api/production-boms", { planDate: DATE });
check("issued qty taken out of PM stock", r.json.doc?.materials.every((m) => {
  const before = latest.materials.find((x) => x.code === m.code);
  return m.present === Math.max(0, before.present - give(before));
}), JSON.stringify(r.json.doc?.materials?.map((m) => [m.code, m.present])));
const st = (await store("GET", "/api/state")).json.state;
check("store's state carries the issue slip", st.bomIssues?.some((b) => b.bomNo === latest.bomNo && b.filledBy === "Ramesh"), JSON.stringify(st.bomIssues));
check("gate's state does not", ((await gate("GET", "/api/state")).json.state.bomIssues ?? []).length === 0);


// Soft reservation: open BOM lists hold stock, earlier production date first (worked out, never stored)
const { tsImport } = await import("tsx/esm/api");
const L = await tsImport("../../src/flow/logic.ts", import.meta.url);
const bom = (bomNo, planDate, createdAt, required) => ({ bomNo, planDate, createdAt, lines: [{ code: "X", required }] });
const stock100 = new Map([["X", 100]]);
let q = L.reservePm([bom("B1", "2026-11-01", "a", 102), bom("B2", "2026-11-01", "b", 102)], stock100);
check("100 in stock, two lists of 102: first reserves 100 (short 2), second short 102",
  q.get("B1").get("X").reserved === 100 && q.get("B1").get("X").short === 2 && q.get("B2").get("X").reserved === 0 && q.get("B2").get("X").short === 102);
q = L.reservePm([bom("B2", "2026-11-01", "b", 102)], stock100);
check("first cancelled → second reserves 100", q.get("B2").get("X").reserved === 100);
q = L.reservePm([bom("LATE", "2026-11-09", "a", 80), bom("EARLY", "2026-11-03", "z", 80)], stock100);
check("earlier production date first, whatever was generated first", q.get("EARLY").get("X").reserved === 80 && q.get("LATE").get("X").reserved === 20);

const current = r.json.doc; // the open BOM list of DATE (2026-11-05)
const EARLY = "2026-11-04";
await packing("POST", `/api/production-plans/${EARLY}`, { lines: [{ productName: P, productType: "", targetQty: 300 }] });
r = await packing("POST", "/api/production-boms", { planDate: EARLY });
const early = r.json.doc;
check("an earlier plan is ahead of a later open list: sees all the stock", early?.materials.every((m) => m.present === current.materials.find((x) => x.code === m.code).present), JSON.stringify(early?.materials));
await packing("POST", `/api/production-plans/${DATE}`, { lines: [{ productName: P, productType: "", targetQty: 700 }] });
r = await packing("POST", "/api/production-boms", { planDate: DATE });
check("the later plan's new list sees stock less what the earlier list holds", r.json.doc?.materials.every((m) => {
  const e = early.materials.find((x) => x.code === m.code);
  return m.present === Math.max(0, e.present - e.required);
}), JSON.stringify(r.json.doc?.materials?.map((m) => [m.code, m.present])));
let open = (await store("GET", "/api/production-reservations")).json?.open ?? [];
check("reservations list the open BOM lists", open.some((b) => b.bomNo === early.bomNo) && open.some((b) => b.bomNo === r.json.doc.bomNo) && !open.some((b) => b.bomNo === current.bomNo), JSON.stringify(open.map((b) => b.bomNo)));
check("gate cannot read reservations", (await gate("GET", "/api/production-reservations")).status === 403);

check("store cannot cancel a BOM list", (await store("POST", `/api/production-boms/${early.bomNo}/cancel`, { reason: "x" })).status === 403);
check("cancel needs a reason", (await packing("POST", `/api/production-boms/${early.bomNo}/cancel`, { reason: " " })).status === 400);
check("an issued list cannot be cancelled", (await packing("POST", `/api/production-boms/${latest.bomNo}/cancel`, { reason: "x" })).status === 409);
r = await packing("POST", `/api/production-boms/${early.bomNo}/cancel`, { reason: "line down" });
check("packing cancels an open BOM list", r.status === 200, JSON.stringify(r.json));
check("cancelled once", (await packing("POST", `/api/production-boms/${early.bomNo}/cancel`, { reason: "x" })).status === 409);
open = (await store("GET", "/api/production-reservations")).json?.open ?? [];
check("cancelled list holds nothing", !open.some((b) => b.bomNo === early.bomNo));
check("cancelled list leaves the issue list", !((await store("GET", "/api/production-boms")).json?.boms ?? []).some((b) => b.bomNo === early.bomNo));
check("cancelled list cannot be issued", (await store("POST", `/api/production-boms/${early.bomNo}/issue`, { filledBy: "R", lines: early.materials.map((m) => ({ componentCode: m.code, issuedQty: 0, remark: "" })) })).status === 409);
r = await packing("POST", "/api/production-boms", { planDate: EARLY });
check("generating again after a cancel gives a new number", r.json.doc?.bomNo !== early.bomNo && r.json.doc?.reused === false, r.json.doc?.bomNo);

// Supervisor BOM verify: issued lists of a date, received per item (≤ issued), each verified once
const issuedOn = new Date().toLocaleDateString("en-CA");
r = await packing("GET", `/api/production-verifications/${issuedOn}`);
const vslip = r.json?.slips?.find((x) => x.bomNo === latest.bomNo);
check("today's issued BOM list is listed for verification", vslip && !vslip.verifiedBy && vslip.filledBy === "Ramesh" && vslip.lines.every((l) => l.received === null), JSON.stringify(r.json));
check("gate cannot read verifications", (await gate("GET", `/api/production-verifications/${issuedOn}`)).status === 403);
const recv = (d = 0) => vslip.lines.map((l) => Math.max(0, l.issued - d));
check("store cannot verify", (await store("POST", "/api/production-verifications", { verifiedBy: "S", boms: [{ bomNo: latest.bomNo, received: recv() }] })).status === 403);
check("received above issued refused", (await packing("POST", "/api/production-verifications", { verifiedBy: "S", boms: [{ bomNo: latest.bomNo, received: vslip.lines.map((l) => l.issued + 1) }] })).status === 409);
check("unissued BOM refused", (await packing("POST", "/api/production-verifications", { verifiedBy: "S", boms: [{ bomNo: early.bomNo, received: [0] }] })).status === 409);
check("missing verified-by refused", (await packing("POST", "/api/production-verifications", { verifiedBy: "", boms: [{ bomNo: latest.bomNo, received: recv() }] })).status === 400);
r = await packing("POST", "/api/production-verifications", { verifiedBy: "Suresh", boms: [{ bomNo: latest.bomNo, received: recv(1) }] });
check("supervisor verifies", r.status === 200, JSON.stringify(r.json));
check("verified once", (await packing("POST", "/api/production-verifications", { verifiedBy: "S", boms: [{ bomNo: latest.bomNo, received: recv() }] })).status === 409);
const after = (await packing("GET", `/api/production-verifications/${issuedOn}`)).json.slips.find((x) => x.bomNo === latest.bomNo);
check("verification reads back (received, lost = issued − received)", after.verifiedBy === "Suresh" && after.lines.every((l) => l.received === Math.max(0, l.issued - 1)), JSON.stringify(after));

// Production report: starts from the plan, saved as a draft, final submit locks the date
const RD = DATE; // the plan above is for this date
r = await packing("GET", `/api/production-reports/${RD}`);
check("new report: no saved report, the day's plan offered", r.json?.report === null && r.json.plan.length === 1 && r.json.plan[0].targetQty === 700, JSON.stringify(r.json));
const row = (o = {}) => ({
  floor: "1st", line: "2nd", manpower: 6, leader: "MEENA", supervisor: "Kamal", productName: P, productType: "", stage: "Packing", targetQty: 700, slot: "1st",
  qtyFirst: 300, qtySecond: 200, qtyEvening: null, sfgQty: null, downtimeMin: 20, reason: "box late", ...o,
});
check("store cannot save a report", (await store("POST", `/api/production-reports/${RD}`, { final: false, lines: [row()] })).status === 403);
check("unknown stage refused", (await packing("POST", `/api/production-reports/${RD}`, { final: false, lines: [row({ stage: "Dancing" })] })).status === 400);
check("unknown product refused", (await packing("POST", `/api/production-reports/${RD}`, { final: false, lines: [row({ productName: "Nope" })] })).status === 400);
check("final without supervisor refused", (await packing("POST", `/api/production-reports/${RD}`, { final: true, lines: [row({ supervisor: "" })] })).status === 400);
r = await packing("POST", `/api/production-reports/${RD}`, { final: false, lines: [row(), row({ line: "3rd", qtyFirst: 100 })] });
check("draft saved", r.status === 200, JSON.stringify(r.json));
r = await packing("GET", `/api/production-reports/${RD}`);
check("draft reads back", r.json.report?.lines.length === 2 && r.json.report.lines[1].line === "3rd" && r.json.report.lines[0].qtyEvening === null && !r.json.report.finalAt && r.json.report.lines[1].supervisor === "Kamal", JSON.stringify(r.json.report));
r = await packing("POST", `/api/production-reports/${RD}`, { final: true, lines: [row()] });
check("final submit", r.status === 200, JSON.stringify(r.json));
r = await packing("GET", `/api/production-reports/${RD}`);
check("final report is marked and replaced the draft rows", Boolean(r.json.report?.finalAt) && r.json.report.finalBy === "packing" && r.json.report.lines.length === 1);
check("locked after final submit", (await packing("POST", `/api/production-reports/${RD}`, { final: false, lines: [row()] })).status === 409);
const T = L.reportRowTotals({ qtyFirst: 300, qtySecond: 200, qtyEvening: null, targetQty: 700 });
check("achievement = total FG ÷ target (500 / 700 = 71.4%)", T.total === 500 && T.achievement === 71.4, JSON.stringify(T));
check("no target → no achievement", L.reportRowTotals({ qtyFirst: 5, qtySecond: null, qtyEvening: null, targetQty: null }).achievement === null);

// the Excel download is a real .xlsx: a ZIP whose entries carry correct CRCs
const X = await tsImport("../../src/flow/xlsx.ts", import.meta.url);
const zlib = await import("node:zlib");
const bytes = X.xlsxBytes("Production Report", [["A", "B"], [1, "x & <y>"]]);
const dv = new DataView(bytes.buffer, bytes.byteOffset);
let at = 0, entries = 0, crcOk = true;
while (dv.getUint32(at, true) === 0x04034b50) {
  const size = dv.getUint32(at + 18, true), nameLen = dv.getUint16(at + 26, true);
  const data = bytes.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
  if (zlib.crc32(data) !== dv.getUint32(at + 14, true)) crcOk = false;
  entries++;
  at += 30 + nameLen + size;
}
check("xlsx: 6 parts with correct CRCs, then the central directory", entries === 6 && crcOk && dv.getUint32(at, true) === 0x02014b50, `${entries} ${crcOk}`);
check("xlsx: text is escaped", new TextDecoder().decode(bytes).includes("x &amp; &lt;y&gt;"));

// bulk production plan: items from the stored list or typed; a typed name joins the list
const BD = "2026-11-07";
r = await packing("GET", `/api/bulk-plans/${BD}`);
check("bulk: starter item list, no plan yet", r.json.items?.some((x) => x.name === "LS-143 Gel Lipstick Mix") && r.json.plan === null, JSON.stringify(r.json));
r = await packing("POST", `/api/bulk-plans/${BD}`, { lines: [{ itemName: "LS-143 Gel Lipstick Mix", unit: "KG", qty: 25.5 }, { itemName: "ZZ-1 Test Mix", unit: "L", qty: 10 }] });
check("bulk: plan saved", r.status === 200, JSON.stringify(r.json));
r = await packing("GET", `/api/bulk-plans/${BD}`);
check("bulk: reads back, typed name joined the list", r.json.plan?.lines.length === 2 && r.json.plan.lines[0].qty === 25.5 && r.json.items.some((x) => x.name === "ZZ-1 Test Mix" && x.unit === "L"), JSON.stringify(r.json));
await packing("POST", `/api/bulk-plans/${BD}`, { lines: [{ itemName: "zz-1 test mix", unit: "L", qty: 4 }] });
r = await packing("GET", `/api/bulk-plans/${BD}`);
check("bulk: re-save replaces lines; name matched ignoring case", r.json.plan?.lines.length === 1 && r.json.plan.lines[0].itemName === "ZZ-1 Test Mix" && r.json.items.filter((x) => x.name.toLowerCase() === "zz-1 test mix").length === 1, JSON.stringify(r.json));
check("bulk: zero qty refused", (await packing("POST", `/api/bulk-plans/${BD}`, { lines: [{ itemName: "X", unit: "KG", qty: 0 }] })).status === 400);
check("bulk: store cannot save", (await store("POST", `/api/bulk-plans/${BD}`, { lines: [{ itemName: "X", unit: "KG", qty: 1 }] })).status === 403);
check("bulk: gate cannot read", (await gate("GET", `/api/bulk-plans/${BD}`)).status === 403);
check("bulk: unit must match the item's unit", (await packing("POST", `/api/bulk-plans/${BD}`, { lines: [{ itemName: "ZZ-1 Test Mix", unit: "KG", qty: 4 }] })).status === 409);

// bulk manufacturing report: starts from the bulk plan, draft, final submit locks the date
r = await packing("GET", `/api/bulk-reports/${BD}`);
check("bulk report: new, plan offered with its unit", r.json?.report === null && r.json.plan.length === 1 && r.json.plan[0].unit === "L" && r.json.plan[0].qty === 4, JSON.stringify(r.json));
const brow = (o = {}) => ({ itemName: "ZZ-1 Test Mix", unit: "L", shade: "Red", orderDate: "2026-11-10", responsible: "Atul Sharma", batchSize: 4, actualQty: 3.5, mfgBy: "Ravi", remark: "", ...o });
check("bulk report: store cannot save", (await store("POST", `/api/bulk-reports/${BD}`, { final: false, lines: [brow()] })).status === 403);
check("bulk report: wrong unit refused", (await packing("POST", `/api/bulk-reports/${BD}`, { final: false, lines: [brow({ unit: "KG" })] })).status === 409);
check("bulk report: final without actual qty refused", (await packing("POST", `/api/bulk-reports/${BD}`, { final: true, lines: [brow({ actualQty: null })] })).status === 400);
r = await packing("POST", `/api/bulk-reports/${BD}`, { final: false, lines: [brow({ actualQty: null }), brow({ itemName: "LS-143 Gel Lipstick Mix", unit: "KG", orderDate: "" })] });
check("bulk report: draft saved", r.status === 200, JSON.stringify(r.json));
r = await packing("GET", `/api/bulk-reports/${BD}`);
check("bulk report: draft reads back", r.json.report?.lines.length === 2 && r.json.report.lines[0].orderDate === "10-11-2026" && r.json.report.lines[0].actualQty === null && r.json.report.lines[1].orderDate === "" && !r.json.report.finalAt, JSON.stringify(r.json.report));
r = await packing("POST", `/api/bulk-reports/${BD}`, { final: true, lines: [brow()] });
check("bulk report: final submit", r.status === 200, JSON.stringify(r.json));
r = await packing("GET", `/api/bulk-reports/${BD}`);
check("bulk report: final marked, rows replaced", Boolean(r.json.report?.finalAt) && r.json.report.lines.length === 1 && r.json.report.lines[0].actualQty === 3.5);
check("bulk report: locked after final submit", (await packing("POST", `/api/bulk-reports/${BD}`, { final: false, lines: [brow()] })).status === 409);

// bulk quality testing: the final row waits; QC accepts (part needs a reason), holds, rejects; accepted is bulk stock
const qc = await login("qc");
const qt = async () => (await qc("GET", "/api/bulk-qt")).json;
let Q = await qt();
check("qt: final row waits under test", Q.rows?.some((x) => x.isoDate === BD && x.rowNo === 1 && x.status === "UNDER_TEST" && x.actualQty === 3.5), JSON.stringify(Q));
const dec = (who, body) => who("POST", `/api/bulk-qt/${BD}/1`, { acceptedQty: null, remarks: "", ...body });
check("qt: packing cannot decide", (await dec(packing, { status: "ACCEPTED" })).status === 403);
check("qt: gate cannot read", (await gate("GET", "/api/bulk-qt")).status === 403);
check("qt: hold", (await dec(qc, { status: "HOLD" })).status === 200);
check("qt: hold twice refused", (await dec(qc, { status: "HOLD" })).status === 409);
check("qt: more than made refused", (await dec(qc, { status: "ACCEPTED", acceptedQty: 4 })).status === 409);
check("qt: part accept needs a reason", (await dec(qc, { status: "ACCEPTED", acceptedQty: 3 })).status === 409);
check("qt: part accept", (await dec(qc, { status: "ACCEPTED", acceptedQty: 3, remarks: "0.5 L off colour" })).status === 200);
check("qt: decided once", (await dec(qc, { status: "REJECTED" })).status === 409);
Q = await qt();
const BS = (await store("GET", "/api/bulk-stock")).json.items?.find((s) => s.itemName === "ZZ-1 Test Mix");
check("qt: accepted qty is bulk stock (store sees it), rest rejected", BS?.stock === 3 && BS.rejected === 0.5 && BS.unit === "L", JSON.stringify(BS));
check("qt: decision listed", Q.rows.find((x) => x.isoDate === BD && x.rowNo === 1).status === "ACCEPTED");
check("qt: a draft row cannot be decided", (await qc("POST", `/api/bulk-qt/${BD}/2`, { status: "REJECTED", acceptedQty: null, remarks: "" })).status === 409);


// FG transfer note: a draft per date; final submit makes a numbered note and clears the draft
const FD = "2026-11-08";
const fgRow = (o = {}) => {
  const r = { productName: P, productType: "", qtyInBox: 72, totalBox: 32, palletNo: "1", supervisor: "Narender Rathi", ...o };
  return { ...r, totalQty: "totalQty" in o ? o.totalQty : r.qtyInBox && r.totalBox ? r.qtyInBox * r.totalBox : null };
};
r = await packing("GET", `/api/fg-transfer/${FD}`);
check("fg note: nothing yet", r.json.draft === null && r.json.notes?.length === 0, JSON.stringify(r.json));
r = await packing("POST", `/api/fg-transfer/${FD}`, { final: false, lines: [fgRow({ qtyInBox: null, supervisor: "" })] });
check("fg note: incomplete draft saves", r.status === 200, JSON.stringify(r.json));
check("fg note: final without total qty refused", (await packing("POST", `/api/fg-transfer/${FD}`, { final: true, lines: [fgRow({ totalQty: null })] })).status === 400);
await packing("POST", `/api/fg-transfer/${FD}`, { final: false, lines: [fgRow({ totalQty: 2300 })] });
check("fg note: typed total qty kept on the draft", (await packing("GET", `/api/fg-transfer/${FD}`)).json.draft?.lines[0].totalQty === 2300);
check("fg note: incomplete final refused", (await packing("POST", `/api/fg-transfer/${FD}`, { final: true, lines: [fgRow({ supervisor: "" })] })).status === 400);
r = await packing("POST", `/api/fg-transfer/${FD}`, { final: true, lines: [fgRow(), fgRow({ totalBox: 34 })] });
check("fg note: final gives FTN-yyyymmdd-nnnn", r.status === 200 && /^FTN-20261108-\d{4}$/.test(r.json.noteNo ?? ""), JSON.stringify(r.json));
const ftn = r.json.noteNo;
r = await packing("GET", `/api/fg-transfer/${FD}`);
check("fg note: listed with its rows, draft cleared", r.json.draft === null && r.json.notes.length === 1 && r.json.notes[0].noteNo === ftn && r.json.notes[0].lines[1].totalBox === 34, JSON.stringify(r.json));
r = await packing("POST", `/api/fg-transfer/${FD}`, { final: true, lines: [fgRow()] });
check("fg note: second note same date → next number", Number(r.json.noteNo?.slice(-4)) === Number(ftn.slice(-4)) + 1, r.json.noteNo);
check("fg note: unknown product refused", (await packing("POST", `/api/fg-transfer/${FD}`, { final: false, lines: [fgRow({ productName: "Nope" })] })).status === 400);
check("fg note: store cannot save", (await store("POST", `/api/fg-transfer/${FD}`, { final: false, lines: [fgRow()] })).status === 403);

// FG transfer verify: the warehouse picks the note, counts each row, marks it received (then locked)
const fgwh = await login("fgwh");
r = await fgwh("GET", "/api/fg-transfer-notes");
check("fg verify: note listed pending with its total", r.json.notes?.some((n) => n.noteNo === ftn && n.status === "PENDING" && n.totalQty === 72 * 32 + 72 * 34 && n.rows === 2), JSON.stringify(r.json));
r = await fgwh("GET", `/api/fg-transfer-notes/${ftn}`);
check("fg verify: note loads its rows", r.json.lines?.length === 2 && r.json.lines[1].totalBox === 34 && r.json.lines[0].verifiedQty === null, JSON.stringify(r.json));
const fgRecv = (who, lines, by = "Mohan") => who("POST", `/api/fg-transfer-notes/${ftn}/receive`, { verifiedBy: by, lines });
check("fg verify: packing cannot receive", (await fgRecv(packing, [{ verifiedQty: 1, remark: "" }, { verifiedQty: 1, remark: "" }])).status === 403);
check("fg verify: who verified needed", (await fgRecv(fgwh, [{ verifiedQty: 1, remark: "" }, { verifiedQty: 1, remark: "" }], " ")).status === 400);
check("fg verify: every row needed", (await fgRecv(fgwh, [{ verifiedQty: 1, remark: "" }])).status === 409);
r = await fgRecv(fgwh, [{ verifiedQty: 2304, remark: "" }, { verifiedQty: 2440, remark: "8 short" }]);
check("fg verify: received", r.status === 200, JSON.stringify(r.json));
check("fg verify: received once", (await fgRecv(fgwh, [{ verifiedQty: 1, remark: "" }, { verifiedQty: 1, remark: "" }])).status === 409);
r = await fgwh("GET", `/api/fg-transfer-notes/${ftn}`);
check("fg verify: status RECEIVED with the counts", r.json.status === "RECEIVED" && r.json.verifiedBy === "Mohan" && r.json.lines[1].verifiedQty === 2440 && r.json.lines[1].remark === "8 short", JSON.stringify(r.json));
check("fg verify: gate cannot read", (await gate("GET", "/api/fg-transfer-notes")).status === 403);
r = await fgwh("GET", "/api/pending-counts");
check("pending counts: numbers for the strip (the received note no longer counts)", r.status === 200 && typeof r.json.notesToReceive === "number" && typeof r.json.mrnToVerify === "number" && typeof r.json.bulkToTest === "number", JSON.stringify(r.json));

// MRN against a BOM list: supervisor returns PM, Store counts it, approval puts it back into stock
const rBeforeMrn = r; // the checks after this block read r
r = await packing("GET", `/api/bom-returns/source/${latest.bomNo}`);
const src = r.json?.lines ?? [];
const m0 = src[0];
check("mrn: source lists the issued items; can come back = verified (else issued) qty", r.status === 200 && src.length === latest.materials.length && m0?.max === (m0?.received ?? m0?.issued), JSON.stringify(src[0]));
check("mrn: a BOM never issued has no source", (await packing("GET", `/api/bom-returns/source/${first.bomNo}`)).status === 404);
const mrnBody = (qty, code = m0.code) => ({ bomNo: latest.bomNo, returnedBy: "Atul Sharma", remarks: "", lines: [{ code, qty, remark: "" }] });
check("mrn: store cannot raise", (await store("POST", "/api/bom-returns", mrnBody(1))).status === 403);
check("mrn: more than issued refused", (await packing("POST", "/api/bom-returns", mrnBody(m0.max + 1))).status === 409);
check("mrn: item not on the BOM refused", (await packing("POST", "/api/bom-returns", mrnBody(1, "PMS9999"))).status === 409);
check("mrn: supervisor name needed", (await packing("POST", "/api/bom-returns", { ...mrnBody(1), returnedBy: " " })).status === 400);
r = await packing("POST", "/api/bom-returns", mrnBody(1));
check("mrn: supervisor raises MRN-yyyymmdd-nnnn", r.status === 200 && /^MRN-\d{8}-\d{4}$/.test(r.json.mrnNo ?? ""), JSON.stringify(r.json));
const mrnNo = r.json.mrnNo;
r = await packing("GET", `/api/bom-returns/source/${latest.bomNo}`);
check("mrn: a pending return counts against what can come back", r.json.lines[0].max === m0.max - 1 && r.json.lines[0].returned === 1, JSON.stringify(r.json.lines[0]));
const bomLine = async () => (await store("GET", "/api/state")).json.state.bomIssues.find((b) => b.bomNo === latest.bomNo).lines.find((l) => l.componentCode === m0.code);
check("mrn: pending → stock not changed yet", !(await bomLine()).returnedQty);
check("mrn: packing cannot approve", (await packing("POST", `/api/bom-returns/${mrnNo}/approve`, { received: [1], remarks: "" })).status === 403);
check("mrn: received more than returned refused", (await store("POST", `/api/bom-returns/${mrnNo}/approve`, { received: [2], remarks: "" })).status === 409);
check("mrn: wrong line count refused", (await store("POST", `/api/bom-returns/${mrnNo}/approve`, { received: [1, 1], remarks: "" })).status === 409);
r = await store("POST", `/api/bom-returns/${mrnNo}/approve`, { received: [1], remarks: "counted" });
check("mrn: store approves", r.status === 200, JSON.stringify(r.json));
check("mrn: approved once", (await store("POST", `/api/bom-returns/${mrnNo}/approve`, { received: [1], remarks: "" })).status === 409);
check("mrn: approved qty is back in stock (returned on the slip)", (await bomLine()).returnedQty === 1);
r = await store("GET", "/api/bom-returns");
const listed = r.json.returns?.find((x) => x.mrnNo === mrnNo);
check("mrn: listed approved with store's count", listed?.status === "APPROVED" && listed.lines[0].received === 1 && listed.verifiedBy, JSON.stringify(listed));
check("mrn: gate cannot read MRNs", (await gate("GET", "/api/bom-returns")).status === 403);
r = rBeforeMrn;

// indent requests: Store approves an item below minimum (one open request per item); Purchase makes the indent; PO closes it
// the API allows 600 requests a minute per address and this suite is long: let the window clear first
await new Promise((r) => setTimeout(r, 61_000));
const act = async (c, name, args) => c("POST", `/api/actions/${name}`, { args, basis: (await c("GET", "/api/version")).json.version });
const purchase = await login("purchase");
const IRC = "PMS0164";
const V = (await gate("GET", "/api/vendors")).json.vendors[0]; // a Tally vendor once Tally is synced
const raiseIr = (items, c = store) => c("POST", "/api/indent-requests", { requiredDate: "2026-11-09", items });
r = await raiseIr([{ code: IRC, qty: 500, remarks: "short in plan" }]);
check("ir: raised with IR-yyyymmdd-nnnn", r.status === 200 && /^IR-\d{8}-\d{4}$/.test(r.json.requestNos?.[0] ?? ""), JSON.stringify(r.json));
const irNo = r.json.requestNos?.[0];
r = await raiseIr([{ code: "PMS0158", qty: 1, remarks: "" }, { code: IRC, qty: 500, remarks: "" }]);
check("ir: same item again (another day's plan) refused, all or nothing", r.status === 409 && /already has an open indent request/.test(r.json.error), JSON.stringify(r.json));
r = await Promise.all([raiseIr([{ code: "PMS0160", qty: 5, remarks: "" }]), raiseIr([{ code: "PMS0160", qty: 5, remarks: "" }])]);
check("ir: two at the same moment → exactly one made", r.filter((x) => x.status === 200).length === 1 && r.filter((x) => x.status === 409).length === 1, JSON.stringify(r.map((x) => x.status)));
r = await packing("GET", "/api/indent-requests");
const mine = r.json.requests?.find((x) => x.requestNo === irNo);
check("ir: listed, approved by the login's name, verified at once, open", mine?.raisedBy && mine.verifiedBy === mine.raisedBy && mine.status === "VERIFIED" && mine.open && mine.requiredDate === "2026-11-09", JSON.stringify(mine));
check("ir: purchase and store can read the list", (await purchase("GET", "/api/indent-requests")).status === 200 && (await store("GET", "/api/indent-requests")).status === 200);
check("ir: packing cannot raise", (await raiseIr([{ code: "PMS0158", qty: 1, remarks: "" }], packing)).status === 403);
const irIndent = (no) => ({ date: "", componentCode: IRC, componentName: "", qty: 500, reason: "test", supplierName: V, rate: 2.1, requestNo: no });
check("ir: already verified → verify refused", (await store("POST", `/api/indent-requests/${irNo}/verify`, { approve: false, remarks: "x" })).status === 409);
r = await act(purchase, "addIndent", [irIndent(irNo)]);
const irInd = r.json?.changes?.indents?.at(-1);
check("ir: purchase makes the indent from it", r.status === 200 && irInd?.requestNo === irNo, JSON.stringify(r.json?.error ?? irInd));
check("ir: a second indent for it refused", (await act(purchase, "addIndent", [irIndent(irNo)])).status === 409);
r = await packing("GET", "/api/indent-requests");
check("ir: shows its indent, still open (no PO yet)", r.json.requests.find((x) => x.requestNo === irNo)?.indentNo === irInd?.id && r.json.requests.find((x) => x.requestNo === irNo).open);
check("ir: still blocks a new request for the item", (await raiseIr([{ code: IRC, qty: 1, remarks: "" }])).status === 409);
r = await act(purchase, "raisePo", [{ date: "", supplierName: V, lines: [{ componentCode: IRC, componentName: "", qty: 500, rate: 2.1 }], expectedDate: "30-11-2026", indentIds: [irInd?.id], gst: "INTRA" }]);
check("ir: PO raised on its indent", r.status === 200, JSON.stringify(r.json?.error));
const irPo = r.json?.changes?.purchaseOrders?.at(-1)?.id;
r = await packing("GET", "/api/indent-requests");
check("ir: on a PO but not received → still open", r.json.requests.find((x) => x.requestNo === irNo)?.open === true && r.json.requests.find((x) => x.requestNo === irNo)?.poNo === irPo);
r = await raiseIr([{ code: IRC, qty: 1, remarks: "" }]);
check("ir: same plan again after the PO → still refused (material not in yet)", r.status === 409 && /already has an open indent request/.test(r.json.error), JSON.stringify(r.json));
const admin = await login("admin");
await act(admin, "approvePo", [irPo, ""]);
r = await act(admin, "closePo", [irPo, "test: closed by hand", "", ""]);
check("ir: PO closed by hand", r.status === 200, JSON.stringify(r.json?.error));
r = await packing("GET", "/api/indent-requests");
check("ir: PO done → request closed", r.json.requests.find((x) => x.requestNo === irNo)?.open === false);
r = await raiseIr([{ code: IRC, qty: 1, remarks: "" }]);
check("ir: item can be requested again", r.status === 200, JSON.stringify(r.json));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * Purchase System — the rules of the old Apps Script (Code.gs v2.0), ported 1:1 as pure functions.
 * Dates are local wall-clock (the server runs in India time, like the script's Asia/Kolkata).
 * Shared by the importer (to check the sheet's own calculated columns) and the backend.
 */

export const CFG = {
  VERSION: "2.0 · 21-Nov-2026 (database)",
  PORTAL: "Seven Seas Purchase System",
  COMPANY: { name: "Seven Seas Beauty Products Pvt Ltd", phone: "92207 08293", email: "purchase@sevenseascosmetics.com" },
  ENTITIES: {
    HR: {
      poCompany: "Seven Seas Beauty Products Pvt Ltd (HR)",
      address: "Khasra No. 61/22/2, Village Rathdana, Sonipat, Haryana - 131001, India",
      gstin: "06ABSCS5392P1Z8",
      state: "06",
      stateName: "haryana",
      label: "Haryana",
    },
    DL: {
      poCompany: "Seven Seas Beauty Products (Delhi)",
      address: "B-68 GT Karnal Road Industrial Area, Near Bikanervala, Delhi-110033, India",
      gstin: "07AAJPM3260D1ZY",
      state: "07",
      stateName: "delhi",
      label: "Delhi",
    },
  },
  ECOM_REGEX: /^\s*e-?commerce/i,
  PO_TERMS: [
    "Please quote the PO number on every invoice and challan.",
    "Late delivery penalty: 1% for 7-10 days, 2% beyond 10 days, 5% beyond 1 month.",
    "Quantity and quality must match this PO and the approved sample.",
    "Packing must follow company norms. Damage due to poor packing is the supplier's responsibility.",
    "Rates are firm. No increase without written approval.",
    "The buyer may cancel the PO fully or partly if delivery or quality terms are not met.",
  ],
  PURCHASE_EMAIL: "purchase@sevenseascosmetics.com",
  DIRECTOR_EMAIL: "director.naman@sevenseascosmetics.com",
  PO_SERIES: "26SEV",
  IND_PREFIX: "IND",
  GO_LIVE: "2026-11-20",
  REQUIRE_APPROVAL: true,
  DEFAULT_LEAD_DAYS: 15,
  GST_RATES: [0, 5, 12, 18, 28],
  BRAND_LOGOS: { sevenseas: "SS", red4: "RED4", redfour: "RED4" } as Record<string, string>,
  DEFAULT_GST: 18,
  UNITS: ["PCS", "KG", "LTR", "MTR", "BOX", "PKT", "ROLL", "SET", "GM", "ML", "NOS"],
  URGENCY: ["Urgent (1-2 days)", "Within 7 days", "Within 15 days", "Within 30 days"],
  SKIP_SUNDAY: true,
  HOLIDAYS: [] as string[],
  PUBLIC_INDENT: true,
  REPEAT_DAYS: 30,
  SESSION_HOURS: 6,
  MAX_UPLOAD_MB: 10,
  MATCH_DAYS: 45,
  ARCHIVE_OLD_RECEIVED: true,
  BLOCK_INACTIVE_VENDOR: true,
  PHOTO_REQUIRED: true,
  NOTIFY_ON_INDENT: true,
};

export interface Step {
  id: 1 | 2 | 3 | 4 | 5;
  exType: "REMARK" | "NEXT_DATE";
  label: string;
  opts: string[];
  req: string[];
  before?: number;
}
export const STEPS: Step[] = [
  { id: 1, exType: "REMARK", label: "Send PO to vendor", opts: ["DONE"], req: [] },
  { id: 2, exType: "REMARK", label: "Vendor confirmation – PO received?", opts: ["DONE", "NOT RECEIVED", "CANCELLED"], req: ["NOT RECEIVED", "CANCELLED"] },
  { id: 3, exType: "NEXT_DATE", label: "Follow up – order status (T-7)", opts: ["DONE", "NOT DONE"], req: ["DONE", "NOT DONE"], before: 7 },
  { id: 4, exType: "NEXT_DATE", label: "Follow up – order status (T-2)", opts: ["DONE", "NOT DONE"], req: ["DONE", "NOT DONE"], before: 2 },
  { id: 5, exType: "REMARK", label: "Entry in Tally", opts: ["DONE"], req: [], before: 2 },
];

export const STAGE = {
  indent: "INDENT – NO PO",
  indClosed: "INDENT CLOSED",
  appr: "PO MADE – APPROVAL PENDING",
  send: "PO APPROVED – SEND TO VENDOR",
  follow: "PO SENT – FOLLOW UP",
  part: "PART RECEIVED",
  tally: "RECEIVED – TALLY PENDING",
  closed: "CLOSED",
  cancelled: "CANCELLED",
  dup: "DUPLICATE ROW",
  orphan: "OLD ROW – NO INDENT / NO PO",
} as const;
export const ARCHIVE_STAGES: string[] = [STAGE.closed, STAGE.cancelled, STAGE.indClosed, STAGE.dup, STAGE.orphan];

/* ── text and numbers ── */
export const str = (v: unknown): string => (v === null || v === undefined ? "" : v instanceof Date ? fmt(v) : String(v).trim());
export const norm = (v: unknown) => str(v).toLowerCase().replace(/\s+/g, " ");
export const key = (v: unknown) => str(v).toLowerCase().replace(/[^a-z0-9]+/g, "");
export const normPo = (v: unknown) => str(v).toUpperCase().replace(/\s+/g, "");
export function num(v: unknown): number {
  const n = Number(String(v === null || v === undefined ? "" : v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
export const r2 = (n: number) => Math.round(n * 100) / 100;
export const esc = (s: unknown) =>
  String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/* ── dates (local wall-clock) ── */
const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Utilities.formatDate subset: dd MM MMM yyyy HH mm ss u */
export function fmt(d: Date | null | undefined, f = "dd/MM/yyyy"): string {
  if (!d) return "";
  return f.replace(/yyyy|MMM|MM|dd|HH|mm|ss/g, (t) =>
    t === "yyyy" ? String(d.getFullYear()) : t === "MMM" ? MONTHS[d.getMonth()] : t === "MM" ? pad(d.getMonth() + 1)
      : t === "dd" ? pad(d.getDate()) : t === "HH" ? pad(d.getHours()) : t === "mm" ? pad(d.getMinutes()) : pad(d.getSeconds()),
  );
}
export const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());
export const ms = (d: Date | null | undefined) => (isDate(d) ? d.getTime() : null);

/** Date / sheet serial / "dd/mm/yyyy [hh:mm[:ss]]" / "yyyy-mm-dd" / "dd-Mmm-yyyy" → Date, else null (Code.gs toDate_) */
export function toDate(v: unknown, now = Date.now()): Date | null {
  if (isDate(v)) return v;
  if (typeof v === "number" && v > 30000 && v < 80000) {
    // serial = local wall-clock days since 1899-12-30
    const whole = Math.floor(v);
    const base = new Date(1899, 11, 30 + whole);
    const secs = Math.round((v - whole) * 86400);
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, secs);
  }
  const s = str(v);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    // dd/mm/yyyy; a future date that works as mm/dd is read as mm/dd (old rows have both)
    const d = new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (d.getTime() > now + 2 * 864e5 && +m[1] <= 12) {
      const w = new Date(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
      if (w.getTime() <= now + 864e5) return w;
    }
    return d;
  }
  const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})/);
  if (m && MON[m[2].toLowerCase()] !== undefined) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return new Date(y, MON[m[2].toLowerCase()], +m[1]);
  }
  return null;
}
export const day = (d: Date | null) => (d ? new Date(d.getFullYear(), d.getMonth(), d.getDate()) : null);
export const today = () => day(new Date())!;
export const dayKey = (d: Date | null) => (d ? fmt(d, "yyyy-MM-dd") : "");
export const diffDays = (a: Date, b: Date) => Math.round((day(a)!.getTime() - day(b)!.getTime()) / 864e5);
const isOff = (d: Date) => (CFG.SKIP_SUNDAY && d.getDay() === 0) || CFG.HOLIDAYS.includes(dayKey(d));
/** n working days after / before d (Sunday + holidays skipped), time 6 PM */
export function addWork(d: Date, n: number): Date {
  let x = day(d)!;
  let left = Math.abs(n);
  const step = n >= 0 ? 1 : -1;
  while (left > 0) {
    x = new Date(x.getFullYear(), x.getMonth(), x.getDate() + step);
    if (!isOff(x)) left--;
  }
  while (isOff(x)) x = new Date(x.getFullYear(), x.getMonth(), x.getDate() + 1);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 18, 0, 0);
}
export const maxDate = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b);
export function isoToDate(s: unknown, label = "Date"): Date {
  const m = str(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(label + " – please select.");
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

/** indent qty text → number + unit: "300 PCS" → 300 PCS · "2lakh" → 200000 · "50kg" → 50 KG · "1.5 k" → 1500 */
export function qtyParse(v: unknown): { q: number; u: string } {
  if (typeof v === "number") return { q: v, u: "" };
  const t = str(v).toLowerCase().replace(/,/g, "");
  const m = t.match(/(\d+(?:\.\d+)?)\s*(lakh|lac|lakhs|k\b|thousand)?/);
  if (!m) return { q: 0, u: "" };
  let q = Number(m[1]);
  if (/^la/.test(m[2] || "")) q *= 100000;
  else if (m[2]) q *= 1000;
  const rest = t.slice(m.index! + m[0].length).trim();
  const um = rest.match(/^(pcs|pc|nos|kgs|kg|gms|gm|g|ltr|litre|l|ml|mtr|m|box|pkt|roll|set)\b/);
  const U: Record<string, string> = { pc: "PCS", pcs: "PCS", nos: "NOS", kg: "KG", kgs: "KG", gm: "GM", gms: "GM", g: "GM", ltr: "LTR", litre: "LTR", l: "LTR", ml: "ML", mtr: "MTR", m: "MTR", box: "BOX", pkt: "PKT", roll: "ROLL", set: "SET" };
  return { q: Math.round(q * 1000) / 1000, u: um ? U[um[1]] : "" };
}

/* ── tax and PO entity ── */
export type Entity = (typeof CFG.ENTITIES)["HR"] & { key: "HR" | "DL" };
export function taxType(v: { gstin?: string; address?: string } | null, ent: { state: string; stateName: string } = CFG.ENTITIES.HR) {
  const g = str(v?.gstin).replace(/\s/g, "");
  if (/^\d{2}/.test(g)) return g.slice(0, 2) === ent.state ? "CGST+SGST" : "IGST";
  return new RegExp(ent.stateName, "i").test(str(v?.address)) ? "CGST+SGST" : "IGST";
}
export function taxSplit(gstAmt: number, type: string) {
  if (type === "IGST") return { cgst: 0, sgst: 0, igst: r2(gstAmt) };
  const h = r2(gstAmt / 2);
  return { cgst: h, sgst: r2(gstAmt - h), igst: 0 };
}
export const isEcom = (n: unknown) => CFG.ECOM_REGEX.test(str(n));
/** strict = true: a PO with ECOMMERCE and other items together is refused (one PO = one GSTIN) */
export function entityOf(lines: { name?: string; it?: string }[], strict: boolean): Entity {
  const names = (lines || []).map((l) => str(l.name || l.it)).filter(Boolean);
  const ec = names.filter(isEcom).length;
  if (strict && ec && ec < names.length) {
    throw new Error("ECOMMERCE items are bought on the Delhi GSTIN and other items on the Haryana GSTIN. Please make separate POs.");
  }
  return ec && ec === names.length ? { key: "DL", ...CFG.ENTITIES.DL } : { key: "HR", ...CFG.ENTITIES.HR };
}

/* ── PO Demand Form rules: dibbi + outer box, inner + master peti, chemical packs ── */
export const isDibbi = (n: string) => /dibbi|mono.?carton/i.test(n) && !/shrink/i.test(n);
export const isInnerPeti = (n: string) => /pet[t]?i/i.test(n) && !/master/i.test(n);
export function namedCap(n: string) {
  const m = String(n).match(/\b(\d+)\s*pcs\b/gi) || [];
  return m.length === 1 ? Number(m[0].replace(/\D/g, "")) : 0;
}
export function chemPacks(t: string, uom: string, types: string[], cat: string) {
  t = str(t);
  if (!t || String(uom || "").toUpperCase() !== "KG") return [];
  if (!types.includes("Raw Material") && !/chemical/i.test(cat || "")) return [];
  const out: { label: string; kg: number; noun: string }[] = [];
  t.split(/[/;]/).forEach((part) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:kgs?)\.?\s*([A-Za-z]*)\s*$/i.exec(part);
    if (m && Number(m[1]) > 0) out.push({ label: str(part).replace(/\s+/g, " "), kg: Number(m[1]), noun: (m[2] || "pack").toLowerCase() });
  });
  return out;
}
export const roundUpPack = (q: number, kg: number) => Math.round(Math.ceil(Math.round((q / kg) * 1e6) / 1e6) * kg * 1e6) / 1e6;

/** One item as the script's items_() builds it (grouped by item name). v = [vendor, cost, vendorItemName, vendorCode] cheapest first. */
export interface Item {
  n: string;
  s: string;
  t: string;
  c: string;
  b: string;
  u: string;
  pk: string;
  o: string;
  ph: string;
  st: string;
  hs: string;
  gs: number | "";
  v: [string, number, string, string][];
  fg: 0 | 1;
  ty: string[];
  packs: string[];
  moq: number;
  pt: string;
  ch?: 0 | 1;
  pkgs?: { label: string; kg: number; noun: string }[];
  set?: Record<string, unknown>;
  peti?: Record<string, unknown>;
  p?: string;
}

export function attachSets(list: Item[]) {
  const fam: Record<string, Item[]> = {};
  list.forEach((it) => {
    const m = /^([A-Z]+-\d+)\b/i.exec(it.n);
    if (m) (fam[m[1].toUpperCase()] ??= []).push(it);
  });
  const shared = (a: Item, b: Item) => a.v.map((x) => x[0]).filter((x) => b.v.some((y) => y[0].toLowerCase() === x.toLowerCase()));
  const unitsOk = (l: Item[]) => l.every((i) => !i.u || ["PCS", "BOX"].includes(i.u));
  Object.keys(fam).forEach((f) => {
    const l = fam[f];
    const dib = l.filter((i) => isDibbi(i.n));
    const box = l.filter((i) => /\bbox\b/i.test(i.n) && !/pet[t]?i|outer\s*\(pet|master|single|jali|dibbi|\b1\s*pcs\b/i.test(i.n));
    if (dib.length) {
      let link: Record<string, unknown> = { ok: 0, family: f, reason: "Dibbi or box missing / ambiguous" };
      if (dib.length === 1 && box.length === 1) {
        const d = dib[0], bx = box[0], m = /\b(\d+)\s*pcs\b/i.exec(bx.n), cap = m ? Number(m[1]) : 0, vs = shared(d, bx);
        const conflict = bx.packs.some((x) => {
          const mm = /^(\d+)(?:\s*pcs)?$/i.exec(x);
          return !mm || Number(mm[1]) !== cap;
        });
        if (cap > 1 && vs.length && unitsOk([d, bx]) && !conflict) link = { ok: 1, family: f, dibbi: d.n, box: bx.n, capacity: cap, vendors: vs };
        else link.reason = !cap ? "Box pack size missing" : !vs.length ? "Same vendor not linked to both pieces" : !unitsOk([d, bx]) ? "Purchase unit needs review" : "Pack size conflicts with box name";
      }
      dib.forEach((d) => (d.set = link));
    }
    const inner = l.filter((i) => isInnerPeti(i.n));
    const mast = l.filter((i) => /master/i.test(i.n) && i.ty.includes("Packaging Material"));
    if (inner.length) {
      let link: Record<string, unknown> = {
        ok: 0,
        family: f,
        standalone: mast.length === 0 ? 1 : 0,
        reason: mast.length === 0 ? "No master peti in this family" : "Inner or master peti missing / ambiguous",
      };
      if (inner.length === 1 && mast.length === 1) {
        const a = inner[0], m = mast[0], ic = namedCap(a.n), mc = namedCap(m.n), ratio = ic ? mc / ic : 0, vs = shared(a, m);
        const conflict = [a, m].some((it) => it.packs.some((x) => !/^\d+(?:\s*pcs)?$/i.test(x) || Number(/^\d+/.exec(x)![0]) !== namedCap(it.n)));
        if (!ic || !mc) link.reason = "Explicit PCS capacity missing in peti name";
        else if (!Number.isSafeInteger(ratio) || ratio <= 1) link.reason = "Master capacity must hold a whole number of inner peti";
        else if (!vs.length) link.reason = "Same vendor not linked to inner and master peti";
        else if (!unitsOk([a, m])) link.reason = "Peti purchase unit needs review";
        else if (conflict) link.reason = "Pack size conflicts with peti name";
        else link = { ok: 1, family: f, inner: a.n, master: m.n, innerCapacity: ic, masterCapacity: mc, ratio, vendors: vs };
      }
      inner.forEach((a) => (a.peti = link));
    }
  });
}

/* ── the FMS line and its calculation ── */
export interface StepState {
  act: Date | null;
  st: string;
  /** REMARK steps: the remark; NEXT_DATE steps: the remark when there is no next date */
  ex: string;
  nx: Date | null;
  history: string;
}
export interface Line {
  id: string;
  seq: number;
  ts: Date | null;
  ind: string;
  item: string;
  party: string;
  urg: string;
  by: string;
  rem: string;
  iqty: string;
  signed: string;
  po: string;
  code: string;
  qty: number | null;
  rate: number | null;
  value: number | null;
  vendor: string;
  poDate: Date | null;
  edd: Date | null;
  pdf: string;
  override: string;
  signedAt: Date | null;
  mailedAt: Date | null;
  note: string;
  lead: string;
  unit: string;
  steps: Record<number, StepState>;
}
export const blankStep = (): StepState => ({ act: null, st: "", ex: "", nx: null, history: "" });

/** A PO as readPo_() sees it: its sheet rows grouped by PO no. */
export interface PoLine {
  rowId: number;
  vitem: string;
  cgst: number;
  sgst: number;
  igst: number;
  code: string;
  name: string;
  hsn: string;
  qty: number;
  unit: string;
  rate: number;
  gst: number | "";
  gstAmt: number;
  amount: number;
  total: number;
  ind: string;
  id: string;
}
export interface PoRec {
  po: string;
  pd: Date | null;
  ed: Date | null;
  ve: string;
  lines: PoLine[];
  appr: string;
  by: string;
  at: Date | null;
  pdf: string;
  lead: number | "";
  doer: string;
  rem: string;
  vcode: string;
  taxType: string;
  reqBy?: string;
}
export interface PoRow {
  id: number;
  po_no: string;
  po_date: Date | null;
  edd: Date | null;
  vendor: string;
  item_code: string;
  item_name: string;
  hsn: string;
  qty: number;
  unit: string;
  rate: number;
  gst: string;
  gst_amt: number;
  amount: number;
  total: number;
  indent_no: string;
  doer: string;
  pdf: string;
  approval: string;
  approved_by: string;
  approved_at: Date | null;
  lead_days: string;
  line_id: string;
  remarks: string;
  vendor_code: string;
  vendor_item: string;
  tax_type: string;
  cgst: number;
  sgst: number;
  igst: number;
}
export function groupPo(rows: PoRow[]): { by: Record<string, PoRec>; order: string[] } {
  const by: Record<string, PoRec> = {}, order: string[] = [];
  const live = new Date(CFG.GO_LIVE + "T00:00:00");
  for (const r of rows) {
    const po = normPo(r.po_no);
    if (!po) continue;
    let x = by[po];
    if (!x) {
      x = by[po] = { po: str(r.po_no), pd: r.po_date, ed: r.edd, ve: str(r.vendor), lines: [], appr: "", by: "", at: null, pdf: "", lead: "", doer: str(r.doer), rem: str(r.remarks), vcode: str(r.vendor_code), taxType: "" };
      order.push(po);
    }
    if (!x.taxType && str(r.tax_type)) x.taxType = str(r.tax_type);
    x.lines.push({
      rowId: r.id, vitem: str(r.vendor_item), cgst: num(r.cgst), sgst: num(r.sgst), igst: num(r.igst), code: str(r.item_code), name: str(r.item_name), hsn: str(r.hsn),
      qty: num(r.qty), unit: str(r.unit), rate: num(r.rate), gst: str(r.gst) === "" ? "" : num(r.gst), gstAmt: num(r.gst_amt), amount: num(r.amount), total: num(r.total), ind: str(r.indent_no), id: str(r.line_id),
    });
    const a = str(r.approval).toUpperCase();
    if (a && (!x.appr || a === "CANCELLED" || (a === "APPROVED" && x.appr !== "CANCELLED"))) x.appr = a;
    if (!x.by && str(r.approved_by)) {
      x.by = str(r.approved_by);
      x.at = r.approved_at;
    }
    if (!x.pdf && str(r.pdf)) x.pdf = str(r.pdf);
    if (x.lead === "" && str(r.lead_days) !== "") x.lead = num(r.lead_days);
  }
  order.forEach((k) => {
    const x = by[k];
    if (!x.appr) x.appr = !x.pd || x.pd < live || !CFG.REQUIRE_APPROVAL ? "APPROVED" : "PENDING";
  });
  return { by, order };
}

/** GRN rows (copy of the GRN system) → PO|item → received (Code.gs gate_()) */
export interface GrnRow {
  grn_id: string;
  gate_entry_id: string;
  po_no: string;
  po_line_code: string;
  po_item_name: string;
  po_qty: string;
  unit: string;
  store_received_qty: string;
  decision: string;
  approved_qty: string;
  po_status: string;
}
export interface Gate {
  ge: string[];
  grn: string[];
  code: string;
  name: string;
  qty: number;
  unit: string;
  closed: boolean;
  poQty: number;
}
export function gateOf(rows: GrnRow[]) {
  const map: Record<string, Gate> = {}, byPo: Record<string, Gate[]> = {};
  for (const r of rows) {
    const po = normPo(r.po_no);
    if (!po) continue;
    const code = str(r.po_line_code), name = str(r.po_item_name);
    const k = po + "|" + key(code || name);
    let x = map[k];
    if (!x) {
      x = map[k] = { ge: [], grn: [], code, name, qty: 0, unit: "", closed: false, poQty: 0 };
      (byPo[po] ??= []).push(x);
      if (name && key(name) !== key(code)) map[po + "|" + key(name)] = x;
    }
    const add = (a: string[], v: unknown) => {
      const s = str(v);
      if (s && !a.includes(s)) a.push(s);
    };
    add(x.ge, r.gate_entry_id);
    add(x.grn, r.grn_id);
    if (norm(r.decision) !== "reject") x.qty += str(r.approved_qty) !== "" ? num(r.approved_qty) : num(r.store_received_qty);
    if (!x.unit) x.unit = str(r.unit);
    if (num(r.po_qty)) x.poQty = num(r.po_qty);
    if (/^CLOSED|^COMPLETE|^RECEIVED/i.test(str(r.po_status))) x.closed = true;
  }
  return { map, byPo };
}
export function gateFor(g: ReturnType<typeof gateOf>, po: string, code: string, name: string): Gate | null {
  const k = normPo(po), hit = g.map[k + "|" + key(code)] || g.map[k + "|" + key(name)];
  if (hit) return hit;
  const l = g.byPo[k];
  return l && l.length === 1 ? l[0] : null;
}

export interface Calc {
  plans: Record<number, Date | "">;
  delays: Record<number, string>;
  /** AM–AT: GE ids, GRN ids, PO date, GRN line code, GRN item name, HSN, received qty, unit */
  gate: [string, string, Date | "", string, string, string, number | "", string];
  rc: string;
  stage: string;
}
export interface Ctx {
  gate: ReturnType<typeof gateOf>;
  po: ReturnType<typeof groupPo>;
  today: Date;
}
export function doneOn(step: StepState, today: Date): Date | null {
  if (step.act) return step.act;
  return /^(DONE|NOT DONE|NOT RECEIVED|CANCELLED)$/.test(step.st.toUpperCase()) ? today : null;
}
function hsnOf(rec: PoRec | undefined, code: string) {
  if (!rec) return "";
  const l = rec.lines.find((x) => key(x.code) === key(code) || key(x.name) === key(code));
  return l && l.hsn !== "-" ? l.hsn : "";
}
/** Code.gs calcRow_: planned dates, delays, gate columns, receipt status and stage of one line */
export function calcRow(r: Line, c: Ctx): Calc {
  const o: Calc = { plans: {}, delays: {}, gate: ["", "", "", "", "", "", "", ""], rc: "", stage: "" };
  const po = str(r.po), ov = str(r.override).toUpperCase(), note = str(r.note);
  STEPS.forEach((s) => {
    o.plans[s.id] = "";
    o.delays[s.id] = "";
  });
  if (/^DUPLICATE/i.test(note)) {
    o.stage = STAGE.dup;
    return o;
  }
  if (!po) {
    if (ov === "CANCELLED" || ov === "CLOSED") o.stage = STAGE.indClosed;
    else if (/IND\d+/i.test(r.ind)) o.stage = STAGE.indent;
    else o.stage = STAGE.orphan; // a line here always has data (empty rows are not imported)
    return o;
  }
  const rec = c.po.by[normPo(po)], appr = rec ? rec.appr : "APPROVED";
  const g = gateFor(c.gate, po, r.code, r.item);
  const pd = r.poDate;
  if (g) o.gate = [g.ge.join(", "), g.grn.join(", "), pd || "", g.code, g.name, hsnOf(rec, r.code), g.qty, g.unit];
  const qty = num(r.qty), got = g ? g.qty : 0;
  const cancelled = appr === "CANCELLED" || [2, 3, 4].some((id) => r.steps[id].st.toUpperCase() === "CANCELLED");
  o.rc = ["CANCELLED", "RECEIVED", "PARTIAL", "OPEN"].includes(ov) ? ov : cancelled ? "CANCELLED" : g && g.closed ? "RECEIVED"
    : got <= 0 ? "OPEN" : qty > 0 && got > qty * 1.12 ? "REVIEW - EXCESS QTY" : qty > 0 && got >= qty ? "RECEIVED" : "PARTIAL";
  const edd = r.edd || (pd ? new Date(pd.getFullYear(), pd.getMonth(), pd.getDate() + CFG.DEFAULT_LEAD_DAYS) : null);
  const mailed = r.mailedAt;
  let prev: Date | null = null;
  STEPS.forEach((s) => {
    const own = doneOn(r.steps[s.id], c.today);
    let open = false;
    if (s.id === 1) open = appr === "APPROVED";
    else if (s.id === 2) open = prev !== null || !!mailed;
    else if (s.id === 5) open = prev !== null || o.rc === "RECEIVED" || o.rc === "PARTIAL" || o.rc === "REVIEW - EXCESS QTY";
    else open = prev !== null;
    if ((open || own) && pd && o.rc !== "CANCELLED") {
      let plan: Date;
      if (s.id === 1) plan = addWork(pd, 1);
      else if (s.id === 2) plan = maxDate(addWork(pd, 1), prev ? addWork(prev, 1) : mailed ? addWork(mailed, 1) : null)!;
      else plan = maxDate(addWork(edd!, -s.before!), prev ? addWork(prev, 0) : null)!;
      o.plans[s.id] = plan;
      const late = own ? diffDays(own, plan) : diffDays(c.today, plan);
      o.delays[s.id] = own ? (late > 0 ? "DELAYED BY " + late + " DAYS" : "ON TIME") : late > 0 ? "OVERDUE BY " + late + " DAYS" : "PENDING";
    }
    prev = own;
  });
  const done = (id: number) => !!doneOn(r.steps[id], c.today);
  o.stage = o.rc === "CANCELLED" ? STAGE.cancelled : done(5) ? STAGE.closed : o.rc === "RECEIVED" || o.rc === "REVIEW - EXCESS QTY" ? STAGE.tally
    : o.rc === "PARTIAL" ? STAGE.part : appr === "PENDING" ? STAGE.appr : done(1) || mailed ? STAGE.follow : STAGE.send;
  return o;
}

/** archived = would have been moved to the "Purchase Archive" file */
export function isArchived(stage: string, poDate: Date | null): boolean {
  const live = new Date(CFG.GO_LIVE + "T00:00:00");
  return ARCHIVE_STAGES.includes(stage) || (CFG.ARCHIVE_OLD_RECEIVED && stage === STAGE.tally && !!poDate && poDate < live);
}

/** LINE ID: L + time base36 + '-' + 3 random + counter (Code.gs lineId_) */
let lidN = 0;
export function lineId(): string {
  lidN++;
  return "L" + Date.now().toString(36).toUpperCase() + "-" + ("00" + Math.floor(Math.random() * 46656).toString(36).toUpperCase()).slice(-3) + lidN.toString(36).toUpperCase();
}

/** Indian money format 1,23,456.78 */
export function money(n: number): string {
  const v = r2(Number(n) || 0), p = v.toFixed(2).split(".");
  const neg = p[0].startsWith("-");
  const digits = neg ? p[0].slice(1) : p[0];
  const h = digits.slice(0, -3);
  let t = digits.slice(-3);
  if (h) t = "," + t;
  return (neg ? "-" : "") + h.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + t + "." + p[1];
}
export function words(n: number): string {
  const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x: number) => (x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? " " + a[x % 10] : ""));
  const three = (x: number) => (x >= 100 ? a[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " : "") : "") + (x % 100 ? two(x % 100) : "");
  let r = Math.floor(n);
  const paise = Math.round((n - r) * 100);
  let out = "";
  const cr = Math.floor(r / 1e7);
  r %= 1e7;
  const lk = Math.floor(r / 1e5);
  r %= 1e5;
  const th = Math.floor(r / 1e3);
  r %= 1e3;
  if (cr) out += three(cr) + " Crore ";
  if (lk) out += two(lk) + " Lakh ";
  if (th) out += two(th) + " Thousand ";
  if (r) out += three(r);
  out = (out.trim() || "Zero") + " Rupees";
  if (paise) out += " and " + two(paise) + " Paise";
  return out + " Only";
}
